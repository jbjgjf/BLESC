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
import { dispatchAttention, dispatchPendingEscalations, readCount } from "@/lib/server/safetyDispatch";

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
  // `attention` is the sentences a human has to act on, decided here rather
  // than by the caller (#453). The five-minute workflow used to read `stuck`
  // and `pending` itself and got the `null` case wrong; it now prints these.
  return NextResponse.json({ ...result, attention: dispatchAttention(result) });
}

/**
 * Whether the dispatcher is in a position to do its job.
 *
 * Booleans and counts only, so it can be polled by an uptime check without
 * handing anything out. A deployment where `channels` is false is one where a
 * crisis has nowhere to go, and that is worth alerting on by itself.
 *
 * ## A count that could not be read is not zero (#453)
 *
 * This answered `owed: count ?? 0` without looking at `error`, so a failed
 * query — a dropped connection, a rotated key, RLS — was reported as "nothing
 * is owed, all clear" to whatever polls it. That is the quiet zero #377
 * removed from `stuck` one function away, in the endpoint the retry workflow's
 * own header calls the thing that makes a gap "visible rather than assumed
 * away".
 *
 * So an unreadable count is `null`, its reason is beside it, and the response
 * is **502**: a monitor that reads only the status code has to see this as the
 * dispatcher failing to answer, because that is what happened. The body still
 * carries `channels` and whichever count did read, so a person who opens it
 * learns more than "502".
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

  const owedCount = readCount(owed);
  const noRecipientCount = readCount(undeliverable);

  const body: Record<string, unknown> = {
    channels: Boolean(
      process.env.SAFETY_ALERT_WEBHOOK_URL ||
        (process.env.RESEND_API_KEY && process.env.SAFETY_ALERT_EMAIL_FROM),
    ),
    owed: owedCount,
    no_recipient: noRecipientCount,
  };

  const attention: string[] = [];
  if (owedCount === null) {
    const reason = owed.error?.message ?? "no_count_returned";
    body.owed_error = reason;
    attention.push(
      `まだ誰にも届いていない escalation の件数が読めませんでした（${reason}）。0件ではありません。`,
    );
  }
  if (noRecipientCount === null) {
    const reason = undeliverable.error?.message ?? "no_count_returned";
    body.no_recipient_error = reason;
    attention.push(
      `見守り同意の無い参加者の escalation の件数が読めませんでした（${reason}）。0件ではありません。`,
    );
  }

  // Always present, so a reader does not have to tell "nothing to report" from
  // "this deployment does not report" — the distinction the workflow's own
  // fallback annotation exists for.
  body.attention = attention;

  if (attention.length > 0) {
    console.error("[safety-dispatch] could not read the queue counts; reporting them as unknown, not 0", {
      owed_error: body.owed_error ?? null,
      no_recipient_error: body.no_recipient_error ?? null,
    });
    return NextResponse.json(body, { status: 502 });
  }

  return NextResponse.json(body);
}
