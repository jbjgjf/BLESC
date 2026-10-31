// Relative, with the extension, so `node --test` can load this file directly
// (see the note at the top of `pilotOps.ts`).
import { localDayKey } from "./journalStats.ts";
import { STUDY_TIME_ZONE } from "./pilotOps.ts";

/**
 * The `day` column convention, declared once (#521).
 *
 * `graph_snapshots.day`, `insights.day` and `longitudinal_features.window_end`
 * are **the calendar day in the study's timezone** (`STUDY_TIME_ZONE`, JST)
 * that the submission's instant falls on. `created_at` stays a UTC instant —
 * that is a time, not a date; this is the date a school day is counted by.
 *
 * It used to be `new Date().toISOString().slice(0, 10)`, the UTC calendar day.
 * JST is UTC+9, so everything written between 00:00 and 09:00 JST — the
 * morning before school — landed on the previous day: one school day became two
 * baseline buckets, the 14-day ramp filled early, and the export's `day_index`
 * (counted in JST) disagreed with the `day` column for the same entry.
 *
 * Built on `localDayKey` rather than adding `+9h` to a timestamp: the offset
 * arithmetic is what `journalStats` was written to avoid.
 */
export function studyDay(instant: string | Date = new Date()): string {
  return localDayKey(instant, STUDY_TIME_ZONE);
}
