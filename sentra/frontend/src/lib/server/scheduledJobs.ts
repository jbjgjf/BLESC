/**
 * The work the scheduler triggers, separated from how it is triggered (#B3).
 *
 * Both jobs are reachable two ways: a POST to their own route with that
 * route's shared secret (any scheduler, and a human running one by hand), and a
 * GET to `/api/cron/*` with `CRON_SECRET`. The second exists because **Vercel
 * cron jobs can only send GET** — a `vercel.json` entry pointing at a
 * POST-only path silently runs that path's GET handler instead, which on
 * `/api/safety/dispatch` is the read-only health check. It would have returned
 * 200 every five minutes while delivering nothing.
 *
 * The runners live here so the two entry points cannot drift into doing
 * different work, which is the failure this whole file exists to avoid.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { deliverEscalation, type EscalationRow } from "./safetyEscalation";

/** How many to attempt per run. Bounded so one bad night cannot time out. */
const BATCH = 20;

/**
 * Give up paging after this many tries, and say so loudly.
 *
 * Not because the escalation stops mattering — it does not — but because a row
 * retried forever is a row nobody investigates. At this point the delivery has
 * failed for something like half an hour and the problem is the configuration,
 * not the network.
 *
 * A row in `no_recipient` does not consume attempts, so this bound does not
 * apply to it: it is waiting on configuration, not failing (#178).
 */
const MAX_ATTEMPTS = 6;

export type DispatchResult =
  | { ok: false; detail: string }
  | {
      ok: true;
      attempted: number;
      delivered: number;
      failed: number;
      no_recipient: number;
      stuck: number;
    };

export async function runSafetyDispatch(service: SupabaseClient): Promise<DispatchResult> {
  const pending = await service
    .from("safety_escalations")
    .select("id, owner_user_id, participant_id, risk_level, reasons, surface, detected_at, status, attempts")
    .in("status", ["pending", "failed", "no_recipient"])
    .lt("attempts", MAX_ATTEMPTS)
    .order("detected_at", { ascending: true })
    .limit(BATCH);

  if (pending.error) {
    console.error("[safety-dispatch] could not read the queue", pending.error.message);
    return { ok: false, detail: pending.error.message };
  }

  const rows = (pending.data ?? []) as EscalationRow[];

  // The participant code is what the message names, and it is not on the
  // escalation row — one lookup for the batch rather than one per row.
  const codes = new Map<string, string | null>();
  if (rows.length > 0) {
    const participants = await service
      .from("participants")
      .select("id, code")
      .in("id", Array.from(new Set(rows.map((row) => row.participant_id))));
    for (const row of (participants.data ?? []) as Array<{ id: string; code: string | null }>) {
      codes.set(row.id, row.code);
    }
  }

  const outcomes = { delivered: 0, failed: 0, no_recipient: 0 };
  for (const row of rows) {
    // Sequential, not `Promise.all`. The batch is small, the providers are rate
    // limited, and a burst that trips a rate limit turns a recoverable delay
    // into a wall of failures.
    const outcome = await deliverEscalation(service, row, codes.get(row.participant_id) ?? null);
    outcomes[outcome] += 1;
  }

  // Anything that has run out of attempts is a standing failure. Reported on
  // every run so it shows up in whatever watches this endpoint, rather than
  // waiting for someone to query the table.
  const exhausted = await service
    .from("safety_escalations")
    .select("id", { count: "exact", head: true })
    .in("status", ["pending", "failed", "no_recipient"])
    .gte("attempts", MAX_ATTEMPTS);
  const stuck = exhausted.count ?? 0;
  if (stuck > 0) {
    console.error(
      `[safety-dispatch] ${stuck} escalation(s) have exhausted their attempts and nobody has been told. ` +
        "Check SAFETY_ALERT_WEBHOOK_URL / RESEND_API_KEY and the oversight consent for those participants.",
    );
  }

  return { ok: true, attempted: rows.length, ...outcomes, stuck };
}

export type PurgeResult = { ok: false; detail: string } | { ok: true; purged: number };

/**
 * Delete the stored text whose retention window has closed.
 *
 * The `where` clause is not here. It lives in `purge_expired_raw_text()`, next
 * to the columns it nulls, so that the definition of "expired" cannot differ
 * between the thing that sets `raw_text_expires_at` and the thing that acts on
 * it.
 */
export async function runRetentionPurge(service: SupabaseClient): Promise<PurgeResult> {
  const result = await service.rpc("purge_expired_raw_text");

  if (result.error) {
    // Loud. A purge that has been failing for a week is a retention promise
    // that has been false for a week, and the only way anyone finds out is if
    // this is in the logs the monitor reads.
    console.error("[retention-purge] purge failed", result.error.message);
    return { ok: false, detail: result.error.message };
  }

  const purged = typeof result.data === "number" ? result.data : 0;
  console.info("[retention-purge] purged", { rows: purged });
  return { ok: true, purged };
}

/** How much text is being kept past what the student was told. */
export async function retentionOverdue(
  service: SupabaseClient,
): Promise<{ ok: false; detail: string } | { ok: true; overdue: number }> {
  const overdue = await service
    .from("entries")
    .select("id", { count: "exact", head: true })
    .not("raw_text_ciphertext", "is", null)
    .not("raw_text_expires_at", "is", null)
    .lte("raw_text_expires_at", new Date().toISOString());

  if (overdue.error) return { ok: false, detail: overdue.error.message };
  return { ok: true, overdue: overdue.count ?? 0 };
}
