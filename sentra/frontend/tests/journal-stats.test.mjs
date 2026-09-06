import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EMPTY_STATS,
  computeJournalStats,
  computeStreak,
  computeWeekly,
  localDayKey,
} from "../src/lib/journalStats.ts";

describe("localDayKey", () => {
  it("buckets an instant into the viewer's calendar day, not UTC's", () => {
    // 23:30 UTC on the 5th is already the 6th in Tokyo. Bucketing by UTC would
    // put a late-evening entry on the previous day and break the streak.
    const lateEvening = "2026-09-05T23:30:00.000Z";
    assert.equal(localDayKey(lateEvening, "Asia/Tokyo"), "2026-09-06");
    assert.equal(localDayKey(lateEvening, "UTC"), "2026-09-05");
    assert.equal(localDayKey(lateEvening, "America/Los_Angeles"), "2026-09-05");
  });

  it("falls back to the UTC day for an unknown timezone rather than throwing", () => {
    assert.equal(localDayKey("2026-09-05T10:00:00.000Z", "Not/AZone"), "2026-09-05");
  });

  it("returns an empty key for an unparseable instant", () => {
    assert.equal(localDayKey("not-a-date", "Asia/Tokyo"), "");
  });
});

describe("computeStreak", () => {
  it("is 0 with no submissions", () => {
    assert.equal(computeStreak([], "2026-09-06"), 0);
  });

  it("is 1 on a first submission — not the hard-coded 7", () => {
    // The defect (#133): DoneScreen counted up to 7 for every student,
    // including one submitting for the first time.
    assert.equal(computeStreak(["2026-09-06"], "2026-09-06"), 1);
  });

  it("counts consecutive days ending today", () => {
    const days = ["2026-09-04", "2026-09-05", "2026-09-06"];
    assert.equal(computeStreak(days, "2026-09-06"), 3);
  });

  it("stops at a gap", () => {
    const days = ["2026-09-01", "2026-09-02", "2026-09-05", "2026-09-06"];
    assert.equal(computeStreak(days, "2026-09-06"), 2);
  });

  it("still counts a streak that ended yesterday", () => {
    assert.equal(computeStreak(["2026-09-04", "2026-09-05"], "2026-09-06"), 2);
  });

  it("is 0 when the last submission was two days ago", () => {
    assert.equal(computeStreak(["2026-09-03", "2026-09-04"], "2026-09-06"), 0);
  });

  it("counts a day once however many times it was submitted on", () => {
    assert.equal(computeStreak(["2026-09-06", "2026-09-06", "2026-09-05"], "2026-09-06"), 2);
  });

  it("crosses a month boundary", () => {
    assert.equal(computeStreak(["2026-08-31", "2026-09-01"], "2026-09-01"), 2);
  });
});

describe("computeWeekly", () => {
  it("counts the Monday-based week the day falls in", () => {
    // 2026-09-06 is a Sunday; its week runs Mon 08-31 to Sun 09-06.
    const days = ["2026-08-31", "2026-09-02", "2026-09-06"];
    assert.equal(computeWeekly(days, "2026-09-06"), 3);
  });

  it("excludes the previous week", () => {
    // 2026-08-30 is the Sunday before that week starts.
    const days = ["2026-08-30", "2026-08-31"];
    assert.equal(computeWeekly(days, "2026-09-06"), 1);
  });

  it("is 1 for a student's first submission — not the hard-coded 6", () => {
    assert.equal(computeWeekly(["2026-09-06"], "2026-09-06"), 1);
  });

  it("is 0 with no submissions", () => {
    assert.equal(computeWeekly([], "2026-09-06"), 0);
  });
});

describe("computeJournalStats", () => {
  it("reports 1 and 1 for a first-time submitter", () => {
    const stats = computeJournalStats(
      ["2026-09-06T09:00:00.000Z"],
      "Asia/Tokyo",
      new Date("2026-09-06T09:00:05.000Z"),
    );
    assert.deepEqual(stats, { streak: 1, weekly: 1, totalDays: 1 });
  });

  it("returns zeroes for an empty history", () => {
    const stats = computeJournalStats([], "Asia/Tokyo", new Date("2026-09-06T09:00:00.000Z"));
    assert.deepEqual(stats, EMPTY_STATS);
  });

  it("groups two entries on the same local day into one day", () => {
    const stats = computeJournalStats(
      ["2026-09-06T00:30:00.000Z", "2026-09-06T13:00:00.000Z"],
      "Asia/Tokyo",
      new Date("2026-09-06T14:00:00.000Z"),
    );
    assert.equal(stats.totalDays, 1);
    assert.equal(stats.streak, 1);
  });

  it("counts an entry written late at night in Tokyo toward that Tokyo day", () => {
    // 2026-09-05T23:30Z is 2026-09-06 08:30 JST.
    const stats = computeJournalStats(
      ["2026-09-05T23:30:00.000Z"],
      "Asia/Tokyo",
      new Date("2026-09-06T01:00:00.000Z"),
    );
    assert.equal(stats.streak, 1);
    assert.equal(stats.totalDays, 1);
  });
});
