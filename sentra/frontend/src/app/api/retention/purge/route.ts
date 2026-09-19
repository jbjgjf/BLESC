/**
 * Running the retention promise (#B3).
 *
 * `purge_expired_raw_text()` has existed since 20260906000000 and, until this
 * route, was called by nothing but the SQL tests. The consent document tells a
 * student their text is deleted after `RESEARCH_RAW_TEXT_RETENTION_DAYS`; a
 * retention period nothing enforces is not a retention period, it is a sentence
 * in a document. This is the thing that makes the sentence true.
 *
 * ## Running it
 *
 * A POST here with `RETENTION_PURGE_TOKEN`, for a scheduler that can send one
 * and for a human running it by hand. The Vercel cron entry point is
 * `/api/cron/retention-purge` — Vercel cron only sends GET.
 *
 * Daily, not hourly: the unit of the promise is days, and an hourly purge would
 * add 23 writes a day that can only find nothing. 03:17 rather than 03:00
 * because every scheduler in the world fires on the hour.
 *
 * ## What it does not do
 *
 * It does not choose what expires. The `where` clause lives in the SQL
 * function, next to the columns it nulls, so that the definition of "expired"
 * cannot differ between the thing that sets `raw_text_expires_at` and the thing
 * that acts on it.
 */

import { NextRequest, NextResponse } from "next/server";
import { serviceRoleClient } from "@/lib/server/supabaseWriter";
import { bearerAuthorized } from "@/lib/server/cronAuth";
import { retentionOverdue, runRetentionPurge } from "@/lib/server/scheduledJobs";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  if (!bearerAuthorized(request, "RETENTION_PURGE_TOKEN")) {
    return NextResponse.json({ detail: "forbidden" }, { status: 403 });
  }

  const service = serviceRoleClient();
  if (!service) return NextResponse.json({ detail: "supabase_not_configured" }, { status: 503 });

  const result = await runRetentionPurge(service);
  if (!result.ok) return NextResponse.json({ detail: result.detail }, { status: 502 });
  return NextResponse.json({ purged: result.purged });
}

/**
 * How much is overdue, without deleting anything.
 *
 * For the monitor in the runbook: a non-zero `overdue` means the purge is not
 * running, and the number says how much text is being kept past what the
 * student was told. Read-only, so it can be polled.
 */
export async function GET(request: NextRequest) {
  if (!bearerAuthorized(request, "RETENTION_PURGE_TOKEN")) {
    return NextResponse.json({ detail: "forbidden" }, { status: 403 });
  }

  const service = serviceRoleClient();
  if (!service) return NextResponse.json({ detail: "supabase_not_configured" }, { status: 503 });

  const result = await retentionOverdue(service);
  if (!result.ok) return NextResponse.json({ detail: result.detail }, { status: 502 });

  return NextResponse.json({
    overdue: result.overdue,
    configured: Boolean(process.env.RESEARCH_RAW_TEXT_RETENTION_DAYS),
  });
}
