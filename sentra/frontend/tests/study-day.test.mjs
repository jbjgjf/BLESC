import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { studyDay } from "../src/lib/studyDay.ts";
import { STUDY_TIME_ZONE } from "../src/lib/pilotOps.ts";
import { dayIndex } from "../src/lib/researchExport.ts";

// #521: the `day` column is the calendar day in the study's timezone, not UTC's.
// CI and Vercel both run in UTC, so these use fixed instants inside the
// 00:00–09:00 JST window — the only window where the two calendars disagree.

describe("studyDay", () => {
  it("puts a 00:30 JST submission on the JST date, not the previous UTC date", () => {
    // 00:30 JST on 2026-11-02 is 15:30 UTC on 2026-11-01.
    const instant = "2026-11-01T15:30:00.000Z";
    assert.equal(instant.slice(0, 10), "2026-11-01", "the UTC slice is the bug");
    assert.equal(studyDay(instant), "2026-11-02");
  });

  it("gives 08:00 JST and 21:00 JST on one school day the same day", () => {
    const morning = "2026-11-01T23:00:00.000Z"; // 08:00 JST, 11-02
    const evening = "2026-11-02T12:00:00.000Z"; // 21:00 JST, 11-02
    assert.notEqual(morning.slice(0, 10), evening.slice(0, 10));
    assert.equal(studyDay(morning), "2026-11-02");
    assert.equal(studyDay(evening), "2026-11-02");
  });

  it("counts one school day as one observed day in the baseline buckets", () => {
    // `loadBaselineHistory` buckets rows by distinct `day`; with the UTC slice
    // the same school day produced two buckets and filled the 14-day ramp early.
    const sameSchoolDay = [
      "2026-11-01T22:10:00.000Z", // 07:10 JST
      "2026-11-01T23:50:00.000Z", // 08:50 JST
      "2026-11-02T11:00:00.000Z", // 20:00 JST
    ];
    assert.equal(new Set(sameSchoolDay.map((i) => i.slice(0, 10))).size, 2);
    assert.equal(new Set(sameSchoolDay.map((i) => studyDay(i))).size, 1);
  });

  it("lands on the same day the export's day_index counts", () => {
    const startedAt = "2026-11-01T00:00:00.000Z"; // 09:00 JST, 11-01 → day 1
    const entries = [
      "2026-11-01T15:30:00.000Z", // 00:30 JST 11-02 → day 2
      "2026-11-02T23:59:00.000Z", // 08:59 JST 11-03 → day 3
      "2026-11-03T14:59:00.000Z", // 23:59 JST 11-03 → day 3
    ];
    const startDay = studyDay(startedAt);
    for (const createdAt of entries) {
      const index = dayIndex(createdAt, startedAt, STUDY_TIME_ZONE);
      const elapsed =
        (Date.parse(`${studyDay(createdAt)}T00:00:00Z`) - Date.parse(`${startDay}T00:00:00Z`)) / 86_400_000;
      assert.equal(index, elapsed + 1, createdAt);
    }
  });

  it("defaults to now", () => {
    assert.match(studyDay(), /^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("the writers use studyDay for the day column", () => {
  const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

  it("the entries route derives day from studyDay(createdAt)", () => {
    const route = read("../src/app/api/entries/route.ts");
    assert.match(route, /const day = studyDay\(createdAt\);/);
    assert.doesNotMatch(route, /const day = createdAt\.slice\(0, 10\)/);
  });

  it("supabaseWriter has no UTC-day fallback left", () => {
    const writer = read("../src/lib/server/supabaseWriter.ts");
    assert.doesNotMatch(writer, /new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/);
    assert.ok((writer.match(/studyDay\(\)/g) ?? []).length >= 3);
  });
});
