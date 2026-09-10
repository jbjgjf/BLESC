import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  STUDY_TIME_ZONE,
  expectedDays,
  reconcileParticipant,
  retentionStatus,
  studyDaysElapsed,
  tally,
  totalsFor,
} from "../src/lib/pilotOps.ts";

/**
 * The reconciliation behind the operations dashboard (#167).
 *
 * The dataset itself, its day arithmetic and the PII scanner live in
 * `researchExport.ts` and `piiScanner.ts` (#172) and are covered by
 * `research-export.test.mjs` and `pii-scanner.test.mjs`. What is left here is
 * the counting: is what we have what we should have, and if not, whose days are
 * missing.
 */

describe("study days elapsed", () => {
  it("counts the opening day as zero days elapsed", () => {
    // `dayIndex` in the export is 1 on the opening day, because a dataset row
    // reading "day 1" is what an analyst expects. Reconciliation counts elapsed
    // days instead, and keeping both conventions in a reader's head is how an
    // off-by-one gets into a compliance table.
    assert.equal(studyDaysElapsed("2026-09-05T23:00:00Z", "2026-09-06T02:00:00Z"), 0);
  });

  it("counts calendar days in the study timezone", () => {
    // 23:50 JST and 00:10 JST are twenty minutes apart and on different study
    // days — the boundary a nightly journal actually sits on.
    assert.equal(studyDaysElapsed("2026-09-05T23:00:00Z", "2026-09-06T14:50:00Z"), 0);
    assert.equal(studyDaysElapsed("2026-09-05T23:00:00Z", "2026-09-06T15:10:00Z"), 1);
  });

  it("runs on the study's timezone, not the region's", () => {
    assert.equal(STUDY_TIME_ZONE, "Asia/Tokyo");
  });

  it("has no day number when collection never opened", () => {
    assert.equal(studyDaysElapsed(null, "2026-09-06T02:00:00Z"), null);
  });
});

describe("expected days", () => {
  const study = { baselineDays: 3, observationDays: 0 };

  it("counts day 0 as one expected submission", () => {
    assert.equal(
      expectedDays({ collectionStartedAt: "2026-09-01T00:00:00.000Z", now: "2026-09-01T10:00:00.000Z", ...study }),
      1,
    );
  });

  it("stops at the protocol length", () => {
    assert.equal(
      expectedDays({ collectionStartedAt: "2026-09-01T00:00:00.000Z", now: "2026-09-30T10:00:00.000Z", ...study }),
      3,
    );
  });

  it("stops at withdrawal, so a participant who left is not counted as absent", () => {
    assert.equal(
      expectedDays({
        collectionStartedAt: "2026-09-01T00:00:00.000Z",
        withdrawnAt: "2026-09-02T09:00:00.000Z",
        now: "2026-09-30T10:00:00.000Z",
        ...study,
      }),
      2,
    );
  });

  it("expects nothing of an enrollment that never opened a window", () => {
    assert.equal(expectedDays({ collectionStartedAt: null, now: "2026-09-05T00:00:00.000Z", ...study }), 0);
  });

  it("expects nothing when withdrawal preceded collection", () => {
    assert.equal(
      expectedDays({
        collectionStartedAt: "2026-09-05T00:00:00.000Z",
        withdrawnAt: "2026-09-01T00:00:00.000Z",
        now: "2026-09-10T00:00:00.000Z",
        ...study,
      }),
      0,
    );
  });
});

describe("reconciliation", () => {
  const base = {
    research_code: "R-0007",
    cohort: "3-B",
    state: "collecting",
    expected_days: 3,
    failed_submissions: 0,
    entries_without_self_report: 0,
  };

  it("reports a complete participant as complete", () => {
    const row = reconcileParticipant({ ...base, submittedDayNumbers: [0, 1, 2] });
    assert.equal(row.submitted_days, 3);
    assert.equal(row.missing_days, 0);
    assert.deepEqual(row.missing_day_numbers, []);
  });

  it("names the days that are missing, not just how many", () => {
    const row = reconcileParticipant({ ...base, submittedDayNumbers: [0, 2] });
    assert.equal(row.missing_days, 1);
    assert.deepEqual(row.missing_day_numbers, [1]);
  });

  it("counts a second entry on one day as a duplicate day, not as two days", () => {
    const row = reconcileParticipant({ ...base, submittedDayNumbers: [0, 0, 1, 2] });
    assert.equal(row.submitted_days, 3);
    assert.equal(row.duplicate_days, 1);
    assert.equal(row.missing_days, 0);
  });

  it("does not credit a submission outside the window against a missing day", () => {
    // A day-5 entry in a 3-day protocol is a deviation. Counting it as coverage
    // would report a complete participant who in fact missed two days.
    const row = reconcileParticipant({ ...base, submittedDayNumbers: [0, 5, 7] });
    assert.equal(row.submitted_days, 1);
    assert.deepEqual(row.missing_day_numbers, [1, 2]);
  });

  it("ignores entries whose day could not be computed", () => {
    const row = reconcileParticipant({ ...base, submittedDayNumbers: [0, null, null] });
    assert.equal(row.submitted_days, 1);
    assert.equal(row.missing_days, 2);
  });

  it("expects nothing of a participant with no open window", () => {
    const row = reconcileParticipant({ ...base, expected_days: 0, submittedDayNumbers: [] });
    assert.equal(row.missing_days, 0);
    assert.deepEqual(row.missing_day_numbers, []);
  });

  it("carries the pseudonym and nothing else identifying", () => {
    const row = reconcileParticipant({ ...base, submittedDayNumbers: [0] });
    const serialised = JSON.stringify(row);
    for (const key of ["participant_id", "owner_user_id", "email"]) {
      assert.ok(!serialised.includes(key), `reconciliation row mentions ${key}`);
    }
    assert.equal(row.research_code, "R-0007");
  });
});

