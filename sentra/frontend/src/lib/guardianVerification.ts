/**
 * What a guardian is asked, and who is allowed to answer it (#164).
 *
 * Pure, shared by the participant's screen, the guardian's screen and the two
 * route handlers, so that "a minor cannot confirm their own guardian consent"
 * is written down once instead of being an emergent property of four files.
 *
 * The rule this module exists to keep: **`guardian_consent` is never a value
 * the participant's session can supply.** It arrives from a token that was
 * presented on a different request, without that session, and everything here
 * is arranged so that a caller who wants to bypass it has to bypass the token,
 * not a boolean.
 */

import type { ConsentGrants, ConsentState } from "@/lib/consent";
import type { PilotEnrollment } from "@/lib/pilotEnrollment";

/**
 * How long a link is good for.
 *
 * 72 hours, not 24: the participant is a student who will hand this to a parent
 * in the evening, and a link that expires before the weekend is over turns a
 * consent step into a support call. Not 30 days either — an unbounded link is a
 * credential sitting in a message thread, and the guardian who never used it is
 * the one whose child never enrolled, which the operator should see rather than
 * discover in week three.
 */
export const GUARDIAN_TOKEN_TTL_HOURS = 72;

/** The optional grants a guardian is shown and asked to approve. */
export const GUARDIAN_REVIEWABLE_GRANTS = [
  "anonymized_export",
  "raw_text_retention",
  "future_fine_tuning",
] as const;

export type GuardianReviewableGrant = (typeof GUARDIAN_REVIEWABLE_GRANTS)[number];

/**
 * The participant's choices, held until a guardian answers.
 *
 * `research_analysis` is not in here and is not optional: it is what the study
 * is, and a participant who declines it is declining to take part rather than
 * configuring their participation. The three that are here are the ones the
 * consent document presents as separable.
 */
export type RequestedGrants = {
  [K in GuardianReviewableGrant]: boolean;
} & {
  document_version: string;
};

export function normalizeRequestedGrants(value: unknown, documentVersion: string): RequestedGrants {
  const source = (value ?? {}) as Record<string, unknown>;
  const grants = {} as RequestedGrants;
  for (const key of GUARDIAN_REVIEWABLE_GRANTS) {
    grants[key] = source[key] === true;
  }
  grants.document_version =
    typeof source.document_version === "string" && source.document_version ? source.document_version : documentVersion;
  return grants;
}

/**
 * Whether this enrollment needs a guardian at all.
 *
 * `is_minor` comes from the enrollment row, which was set at redemption from
 * the age band the coordinator configured — not from anything the participant
 * can edit afterwards. An adult is not asked for a guardian and is not shown
 * the step (#164: 生年月日の過剰収集を避ける).
 */
export function guardianRequired(enrollment: PilotEnrollment): boolean {
  return enrollment.is_minor === true;
}

/**
 * Whether a verification may be issued for this enrollment right now.
 *
 * Only at `participant_assented`: earlier and the guardian would be asked to
 * approve something the participant has not yet agreed to themselves, which
 * inverts the order the consent document describes; later and the guardian has
 * already answered.
 */
export function canRequestGuardianVerification(enrollment: PilotEnrollment): boolean {
  return guardianRequired(enrollment) && enrollment.state === "participant_assented";
}

/** The states a stored verification can be in, as a screen needs to say it. */
export type GuardianVerificationStatus =
  | "none"
  | "pending"
  | "expired"
  | "confirmed"
  | "declined"
  | "revoked";

export type GuardianVerificationRow = {
  expires_at: string;
  claimed_at: string | null;
  decision: "confirmed" | "declined" | null;
  decided_at: string | null;
  revoked_at: string | null;
};

/**
 * Read a stored row as a status.
 *
 * Order matters and is not arbitrary: a decision outlives both revocation and
 * expiry. A guardian who confirmed on the last hour of the third day confirmed,
 * and a row that reported "expired" afterwards would lose a consent that was
 * actually given.
 */
