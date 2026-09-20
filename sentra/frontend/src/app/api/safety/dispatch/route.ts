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
 * Any scheduler that can make an authenticated POST. On Vercel, `vercel.json`:
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
import { dispatchPendingEscalations } from "@/lib/server/safetyDispatch";

export const runtime = "nodejs";
export const maxDuration = 60;

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

  const result = await dispatchPendingEscalations(service);
  if ("error" in result) return NextResponse.json({ detail: result.error }, { status: 502 });
  return NextResponse.json(result);
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
