import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { counselorSummaryToText, formatSafetyFlag, generateCounselorSummary } from "../src/lib/counselor-summary.ts";

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
    assert.ok(summary.sections.find((section) => section.key === "recent_themes").items.includes("anxious（1件）"));
    assert.deepEqual(summary.sections.find((section) => section.key === "intensity_trend").evidence_event_ids, ["event-0"]);
  });

  it("ranks recurring patterns across five events", () => {
    const summary = generateCounselorSummary([0, 1, 2, 3, 4].map((index) => event(index)));
    assert.equal(summary.reflection_count, 5);
    assert.equal(summary.sections.find((section) => section.key === "recurring_triggers").items[0], "school workload（5件）");
    assert.match(summary.sections.find((section) => section.key === "intensity_trend").items[0], /1\/5 から 5\/5 へ上がっています/);
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
    assert.match(text, /診断や臨床的な評価ではありません/);
  });
});

// The copied / downloaded text is the document a student hands over (#471). It
// used to print `- crisis: self_harm_or_suicide_risk`; the screens translated.
describe("counselorSummaryToText safety section", () => {
  const crisis = event(1, {
    timestamp: "2026-07-02T09:00:00.000Z",
    safety_level: "crisis",
    safety_reasons: ["self_harm_or_suicide_risk", "inability_to_stay_safe"],
  });

  it("words the level and reasons in Japanese, with the date", () => {
    const text = counselorSummaryToText(generateCounselorSummary([event(0), crisis]));
    assert.doesNotMatch(text, /crisis/);
    assert.doesNotMatch(text, /self_harm_or_suicide_risk/);
    assert.doesNotMatch(text, /inability_to_stay_safe/);
    assert.match(text, /- 2026\/7\/2 · すぐに確認 · 自傷・自殺に関する直接的な表現、安全を保てないという表現/);
  });

  it("gives the period in ja-JP regardless of the runtime locale", () => {
    const text = counselorSummaryToText(generateCounselorSummary([event(0), event(4)]));
    assert.match(text, /2026\/7\/1 – 2026\/7\/5/);
  });

  it("falls back to the raw code when there is no translation, without dropping the line", () => {
    const line = formatSafetyFlag({ level: "unheard_of", reasons: ["new_reason_code"], timestamp: "2026-07-02T09:00:00.000Z" });
    assert.equal(line, "2026/7/2 · unheard_of · new_reason_code");
  });

  it("says a flag was recorded when it has no reasons", () => {
    assert.equal(formatSafetyFlag({ level: "elevated", reasons: [], timestamp: "2026-07-02T09:00:00.000Z" }), "2026/7/2 · 確認が必要 · 記録あり");
  });

  it("is the one wording both screens use", async () => {
    const { readFileSync } = await import("node:fs");
    for (const page of ["../src/app/support-summary/page.tsx", "../src/app/oversight/page.tsx"]) {
      const source = readFileSync(new URL(page, import.meta.url), "utf8");
      assert.match(source, /formatSafetyFlag\(flag\)/, `${page} formats safety flags itself again`);
      assert.doesNotMatch(source, /t\.safety\.reason\[reason\]/, `${page} formats safety flags itself again`);
    }
  });
});
