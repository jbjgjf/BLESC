import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  FORBIDDEN_DATASET_KEYS,
  PILOT_DATASET_VERSION,
  TELEMETRY_EXPORT_KEYS,
  buildDatasetRow,
  forbiddenKeysIn,
  relativeDay,
  studyLocalDate,
  studyPhase,
} from "../src/lib/pilotExport.ts";
import {
  expectedDays,
  reconcileParticipant,
  retentionStatus,
  tally,
  totalsFor,
} from "../src/lib/pilotOps.ts";

/** A complete, synthetic source row. Every test mutates a copy of this. */
function source(overrides = {}) {
  return {
    enrollment: {
      research_code: "R-0007",
      cohort: "3-B",
      is_minor: true,
      collection_started_at: "2026-09-01T00:00:00.000Z",
      ...(overrides.enrollment ?? {}),
    },
    study: {
      slug: "pilot-2026",
      protocol_version: "pilot-protocol-v1",
      consent_document_version: "research-consent-doc-v1",
      baseline_days: 14,
      observation_days: 7,
      ...(overrides.study ?? {}),
    },
    entry: {
      id: "prod_abcdef0123456789",
      created_at: "2026-09-03T11:00:00.000Z",
      observation_type: "daily",
      extraction_provider: "none",
      extraction_model: "withheld_collection_only",
      raw_text_ciphertext: "v1.sealed",
      raw_text_key_version: "v1",
      raw_text_expires_at: "2027-03-01T00:00:00.000Z",
      ...(overrides.entry ?? {}),
    },
    selfReport:
      overrides.selfReport === undefined
        ? {
            schema_version: "pilot-selfreport-v1",
            mood: 6,
            stress: 3,
            sleep_quality: 4,
            sleep_hours: 6.5,
            event_intensity: null,
            rejected_json: {},
          }
        : overrides.selfReport,
    session:
      overrides.session === undefined
        ? { aggregate_metrics_json: { compose_duration_ms: 91_000, pause_count: 4 } }
        : overrides.session,
    piiReview:
      overrides.piiReview === undefined
        ? {
            status: "pending",
            scanner_version: "pii-scan-ja-v1",
            finding_count: 1,
            max_severity: "medium",
            kinds: ["person_name_honorific"],
          }
        : overrides.piiReview,
  };
}

describe("relative day is a JST calendar day", () => {
  it("counts the opening day as day 0", () => {
    assert.equal(relativeDay("2026-09-01T00:00:00.000Z", "2026-09-01T05:00:00.000Z"), 0);
  });

  it("counts calendar days, not 24-hour periods", () => {
    // 2026-09-02 19:00 JST — one calendar day after the 09-01 opening.
    assert.equal(relativeDay("2026-09-01T00:00:00.000Z", "2026-09-02T10:00:00.000Z"), 1);
    // 34 hours later in wall-clock terms, but two calendar days on.
    assert.equal(relativeDay("2026-09-01T00:00:00.000Z", "2026-09-02T20:00:00.000Z"), 2);
  });

  it("keeps a late-evening JST entry on its own day", () => {
    // 2026-09-03 23:30 JST is 14:30 UTC the same day. A UTC-based day number
    // happens to agree here; the next case is the one that separates them.
    assert.equal(relativeDay("2026-09-01T00:00:00.000Z", "2026-09-03T14:30:00.000Z"), 2);
  });

  it("keeps a just-past-midnight JST entry on the new day, not the previous one", () => {
    // 2026-09-04 00:20 JST is 2026-09-03 15:20 UTC. In UTC this is day 2; in
    // the participant's calendar it is day 3, and the participant is right.
    assert.equal(relativeDay("2026-09-01T00:00:00.000Z", "2026-09-03T15:20:00.000Z"), 3);
  });

  it("returns null when collection never opened", () => {
    assert.equal(relativeDay(null, "2026-09-03T11:00:00.000Z"), null);
  });

  it("returns null for an unparseable instant rather than 0", () => {
    assert.equal(relativeDay("2026-09-01T00:00:00.000Z", "not a date"), null);
    assert.equal(studyLocalDate("not a date"), null);
  });

  it("goes negative for a submission before the window opened", () => {
    assert.equal(relativeDay("2026-09-05T00:00:00.000Z", "2026-09-03T11:00:00.000Z"), -2);
  });
});

