/**
 * Whether the terms and the privacy policy are in force, and from when.
 *
 * Both documents on `/legal` are headed 「（案）」 with 「施行日・承認日：未設定」,
 * and the page says out loud that reading them is not agreement. That is honest
 * and it is also a dead end: there was no way to enact them, no effective date
 * to enact them *from*, and nowhere to record that a person accepted a
 * particular version at a particular moment.
 *
 * This is the same shape as `consentDocument.ts`, deliberately. Enactment is:
 *
 *   - **a deployment decision with a date on it**, read from the environment,
 *     not a commit that takes effect wherever it lands;
 *   - **refused while the documents still read as drafts**, so turning it on is
 *     a decision somebody has to complete rather than one they make by typing a
 *     string (`tests/legal-enactment.test.mjs` enforces this);
 *   - **paired with a record**, because a policy in force that nobody accepted
 *     is a policy nobody is bound by.
 *
 * What it is not: an approval. Setting the variable does not mean counsel
 * reviewed anything. It means someone who is accountable for that review has
 * said it happened, and the date is the claim they are making.
 */

/** The version string that the enacted documents carry. */
export const LEGAL_ENACTED_VERSION = "legal-2026-10-01-v1";

/**
 * The effective date, as the deployment declares it.
 *
 * `YYYY-MM-DD`, in JST — the documents are Japanese and the date is a Japanese
 * legal effective date, so resolving it in the viewer's timezone would make the
 * policy come into force on different days for different people.
 */
export function legalEffectiveDate(): string | null {
  const raw = process.env.NEXT_PUBLIC_LEGAL_EFFECTIVE_DATE?.trim();
  if (!raw) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

/**
 * Whether this build treats the terms and policy as in force.
 *
 * Needs both halves: the version the deployment claims to enact, and the date
 * it takes effect. A version with no date cannot be shown to anyone as binding,
 * and a date with no version does not say binding *to what*.
 */
export function legalEnacted(): boolean {
  return (
    process.env.NEXT_PUBLIC_LEGAL_ENACTED === LEGAL_ENACTED_VERSION &&
    legalEffectiveDate() !== null
  );
}

/** What the documents call themselves: a draft until enacted. */
export function legalDocumentLabel(base: string): string {
  return legalEnacted() ? base : `${base}（案）`;
}

/** The version stamped onto an acceptance row written by this build. */
export function currentLegalVersion(): string {
  return legalEnacted() ? LEGAL_ENACTED_VERSION : `${LEGAL_ENACTED_VERSION}-draft`;
}