describe("cohort totals", () => {
  it("adds up to the ten-by-three reconciliation the dry run needs", () => {
    const rows = Array.from({ length: 10 }, (_, index) =>
      reconcileParticipant({
        research_code: `R-00${index}`,
        cohort: "dry-run",
        state: "collecting",
        expected_days: 3,
        // Two participants miss their last day.
        submittedDayNumbers: index < 2 ? [0, 1] : [0, 1, 2],
        failed_submissions: index === 0 ? 1 : 0,
        entries_without_self_report: 0,
      }),
    );
    assert.deepEqual(totalsFor(rows), {
      participants: 10,
      expected_submissions: 30,
      stored_submissions: 28,
      missing_submissions: 2,
      failed_submissions: 1,
      duplicate_days: 0,
      participants_with_gaps: 2,
    });
  });

  it("returns zeroes for an empty cohort", () => {
    assert.equal(totalsFor([]).participants, 0);
    assert.equal(totalsFor([]).expected_submissions, 0);
  });
});

describe("tallies and retention", () => {
  it("counts states, and files a null under unknown rather than dropping it", () => {
    assert.deepEqual(tally(["collecting", "collecting", "withdrawn", null]), {
      collecting: 2,
      withdrawn: 1,
      unknown: 1,
    });
  });

  it("separates text that is due for purge from text that is overdue", () => {
    const status = retentionStatus(
      [
        "2026-09-12T00:00:00.000Z", // within 7 days
        "2026-10-30T00:00:00.000Z", // later
        "2026-09-01T00:00:00.000Z", // overdue
        null, // retained with no expiry recorded
      ],
      "2026-09-09T00:00:00.000Z",
    );
    assert.deepEqual(status, { retained: 4, expiring_within_7_days: 1, overdue: 1 });
  });

  it("reports a non-zero overdue count, which means the purge schedule is not running", () => {
    // `purge_expired_raw_text` is a function, not a scheduler — whatever runs
    // cron has to call it. A non-zero count here is that call not happening.
    const status = retentionStatus(["2026-01-01T00:00:00.000Z"], "2026-09-09T00:00:00.000Z");
    assert.equal(status.overdue, 1);
  });
});

describe("the dashboard cannot return journal text", () => {
  const dashboard = fileURLToPath(
    new URL("../src/app/api/research/pilot-dashboard/route.ts", import.meta.url),
  );

  it("never selects a text column", async () => {
    const contents = await readFile(dashboard, "utf8");
    for (const column of [
      "raw_text,",
      "raw_text)",
      "answer_text",
      "question_text",
      "extraction_json",
      "summary_json",
      "nodes_json",
      "findings_json",
    ]) {
      assert.ok(!contents.includes(column), `the dashboard selects ${column}`);
    }
  });

  it("never decrypts", async () => {
    assert.ok(!(await readFile(dashboard, "utf8")).includes("decryptRawText"));
  });

  it("never touches owner_user_id outside a comment", async () => {
    const code = (await readFile(dashboard, "utf8"))
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
    assert.ok(!code.includes("owner_user_id"));
  });
});

describe("the review queue stores findings, never the text they matched", () => {
  it("the writer strips the matched text before inserting", async () => {
    // `PiiFinding.text` is the participant's own words. `forStorage` drops it,
    // and the CHECK on `findings_json` refuses a row that kept it — so a writer
    // that forgets the call is rejected by the database rather than quietly
    // persisting journal text under operator access rules.
    const file = fileURLToPath(new URL("../src/lib/server/supabaseWriter.ts", import.meta.url));
    const contents = await readFile(file, "utf8");
    assert.ok(contents.includes("forStorage(findings)"), "the writer stores unstripped findings");
    assert.ok(
      !contents.includes("findings_json: findings.map"),
      "findings must be stripped by forStorage, not reshaped inline",
    );
  });

  it("the migration refuses any key beyond the four that survive stripping", async () => {
    const file = fileURLToPath(
      new URL("../../supabase/migrations/20260909030000_pilot_pii_review_and_export.sql", import.meta.url),
    );
    const contents = await readFile(file, "utf8");
    assert.ok(contents.includes("'kind', 'confidence', 'start', 'end'"));
    assert.ok(!contents.includes("'text'"), "the CHECK must not admit the matched text");
  });
});
