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
 *
 * ## Three states, not two (#282)
 *
 * The date used to be checked for its *shape* and never against the calendar,
 * so `legalEnacted()` answered "is there a date" rather than "has it arrived".
 * A deployment configured ahead of its own effective date therefore dropped
 * 「（案）」 from the page and accepted agreements to a document that was not yet
 * in force — into `legal_acceptances`, which has no UPDATE and no DELETE policy
 * by design, so those rows could not afterwards be corrected.
 *
 * So there are three states and the middle one is real:
 *
 *   `draft`      no version, no date, or a date that is not a date.
 *   `scheduled`  both halves present, and the day has not arrived.
 *   `in_force`   both halves present, and it has.
 *
 * `scheduled` is not `draft`. 「まだ決まっていない」 and 「決まっているが、まだ
 * その日ではない」 are different things to tell a participant, and only the
 * second one has a date to show them.
 */

/** The version string that the enacted documents carry. */
export const LEGAL_ENACTED_VERSION = "legal-2026-10-01-v1";

export type LegalEnactmentState = "draft" | "scheduled" | "in_force";

/**
 * The effective date, as the deployment declares it.
 *
 * `YYYY-MM-DD`, in JST — the documents are Japanese and the date is a Japanese
 * legal effective date, so resolving it in the viewer's timezone would make the
 * policy come into force on different days for different people.
 *
 * Checked against the calendar and not only against a pattern. `2026-13-45`
 * matches `\d{4}-\d{2}-\d{2}` and is not a day; it used to reach the page and
 * print as 「施行日：2026-13-45」.
 */
export function legalEffectiveDate(): string | null {
  const raw = process.env.NEXT_PUBLIC_LEGAL_EFFECTIVE_DATE?.trim();
  if (!raw) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;

  // Round-trip through UTC: `Date.UTC(2026, 12, 45)` happily rolls over into
  // the following year, so the only way to reject an impossible day is to ask
  // whether the date we built is still the date we were given.
  const [year, month, day] = raw.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }
  return raw;
}

/**
 * Today in JST, as `YYYY-MM-DD`.
 *
 * Same `+9h then read UTC` shape as `slotFor()` in `crisisTriage.ts`. The
 * comparison has to be a *day* comparison: a document in force from 2026-10-01
 * is in force for the whole of that day in Japan, not from some instant in it.
 */
function jstToday(now: Date): string {
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * Which of the three states this build is in.
 *
 * `now` is injectable so the tests can pin a day; nothing in the app passes it.
 */
export function legalEnactmentState(now: Date = new Date()): LegalEnactmentState {
  if (process.env.NEXT_PUBLIC_LEGAL_ENACTED !== LEGAL_ENACTED_VERSION) return "draft";

  const effective = legalEffectiveDate();
  if (effective === null) return "draft";

  // Both are zero-padded `YYYY-MM-DD`, so string order is date order.
  return effective <= jstToday(now) ? "in_force" : "scheduled";
}

/**
 * Whether this build treats the terms and policy as in force.
 *
 * Needs all three: the version the deployment claims to enact, the date it
 * takes effect, and that date having arrived. A version with no date cannot be
 * shown to anyone as binding, a date with no version does not say binding
 * *to what*, and a date in the future says binding *later*.
 */
export function legalEnacted(now: Date = new Date()): boolean {
  return legalEnactmentState(now) === "in_force";
}

/** What the documents call themselves: a draft until the date arrives. */
export function legalDocumentLabel(base: string, now: Date = new Date()): string {
  return legalEnacted(now) ? base : `${base}（案）`;
}

/**
 * The effective date as the page prints it.
 *
 * Here rather than in the page so that it can be tested by calling it. Three
 * states, three answers — and the scheduled one names the day, because a
 * deployment that has decided its effective date should not tell participants
 * 「未設定」.
 */
export function legalEffectiveDateLabel(now: Date = new Date()): string {
  const effective = legalEffectiveDate();
  switch (legalEnactmentState(now)) {
    case "in_force":
      return effective ?? "未設定";
    case "scheduled":
      return `${effective}（施行予定）`;
    default:
      return "未設定";
  }
}

/** The version stamped onto an acceptance row written by this build. */
export function currentLegalVersion(now: Date = new Date()): string {
  return legalEnacted(now) ? LEGAL_ENACTED_VERSION : `${LEGAL_ENACTED_VERSION}-draft`;
}