describe("study phase", () => {
  it("splits baseline from observation at the protocol boundary", () => {
    assert.equal(studyPhase(0, 14, 7), "baseline");
    assert.equal(studyPhase(13, 14, 7), "baseline");
    assert.equal(studyPhase(14, 14, 7), "observation");
    assert.equal(studyPhase(20, 14, 7), "observation");
  });

  it("labels days outside the window rather than dropping them", () => {
    assert.equal(studyPhase(21, 14, 7), "after_window");
    assert.equal(studyPhase(-1, 14, 7), "before_window");
  });

  it("handles the dry run's short protocol", () => {
    assert.equal(studyPhase(2, 3, 0), "baseline");
    assert.equal(studyPhase(3, 3, 0), "after_window");
  });

  it("is null when there is no day number", () => {
    assert.equal(studyPhase(null, 14, 7), null);
  });
});

describe("a dataset row carries the pseudonym and nothing else identifying", () => {
  it("has no forbidden key at any depth", () => {
    assert.deepEqual(forbiddenKeysIn(buildDatasetRow(source())), []);
  });

  it("carries research_code, never participant_id or owner_user_id", () => {
    const row = buildDatasetRow(source());
    assert.equal(row.research_code, "R-0007");
    const serialised = JSON.stringify(row);
    for (const key of ["participant_id", "owner_user_id", "email"]) {
      assert.ok(!serialised.includes(key), `row mentions ${key}`);
    }
  });

  it("carries a relative day and no calendar date for the submission", () => {
    const row = buildDatasetRow(source());
    assert.equal(row.relative_day, 2);
    assert.equal(row.study_phase, "baseline");
    assert.ok(!JSON.stringify(row).includes("2026-09-03"), "the submission date leaked");
  });

  it("references the ciphertext without carrying it", () => {
    const row = buildDatasetRow(source());
    assert.deepEqual(row.raw_text_ref, {
      entry_id: "prod_abcdef0123456789",
      retained: true,
      key_version: "v1",
      // 2026-09-01 → 2027-03-01 is 181 study days.
      expires_relative_day: 181,
    });
    assert.ok(!JSON.stringify(row).includes("sealed"), "the ciphertext leaked");
  });

  it("exports the retention expiry as a study day, never as a timestamp", () => {
    // `raw_text_expires_at` is the submission time plus a fixed interval, so an
    // absolute expiry hands back the submission's calendar date by subtraction
    // — the school-timetable alignment relative days exist to prevent.
    const row = buildDatasetRow(source());
    const serialised = JSON.stringify(row);
    assert.ok(!serialised.includes("2027-03-01"), "the absolute expiry leaked");
    assert.ok(!serialised.includes("expires_at"), "the absolute expiry field is still present");
    assert.equal(typeof row.raw_text_ref.expires_relative_day, "number");
  });

  it("has no expiry day when nothing is retained", () => {
    const row = buildDatasetRow(source({ entry: { raw_text_ciphertext: null, raw_text_expires_at: null } }));
    assert.equal(row.raw_text_ref.retained, false);
    assert.equal(row.raw_text_ref.expires_relative_day, null);
  });

  it("refuses an absolute timestamp key anywhere in an envelope", () => {
    assert.deepEqual(forbiddenKeysIn({ rows: [{ raw_text_ref: { expires_at: "2027-03-01" } }] }), [
      "rows.0.raw_text_ref.expires_at",
    ]);
    assert.deepEqual(forbiddenKeysIn({ rows: [{ created_at: "2026-09-03" }] }), ["rows.0.created_at"]);
  });

  it("says so when no text was retained", () => {
    const row = buildDatasetRow(source({ entry: { raw_text_ciphertext: null, raw_text_key_version: null } }));
    assert.equal(row.raw_text_ref.retained, false);
  });

  it("does not spread the database row it was built from", () => {
    // The failure this guards against: a column added to `entries` tomorrow
    // appearing in tomorrow's export because the builder spread the row.
    const withExtra = source();
    withExtra.entry.secret_internal_column = "should not appear";
    assert.ok(!JSON.stringify(buildDatasetRow(withExtra)).includes("should not appear"));
  });
});

