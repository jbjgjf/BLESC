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
