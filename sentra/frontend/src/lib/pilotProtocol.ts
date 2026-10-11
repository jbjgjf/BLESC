/**
 * How long the pilot runs, and how big it can get (#315).
 *
 * Before #315 the repository said 21 days (14 baseline + 7 observation) and the
 * original Google Doc said 「1ヶ月」, and nobody could say which a participant had
 * agreed to. The owner settled it on 2026-10-04:
 *
 *   - **28 days, fixed.** Not a calendar month: a calendar month is 28 to 31
 *     days depending on when a participant starts, so two people in the same
 *     study would be asked for different amounts. 28 is four whole weeks, so
 *     every participant has each weekday exactly four times whichever day they
 *     start on — a school week and a weekend are not distributed differently
 *     between participants.
 *   - **One collection period, no baseline / observation split.** The split was
 *     an analysis convenience, and the protocol now leaves it to the analysis
 *     plan rather than fixing it into the schema and the consent text.
 *
 * Everything that states the period — the protocol, the consent pack, the
 * research explanation on `/legal`, the `pilot_studies.study_days` default —
 * must agree with this file. `tests/study-period.test.mjs` reads them and fails
 * on a mismatch or on a statement of the period from before #315.
 *
 * Per-study values still come from `pilot_studies.study_days` at runtime: a dry
 * run is three days, and a study configured before #315 keeps the length it
 * was configured with. These constants are what a new study defaults to and
 * what the documents promise.
 */

/** The protocol revision that set the period to 28 days. */
export const PILOT_PROTOCOL_VERSION = "pilot-protocol-v3";

/** Days of collection, counted from the first day of a participant's window. */
export const PILOT_STUDY_DAYS = 28;

/** The recruitment target the protocol is sized for. */
export const PILOT_TARGET_PARTICIPANTS = 50;

/**
 * The most diary entries the pilot can produce: one a day per participant.
 *
 * Code that has to hold the whole pilot at once — the crisis triage queue, the
 * research export — is sized against this number, so it is derived rather than
 * written out a second time.
 */
export const PILOT_MAX_ENTRIES = PILOT_TARGET_PARTICIPANTS * PILOT_STUDY_DAYS;
