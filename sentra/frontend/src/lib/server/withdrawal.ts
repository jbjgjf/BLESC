/**
 * Withdrawing from the research, one way (#263, #224).
 *
 * There used to be two withdrawals, and each did half the job:
 *
 *   `/pilot/join`「参加をやめる」 withdrew the enrollment. Consent stayed active,
 *   and the stored text stayed without anyone asking the participant.
 *
 *   `/consent`「同意を撤回」 revoked consent and purged text. The enrollment
 *   stayed `collecting`, so the journal and `POST /api/entries` stayed open.
 *   The dashboard counted zero withdrawals and kept scoring the missing days.
 *
 * Both routes now call `withdrawFromResearch`, which calls one SQL procedure,
 * `withdraw_from_research`. It withdraws every enrollment the participant
 * holds, appends a revoked consent row carrying their delete/keep choice, and
 * purges stored text on delete, in a single transaction. A partial withdrawal
 * therefore cannot exist. If the call fails nothing changed, and the caller
 * must say that rather than "撤回しました".
 *
 * The state design is in `docs/pilot/withdrawal.md`.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { CONSENT_DOCUMENT_VERSION, CONSENT_VERSION } from "../consent.ts";

/**
 * What happens to already-collected journal text (#224).
 *
 * `delete` destroys it now. `keep` leaves it until the ordinary retention
 * window closes and `purge_expired_raw_text()` takes it like any other row.
 *
 * **`keep` is not permission to keep using it.** Research analysis, export and
 * training use stop either way. The choice governs destruction only.
 */
export type RetainedDataDisposition = "delete" | "keep";

/**
 * Only the exact string `"keep"` keeps.
 *
 * Anything else (absent, misspelled, a boolean, a drifted client) reads as
 * `"delete"`. The two mistakes are not symmetric. Reading a garbled request as
 * "keep" retains text after a withdrawal that may well have meant "get rid of
 * it", which is the failure this exists to prevent. The SQL procedure applies
 * the same rule, so the two layers cannot disagree.
 */
export function parseDisposition(value: unknown): RetainedDataDisposition {
  return value === "keep" ? "keep" : "delete";
}

export type WithdrawalActor = "participant" | "guardian" | "operator";

export type WithdrawalResult =
  | {
      outcome: "withdrawn";
      /** Enrollments moved to `withdrawn` by this call. 0 for someone with none, or already withdrawn. */
      enrollmentsWithdrawn: number;
      disposition: RetainedDataDisposition;
      /** Entries whose stored text was destroyed. Always 0 for `keep`. */
      purgedRawText: number;
    }
  | {
      outcome: "not_withdrawn";
      /** For the log. Never shown to the participant. */
      reason: string;
    };

export async function withdrawFromResearch(
  client: SupabaseClient,
  params: {
    ownerUserId: string;
    participantId: string;
    disposition: RetainedDataDisposition;
    actor: WithdrawalActor;
    /** `consent_records.source`: which screen the participant used. */
    source: string;
    reason?: string;
  },
): Promise<WithdrawalResult> {
  const result = await client.rpc("withdraw_from_research", {
    p_owner_user_id: params.ownerUserId,
    p_participant_id: params.participantId,
    p_disposition: params.disposition,
    p_actor: params.actor,
    p_source: params.source,
    p_reason: params.reason ?? null,
    p_consent_version: CONSENT_VERSION,
    p_document_version: CONSENT_DOCUMENT_VERSION,
  });

  if (result.error) {
    return { outcome: "not_withdrawn", reason: result.error.message };
  }

  const row = (Array.isArray(result.data) ? result.data[0] : result.data) as
    | { enrollments_withdrawn?: number; disposition?: string; purged_raw_text?: number }
    | null
    | undefined;
  if (!row) return { outcome: "not_withdrawn", reason: "withdraw_from_research returned no row" };

  return {
    outcome: "withdrawn",
    enrollmentsWithdrawn: Number(row.enrollments_withdrawn ?? 0),
    disposition: parseDisposition(row.disposition),
    purgedRawText: Number(row.purged_raw_text ?? 0),
  };
}

/**
 * The response both routes give, so that the two screens cannot describe the
 * same withdrawal differently.
 *
 * On failure, `steps` says "not done" for every step, because the procedure is
 * one transaction and that is the truth. The message tells the participant
 * nothing changed and that they can try again.
 */
export function withdrawalResponseBody(result: WithdrawalResult) {
  if (result.outcome === "not_withdrawn") {
    return {
      status: "not_withdrawn" as const,
      steps: { enrollment: "not_done", consent: "not_done", raw_text: "not_done" } as const,
      detail: "撤回は完了していません。何も変更されていないので、もう一度お試しください。",
    };
  }
  return {
    status: "withdrawn" as const,
    steps: {
      enrollment: result.enrollmentsWithdrawn > 0 ? ("withdrawn" as const) : ("none_active" as const),
      consent: "revoked" as const,
      raw_text: result.disposition === "keep" ? ("kept" as const) : ("deleted" as const),
    },
    retained_data: result.disposition,
    // Reported next to an explicit `retained_data: "keep"`, so a caller cannot
    // mistake "kept" for "deleted zero".
    purged_raw_text: result.purgedRawText,
    enrollments_withdrawn: result.enrollmentsWithdrawn,
    detail:
      result.disposition === "keep"
        ? "研究への参加をやめ、同意を撤回しました。保存済みの本文は、保存期間が終わるまで残ります。研究には使われません。"
        : "研究への参加をやめ、同意を撤回しました。保存済みの本文は削除しました。",
  };
}
