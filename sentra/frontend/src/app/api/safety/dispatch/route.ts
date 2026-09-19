/**
 * The retry that makes "late" the worst case instead of "never".
 *
 * `/api/chat` and `/api/entries` record an escalation and start a delivery
 * without waiting for it — a student in crisis must not sit behind a school's
 * mail server. That trade is only safe if something else guarantees the send,
 * and this is that something: it picks up every escalation still `pending` or
 * `failed` and tries again.
 *
 * It is the difference between a notification system and a notification
 * attempt. The provider is down for ten minutes, the function times out, the
 * deployment was rolled while a row was in flight — in each case the row is
 * still there, still owed, and this endpoint still owes it.
 *
 * ## Running it
 *
 * Any scheduler that can make an authenticated POST. On Vercel, a `vercel.json`
 * in the project's Root Directory (sentra/frontend; one at the repo root is
 * never read):
 *
 *     { "crons": [{ "path": "/api/safety/dispatch", "schedule": "*\/5 * * * *" }] }
 *
 * Five minutes is a starting point, not a recommendation from evidence. It is
 * the ceiling on how late a *retried* escalation can be; the first attempt is
 * immediate. A school that needs a tighter ceiling should say so and this
 * should follow, because the number belongs to their duty roster, not to us.
 *
 * ## Authorisation
 *
 * A shared secret in `SAFETY_DISPATCH_TOKEN`, compared in constant time. Not a
 * user session: the caller is a scheduler, and there is no person to sign in.
 * Unset means the endpoint refuses everything — a dispatcher anyone on the
 * internet can trigger is a way to make this deployment send mail on command.
 */

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { serviceRoleClient } from "@/lib/server/supabaseWriter";
import { deliverEscalation, type EscalationRow } from "@/lib/server/safetyEscalation";

export const runtime = "nodejs";
export const maxDuration = 60;

/** How many to attempt per run. Bounded so one bad night cannot time out. */
const BATCH = 20;

/**
 * Give up paging after this many tries, and say so loudly.
 *
 * Not because the escalation stops mattering — it does not — but because a row
 * retried forever is a row nobody investigates. At this point the delivery has
 * failed for something like half an hour and the problem is the configuration,
 * not the network.
 */
const MAX_ATTEMPTS = 6;

function authorized(request: NextRequest): boolean {
  const expected = process.env.SAFETY_DISPATCH_TOKEN;
  if (!expected) return false;

  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!presented) return false;

  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  // `timingSafeEqual` throws on a length mismatch, which is itself a leak of
  // the length, so the lengths are compared first and the result is fixed.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ detail: "forbidden" }, { status: 403 });
  }

  const service = serviceRoleClient();
  if (!service) return NextResponse.json({ detail: "supabase_not_configured" }, { status: 503 });

  const pending = await service
    .from("safety_escalations")
    .select("id, owner_user_id, participant_id, risk_level, reasons, surface, detected_at, status, attempts")
    .in("status", ["pending", "failed"])
    .lt("attempts", MAX_ATTEMPTS)
    .order("detected_at", { ascending: true })
    .limit(BATCH);

  if (pending.error) {
    console.error("[safety-dispatch] could not read the queue", pending.error.message);
    return NextResponse.json({ detail: pending.error.message }, { status: 502 });
  }

  const rows = (pending.data ?? []) as EscalationRow[];

  // The participant code is what the message names, and it is not on the
  // escalation row — one lookup for the batch rather than one per row.
  const codes = new Map<string, string | null>();
  if (rows.length > 0) {
    const participants = await service
      .from("participants")
      .select("id, code")
      .in("id", Array.from(new Set(rows.map((row) => row.participant_id))));
    for (const row of (participants.data ?? []) as Array<{ id: string; code: string | null }>) {
      codes.set(row.id, row.code);
    }
  }

  const outcomes = { delivered: 0, failed: 0, no_recipient: 0 };
  for (const row of rows) {
    // Sequential, not `Promise.all`. The batch is small, the providers are rate
    // limited, and a burst that trips a rate limit turns a recoverable delay
    // into a wall of failures.
    const outcome = await deliverEscalation(service, row, codes.get(row.participant_id) ?? null);
    outcomes[outcome] += 1;
  }

  // Anything that has run out of attempts is a standing failure. Reported on
  // every run so it shows up in whatever watches this endpoint, rather than
  // waiting for someone to query the table.
  const exhausted = await service
    .from("safety_escalations")
    .select("id", { count: "exact", head: true })
    .in("status", ["pending", "failed"])
    .gte("attempts", MAX_ATTEMPTS);
  const stuck = exhausted.count ?? 0;
  if (stuck > 0) {
    console.error(
      `[safety-dispatch] ${stuck} escalation(s) have exhausted their attempts and nobody has been told. ` +
        "Check SAFETY_ALERT_WEBHOOK_URL / RESEND_API_KEY and the oversight consent for those participants.",
    );
  }

  return NextResponse.json({ attempted: rows.length, ...outcomes, stuck });
}

/**
 * Whether the dispatcher is in a position to do its job.
 *
 * Booleans and counts only, so it can be polled by an uptime check without
 * handing anything out. A deployment where `channels` is false is one where a
 * crisis has nowhere to go, and that is worth alerting on by itself.
 */
export async function GET(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ detail: "forbidden" }, { status: 403 });
  }
  const service = serviceRoleClient();
  if (!service) return NextResponse.json({ detail: "supabase_not_configured" }, { status: 503 });

  const owed = await service
    .from("safety_escalations")
    .select("id", { count: "exact", head: true })
    .in("status", ["pending", "failed"]);
  const undeliverable = await service
    .from("safety_escalations")
    .select("id", { count: "exact", head: true })
    .eq("status", "no_recipient");

  return NextResponse.json({
    channels: Boolean(
      process.env.SAFETY_ALERT_WEBHOOK_URL ||
        (process.env.RESEND_API_KEY && process.env.SAFETY_ALERT_EMAIL_FROM),
    ),
    owed: owed.count ?? 0,
    no_recipient: undeliverable.count ?? 0,
  });
}
