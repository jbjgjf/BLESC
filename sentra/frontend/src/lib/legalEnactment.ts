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

/**
 * The documents a person can accept. Research consent is not among them: it is
 * recorded in `consent_records`, by a different screen, under different rules.
 */
export const LEGAL_ACCEPTABLE_DOCUMENTS = ["terms", "privacy"] as const;
export type LegalAcceptableDocument = (typeof LEGAL_ACCEPTABLE_DOCUMENTS)[number];

export function isLegalAcceptableDocument(value: unknown): value is LegalAcceptableDocument {
  return typeof value === "string" && (LEGAL_ACCEPTABLE_DOCUMENTS as readonly string[]).includes(value);
}

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

/**
 * What the terms and the privacy policy call themselves: a draft until enacted.
 *
 * This existed with no callers while every title in `legalDocuments.ts` carried
 * a hard-coded 「（案）」 and the page headed itself 「確認用草案」 unconditionally.
 * So the notice at the top of `/legal` switched on enactment and the headings
 * under it did not — one screen naming itself two ways, which is the thing the
 * page's own comment says it must not do. `documentHeading()` in
 * `legalDocuments.ts` is the caller.
 */
export function legalDocumentLabel(base: string): string {
  return legalEnacted() ? base : `${base}（案）`;
}

/**
 * The version string the terms and the privacy policy *display*.
 *
 * It has to be the version an acceptance row would be stamped with, because
 * that record is worth something only if it names the text the person read —
 * which is why `POST /api/legal/acceptance` refuses to take a version from the
 * request. A page headed `legal-review-2026-09-14-v1` that writes
 * `legal-2026-10-01-v1` reintroduces the same gap through the other side.
 *
 * `draftVersion` rather than a constant: while unenacted the page keeps naming
 * the draft it is actually showing, and nothing is recorded at all (the route
 * answers 409). The switch only has to be true at the moment a row can exist.
 */
export function legalDisplayVersion(draftVersion: string): string {
  return legalEnacted() ? LEGAL_ENACTED_VERSION : draftVersion;
}

/** The version stamped onto an acceptance row written by this build. */
export function currentLegalVersion(): string {
  return legalEnacted() ? LEGAL_ENACTED_VERSION : `${LEGAL_ENACTED_VERSION}-draft`;
}
