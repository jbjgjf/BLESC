/**
 * The job that makes the 90-day retention limit a limit (#185).
 *
 * `purge_expired_raw_text()` has existed since 20260906000000 and the migration
 * that created it said the scheduler was somebody else's job: "Scheduled by
 * whatever runs cron for the deployment — the function is the contract, not the
 * scheduler." Nothing ever became that scheduler. A search of the repository
 * found exactly one mention of the function outside its own migration, in a
 * comment in `lib/pilotOps.ts` explaining why an overdue count matters.
 *
 * So retained journal text carried an `expires_at`, the consent screen and the
 * participant documents promised 90 days, and the row was never going to be
 * touched. "90 days" meant "forever with a date written on it".
 *
 * ## What this does not fix
 *
 * Rows written before this shipped are already past their expiry. The first run
 * will purge all of them at once, which is correct and also means the first run
 * is the one to watch. `/api/research/pilot-dashboard` reports
 * `retention.overdue`, and it should read zero the morning after this is
 * scheduled. (An earlier version of this comment named `/api/pilot/admin/ops`,
 * which does not exist.)
 *
 * `overdue` proves the purge ran; it cannot prove it is scheduled. Before any
 * retained text has reached its expiry — day 1 of a dry run, say — a deployment
 * with no `CRON_SECRET` reports the same zero as a healthy one. The boolean that
 * separates them is `scheduled_jobs.cron_secret_configured` on the same
 * response (#205).
 */

import { NextRequest, NextResponse } from "next/server";
import { authorizedCron } from "@/lib/server/cronAuth";
import { serviceRoleClient } from "@/lib/server/supabaseWriter";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  if (!authorizedCron(request)) {
    return NextResponse.json({ detail: "forbidden" }, { status: 403 });
  }

  // `purge_expired_raw_text()` is SECURITY INVOKER with EXECUTE granted only to
  // `service_role`, so it has to be called with the service key — and being
  // invoker rather than definer is what keeps it from ignoring RLS for anyone
  // else who reaches it.
  const service = serviceRoleClient();
  if (!service) {
    console.error("[cron:retention] Supabase is not configured; retained text is not being purged");
    return NextResponse.json({ detail: "supabase_not_configured" }, { status: 503 });
  }

  const { data, error } = await service.rpc("purge_expired_raw_text");
  if (error) {
    // Loud, because a purge that silently fails leaves text the participant was
    // told would be gone.
    console.error("[cron:retention] purge failed; retained text is past its expiry", error.message);
    return NextResponse.json({ detail: error.message }, { status: 502 });
  }

  const purged = typeof data === "number" ? data : 0;
  if (purged > 0) console.info(`[cron:retention] purged ${purged} expired raw-text row(s)`);
  return NextResponse.json({ purged });
}
