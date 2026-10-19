import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { counselorSummaryToText, generateCounselorSummary, safetyFlagParts } from "../src/lib/counselor-summary.ts";
import { t } from "../src/lib/i18n/index.ts";

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

/**
 * The text form is what a student copies or downloads and hands to the person
 * supporting them (#471). It used to print `flag.level` and `flag.reasons` as
 * they are stored — `- crisis: self_harm_or_suicide_risk` — while the two
 * screens rendering the same data translated both.
 */
describe("safetyFlagParts", () => {
  const flag = (overrides = {}) => ({
    level: "crisis",
    reasons: ["inability_to_stay_safe"],
    timestamp: "2026-07-02T09:00:00.000Z",
    event_id: "event-1",
    ...overrides,
  });

  it("translates the level and the reasons", () => {
    const parts = safetyFlagParts(flag({ reasons: ["self_harm_or_suicide_risk", "inability_to_stay_safe"] }));
    assert.equal(parts.level, t.safety.level.crisis);
    assert.equal(
      parts.reasons,
      `${t.safety.reason.self_harm_or_suicide_risk}、${t.safety.reason.inability_to_stay_safe}`,
    );
  });

  it("formats the date in the catalogue's locale", () => {
    assert.equal(safetyFlagParts(flag()).date, new Date("2026-07-02T09:00:00.000Z").toLocaleDateString("ja-JP"));
  });

  it("says a record exists when the assessment carried no reason", () => {
    assert.equal(safetyFlagParts(flag({ reasons: [] })).reasons, t.safety.flagRecorded);
  });

  // A level or a reason the catalogue does not have is shown as it is. The
  // alternative — dropping it — would hide that something was recorded.
  it("falls back to the raw code for a level or reason with no translation", () => {
    const parts = safetyFlagParts(flag({ level: "unmapped_level", reasons: ["unmapped_reason"] }));
    assert.equal(parts.level, "unmapped_level");
    assert.equal(parts.reasons, "unmapped_reason");
  });
});

describe("counselorSummaryToText safety section", () => {
  const crisis = () =>
    generateCounselorSummary([
      event(0),
      event(1, { safety_level: "crisis", safety_reasons: ["inability_to_stay_safe", "self_harm_or_suicide_risk"] }),
    ]);

  it("carries no stored code into the text a counsellor is handed", () => {
    const text = counselorSummaryToText(crisis());
    assert.doesNotMatch(text, /crisis/);
    assert.doesNotMatch(text, /inability_to_stay_safe/);
    assert.doesNotMatch(text, /self_harm_or_suicide_risk/);
  });

  it("names the level, the reasons and the day of each flag", () => {
    const summary = crisis();
    const text = counselorSummaryToText(summary);
    const parts = safetyFlagParts(summary.safety_flags[0]);
    assert.ok(text.includes("安全に関する記録"), "the section heading is missing");
    assert.ok(text.includes(`- ${parts.date} · ${parts.level} · ${parts.reasons}`), text);
  });

  it("states the period in the catalogue's locale", () => {
    const summary = crisis();
    const from = new Date(summary.date_range.from).toLocaleDateString("ja-JP");
    const to = new Date(summary.date_range.to).toLocaleDateString("ja-JP");
    assert.ok(counselorSummaryToText(summary).includes(`${from} – ${to}`), "the period is not in ja-JP");
  });

  it("leaves the section out when nothing was flagged", () => {
    assert.doesNotMatch(counselorSummaryToText(generateCounselorSummary([event(0)])), /安全に関する記録/);
  });
});
