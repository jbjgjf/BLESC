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
 * `POST` here, from any scheduler that can make an authenticated POST.
 *
 * **A Vercel cron job is not one of them** — it issues `GET`, and `GET` here is
 * the health probe. Schedulers that can only issue `GET` use
 * `/api/safety/dispatch/run`, which is wired into `sentra/frontend/vercel.json`.
 * See the head of that route for why the two are separate.
 *
 * ## Authorisation
 *
 * A shared secret in `SAFETY_DISPATCH_TOKEN` or `CRON_SECRET`, compared in
 * constant time — see `dispatchAuthorized`. Not a user session: the caller is a
 * scheduler, and there is no person to sign in. Neither set means the endpoint
 * refuses everything.
 */

import { NextRequest, NextResponse } from "next/server";
import { serviceRoleClient } from "@/lib/server/supabaseWriter";
import {
  dispatchAuthorized,
  dispatchSecretConfigured,
  runSafetyDispatch,
} from "@/lib/server/safetyDispatch";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  if (!dispatchAuthorized(request.headers.get("authorization"))) {
    return NextResponse.json({ detail: "forbidden" }, { status: 403 });
  }

  const service = serviceRoleClient();
  if (!service) return NextResponse.json({ detail: "supabase_not_configured" }, { status: 503 });

  try {
    return NextResponse.json(await runSafetyDispatch(service));
  } catch (error) {
    return NextResponse.json(
      { detail: error instanceof Error ? error.message : "dispatch failed" },
      { status: 502 },
    );
  }
}

/**
 * Whether the dispatcher is in a position to do its job.
 *
 * Booleans and counts only, so it can be polled by an uptime check without
 * handing anything out. A deployment where `channels` is false is one where a
 * crisis has nowhere to go, and that is worth alerting on by itself.
 *
 * This stays a probe and does not dispatch, even though a `GET` that retried
 * would have made the Vercel cron configuration work by accident. An uptime
 * check that pages a school every time it runs is not an uptime check, and the
 * two callers want opposite things from a 200.
 */
export async function GET(request: NextRequest) {
  if (!dispatchAuthorized(request.headers.get("authorization"))) {
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
    // False means no scheduler can authenticate, so nothing is retrying. That
    // is as fatal as having no channel, and was previously invisible.
    scheduler_secret: dispatchSecretConfigured(),
    owed: owed.count ?? 0,
    no_recipient: undeliverable.count ?? 0,
  });
}
