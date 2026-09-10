/**
 * The arithmetic behind the operations dashboard (#167).
 *
 * The dashboard answers one question every day of the pilot: *is what we have
 * what we should have?* Ten participants times three days is thirty
 * submissions, and the run is only interpretable if a shortfall can be
 * attributed — this participant withdrew on day 2, that one's write failed
 * twice, this one simply did not write on Tuesday.
 *
 * Pure, and separate from the route, because the counting is where the mistakes
 * are. A dashboard that silently counts a withdrawn participant's remaining
 * days as missing data reports a compliance problem that does not exist, and
 * one that counts them as complete hides a real one.
 *
 * Nothing here reads or returns journal text. The types cannot carry it: the
 * inputs are day numbers and counts (#167: dashboardに本文を表示せず、件数と
 * 状態だけを出してください).
 */

// Relative, with the extension, matching the other cross-module value imports
// in `src/lib` — the unit tests load these files directly under node, which
// does not resolve the `@/` alias for anything that is not a type-only import.
import { dayIndex } from "./researchExport.ts";
import { localDayKey } from "./journalStats.ts";

/**
 * The study's timezone, and the reason it is a constant.
 *
 * The pilot runs in Japanese schools, and a school day is a JST day. Reading it
 * from the browser would make a participant's device clock evidence, and
 * reading it from the serverless region would make it whatever region answered.
 *
 * The same value the export uses, so a day the dashboard calls missing is the
 * same day the export does not contain.
 */
export const STUDY_TIME_ZONE = "Asia/Tokyo";

/**
 * Days since collection opened, counting the opening day as 0.
 *
 * `dayIndex` from the export is 1-based, because a dataset row reading "day 1"
 * is what an analyst expects. Reconciliation counts elapsed days, where the
 * opening day is zero days elapsed, so this shifts by one rather than keeping
 * two different conventions in the reader's head.
 */
function elapsedDays(startedAt: string | null, instant: string): number | null {
  if (!startedAt) return null;
  const index = dayIndex(instant, startedAt, STUDY_TIME_ZONE);
  return index === null ? null : index - 1;
}

/**
 * How many study days this participant has been asked for so far.
 *
 * Bounded three ways, and each bound is a different way of being wrong:
 *
 *   - by today, so tomorrow's entry is not missing;
 *   - by the protocol length, so a participant past day 21 is complete rather
 *     than accumulating a growing deficit forever;
 *   - by the withdrawal date, so a participant who left on day 2 is expected to
 *     have written on days 0-2 and is not counted as absent for the rest.
 *
 * Day 0 counts, so a participant on their first day is expected to have one
 * submission. Returns 0 for an enrollment that never opened a window.
 */
export function expectedDays(input: {
  collectionStartedAt: string | null;
  withdrawnAt?: string | null;
  completedAt?: string | null;
  baselineDays: number;
  observationDays: number;
  now?: string | Date;
}): number {
  if (!input.collectionStartedAt) return 0;
  const now = input.now ?? new Date();
  const nowIso = now instanceof Date ? now.toISOString() : now;

  // The last day this participant was in the study, whichever came first.
  const endpoints = [nowIso, input.withdrawnAt, input.completedAt].filter(Boolean) as string[];
  const lastDay = endpoints
    .map((instant) => elapsedDays(input.collectionStartedAt, instant))
    .filter((day): day is number => day !== null)
    .reduce((min, day) => (day < min ? day : min), Number.POSITIVE_INFINITY);
  if (!Number.isFinite(lastDay)) return 0;

  const protocolLastDay = input.baselineDays + input.observationDays - 1;
  const bounded = Math.min(lastDay, protocolLastDay);
  // A `withdrawnAt` before collection opened gives a negative day: nothing was
  // ever expected of that participant.
  return bounded < 0 ? 0 : bounded + 1;
}

/** Elapsed study days, exported so the dashboard uses one definition. */
export function studyDaysElapsed(startedAt: string | null, instant: string): number | null {
  return elapsedDays(startedAt, instant);
}

export type ParticipantReconciliation = {
  /** The pseudonym. No dashboard row carries anything else identifying. */
  research_code: string;
  cohort: string;
  state: string;
  expected_days: number;
  /** Distinct study days with at least one stored entry. */
  submitted_days: number;
  /** `expected_days` minus `submitted_days`, floored at zero. */
  missing_days: number;
  /** Study days carrying more than one entry. Not an error; worth seeing. */
  duplicate_days: number;
  /** Days inside the expected window with no entry, listed so a coordinator
   *  can ask about Tuesday rather than about "three missing days". */
  missing_day_numbers: number[];
  /** Rows in `submission_failures` for this participant. */
  failed_submissions: number;
  /** Entries whose self-report block was never stored. */
  missing_self_reports: number;
};

