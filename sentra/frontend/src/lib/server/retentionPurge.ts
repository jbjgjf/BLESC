/**
 * Calling the purges, separately from the route that schedules them (#204).
 *
 * Lifted out of `/api/cron/retention-purge` for the reason `safetyDispatch.ts`
 * was lifted out of `/api/safety/dispatch`: a route module pulls in
 * `next/server`, which makes it unloadable outside a Next runtime, so the only
 * way to exercise it was to stand up the app. Nothing did, and the call that
 * makes the 90-day retention promise true shipped with no test at all.
 *
 * The route stays the door — authorisation, status codes, logging. This is the
 * part worth asserting on.
 *
 * Two purges, not one (#494). They share the schedule and nothing else: one
 * deletes retained journal text at its expiry, the other drops spent
 * rate-limit counters. Each is reported on its own, because a failure of the
 * second must not be read as a failure to delete a participant's text, and a
 * failure of the first must not stop the second from running.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export type PurgeResult = { purged: number } | { error: string };

/**
 * How many rows the function says it cleared.
 *
 * `purge_expired_raw_text()` is declared `returns integer`, and PostgREST hands
 * that back as a JSON number — so the happy path is a number and this coercion
 * is for everything else. It matters because the alternative to a number here
 * is not a crash: `Number(null)` is 0, `Number(undefined)` is NaN, and either
 * one would be reported to the operator as a purge that ran and found nothing.
 * "Nothing to delete" and "the call did not do what we think it did" must not
 * look the same on a dashboard whose whole job is to say whether retained text
 * is being deleted.
 *
 * So: a finite number is the count, and anything else is a failure with a
 * message, never a quiet zero.
 */
export function purgedCount(data: unknown): number | null {
  return typeof data === "number" && Number.isFinite(data) ? data : null;
}

export async function purgeExpiredRawText(service: SupabaseClient): Promise<PurgeResult> {
  // `purge_expired_raw_text()` is SECURITY INVOKER with EXECUTE granted only to
  // `service_role`, so it has to be called with the service key — and being
  // invoker rather than definer is what keeps it from ignoring RLS for anyone
  // else who reaches it.
  const { data, error } = await service.rpc("purge_expired_raw_text");

  if (error) {
    // Loud, because a purge that silently fails leaves text the participant was
    // told would be gone.
    console.error("[cron:retention] purge failed; retained text is past its expiry", error.message);
    return { error: error.message };
  }

  const purged = purgedCount(data);
  if (purged === null) {
    console.error(
      "[cron:retention] purge_expired_raw_text() did not return a count; " +
        "treating this as a failure rather than reporting a purge of zero",
      { received: typeof data },
    );
    return { error: "purge_expired_raw_text returned no count" };
  }

  if (purged > 0) console.info(`[cron:retention] purged ${purged} expired raw-text row(s)`);
  return { purged };
}

/**
 * Drop the rate-limit counters whose windows have closed (#494).
 *
 * `purge_rate_limit_counters()` has existed since 20260921000000, and that
 * migration's own retention note said it "is called by the existing retention
 * cron, so this table does not grow without bound and does not need its own
 * schedule". Nothing called it. `rate_limit_counters` takes a row per
 * `(bucket, window)` on every request to a limited route, so the claim was the
 * same shape as the one #185 found for `purge_expired_raw_text()`: a function
 * that was the contract, and no scheduler.
 *
 * Here rather than in its own cron because the migration's judgement about the
 * schedule was right — what was missing was the call. The `where window_start <
 * now() - interval '1 day'` bound lives in the function, so a run that happens
 * late or twice is harmless.
 *
 * **Not the same kind of promise as the raw-text purge.** Nothing in this table
 * is participant data — the identifier is a user id or a hashed address — so a
 * failure here is housekeeping that did not happen, not text somebody was told
 * would be gone. It is still reported rather than swallowed, for the reason
 * `purgedCount` exists: a count that cannot be read must not arrive as a zero.
 */
export async function purgeRateLimitCounters(service: SupabaseClient): Promise<PurgeResult> {
  const { data, error } = await service.rpc("purge_rate_limit_counters");

  if (error) {
    console.error("[cron:retention] rate-limit counter purge failed; the table keeps growing", error.message);
    return { error: error.message };
  }

  const purged = purgedCount(data);
  if (purged === null) {
    console.error(
      "[cron:retention] purge_rate_limit_counters() did not return a count; " +
        "treating this as a failure rather than reporting a purge of zero",
      { received: typeof data },
    );
    return { error: "purge_rate_limit_counters returned no count" };
  }

  if (purged > 0) console.info(`[cron:retention] purged ${purged} spent rate-limit counter row(s)`);
  return { purged };
}
