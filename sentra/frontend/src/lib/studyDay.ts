/**
 * What day a submission belongs to (#521).
 *
 * ## The rule
 *
 * **`day` is the calendar day of the study timezone, never UTC's.** Every
 * column named `day` — `graph_snapshots.day`, `insights.day`, and the window
 * bounds `longitudinal_features` derives from them — holds a value produced
 * here. `created_at` stays the UTC instant it always was: that is a *time*, and
 * a time is not a day.
 *
 * ## Why this file exists
 *
 * The rule was already written down in three places and implemented in none of
 * the ones that write the column. `journalStats.ts` says "'yesterday' for a
 * student in JST is not the UTC day boundary"; `pilotOps.ts` says "a school day
 * is a JST day"; the export counts `day_index` in the study timezone. Mean-
 * while `POST /api/entries` set `day` to `new Date().toISOString().slice(0, 10)`
 * and `supabaseWriter.ts` used the same expression for its fallbacks.
 *
 * JST is UTC+9, so those agree for most of the day and disagree from 00:00 to
 * 09:00 JST — which for a high-school diary is the window that matters. A
 * student writing at 08:00 and again at 21:00 produced two different `day`
 * values for one school day: the evening entry then diffed against the morning
 * one as "yesterday", and `loadBaselineHistory` counted the school day twice
 * toward the fourteen-day baseline ramp. Nothing failed; the series was simply
 * one day wide of the dataset the export built beside it.
 *
 * Both the CI runner and the Vercel runtime are UTC, so no test that uses the
 * real clock can enter the disagreeing window. That is why the rule needs a
 * function rather than a convention.
 */

// Relative, with the extension, matching the other cross-module value imports
// in `src/lib` — the unit tests load these files directly under node, which
// does not resolve the `@/` alias for anything that is not a type-only import.
import { localDayKey } from "./journalStats.ts";

/**
 * The study's timezone, and the reason it is a constant.
 *
 * The pilot runs in Japanese schools, and a school day is a JST day. Reading it
 * from the browser would make a participant's device clock evidence, and
 * reading it from the serverless region would make it whatever region answered.
 *
 * Declared here rather than in `pilotOps.ts`, which re-exports it, so that the
 * write path can reach the rule without pulling the reconciliation arithmetic
 * (and through it the PII scanner) into the submission handler.
 *
 * `GET /api/research/export` reads `PILOT_TIMEZONE` instead of this constant,
 * so the two are the same value only while that variable is unset or set to
 * `Asia/Tokyo` (#525). Resolving that is deliberately not this module's job:
 * when it is resolved, this is the one place that has to change.
 */
export const STUDY_TIME_ZONE = "Asia/Tokyo";

/**
 * The study-timezone calendar day an instant falls on, as `YYYY-MM-DD`.
 *
 * The argument is the submission's own `created_at` wherever there is one, so
 * the stored day and the stored instant describe the same event. It defaults to
 * now for the fallback paths, where the instant was never carried.
 *
 * `localDayKey` answers `""` for a value that is not a date. `day` is `not
 * null` in every table that holds it, so an unparseable input falls back to the
 * current day rather than propagating an empty string into the insert.
 */
export function studyDay(instant: string | Date = new Date()): string {
  return localDayKey(instant, STUDY_TIME_ZONE) || localDayKey(new Date(), STUDY_TIME_ZONE);
}
