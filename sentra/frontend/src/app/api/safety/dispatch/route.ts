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
 * `no_recipient` is picked up too (#178). It means the crisis had nowhere to
 * go — no channel configured, or no educator with active oversight consent —
 * and both are conditions that get fixed later. Excluding it made "the alert
 * channel was set up an hour after go-live" into "that hour is lost forever",
 * which is the ordinary order of events when standing up a new environment.
 * Rows in this state do not consume `attempts`, so they wait rather than
 * expire; see `deliverEscalation`.
 *
 * ## Running it
 *
 * Any scheduler that can make an authenticated POST to this path with
 * `SAFETY_DISPATCH_TOKEN`.
 *
 * **Not Vercel cron.** Vercel cron sends GET and nothing else, and this route's
 * GET is the read-only health check below — a `vercel.json` entry pointing
 * here would return 200 on schedule and deliver nothing. The scheduled entry
 * point is `/api/cron/safety-dispatch`, which is a GET, is gated on
 * `CRON_SECRET`, and runs the same `runSafetyDispatch`.
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
import { serviceRoleClient } from "@/lib/server/supabaseWriter";
import { bearerAuthorized } from "@/lib/server/cronAuth";
import { runSafetyDispatch } from "@/lib/server/scheduledJobs";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  if (!bearerAuthorized(request, "SAFETY_DISPATCH_TOKEN")) {
    return NextResponse.json({ detail: "forbidden" }, { status: 403 });
  }

  const service = serviceRoleClient();
  if (!service) return NextResponse.json({ detail: "supabase_not_configured" }, { status: 503 });

  const result = await runSafetyDispatch(service);
  if (!result.ok) return NextResponse.json({ detail: result.detail }, { status: 502 });

  // Named rather than spread: `ok` is the runner's discriminant, not part of
  // this endpoint's response contract.
  return NextResponse.json({
    attempted: result.attempted,
    delivered: result.delivered,
    failed: result.failed,
    no_recipient: result.no_recipient,
    stuck: result.stuck,
  });
}

/**
 * Whether the dispatcher is in a position to do its job.
 *
 * Booleans and counts only, so it can be polled by an uptime check without
 * handing anything out. A deployment where `channels` is false is one where a
 * crisis has nowhere to go, and that is worth alerting on by itself.
 */
export async function GET(request: NextRequest) {
  if (!bearerAuthorized(request, "SAFETY_DISPATCH_TOKEN")) {
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