describe("self-report values travel with their scale version", () => {
  it("carries the version and the five items", () => {
    const row = buildDatasetRow(source());
    assert.equal(row.self_report.schema_version, "pilot-selfreport-v1");
    assert.equal(row.self_report.mood, 6);
    assert.equal(row.self_report.sleep_hours, 6.5);
  });

  it("keeps an unanswered item null", () => {
    assert.equal(buildDatasetRow(source()).self_report.event_intensity, null);
  });

  it("reports every item as null when no self-report was stored", () => {
    const row = buildDatasetRow(source({ selfReport: null }));
    assert.equal(row.self_report.schema_version, null);
    assert.equal(row.self_report.mood, null);
    assert.equal(row.self_report.rejected_count, 0);
  });

  it("counts rejections without exporting what was rejected", () => {
    const row = buildDatasetRow(
      source({ selfReport: { schema_version: "pilot-selfreport-v1", mood: null, stress: null, sleep_quality: null, sleep_hours: null, event_intensity: null, rejected_json: { mood: "out_of_range" } } }),
    );
    assert.equal(row.self_report.rejected_count, 1);
  });
});

describe("process telemetry is allowlisted by key", () => {
  it("exports the keys on the list", () => {
    assert.deepEqual(buildDatasetRow(source()).process_telemetry, {
      compose_duration_ms: 91_000,
      pause_count: 4,
    });
  });

  it("drops a key a future client version invents", () => {
    // `aggregate_metrics_json` is written by the browser, so its key set is
    // whatever a client release decides. A filter would export a `page_title`
    // the day someone adds one.
    const row = buildDatasetRow(
      source({ session: { aggregate_metrics_json: { compose_duration_ms: 5, page_title: "日記", clipboard_source: "LINE" } } }),
    );
    assert.deepEqual(Object.keys(row.process_telemetry), ["compose_duration_ms"]);
  });

  it("drops a non-numeric value rather than coercing it", () => {
    const row = buildDatasetRow(source({ session: { aggregate_metrics_json: { pause_count: "4" } } }));
    assert.deepEqual(row.process_telemetry, {});
  });

  it("is empty when no session was linked", () => {
    assert.deepEqual(buildDatasetRow(source({ session: null })).process_telemetry, {});
  });

  it("lists only numeric writing-process measures", () => {
    assert.deepEqual([...TELEMETRY_EXPORT_KEYS].sort(), [
      "backspace_count",
      "char_count",
      "compose_duration_ms",
      "paste_count",
      "pause_count",
      "revision_count",
      "word_count",
    ]);
  });
});

describe("PII review state travels with the row", () => {
  it("carries the queue status and never a finding's text", () => {
    const row = buildDatasetRow(source());
    assert.equal(row.pii_review.status, "pending");
    assert.equal(row.pii_review.max_severity, "medium");
    assert.deepEqual(row.pii_review.kinds, ["person_name_honorific"]);
  });

  it("is null when the entry was never scanned", () => {
    assert.equal(buildDatasetRow(source({ piiReview: null })).pii_review, null);
  });

  it("refuses a severity the scanner does not define", () => {
    const row = buildDatasetRow(
      source({ piiReview: { status: "pending", scanner_version: "x", finding_count: 1, max_severity: "catastrophic", kinds: [] } }),
    );
    assert.equal(row.pii_review.max_severity, null);
  });
});

