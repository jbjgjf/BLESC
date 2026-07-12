import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { counselorSummaryToText, generateCounselorSummary } from "../src/lib/counselor-summary.ts";

const event = (index, overrides = {}) => ({
  event_id: `event-${index}`,
  timestamp: `2026-07-${String(index + 1).padStart(2, "0")}T09:00:00.000Z`,
  primary_emotion: "anxious",
  intensity: index + 1,
  triggers: ["school workload"],
  support_needs: ["trusted adult check-in"],
  protective_factors: ["talking with a teacher"],
  safety_level: "none",
  safety_reasons: [],
  ...overrides,
});

describe("generateCounselorSummary", () => {
  it("handles zero events", () => {
    const summary = generateCounselorSummary([], new Date("2026-07-12T00:00:00Z"));
    assert.equal(summary.reflection_count, 0);
    assert.deepEqual(summary.date_range, { from: null, to: null });
    assert.ok(summary.sections.every((section) => section.evidence_event_ids.length === 0));
  });

  it("summarizes one event with evidence", () => {
    const summary = generateCounselorSummary([event(0)]);
    assert.ok(summary.sections.find((section) => section.key === "recent_themes").items.includes("anxious (1 reflection)"));
    assert.deepEqual(summary.sections.find((section) => section.key === "intensity_trend").evidence_event_ids, ["event-0"]);
  });

  it("ranks recurring patterns across five events", () => {
    const summary = generateCounselorSummary([0, 1, 2, 3, 4].map((index) => event(index)));
    assert.equal(summary.reflection_count, 5);
    assert.equal(summary.sections.find((section) => section.key === "recurring_triggers").items[0], "school workload (5)");
    assert.match(summary.sections.find((section) => section.key === "intensity_trend").items[0], /increased from 1\/5 to 5\/5/);
  });

  it("shows crisis flags", () => {
    const summary = generateCounselorSummary([event(0), event(1, { safety_level: "crisis", safety_reasons: ["inability_to_stay_safe"] })]);
    assert.equal(summary.safety_flags[0].level, "crisis");
    assert.deepEqual(summary.safety_flags[0].reasons, ["inability_to_stay_safe"]);
  });

  it("uses structured factors and remains non-diagnostic", () => {
    const text = counselorSummaryToText(generateCounselorSummary([event(0, { protective_factors: ["music", "friend support"] })])).toLowerCase();
    assert.match(text, /music/);
    assert.doesNotMatch(text, /you have|diagnosed with|clinical diagnosis/);
    assert.match(text, /not a clinical assessment or diagnosis/);
  });
});
