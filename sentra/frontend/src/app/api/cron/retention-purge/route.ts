/**
 * The scheduler's entrance to the retention purge (#B3).
 *
 * A GET for the same reason as its sibling: Vercel cron sends nothing else.
 * That it deletes on a GET is a genuine wart — the alternative is a retention
 * promise nothing enforces, and between a verb that is wrong and a promise that
 * is false, the promise matters more. It is gated on `CRON_SECRET` and
 * unreachable without it.
 *
 * Daily, not hourly: the unit of the promise is days, and an hourly purge adds
 * 23 writes a day that can only find nothing.
 */

import { NextRequest, NextResponse } from "next/server";
import { serviceRoleClient } from "@/lib/server/supabaseWriter";
import { bearerAuthorized } from "@/lib/server/cronAuth";
import { runRetentionPurge } from "@/lib/server/scheduledJobs";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  if (!bearerAuthorized(request, "CRON_SECRET")) {
    return NextResponse.json({ detail: "forbidden" }, { status: 403 });
  }

  const service = serviceRoleClient();
  if (!service) return NextResponse.json({ detail: "supabase_not_configured" }, { status: 503 });

  const result = await runRetentionPurge(service);
  if (!result.ok) return NextResponse.json({ detail: result.detail }, { status: 502 });
  return NextResponse.json({ purged: result.purged });
}
