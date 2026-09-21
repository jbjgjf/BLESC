/**
 * Draining the escalation queue.
 *
 * Lifted out of `/api/safety/dispatch` when the Vercel cron entry needed the
 * same work (#179). Vercel Cron only issues `GET` with a `CRON_SECRET` bearer
 * token, and that route is a `POST` behind its own shared secret, so a second
 * entry point was unavoidable — but two copies of the loop that decides whether
 * a crisis reaches a person is not. The routes are now two doors onto this.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
// Relative, with the extension, for the reason `pilotOps.ts` gives: the unit
// tests load these files directly under node, which does not resolve the `@/`
// alias for anything that is not a type-only import. This module was lifted
// out of the route so the loop could be exercised without a Next runtime, and
// an aliased value import is what kept it from actually being exercised.
import { deliverEscalation, type EscalationRow } from "./safetyEscalation.ts";

/** How many to attempt per run. Bounded so one bad night cannot time out. */
export const BATCH = 20;

/**
 * Give up paging after this many tries, and say so loudly.
 *
 * Not because the escalation stops mattering — it does not — but because a row
 * retried forever is a row nobody investigates. By this point delivery has been
 * failing for something like half an hour and the problem is the configuration,
 * not the network.
 */
export const MAX_ATTEMPTS = 6;

export type DispatchResult = {
  attempted: number;
  delivered: number;
  failed: number;
  no_recipient: number;
  /**
   * Reached nobody and left queued, because nothing could be attempted: no
   * channel is configured on this deployment (#178), or the educators who hold
   * consent have no address the configured channels can reach (#203).
   *
   * Distinct from `no_recipient`, which is terminal: these rows are still owed,
   * and the next run after somebody closes the gap will send them.
   */
  pending: number;
  stuck: number;
};

export async function dispatchPendingEscalations(
  service: SupabaseClient,
): Promise<DispatchResult | { error: string }> {
  /*
   * Least-recently-attempted first, and only then oldest-first (#203).
   *
   * `detected_at` alone was safe while every queued row was eventually either
   * delivered or exhausted: `attempts` climbed, and `.lt("attempts", …)` took
   * the row out of this query. Rows that reach nobody *without attempting
   * anything* do not climb — deliberately, so an idle misconfiguration does
   * not burn a retry budget meant for transport failures — and once there are
   * `BATCH` of them they are permanently the oldest `BATCH` rows in the queue.
   * Every run would then select the same twenty, attempt nothing, and never
   * reach a newer crisis whose educator does have an address.
   *
   * That could not happen while the only such rows came from `noChannel`,
   * because then nothing was deliverable anyway and there was nothing to
   * starve. Recipients with no address (#203) are the case where blocked and
   * deliverable rows coexist, so the queue has to rotate.
   *
   * `last_attempt_at` is stamped on every pass through `deliverEscalation`,
   * including the passes that send nothing, so this rotates the batch. Nulls
   * first keeps the ordering the thing it was: a row nobody has looked at yet
   * — a crisis recorded a minute ago — sorts ahead of anything already tried.
   */
  const pending = await service
    .from("safety_escalations")
    .select("id, owner_user_id, participant_id, risk_level, reasons, surface, detected_at, status, attempts")
    .in("status", ["pending", "failed"])
    .lt("attempts", MAX_ATTEMPTS)
    .order("last_attempt_at", { ascending: true, nullsFirst: true })
    .order("detected_at", { ascending: true })
    .limit(BATCH);

  if (pending.error) {
    console.error("[safety-dispatch] could not read the queue", pending.error.message);
    return { error: pending.error.message };
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

  const outcomes = { delivered: 0, failed: 0, no_recipient: 0, pending: 0 };
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
    .in("status", ["pending", "failed"])
    .gte("attempts", MAX_ATTEMPTS);
  const stuck = exhausted.count ?? 0;
  if (stuck > 0) {
    console.error(
      `[safety-dispatch] ${stuck} escalation(s) have exhausted their attempts and nobody has been told. ` +
        "Check SAFETY_ALERT_WEBHOOK_URL / RESEND_API_KEY and the oversight consent for those participants.",
    );
  }

  return { attempted: rows.length, ...outcomes, stuck };
}
