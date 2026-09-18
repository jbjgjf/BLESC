/**
 * The body of the retry, separated from the route that exposes it.
 *
 * This lived inside `app/api/safety/dispatch/route.ts` until a scheduler had to
 * reach it by a second path. The split is not tidiness: a route module imports
 * `next/server`, which makes it unloadable outside a Next runtime, and the code
 * that decides whether a crisis gets retried should be runnable by executing
 * one file. `safetyEscalation.ts` is split from `api.ts` for the same reason and
 * says so at its own head.
 *
 * Nothing here knows about HTTP. The route hands it a client, it works the
 * queue, it returns counts.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { timingSafeEqual } from "node:crypto";
// The explicit extension is what lets `node --test` load this module directly,
// the same reason the rest of `src/lib` writes its relative imports this way.
import { deliverEscalation, type EscalationRow } from "./safetyEscalation.ts";

/** How many to attempt per run. Bounded so one bad night cannot time out. */
export const BATCH = 20;

/**
 * Give up paging after this many tries, and say so loudly.
 *
 * Not because the escalation stops mattering — it does not — but because a row
 * retried forever is a row nobody investigates. At this point the delivery has
 * failed for something like half an hour and the problem is the configuration,
 * not the network.
 */
export const MAX_ATTEMPTS = 6;

function constantTimeEquals(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  // `timingSafeEqual` throws on a length mismatch, which is itself a leak of
  // the length, so the lengths are compared first and the result is fixed.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * The secrets that may trigger a dispatch.
 *
 * Two, not one, and the second is the whole point of #179. A Vercel cron job
 * presents `Authorization: Bearer $CRON_SECRET` — that name is fixed by the
 * platform and is not ours to choose. Before this, the endpoint compared only
 * against `SAFETY_DISPATCH_TOKEN`, so an operator who followed the documented
 * cron configuration got a scheduler that authenticated against nothing it
 * held and was refused every five minutes.
 *
 * Accepting both is not a widening. Either value is a shared secret held by the
 * deployment; a caller who has one of them is the scheduler. What it removes is
 * the requirement that an operator know to set two variables to the same string
 * — a requirement that was written down nowhere and, when missed, failed by
 * going quiet rather than by complaining.
 */
function dispatchSecrets(): string[] {
  return [process.env.SAFETY_DISPATCH_TOKEN, process.env.CRON_SECRET].filter(
    (value): value is string => Boolean(value),
  );
}

/**
 * Whether a caller presenting this `Authorization` header may run the dispatch.
 *
 * A shared secret, compared in constant time. Not a user session: the caller is
 * a scheduler, and there is no person to sign in. No secret configured means the
 * endpoint refuses everything — a dispatcher anyone on the internet can trigger
 * is a way to make this deployment send mail on command.
 */
export function dispatchAuthorized(authorizationHeader: string | null): boolean {
  const expected = dispatchSecrets();
  if (expected.length === 0) return false;

  const header = authorizationHeader ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!presented) return false;

  // Every candidate is compared, and the loop is not short-circuited, so the
  // time taken does not say which of the two matched.
  let matched = false;
  for (const candidate of expected) {
    if (constantTimeEquals(presented, candidate)) matched = true;
  }
  return matched;
}

/** Whether any scheduler could authenticate at all, for the health probe. */
export function dispatchSecretConfigured(): boolean {
  return dispatchSecrets().length > 0;
}

export type DispatchOutcome = {
  attempted: number;
  delivered: number;
  failed: number;
  no_recipient: number;
  stuck: number;
};

/**
 * Work the queue once: every escalation still `pending` or `failed`, oldest
 * first, up to `BATCH`.
 */
export async function runSafetyDispatch(service: SupabaseClient): Promise<DispatchOutcome> {
  const pending = await service
    .from("safety_escalations")
    .select("id, owner_user_id, participant_id, risk_level, reasons, surface, detected_at, status, attempts")
    .in("status", ["pending", "failed"])
    .lt("attempts", MAX_ATTEMPTS)
    .order("detected_at", { ascending: true })
    .limit(BATCH);

  if (pending.error) {
    console.error("[safety-dispatch] could not read the queue", pending.error.message);
    throw new Error(pending.error.message);
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
