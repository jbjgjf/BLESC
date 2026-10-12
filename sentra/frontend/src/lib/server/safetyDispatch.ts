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
  /**
   * Escalations that have exhausted their attempts and reached nobody — the
   * number the five-minute workflow warns on. `null` when the count could not
   * be read (#377): this run's sends are done and reported above, but nothing
   * is known about the standing failures, and that must not arrive as `0`.
   * `stuck_error` then says why.
   */
  stuck: number | null;
  stuck_error?: string;
};

export async function dispatchPendingEscalations(
  service: SupabaseClient,
  /** Replaceable so a test can see what a run would send, and to whom. */
  deliver: typeof deliverEscalation = deliverEscalation,
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
    /*
     * A failed lookup stops the run before anything is sent (#377). Without
     * the code every message in the batch reads 「担当している生徒のひとり」 —
     * a page at 02:00 that names nobody — and because the send itself
     * succeeds, the row becomes `delivered` and is never retried. Leaving the
     * batch queued costs five minutes; sending it costs the alert.
     */
    if (participants.error) {
      console.error(
        "[safety-dispatch] could not read participant codes; nothing was sent and the batch stays queued",
        participants.error.message,
      );
      return { error: participants.error.message };
    }
    for (const row of (participants.data ?? []) as Array<{ id: string; code: string | null }>) {
      codes.set(row.id, row.code);
    }
    // Not the same thing as the failure above: the lookup worked and these
    // participants are not in it. Their rows are still owed, so they go out
    // with the wording for a row that has no code — and it is said here,
    // because a codeless alert should be traceable to a reason.
    const unnamed = rows.filter((row) => !codes.has(row.participant_id));
    if (unnamed.length > 0) {
      console.warn(
        `[safety-dispatch] ${unnamed.length} escalation(s) name a participant the lookup did not return; sending them without a participant code`,
        { escalations: unnamed.map((row) => row.id) },
      );
    }
  }

  const outcomes = { delivered: 0, failed: 0, no_recipient: 0, pending: 0 };
  for (const row of rows) {
    // Sequential, not `Promise.all`. The batch is small, the providers are rate
    // limited, and a burst that trips a rate limit turns a recoverable delay
    // into a wall of failures.
    const outcome = await deliver(service, row, codes.get(row.participant_id) ?? null);
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
  // A number is the count; anything else is "not known", never a quiet zero
  // (the rule `retentionPurge.ts` applies to `purgedCount`), and `readCount`
  // below is now the one place that rule is written.
  const stuck = readCount(exhausted);
  if (stuck === null) {
    const reason = exhausted.error?.message ?? "no_count_returned";
    console.error(
      "[safety-dispatch] could not count exhausted escalations; reporting stuck as unknown, not 0",
      reason,
    );
    return { attempted: rows.length, ...outcomes, stuck: null, stuck_error: reason };
  }
  if (stuck > 0) {
    console.error(
      `[safety-dispatch] ${stuck} escalation(s) have exhausted their attempts and nobody has been told. ` +
        "Check SAFETY_ALERT_WEBHOOK_URL / RESEND_API_KEY and the oversight consent for those participants.",
    );
  }

  return { attempted: rows.length, ...outcomes, stuck };
}

/**
 * A count that may be unknown, read the one way that cannot turn "unknown"
 * into a reassuring number (#377, #453).
 *
 * `null` and `undefined` are both unknown, and so is a boolean — `typeof true`
 * is not `"number"`, but `Number(true)` is 1, and a coercion is how a missing
 * count becomes a count. Only a finite, non-negative integer is a count.
 *
 * The same rule `purgedCount` applies in `retentionPurge.ts`, and the same one
 * `dispatchPendingEscalations` applies to `stuck` above. It is here as a
 * function because the self-report endpoint needs it too, and the two had
 * drifted: `GET /api/safety/dispatch` was reporting `owed: count ?? 0` without
 * looking at `error`, so a failed read answered "nothing is owed" — in the
 * endpoint whose stated job is to make a gap visible rather than assumed away.
 */
export function readCount(result: {
  error?: { message: string } | null;
  count?: number | null;
}): number | null {
  if (result.error) return null;
  const count = result.count;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0) return null;
  return count;
}

/**
 * What a reader of a dispatch result has to be told, in sentences.
 *
 * The five-minute workflow (`.github/workflows/safety-dispatch.yml`) used to
 * decide this itself, in two shell one-liners:
 *
 *     if [ "$(python3 -c "…get('stuck',0)")" != "0" ]; then …exhausted their retries…
 *
 * `dict.get(key, 0)` substitutes for a **missing** key, not for a JSON `null`,
 * so once `stuck` became `number | null` (#377) an unreadable count arrived as
 * `None`, compared unequal to `"0"`, and raised the warning for the other
 * condition: "escalations have exhausted their retries" when in fact nothing
 * was known about them. `stuck_error`, which says why, was never printed.
 *
 * So the three states are told apart here, where the types are, and the
 * workflow prints what it is handed. Nothing is said when there is nothing to
 * act on: 288 runs a day means a line that is always there is a line nobody
 * reads.
 */
export function dispatchAttention(result: DispatchResult): string[] {
  const lines: string[] = [];

  if (result.stuck === null) {
    lines.push(
      "再送を使い切った escalation の件数が読めませんでした" +
        `（${result.stuck_error ?? "理由は記録されていません"}）。` +
        "この実行の送信結果は報告されていますが、滞留している件数は不明です。0件ではありません。",
    );
  } else if (result.stuck > 0) {
    lines.push(
      `${result.stuck} 件の escalation が再送を使い切り、誰にも届いていません。` +
        "SAFETY_ALERT_WEBHOOK_URL / RESEND_API_KEY と、該当する参加者の見守り同意を確認してください。",
    );
  }

  if (result.pending > 0) {
    lines.push(
      `${result.pending} 件の escalation が誰にも届かず、待ち行列に残りました。` +
        "SAFETY_ALERT_WEBHOOK_URL / RESEND_API_KEY と、名簿の教職員にメールアドレスがあるかを確認してください。",
    );
  }

  return lines;
}
