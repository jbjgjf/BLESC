import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { localDayKey } from "../src/lib/journalStats.ts";
import { STUDY_TIME_ZONE as REEXPORTED } from "../src/lib/pilotOps.ts";
import { dayIndex } from "../src/lib/researchExport.ts";
import { STUDY_TIME_ZONE, studyDay } from "../src/lib/studyDay.ts";

/**
 * The `day` columns hold a study-timezone calendar day (#521).
 *
 * The defect these pin was invisible to any test that reads the real clock:
 * both the CI runner and the Vercel runtime are UTC, and `new Date()
 * .toISOString().slice(0, 10)` only disagrees with the JST calendar day
 * between 00:00 and 09:00 JST. So every instant here is written out in full.
 */

const SOURCE = (path) => readFile(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");

describe("studyDay", () => {
  it("files a small-hours submission under the school day the student is in", () => {
    // 00:30 on the 12th in Tokyo is still the 11th in UTC. The entry belongs to
    // the 12th: that is the day the student wrote on.
    const smallHours = "2026-10-11T15:30:00.000Z";
    assert.equal(studyDay(smallHours), "2026-10-12");
    assert.equal(smallHours.slice(0, 10), "2026-10-11", "the UTC slice is the value being replaced");
  });

  it("gives one day to two submissions on the same school day", () => {
    // 08:00 and 21:00 JST on the 12th. Under the UTC slice these were
    // 2026-10-11 and 2026-10-12, so the evening entry diffed against the
    // morning one as "yesterday" and the school day counted twice toward the
    // fourteen-day baseline ramp.
    const morning = "2026-10-11T23:00:00.000Z";
    const evening = "2026-10-12T12:00:00.000Z";
    assert.equal(studyDay(morning), "2026-10-12");
    assert.equal(studyDay(evening), "2026-10-12");
    assert.notEqual(morning.slice(0, 10), evening.slice(0, 10));
  });

  it("leaves a daytime submission where it already was", () => {
    // 14:00 JST. UTC and JST agree for most of the day, which is why the
    // defect survived: the regression surface is a nine-hour window.
    assert.equal(studyDay("2026-10-12T05:00:00.000Z"), "2026-10-12");
  });

  it("accepts a Date as well as an instant string", () => {
    assert.equal(studyDay(new Date("2026-10-11T15:30:00.000Z")), "2026-10-12");
  });

  it("falls back to today rather than an empty day", () => {
    // `day` is `not null` in every table that holds it, so an unparseable
    // input must not reach the insert as "".
    assert.equal(localDayKey("not-a-date", STUDY_TIME_ZONE), "");
    assert.equal(studyDay("not-a-date"), studyDay());
    assert.match(studyDay("not-a-date"), /^\d{4}-\d{2}-\d{2}$/);
  });

  it("defaults to now, in the study timezone", () => {
    const now = new Date();
    assert.equal(studyDay(), localDayKey(now, STUDY_TIME_ZONE));
  });
});

describe("the study timezone has one definition", () => {
  it("is the value pilotOps re-exports, so the dashboard and the stored day agree", () => {
    assert.equal(STUDY_TIME_ZONE, "Asia/Tokyo");
    assert.equal(REEXPORTED, STUDY_TIME_ZONE);
  });

  it("puts an entry on the same calendar day as the export's day_index", () => {
    // The dataset numbers relative days in the study timezone
    // (`researchExport.dayIndex`). A stored `day` keyed to UTC meant the same
    // entry sat on day N in the dataset and day N-1 in `graph_snapshots`.
    const startedAt = "2026-10-11T15:30:00.000Z"; // 00:30 JST on the 12th
    const entryAt = "2026-10-12T15:30:00.000Z"; // 00:30 JST on the 13th
    assert.equal(studyDay(startedAt), "2026-10-12");
    assert.equal(dayIndex(startedAt, startedAt, STUDY_TIME_ZONE), 1);
    assert.equal(studyDay(entryAt), "2026-10-13");
    assert.equal(dayIndex(entryAt, startedAt, STUDY_TIME_ZONE), 2);
  });
});

describe("the write path does not compute a day of its own", () => {
  // A census rather than a behavioural test: the next place to need a day is
  // likelier to inline the UTC slice again than to call the wrong function.
  const WRITERS = ["src/app/api/entries/route.ts", "src/lib/server/supabaseWriter.ts"];

  // Both shapes the column used to be written with: `new Date()` sliced to ten
  // characters, and an instant assigned straight to a `day`. The doc comment in
  // `studyDay.ts` quotes the first on purpose; these two files have no reason
  // to contain either.
  const FORBIDDEN = [
    /new Date\(\)\.toISOString\(\)\.slice\(0, ?10\)/,
    /\bday\s*=\s*[A-Za-z_$][\w$]*\.slice\(0, ?10\)/,
  ];

  for (const path of WRITERS) {
    it(`${path} takes its day from studyDay()`, async () => {
      const source = await SOURCE(path);
      const inlined = source
        .split("\n")
        .map((line, index) => [index + 1, line])
        .filter(([, line]) => FORBIDDEN.some((pattern) => pattern.test(line)));
      assert.deepEqual(
        inlined,
        [],
        `computes a UTC calendar day instead of calling studyDay() (#521): ${JSON.stringify(inlined)}`,
      );
      assert.match(source, /\bstudyDay\(/);
    });
  }
});