describe("provenance", () => {
  it("records that the submission was collected with inference off", () => {
    assert.equal(buildDatasetRow(source()).provenance.collection_only, true);
  });

  it("records a normal extraction as not collection-only", () => {
    const row = buildDatasetRow(source({ entry: { extraction_provider: "openai", extraction_model: "gpt-6-astra" } }));
    assert.equal(row.provenance.collection_only, false);
    assert.equal(row.provenance.extraction_model, "gpt-6-astra");
  });

  it("stamps the dataset contract version", () => {
    assert.equal(buildDatasetRow(source()).provenance.dataset_version, PILOT_DATASET_VERSION);
  });
});

describe("the forbidden-key check", () => {
  it("finds an identifier nested anywhere", () => {
    assert.deepEqual(forbiddenKeysIn({ rows: [{ nested: { owner_user_id: "u1" } }] }), ["rows.0.nested.owner_user_id"]);
  });

  it("finds one inside an array of rows", () => {
    assert.deepEqual(forbiddenKeysIn([{ email: "a@b.co" }]), ["0.email"]);
  });

  it("passes a clean envelope", () => {
    assert.deepEqual(forbiddenKeysIn({ rows: [buildDatasetRow(source())], row_count: 1 }), []);
  });

  it("names participant_id and raw_text among the keys it refuses", () => {
    for (const key of ["participant_id", "owner_user_id", "raw_text", "code_hash"]) {
      assert.ok(FORBIDDEN_DATASET_KEYS.includes(key), `${key} should be forbidden`);
    }
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
    const status = retentionStatus(["2026-01-01T00:00:00.000Z"], "2026-09-09T00:00:00.000Z");
    assert.equal(status.overdue, 1);
  });
});

describe("the dashboard cannot return journal text", () => {
  it("never selects a text column", async () => {
    const file = fileURLToPath(new URL("../src/app/api/research/pilot-dashboard/route.ts", import.meta.url));
    const contents = await readFile(file, "utf8");
    for (const column of ["raw_text,", "raw_text)", "answer_text", "question_text", "extraction_json", "summary_json", "nodes_json"]) {
      assert.ok(!contents.includes(column), `the dashboard selects ${column}`);
    }
  });

  it("never decrypts", async () => {
    const file = fileURLToPath(new URL("../src/app/api/research/pilot-dashboard/route.ts", import.meta.url));
    assert.ok(!(await readFile(file, "utf8")).includes("decryptRawText"));
  });
});

describe("the identity map is a separate permission", () => {
  it("is the only research route that reads RESEARCH_IDENTITY_MAP_USER_IDS", async () => {
    const apiRoot = fileURLToPath(new URL("../src/app/api", import.meta.url));
    const users = [];
    for (const file of await routeFiles(apiRoot)) {
      const contents = await readFile(file, "utf8");
      if (contents.includes("authorizedIdentityMappers")) users.push(path.relative(apiRoot, file));
    }
    assert.deepEqual(users, ["research/pilot-identity-map/route.ts"]);
  });

  it("is not derived from the export allowlist", async () => {
    // Two variables, read independently. If one were computed from the other,
    // granting somebody the dataset would quietly grant them re-identification.
    const file = fileURLToPath(new URL("../src/lib/server/researchExportAudit.ts", import.meta.url));
    const contents = await readFile(file, "utf8");
    assert.ok(contents.includes("RESEARCH_EXPORT_USER_IDS"));
    assert.ok(contents.includes("RESEARCH_IDENTITY_MAP_USER_IDS"));
    // Neither allowlist function may mention the other's variable.
    const exporters = contents.slice(contents.indexOf("export function authorizedExporters"));
    assert.ok(!exporters.slice(0, exporters.indexOf("}")).includes("IDENTITY_MAP"));
  });

  it("is the only pilot route whose code touches owner_user_id at all", async () => {
    // Comment lines are stripped first: `pilot-export` names the column in its
    // header precisely to say it does not carry it, and a test that cannot tell
    // the two apart would push people to stop writing the header.
    const apiRoot = fileURLToPath(new URL("../src/app/api/research", import.meta.url));
    const leaking = [];
    for (const file of await routeFiles(apiRoot)) {
      const relative = path.relative(apiRoot, file);
      if (!relative.startsWith("pilot-") || relative.startsWith("pilot-identity-map")) continue;
      const code = (await readFile(file, "utf8"))
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");
      if (code.includes("owner_user_id")) leaking.push(relative);
    }
    assert.deepEqual(leaking, []);
  });
});

