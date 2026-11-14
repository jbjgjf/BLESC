// Relative, with the extension, so `node --test` can load this file directly
// (see the note at the top of `pilotOps.ts`).
import { localDayKey } from "./journalStats.ts";
import { STUDY_TIME_ZONE } from "./pilotOps.ts";

/**
 * "Did each student submit today?" for the educator roster.
 *
 * The source is the instant of each submission, not the `day` column of
 * `insights`: that column was the UTC calendar day until #521, and `insights`
 * is not written at all in collection-only mode. The safety-assessment row in
 * `model_runs` is written for every saved entry, in every mode, and an educator
 * who oversees the student can already read it. Only its `created_at` is used
 * here — never what the student wrote.
 *
 * Days are calendar days in the study timezone (JST): a diary at 00:30 JST
 * counts for that JST date, not the previous UTC one.
 */

export type SubmissionInstant = { participant_id: string; created_at: string };

/** Days shown, today included. A week is what a homeroom teacher checks. */
export const SUBMISSION_WINDOW_DAYS = 7;

/** `YYYY-MM-DD` keys, oldest first, ending with today's study day. */
export function studyDayWindow(
  now: Date = new Date(),
  days: number = SUBMISSION_WINDOW_DAYS,
  timeZone: string = STUDY_TIME_ZONE,
): string[] {
  const today = localDayKey(now, timeZone);
  const keys: string[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    // Calendar arithmetic on the day label: noon UTC on that label is only a
    // vehicle for subtracting whole days, so no instant is converted here.
    const date = new Date(`${today}T12:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() - offset);
    keys.push(date.toISOString().slice(0, 10));
  }
  return keys;
}

/**
 * The earliest instant that can fall inside the window, as an ISO string for a
 * `created_at >= …` filter. Deliberately one day early: the exact boundary
 * depends on the timezone's offset, and rows before the first day are dropped
 * by `submittedDays` anyway. Reading a few extra rows is cheaper than a
 * boundary bug that hides the first morning of the window.
 */
export function windowStartInstant(window: string[]): string {
  const first = window[0];
  const date = new Date(`${first}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString();
}

/** participant_id → the set of study days (within `window`) it submitted on. */
export function submittedDays(
  rows: SubmissionInstant[],
  window: string[],
  timeZone: string = STUDY_TIME_ZONE,
): Map<string, Set<string>> {
  const inWindow = new Set(window);
  const result = new Map<string, Set<string>>();
  for (const row of rows) {
    const day = localDayKey(row.created_at, timeZone);
    if (!day || !inWindow.has(day)) continue;
    let set = result.get(row.participant_id);
    if (!set) {
      set = new Set();
      result.set(row.participant_id, set);
    }
    set.add(day);
  }
  return result;
}

export type DailySubmissionSummary = {
  /** Oldest first; the last one is today. */
  days: string[];
  today: string;
  byParticipant: Map<string, Set<string>>;
  submittedToday: number;
  total: number;
};

export function summarizeSubmissions(
  participantIds: string[],
  rows: SubmissionInstant[],
  now: Date = new Date(),
  days: number = SUBMISSION_WINDOW_DAYS,
  timeZone: string = STUDY_TIME_ZONE,
): DailySubmissionSummary {
  const window = studyDayWindow(now, days, timeZone);
  const today = window[window.length - 1];
  const ids = new Set(participantIds);
  const byParticipant = submittedDays(rows.filter((row) => ids.has(row.participant_id)), window, timeZone);
  let submittedToday = 0;
  for (const id of participantIds) if (byParticipant.get(id)?.has(today)) submittedToday += 1;
  return { days: window, today, byParticipant, submittedToday, total: participantIds.length };
}
