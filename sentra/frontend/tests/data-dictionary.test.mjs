/**
 * The data dictionary describes the code that exists (#B5).
 *
 * `approvals.md` tells the approvers to read `implementation` in this file and
 * to refuse recruitment while anything the protocol promises is unbuilt. That
 * makes a stale `implementation` worse than an undocumented field: the document
 * the ethics reviewer reads was wrong in both directions at once — five
 * self-report items and the relative-day conversion were marked unbuilt when
 * they were shipped, and `model_training_use` said "現状はどの参加者のデータも
 * 学習に使えない" while the opt-in was live and recorded.
 *
 * Nothing could catch that, because a JSON document has no compiler. This is
 * the compiler.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { SELF_REPORT_ITEMS, SELF_REPORT_SCHEMA_VERSION } from "../src/lib/pilotSelfReport.ts";
import { DEFAULT_PHASES, studyPhase } from "../src/lib/researchExport.ts";

const read = (relative) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const dictionary = JSON.parse(read("../../../docs/pilot/data-dictionary.json"));
const migration = read("../../supabase/migrations/20260909020000_pilot_self_reports.sql");
const exportSource = read("../src/lib/researchExport.ts");

const selfReportItems = dictionary.daily_self_report.items;
const byId = new Map(selfReportItems.map((item) => [item.id, item]));

describe("every field marked implemented can be pointed at", () => {
  const walk = (node, path, out) => {
    if (Array.isArray(node)) {
      for (const value of node) walk(value, path, out);
      return;
    }
    if (node && typeof node === "object") {
      if (node.implementation === "implemented") {
        out.push([node.id ? `${path}.${node.id}` : path, node]);
      }
      for (const [key, value] of Object.entries(node)) {
        if (key === "implementation") continue;
        walk(value, path ? `${path}.${key}` : key, out);
      }
    }
  };

  it("carries a code_ref", () => {
    const implemented = [];
    walk(dictionary, "", implemented);
    const missing = implemented.filter(([, node]) => !node.code_ref).map(([path]) => path);
    assert.deepEqual(
      missing,
      [],
      "a field claimed as implemented with nothing to point at is a claim nobody can check",
    );
  });
});

describe("the self-report items match what the code collects", () => {
  const implementedIds = SELF_REPORT_ITEMS.map((item) => item.id);

  for (const id of ["mood", "stress", "sleep_quality", "sleep_hours", "event_intensity"]) {
    it(`${id} is implemented, and the dictionary says so`, () => {
      assert.ok(implementedIds.includes(id), `${id} is missing from SELF_REPORT_ITEMS`);
      assert.match(
        migration,
        new RegExp(`^\\s*${id}\\s`, "m"),
        `${id} has no column in 20260909020000`,
      );
      assert.equal(
        byId.get(id)?.implementation,
        "implemented",
        `the dictionary still calls ${id} unbuilt`,
      );
    });
  }

  it("support_contact is absent from the code and unbuilt in the dictionary", () => {
    // Deliberately, and the migration says so in as many words. The dictionary
    // must not quietly promote it just because the others moved.
    assert.ok(!implementedIds.includes("support_contact"));
    assert.equal(byId.get("support_contact")?.implementation, "not_implemented");
    assert.match(migration, /support_contact/, "the migration should record why it is absent");
  });

  it("agrees with the code about the schema version", () => {
    assert.equal(dictionary.daily_self_report.schema_id, SELF_REPORT_SCHEMA_VERSION);
  });

  it("declares no item the code does not collect", () => {
    const declaredImplemented = selfReportItems
      .filter((item) => item.implementation === "implemented")
      .map((item) => item.id);
    for (const id of declaredImplemented) {
      assert.ok(implementedIds.includes(id), `${id} is declared implemented but SELF_REPORT_ITEMS has no such item`);
    }
  });
});

describe("the identity fields describe the export that exists", () => {
  it("relative_day names the field the export actually emits", () => {
    const entry = dictionary.identity.relative_day;
    assert.equal(entry.implementation, "implemented");
    assert.equal(entry.export_field, "day_index");
    assert.match(exportSource, /day_index: number;/);
  });

  it("relative_day is described as 1-based, because the code is", () => {
    // The dictionary used to say "登録日を0とした相対日" while the export
    // measured from `collection_started_at` starting at 1 — a different origin
    // AND a different base, which would have shifted every analysis by a day.
    const entry = dictionary.identity.relative_day;
    assert.doesNotMatch(entry.description, /0とした/);
    assert.match(entry.description, /1起点|1を|初日を1/);
  });

  it("study_phase is implemented and derived from the study, not from 14/21", () => {
    const entry = dictionary.identity.study_phase;
    assert.equal(entry.implementation, "implemented");
    assert.deepEqual(entry.values, ["baseline", "observation"]);
    assert.match(entry.description, /baseline_days/);

    // And the behaviour the description promises.
    assert.equal(studyPhase(DEFAULT_PHASES.baselineDays, DEFAULT_PHASES), "baseline");
    assert.equal(studyPhase(DEFAULT_PHASES.baselineDays + 1, DEFAULT_PHASES), "observation");
  });
});

describe("the training-use flag", () => {
  const entry = dictionary.consent.model_training_use;

  it("is recorded as implemented", () => {
    assert.equal(entry.implementation, "implemented");
  });

  it("points at the column that really holds it, under its real name", () => {
    // The dictionary calls it `model_training_use`; the database calls it
    // `future_fine_tuning`. Until one of them moves, the dictionary has to say
    // so out loud rather than leaving a reader to assume the names agree.
    assert.equal(entry.code_ref, "public.consent_records.future_fine_tuning");
    assert.equal(entry.column_name_differs, true);
  });

  it("no longer claims nobody's data can be used for training", () => {
    assert.doesNotMatch(
      entry.description,
      /現状はどの参加者のデータも学習に使えない/,
      "that sentence was false, and it was the reassuring direction to be false in",
    );
  });
});


describe("process telemetry says what the collection surface actually emits", () => {
  const telemetry = read("../src/lib/telemetry.ts");
  const fields = new Map(dictionary.process_telemetry.fields.map((f) => [f.id, f]));

  it("does not claim compose_duration_ms, which exists nowhere", () => {
    // It was marked implemented with a code_ref to a type that has no such
    // member. The nearest real thing is `total_duration_ms`, which measures
    // something else — screen-open to submit, not time spent typing.
    assert.doesNotMatch(telemetry, /compose_duration_ms/);
    assert.equal(fields.get("compose_duration_ms").implementation, "not_implemented");
  });

  it("does not claim field_order, which only the research console emits", () => {
    // The pilot collects from /journal, and `EntryTelemetryCollector` does not
    // put `field_order` in its aggregate metrics.
    assert.doesNotMatch(telemetry, /field_order/);
    assert.equal(fields.get("field_order").implementation, "not_implemented");
  });

  for (const id of ["pause_count", "revision_count"]) {
    it(`${id} really is on FieldMetrics`, () => {
      assert.match(telemetry, new RegExp(`^\\s*${id}: number;`, "m"));
      assert.equal(fields.get(id).implementation, "implemented");
    });
  }

  it("lists what is actually collected, so the gap is legible", () => {
    const actual = dictionary.process_telemetry.actually_collected;
    for (const name of actual.field_metrics) {
      assert.match(
        telemetry,
        new RegExp(`^\\s*${name}[?]?: `, "m"),
        `${name} is listed as collected but is not on FieldMetrics`,
      );
    }
    for (const name of actual.aggregate_metrics) {
      assert.match(telemetry, new RegExp(`${name}:`), `${name} is not in aggregate_metrics`);
    }
  });
});