export function guardianVerificationStatus(
  row: GuardianVerificationRow | null,
  now: Date = new Date(),
): GuardianVerificationStatus {
  if (!row) return "none";
  if (row.decision === "confirmed") return "confirmed";
  if (row.decision === "declined") return "declined";
  if (row.revoked_at) return "revoked";
  if (Date.parse(row.expires_at) <= now.getTime()) return "expired";
  return "pending";
}

/** Whether a token in this state may still be presented. */
export function guardianTokenUsable(row: GuardianVerificationRow | null, now: Date = new Date()): boolean {
  return guardianVerificationStatus(row, now) === "pending";
}

/**
 * The consent record written when a guardian confirms.
 *
 * Built here rather than in the route so that the one place a
 * `guardian_consent: true` is ever produced is a function whose inputs are a
 * *token row* and the participant's stored record — never a request body.
 *
 * `minor_assent` is carried from the participant's own record rather than set:
 * the guardian is confirming their child's participation, not asserting that
 * the child assented. If the assent record is missing, this produces a row that
 * the enrollment gate will refuse, which is the correct outcome and a visible
 * one.
 */
export function guardianConsentGrant(
  requested: RequestedGrants,
  participantRecord: ConsentState,
): ConsentGrants & { minor_assent: boolean; guardian_consent: boolean; document_version: string } {
  return {
    app_use: participantRecord.app_use === true,
    research_analysis: true,
    anonymized_export: requested.anonymized_export === true,
    raw_text_retention: requested.raw_text_retention === true,
    future_fine_tuning: requested.future_fine_tuning === true,
    minor_assent: participantRecord.minor_assent === true,
    guardian_consent: true,
    document_version: requested.document_version,
  };
}

/**
 * What the participant's own consent write may contain.
 *
 * Two removals, both deliberate:
 *
 *   - `guardian_consent` is dropped unconditionally. Not "dropped for minors":
 *     there is no request through the participant's session that should ever
 *     set it, and a rule with an exception is a rule someone will find the
 *     exception to.
 *
 *   - `research_analysis` is held back while a guardian is required and has not
 *     confirmed. The write path gates research mirrors on that flag alone, so
 *     storing the participant's intention there before the guardian answers
 *     would collect from a minor on the strength of the minor's own agreement.
 *     The intention is held on the verification row instead and becomes a
 *     consent record when the guardian confirms.
 */
export function participantConsentGrant(
  requested: Record<string, unknown>,
  options: { guardianRequired: boolean; guardianConfirmed: boolean },
): ConsentGrants & { minor_assent: boolean; guardian_consent: boolean } {
  const wantsResearch = requested.research_analysis === true;
  const researchAllowed = !options.guardianRequired || options.guardianConfirmed;

  return {
    app_use: requested.app_use === true,
    research_analysis: wantsResearch && researchAllowed,
    anonymized_export: requested.anonymized_export === true && researchAllowed,
    raw_text_retention: requested.raw_text_retention === true && researchAllowed,
    future_fine_tuning: requested.future_fine_tuning === true && researchAllowed,
    minor_assent: requested.minor_assent === true,
    // Never from the caller. See the header.
    guardian_consent: options.guardianConfirmed,
  };
}

/**
 * What the participant's screen shows while the guardian has not answered.
 *
 * Every one of these is a normal step in a normal flow. None of them is phrased
 * as an error, and none of them asks the participant to persuade anyone — a
 * declined verification ends with how to reach the study team, not with a
 * button that sends the guardian another link (#164: 同意を断っても圧力をかける
 * 表示や偽のエラーを出さない).
 */
export const GUARDIAN_STATUS_MESSAGE: Record<GuardianVerificationStatus, string> = {
  none: "保護者の方に確認をお願いする準備ができています。",
  pending: "保護者の方の確認をお待ちしています。確認が終わると、この画面が進みます。",
  expired: "確認用リンクの有効期限が切れました。新しいリンクを発行できます。",
  confirmed: "保護者の方の確認が完了しました。",
  declined: "保護者の方は、今回は参加に同意されませんでした。ご相談は研究担当までご連絡ください。",
  revoked: "このリンクは無効になりました。新しいリンクを発行できます。",
};