describe("a consent lookup failure is not an empty cohort", () => {
  it("reports the failure instead of returning nobody", async () => {
    // Returning an empty map would fail closed — correct — but the export would
    // then record a *completed* zero-row pull, making an outage look exactly
    // like a cohort that declined.
    const { loadResearchConsent } = await import("../src/lib/server/researchExportAudit.ts");
    const failing = {
      from: () => ({
        select: () => ({
          in: () => ({ order: async () => ({ data: null, error: { message: "permission denied" } }) }),
        }),
      }),
    };
    const result = await loadResearchConsent(failing, ["p1"]);
    assert.equal(result.ok, false);
    assert.equal(result.error, "permission denied");
  });

  it("returns the newest record per participant on success", async () => {
    const { loadResearchConsent } = await import("../src/lib/server/researchExportAudit.ts");
    const rows = [
      { participant_id: "p1", document_version: "v2" },
      { participant_id: "p1", document_version: "v1" },
      { participant_id: "p2", document_version: "v1" },
    ];
    const client = {
      from: () => ({
        select: () => ({ in: () => ({ order: async () => ({ data: rows, error: null }) }) }),
      }),
    };
    const result = await loadResearchConsent(client, ["p1", "p2"]);
    assert.equal(result.ok, true);
    // Ordered newest first, so the first row seen for a participant wins.
    assert.equal(result.byParticipant.get("p1").document_version, "v2");
    assert.equal(result.byParticipant.size, 2);
  });

  it("succeeds with an empty map when there is nobody to look up", async () => {
    const { loadResearchConsent } = await import("../src/lib/server/researchExportAudit.ts");
    const result = await loadResearchConsent(null, []);
    assert.equal(result.ok, true);
    assert.equal(result.byParticipant.size, 0);
  });
});

describe("the export is scoped to the collection window", () => {
  it("filters entries by each participant's own window", async () => {
    // `entries` has no study id, and a participant may have journalled for
    // months before the study or be enrolled in a second one. Selecting by
    // participant alone stamps their whole history with this study's
    // research_code and protocol.
    const file = fileURLToPath(new URL("../src/app/api/research/pilot-export/route.ts", import.meta.url));
    const contents = await readFile(file, "utf8");
    assert.ok(contents.includes('.gte("created_at", earliestStart)'), "no prefilter on the earliest window start");
    assert.ok(
      contents.includes("entry.created_at < (enrollment.collection_started_at as string)"),
      "entries before a participant's own window are not excluded",
    );
    assert.ok(
      contents.includes("enrollment.collection_ends_at && entry.created_at > enrollment.collection_ends_at"),
      "entries after a participant's own window are not excluded",
    );
    assert.ok(contents.includes("excluded.outside_window"), "out-of-window entries are not counted");
  });

  it("a pre-study entry would otherwise land in the file as a negative day", () => {
    // What the filter prevents, stated as arithmetic: an entry written six
    // weeks before enrollment is day -42 of a protocol it predates.
    const row = buildDatasetRow(source({ entry: { created_at: "2026-07-21T11:00:00.000Z" } }));
    assert.equal(row.relative_day, -42);
    assert.equal(row.study_phase, "before_window");
  });
});

async function routeFiles(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await routeFiles(full)));
    else if (entry.name === "route.ts") found.push(full);
  }
  return found;
}
