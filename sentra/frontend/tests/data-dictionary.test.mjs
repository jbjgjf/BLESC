/**
 * The data dictionary describes the code that exists (#B5).
 *
 * `approvals.md` tells the approvers to read `implementation` here and to
 * refuse recruitment while anything the protocol promises is unbuilt. That
 * makes a stale entry worse than an undocumented field, and it had gone stale
 * in both directions at once:
 *
 *   - Five self-report items, the relative-day conversion and the training-use
 *     opt-in were marked unbuilt while they were shipped.
 *   - `compose_duration_ms` and `field_order` were marked built while no such
 *     field exists on the collection surface.
 *
 * And a third failure that neither list caught: every one of those fields says
 * `in_export: true`, while the export emitted none of them. Collected is not
 * exported, and the dictionary is a promise about the dataset.
 *
 * Nothing could catch any of it, because a JSON document has no compiler.
 * This is the compiler.
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
const exportRoute = read("../src/app/api/research/export/route.ts");
const telemetry = read("../src/lib/telemetry.ts");

/**
 * Source with comments stripped.
 *
 * The rules here are explained in the comments next to the code that follows
 * them — the export route says in as many words why `answered_at` is not
 * selected — so a naive grep finds the forbidden name inside its own rationale.
 */
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

const selfReportItems = dictionary.daily_self_report.items;
const byId = new Map(selfReportItems.map((item) => [item.id, item]));

const implementedEntries = () => {
  const out = [];
  const walk = (node, path) => {
    if (Array.isArray(node)) {
      for (const value of node) walk(value, path);
      return;
    }
    if (node && typeof node === "object") {
      if (node.implementation === "implemented") {
        out.push([node.id ? `${path}.${node.id}` : path, node]);
      }
      for (const [key, value] of Object.entries(node)) {
        if (key === "implementation") continue;
        walk(value, path ? `${path}.${key}` : key);
      }
    }
  };
  walk(dictionary, "");
  return out;
};

describe("every field marked implemented can be pointed at", () => {
  it("carries a code_ref", () => {
    const missing = implementedEntries()
      .filter(([, node]) => !node.code_ref)
      .map(([path]) => path);
    assert.deepEqual(
      missing,
      [],
      "a field claimed as implemented with nothing to point at is a claim nobody can check",
    );
  });
});

describe("the self-report items match what the code collects", () => {
  const collected = SELF_REPORT_ITEMS.map((item) => item.id);

  for (const id of ["mood", "stress", "sleep_quality", "sleep_hours", "event_intensity"]) {
    it(`${id} is collected, and the dictionary says so`, () => {
      assert.ok(collected.includes(id), `${id} is missing from SELF_REPORT_ITEMS`);
      assert.match(migration, new RegExp(`^\\s*${id}\\s`, "m"), `${id} has no column`);
      assert.equal(byId.get(id)?.implementation, "implemented");
    });

    it(`${id} actually reaches the export`, () => {
      // The gap that made "implemented" untrue in a way the word did not cover:
      // collected into `pilot_self_reports`, and the export never read it.
      assert.match(exportSource, new RegExp(`${id}: reading\\.${id}`));
      assert.match(exportRoute, new RegExp(`${id}`));
    });
  }

  it("agrees with the code about the schema version", () => {
    assert.equal(dictionary.daily_self_report.schema_id, SELF_REPORT_SCHEMA_VERSION);
  });

  it("support_contact is absent from the code and unbuilt in the dictionary", () => {
    assert.ok(!collected.includes("support_contact"));
    assert.equal(byId.get("support_contact")?.implementation, "not_implemented");
    assert.match(migration, /support_contact/, "the migration should record why it is absent");
  });

  it("declares no item the code does not collect", () => {
    for (const item of selfReportItems.filter((i) => i.implementation === "implemented")) {
      assert.ok(collected.includes(item.id), `${item.id} is declared implemented but not collected`);
    }
  });

  it("does not let answered_at into the exported reading", () => {
    // It is within minutes of the submission, so it hands back the calendar
    // date the whole module exists to withhold.
    assert.doesNotMatch(code(exportRoute), /answered_at/);
  });
});

describe("the identity fields describe the export that exists", () => {
  it("relative_day names the field the export emits", () => {
    const entry = dictionary.identity.relative_day;
    assert.equal(entry.implementation, "implemented");
    assert.equal(entry.export_field, "day_index");
    assert.match(exportSource, /day_index: number;/);
  });

  it("relative_day is described as 1-based, because the code is", () => {
    // It used to say "登録日を0とした相対日" while the export measured from
    // `collection_started_at` starting at 1 — a different origin AND a
    // different base, which shifts every analysis by a day.
    const entry = dictionary.identity.relative_day;
    assert.doesNotMatch(entry.description, /0とした/);
    assert.match(entry.description, /1起点/);
  });

  it("study_phase is implemented and derived from the study, not from 14/21", () => {
    const entry = dictionary.identity.study_phase;
    assert.equal(entry.implementation, "implemented");
    assert.deepEqual(entry.values, ["baseline", "observation"]);
    assert.match(entry.description, /baseline_days/);
    assert.match(exportRoute, /baseline_days/, "the route must read the study's own split");

    assert.equal(studyPhase(DEFAULT_PHASES.baselineDays, DEFAULT_PHASES), "baseline");
    assert.equal(studyPhase(DEFAULT_PHASES.baselineDays + 1, DEFAULT_PHASES), "observation");
  });
});

describe("the training-use flag", () => {
  const entry = dictionary.consent.model_training_use;

  it("is implemented and in the export", () => {
    assert.equal(entry.implementation, "implemented");
    assert.equal(entry.in_export, true);
    assert.match(exportSource, /model_training_use: boolean;/);
    assert.match(exportSource, /model_training_use: consent\.model_training_use === true/);
  });

  it("says out loud that the column is called something else", () => {
    assert.equal(entry.code_ref, "public.consent_records.future_fine_tuning -> ResearchRow.model_training_use");
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
  const fields = new Map(dictionary.process_telemetry.fields.map((f) => [f.id, f]));

  it("does not claim compose_duration_ms, which exists nowhere", () => {
    assert.doesNotMatch(code(telemetry), /compose_duration_ms/);
    assert.equal(fields.get("compose_duration_ms").implementation, "not_implemented");
  });

  it("does not claim field_order, which only the research console emits", () => {
    assert.doesNotMatch(code(telemetry), /field_order/);
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
      assert.match(telemetry, new RegExp(`^\\s*${name}[?]?: `, "m"), `${name} is not on FieldMetrics`);
    }
    for (const name of actual.aggregate_metrics) {
      assert.match(telemetry, new RegExp(`${name}:`), `${name} is not in aggregate_metrics`);
    }
  });
});
