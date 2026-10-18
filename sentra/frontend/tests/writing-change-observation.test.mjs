/**
 * The 「書きぶりの変化」 observation on the educator side (#468).
 *
 * `docs/educator_display_policy.md` in three assertions: no observation without
 * evidence (rule 2), no number in what an educator reads (rule 1), and wording
 * that states an observation relative to the student's own past rather than an
 * inference about them. Plus the two gates on the write path that are easiest
 * to lose in a refactor: collection-only mode and telemetry consent.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  WRITING_CHANGE_OBSERVATION_KIND,
  describeWritingChange,
  latestWritingChangeByParticipant,
  parseWritingChangeObservation,
} from "../src/lib/writingChangeObservation.ts";
import { WRITING_CHANGE_FEATURES } from "../src/lib/writingDynamics.ts";
import { t } from "../src/lib/i18n/index.ts";

const read = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");

const row = (overrides = {}) => ({
  participant_id: "p1",
  kind: WRITING_CHANGE_OBSERVATION_KIND,
  observed_at: "2026-10-18T12:30:00.000Z",
  surface: "journal",
  field_name: "journal_entry",
  evidence: [{ feature: "max_pause_ms", direction: "higher" }],
  baseline_window_days: 14,
  ...overrides,
});

describe("parseWritingChangeObservation", () => {
  it("keeps a row with evidence it can describe", () => {
    const parsed = parseWritingChangeObservation(row());
    assert.equal(parsed?.kind, "writing_change");
    assert.deepEqual(parsed?.evidence, [{ feature: "max_pause_ms", direction: "higher" }]);
    assert.equal(parsed?.baseline_window_days, 14);
  });

  it("drops a row with no evidence, unknown evidence, or no time (rule 2)", () => {
    assert.equal(parseWritingChangeObservation(row({ evidence: [] })), null);
    assert.equal(parseWritingChangeObservation(row({ evidence: [{ feature: "mood", direction: "higher" }] })), null);
    assert.equal(parseWritingChangeObservation(row({ evidence: [{ feature: "pause_ratio", direction: "worse" }] })), null);
    assert.equal(parseWritingChangeObservation(row({ observed_at: null })), null);
    assert.equal(parseWritingChangeObservation(row({ kind: "anomaly" })), null);
  });

  it("carries no number from the evidence through to the screen (rule 1)", () => {
    const parsed = parseWritingChangeObservation(
      row({ evidence: [{ feature: "pause_ratio", direction: "higher", z: 3.4, value: 0.5 }] }),
    );
    assert.deepEqual(parsed?.evidence, [{ feature: "pause_ratio", direction: "higher" }]);
  });

  it("keeps only the latest showable observation per student", () => {
    const latest = latestWritingChangeByParticipant([
      row({ participant_id: "p1", evidence: [] }),
      row({ participant_id: "p1", observed_at: "2026-10-17T09:00:00.000Z" }),
      row({ participant_id: "p1", observed_at: "2026-10-16T09:00:00.000Z" }),
      row({ participant_id: "p2" }),
    ]);
    assert.equal(latest.get("p1")?.observed_at, "2026-10-17T09:00:00.000Z");
    assert.ok(latest.has("p2"));
  });
});

describe("the wording", () => {
  it("describes every feature in both directions, against the student's own past", () => {
    for (const feature of WRITING_CHANGE_FEATURES) {
      for (const direction of ["higher", "lower"]) {
        const text = describeWritingChange({ feature, direction });
        assert.ok(text.includes("本人のふだん"), `${feature}/${direction}: must say what it is compared with`);
        assert.ok(!/\d/.test(text), `${feature}/${direction}: no numbers`);
      }
    }
  });

  it("states its basis and that the text was not used", () => {
    const basis = t.writingChange.basis(14);
    assert.ok(basis.includes("14 日"));
    assert.ok(basis.includes("本文は使っていない"));
    assert.ok(basis.includes("推論なし"));
  });

  it("names no state of mind", () => {
    const copy = JSON.stringify(t.writingChange.evidence);
    for (const inference of ["不安", "落ち込", "ストレス", "悩", "つらい", "危険", "リスク"]) {
      assert.ok(!copy.includes(inference), `writing-change copy must not infer: ${inference}`);
    }
  });
});

describe("the write path's gates", () => {
  const writer = read("../src/lib/server/supabaseWriter.ts");

  it("withholds the comparison and the observation during a collection window", () => {
    assert.match(writer, /journal && collectionOnly\)[\s\S]{0,200}COLLECTION_ONLY_STATUS/);
    assert.match(writer, /collection_only:writing_change_observations/);
    // The observation is written only from a comparison, and none is made in a window.
    assert.match(writer, /if \(!outcome \|\| !evidence\) return;/);
  });

  it("writes nothing derived from telemetry without telemetry consent", () => {
    assert.match(writer, /if \(writtenSessionId && telemetryPermitted\)/);
  });

  it("gives educators the evidence list, not the comparison", () => {
    const upsert = writer.slice(writer.indexOf('from("writing_change_observations")'));
    const body = upsert.slice(0, upsert.indexOf("onConflict"));
    assert.ok(!/z_scores|baseline_comparison|outcome\b(?!\.observed_days)/.test(body.replace("observedDays", "")));
  });
});
