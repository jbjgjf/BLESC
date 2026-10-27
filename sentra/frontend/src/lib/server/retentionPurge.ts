/**
 * Calling the purge, separately from the route that schedules it (#204).
 *
 * Lifted out of `/api/cron/retention-purge` for the reason `safetyDispatch.ts`
 * was lifted out of `/api/safety/dispatch`: a route module pulls in
 * `next/server`, which makes it unloadable outside a Next runtime, so the only
 * way to exercise it was to stand up the app. Nothing did, and the call that
 * makes the 90-day retention promise true shipped with no test at all.
 *
 * The route stays the door — authorisation, status codes, logging. This is the
 * part worth asserting on.
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
 * Clearing expired rate-limit windows (#494).
 *
 * `20260921000000_rate_limit_counters.sql` said this table "is called by the
 * existing retention cron, so this table does not grow without bound and does
 * not need its own schedule". Nothing called it: the retention cron only ever
 * ran `purge_expired_raw_text()`. The judgement that it needs no schedule of
 * its own stands; what was missing was the call, and it is here.
 *
 * Same rules as the raw-text purge: a count is a finite number, anything else
 * is a failure with a message, never a quiet zero. Like
 * `purge_expired_raw_text()`, the function is SECURITY INVOKER with EXECUTE
 * granted only to `service_role`.
 */
export async function purgeRateLimitCounters(service: SupabaseClient): Promise<PurgeResult> {
  let data: unknown;
  let error: { message: string } | null;
  try {
    ({ data, error } = await service.rpc("purge_rate_limit_counters"));
  } catch (thrown) {
    error = { message: thrown instanceof Error ? thrown.message : String(thrown) };
  }

  if (error) {
    console.error("[cron:retention] rate-limit counter purge failed", error.message);
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

  if (purged > 0) console.info(`[cron:retention] purged ${purged} expired rate-limit window(s)`);
  return { purged };
}

export type RetentionRun = {
  /** The heavier promise: decides the route's status. */
  rawText: PurgeResult;
  rateLimitCounters: PurgeResult;
};

/**
 * Everything the retention cron runs, each reported on its own (#494).
 *
 * The two calls are independent. A failed raw-text purge does not skip the
 * counters, and a failed counter purge does not hide or change the raw-text
 * result, which is the promise made to participants and so the one the
 * route's status follows.
 */
export async function runRetentionPurge(service: SupabaseClient): Promise<RetentionRun> {
  let rawText: PurgeResult;
  try {
    rawText = await purgeExpiredRawText(service);
  } catch (thrown) {
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    console.error("[cron:retention] purge failed; retained text is past its expiry", message);
    rawText = { error: message };
  }
  const rateLimitCounters = await purgeRateLimitCounters(service);
  return { rawText, rateLimitCounters };
}
