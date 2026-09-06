/**
 * Submission counts for the completion screen (#133).
 *
 * `DoneScreen` counted up to a hard-coded 7 and 6 — every student, on every
 * submission, including their first. A first-time user was told they had a
 * seven-day streak. These functions compute the two numbers from the days the
 * participant actually submitted on.
 *
 * Days, not timestamps: a streak is a property of local calendar dates, and
 * "yesterday" for a student in JST is not the UTC day boundary. Callers pass
 * the days already localised (`localDayKey`), and everything here is string
 * comparison on `YYYY-MM-DD`.
 */

export type JournalStats = {
  /** Consecutive days ending today (or yesterday, if today has no entry). */
  streak: number;
  /** Submissions within the current week. */
  weekly: number;
  /** Distinct days submitted on, all time. */
  totalDays: number;
};

export const EMPTY_STATS: JournalStats = { streak: 0, weekly: 0, totalDays: 0 };

/**
 * The calendar day an instant falls on for a given IANA timezone. `en-CA`
 * because its short date format is ISO order; the alternative is arithmetic on
 * a UTC offset, which is wrong twice a year.
 */
export function localDayKey(instant: string | Date, timeZone: string): string {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function shiftDay(day: string, deltaDays: number): string {
  const [year, month, date] = day.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, date));
  shifted.setUTCDate(shifted.getUTCDate() + deltaDays);
  return shifted.toISOString().slice(0, 10);
}

/**
 * Consecutive days up to and including `today`.
 *
 * A streak that ended yesterday still counts today: a student opening the
 * completion screen has just submitted, so `today` is in the set, but the
 * function is also called from the home screen before submitting, where
 * yesterday's streak has not been broken yet — only a gap of two days breaks
 * it.
 */
export function computeStreak(days: Iterable<string>, today: string): number {
  const set = new Set(Array.from(days).filter(Boolean));
  if (set.size === 0) return 0;
  let cursor = set.has(today) ? today : shiftDay(today, -1);
  if (!set.has(cursor)) return 0;
  let streak = 0;
  while (set.has(cursor)) {
    streak += 1;
    cursor = shiftDay(cursor, -1);
  }
  return streak;
}

/**
 * Submissions in the current week, Monday-based — the school week these
 * students are in, not the US Sunday convention `getDay()` implies.
 */
export function computeWeekly(days: Iterable<string>, today: string): number {
  const [year, month, date] = today.split("-").map(Number);
  if (!year || !month || !date) return 0;
  const anchor = new Date(Date.UTC(year, month - 1, date));
  const weekdayFromMonday = (anchor.getUTCDay() + 6) % 7;
  const weekStart = shiftDay(today, -weekdayFromMonday);
  const weekEnd = shiftDay(weekStart, 6);
  return Array.from(new Set(Array.from(days).filter(Boolean))).filter(
    (day) => day >= weekStart && day <= weekEnd,
  ).length;
}

/** All three figures from a list of submission instants. */
export function computeJournalStats(
  submittedAt: Array<string | Date>,
  timeZone: string,
  now: Date = new Date(),
): JournalStats {
  const days = new Set(
    submittedAt.map((instant) => localDayKey(instant, timeZone)).filter(Boolean),
  );
  const today = localDayKey(now, timeZone);
  return {
    streak: computeStreak(days, today),
    weekly: computeWeekly(days, today),
    totalDays: days.size,
  };
}
