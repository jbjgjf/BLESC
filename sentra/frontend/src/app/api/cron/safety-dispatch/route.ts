/**
 * The scheduler's entrance to the safety dispatcher (#B3).
 *
 * A GET, because that is the only method Vercel cron sends. Pointing
 * `vercel.json` at `/api/safety/dispatch` — as that route's own header used to
 * suggest — runs its GET handler, which is the read-only health check: a cron
 * that returns 200 every five minutes and delivers nothing.
 *
 * Authorized by `CRON_SECRET`, which Vercel attaches to cron requests as a
 * bearer token by itself. Unset means this endpoint refuses everything, so a
 * deployment that forgot it has a dispatcher that does not run rather than one
 * anyone can trigger.
 *
 * The work is in `scheduledJobs.runSafetyDispatch`, shared with the POST route,
 * so the scheduled path and the manual one cannot do different things.
 */

import { NextRequest, NextResponse } from "next/server";
import { serviceRoleClient } from "@/lib/server/supabaseWriter";
import { bearerAuthorized } from "@/lib/server/cronAuth";
import { runSafetyDispatch } from "@/lib/server/scheduledJobs";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  if (!bearerAuthorized(request, "CRON_SECRET")) {
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