/**
 * One participant's day-by-day reconciliation.
 *
 * `submittedDayNumbers` may contain repeats (two entries on one day) and
 * numbers outside the window (a submission after the protocol ended). Both are
 * counted rather than dropped: a day-22 entry is a protocol deviation, and a
 * deviation that the dashboard silently discards is one nobody investigates.
 */
export function reconcileParticipant(input: {
  research_code: string;
  cohort: string;
  state: string;
  expected_days: number;
  submittedDayNumbers: Array<number | null>;
  failed_submissions: number;
  entries_without_self_report: number;
}): ParticipantReconciliation {
  const counts = new Map<number, number>();
  for (const day of input.submittedDayNumbers) {
    if (day === null) continue;
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }

  const withinWindow = Array.from(counts.keys()).filter((day) => day >= 0 && day < input.expected_days);
  const missing: number[] = [];
  for (let day = 0; day < input.expected_days; day += 1) {
    if (!counts.has(day)) missing.push(day);
  }

  return {
    research_code: input.research_code,
    cohort: input.cohort,
    state: input.state,
    expected_days: input.expected_days,
    submitted_days: withinWindow.length,
    missing_days: missing.length,
    duplicate_days: Array.from(counts.values()).filter((count) => count > 1).length,
    missing_day_numbers: missing,
    failed_submissions: input.failed_submissions,
    missing_self_reports: input.entries_without_self_report,
  };
}

export type CohortTotals = {
  participants: number;
  expected_submissions: number;
  stored_submissions: number;
  missing_submissions: number;
  failed_submissions: number;
  duplicate_days: number;
  /** Participants with at least one missing day. The number a coordinator acts
   *  on: chasing eleven people is a different morning from chasing two. */
  participants_with_gaps: number;
};

export function totalsFor(rows: ParticipantReconciliation[]): CohortTotals {
  return rows.reduce<CohortTotals>(
    (totals, row) => ({
      participants: totals.participants + 1,
      expected_submissions: totals.expected_submissions + row.expected_days,
      stored_submissions: totals.stored_submissions + row.submitted_days,
      missing_submissions: totals.missing_submissions + row.missing_days,
      failed_submissions: totals.failed_submissions + row.failed_submissions,
      duplicate_days: totals.duplicate_days + row.duplicate_days,
      participants_with_gaps: totals.participants_with_gaps + (row.missing_days > 0 ? 1 : 0),
    }),
    {
      participants: 0,
      expected_submissions: 0,
      stored_submissions: 0,
      missing_submissions: 0,
      failed_submissions: 0,
      duplicate_days: 0,
      participants_with_gaps: 0,
    },
  );
}

/** Count occurrences of a string field. Used for state, status and version tallies. */
export function tally(values: Array<string | null | undefined>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    const key = value ?? "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/**
 * Retention health: how much retained text is due for purge, and how much is
 * overdue.
 *
 * `overdue` is the number that matters. `purge_expired_raw_text` is a function,
 * not a scheduler — whatever runs cron for the deployment has to call it — so a
 * non-zero overdue count means the schedule is not running, which is a finding
 * the dry run has to surface rather than discover afterwards (#168).
 */
export function retentionStatus(
  expiries: Array<string | null>,
  now: string | Date = new Date(),
): { retained: number; expiring_within_7_days: number; overdue: number } {
  const today = localDayKey(now instanceof Date ? now.toISOString() : now, STUDY_TIME_ZONE);
  const todayMs = today ? Date.parse(`${today}T00:00:00.000Z`) : Number.NaN;
  let retained = 0;
  let expiring = 0;
  let overdue = 0;
  for (const expiry of expiries) {
    retained += 1;
    if (!expiry || Number.isNaN(todayMs)) continue;
    const expiryDate = localDayKey(expiry, STUDY_TIME_ZONE);
    if (!expiryDate) continue;
    const days = (Date.parse(`${expiryDate}T00:00:00.000Z`) - todayMs) / 86_400_000;
    if (days < 0) overdue += 1;
    else if (days <= 7) expiring += 1;
  }
  return { retained, expiring_within_7_days: expiring, overdue };
}
