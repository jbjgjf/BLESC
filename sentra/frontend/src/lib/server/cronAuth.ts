/**
 * Who is allowed to trigger a scheduled job.
 *
 * Vercel Cron issues a plain `GET` and, when `CRON_SECRET` is set on the
 * project, sends `Authorization: Bearer <CRON_SECRET>`. That shape is the
 * reason these `/api/cron/*` routes exist at all rather than the schedule
 * pointing straight at `/api/safety/dispatch`, which is a `POST` behind its own
 * token: a cron entry cannot produce that request.
 *
 * **Unset means closed.** A scheduled job that anyone on the internet can fire
 * is a way to make this deployment send mail, or to drive a purge, on command.
 * The cost of failing closed is that the schedule silently does nothing, which
 * is why every route here says so loudly in the log and why
 * `/api/research/pilot-dashboard` reports `scheduled_jobs.cron_secret_configured`
 * (#205). An earlier version of this comment named `/api/pilot/admin/ops`, which
 * has never existed — so for as long as it stood, the only report of a schedule
 * refusing every call was a line in a function log.
 */

import type { NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";

export function cronSecretConfigured(): boolean {
  return Boolean(process.env.CRON_SECRET);
}

export function authorizedCron(request: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    console.error(
      "[cron] CRON_SECRET is not set, so every scheduled job refuses to run. " +
        "Retention purges and crisis-notification retries are not happening on this deployment.",
    );
    return false;
  }

  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!presented) return false;

  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  // `timingSafeEqual` throws on a length mismatch, and the throw itself would
  // leak the length, so lengths are compared first and the answer is fixed.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
