/**
 * Leaving the study, as one act (#263).
 *
 * Withdrawal used to be two half-measures that did not know about each other:
 *
 *   - `/pilot/join`「参加をやめる」 moved `pilot_enrollments` to `withdrawn`
 *     and left the consent record granting research use, with the retained
 *     journal text sitting in `entries.raw_text_ciphertext` until its ordinary
 *     expiry. Nobody asked the participant what should happen to it — the
 *     「残す／削除する」 choice #224 built lives on the other screen.
 *   - `/consent`「同意を撤回する」 wrote the revocation and purged the text and
 *     never touched the enrollment, so the participant stayed `collecting`:
 *     `pilotGate` kept letting them into `/journal`, the dashboard kept
 *     counting them as someone who owed a daily entry, and its `withdrawn`
 *     count stayed at zero.
 *
 * So neither screen could finish the thing it said it was doing. This module is
 * the whole act, and both screens call it.
 *
 * ## Three steps, none of which may abort the others
 *
 *   1. **Revoke consent.** Research use and training use stop.
 *   2. **Withdraw every live enrollment.** Collection stops, and the
 *      participant stops being counted as one.
 *   3. **Act on the retained text** — destroy it, or leave it to its ordinary
 *      retention window, according to what the participant chose.
 *
 * They run in that order because the two that *stop* something are reversible
 * in the only sense that matters — they can be retried — and the one that
 * destroys is not. A failure in step 3 must not leave collection running.
 *
 * Nothing here throws. A participant who has said they want to leave is not
 * served by a request that fails on step 1 and never attempts steps 2 and 3;
 * every step is attempted, each outcome is reported separately, and `complete`
 * says whether the act finished. The caller answers with what actually
 * happened rather than with the word "withdrawn" over a partial result.
 *
 * ## What `keep` does not mean
 *
 * `consentStore.ts` says it and it is worth saying twice: `keep` governs
 * destruction only. It does not resume collection, does not re-open the export
 * gate and does not permit training use. Withdrawal is withdrawal either way.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
// Relative, with the extension, for the reason `safetyDispatch.ts` gives: the
// unit tests load these files directly under node, which does not resolve the
// `@/` alias for anything that is not a type-only import. The step that decides
// whether a participant has actually left should be exercisable by running one
// file, not by standing up the app.
import { revokeConsent, type RetainedDataDisposition } from "./consentStore.ts";
import { advanceEnrollment, loadLiveEnrollmentsForParticipant } from "./pilotStore.ts";
import type { ConsentState } from "../consent.ts";

export type WithdrawalActor = "participant" | "operator" | "system" | "guardian";

export type WithdrawalResult = {
  /** The revocation row, and the consent state after it. */
  consent:
    | { outcome: "revoked"; state: ConsentState }
    | { outcome: "failed"; state: null; error: string };
  /**
   * What happened to the participation itself.
   *
   * `none` means there was no live enrollment to withdraw — an ordinary
   * deployment with no study, or someone who had already left. It is not a
   * failure: the participant has still revoked consent, and reporting "failed"
   * here would tell them something went wrong when nothing did.
   */
  enrollment: {
    outcome: "withdrawn" | "none" | "failed";
    /** Enrollment ids that reached `withdrawn` in this call. */
    withdrawn: string[];
    /** Enrollment ids that were asked and did not. */
    failed: string[];
  };
  retained_data: RetainedDataDisposition;
  raw_text:
    | { outcome: "purged"; purged: number | null }
    | { outcome: "kept"; purged: 0 }
    | { outcome: "failed"; purged: null; error: string };
  /** Every step did what it was asked to do. */
  complete: boolean;
};

/**
 * How many rows the purge says it cleared.
 *
 * `purge_raw_text_for_participant` returns an integer, so the happy path is a
 * number and this is for everything else. `Number(null)` is 0 and
 * `Number(undefined)` is NaN, and either one reported as a count would tell a
 * participant their text was deleted on the strength of a call that did not
 * say so. Same rule, and the same reason, as `retentionPurge.purgedCount`.
 */
export function purgedRawTextCount(data: unknown): number | null {
  return typeof data === "number" && Number.isFinite(data) ? data : null;
}

export async function withdrawParticipation(
  service: SupabaseClient,
  params: {
    ownerUserId: string;
    participantId: string;
    /** What the participant chose for text already collected. */
    disposition: RetainedDataDisposition;
    /** Who performed it. Recorded on the enrollment event. */
    actor: WithdrawalActor;
    /** Recorded on the consent row. Which screen this came from. */
    source: string;
    reason?: string;
  },
): Promise<WithdrawalResult> {
  const { ownerUserId, participantId, disposition, actor, source, reason } = params;

  // ---- 1. Consent -------------------------------------------------------
  let consent: WithdrawalResult["consent"];
  try {
    consent = {
      outcome: "revoked",
      state: await revokeConsent(service, ownerUserId, participantId, source, disposition),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[withdrawal] consent revocation failed", { participant: participantId, message });
    consent = { outcome: "failed", state: null, error: message };
  }

  // ---- 2. Participation -------------------------------------------------
  //
  // Every live enrollment, not the newest one. `advance_pilot_enrollment`
  // treats withdrawal as legal from any state and terminal, so this is safe to
  // repeat and safe to run against a row a bug left somewhere unexpected.
  const live = await loadLiveEnrollmentsForParticipant(service, ownerUserId, participantId);
  const withdrawn: string[] = [];
  const failed: string[] = [];
  for (const enrollment of live) {
    const result = await advanceEnrollment(service, {
      enrollmentId: enrollment.id,
      ownerUserId,
      to: "withdrawn",
      actor,
      reason,
    });
    // `terminal` means it was already withdrawn or completed between the read
    // and the write. The participant is out either way, which is what was
    // asked for, so it is not a failure.
    if (result.outcome === "ok" || result.outcome === "terminal") withdrawn.push(enrollment.id);
    else failed.push(enrollment.id);
  }

  const enrollment: WithdrawalResult["enrollment"] =
    failed.length > 0
      ? { outcome: "failed", withdrawn, failed }
      : live.length === 0
        ? { outcome: "none", withdrawn: [], failed: [] }
        : { outcome: "withdrawn", withdrawn, failed: [] };

  // ---- 3. Retained text -------------------------------------------------
  let rawText: WithdrawalResult["raw_text"];
  if (disposition === "keep") {
    rawText = { outcome: "kept", purged: 0 };
  } else {
    const purge = await service.rpc("purge_raw_text_for_participant", {
      target_participant: participantId,
    });
    if (purge.error) {
      console.error("[withdrawal] raw text purge failed after revocation", {
        participant: participantId,
        message: purge.error.message,
      });
      rawText = { outcome: "failed", purged: null, error: purge.error.message };
    } else {
      rawText = { outcome: "purged", purged: purgedRawTextCount(purge.data) };
    }
  }

  return {
    consent,
    enrollment,
    retained_data: disposition,
    raw_text: rawText,
    complete:
      consent.outcome === "revoked" &&
      enrollment.outcome !== "failed" &&
      rawText.outcome !== "failed",
  };
}

/**
 * What to tell the participant.
 *
 * Written here rather than in each route so the two screens cannot describe the
 * same outcome differently — which is how the split this module closes went
 * unnoticed for as long as it did. A partial result never says 「撤回しました」
 * on its own: it names what did not happen, because the participant is the one
 * who has to decide whether to try again.
 */
export function withdrawalMessage(result: WithdrawalResult): string {
  if (!result.complete) {
    const unfinished: string[] = [];
    if (result.consent.outcome === "failed") unfinished.push("同意の撤回");
    if (result.enrollment.outcome === "failed") unfinished.push("研究への参加の停止");
    if (result.raw_text.outcome === "failed") unfinished.push("保管していた本文の削除");
    return `手続きの一部が完了していません（${unfinished.join("・")}）。もう一度お試しください。`;
  }

  return result.retained_data === "keep"
    ? "研究への参加をやめました。保管していた日記の本文は、保存期間が終わるまで残ります。研究には使われません。"
    : "研究への参加をやめました。保管していた日記の本文は削除されました。";
}
