import { describe, expect, it } from "vitest";

import { counselorSummaryToText, generateCounselorSummary, type CounselorTimelineEvent } from "./counselor-summary";

const event = (index: number, overrides: Partial<CounselorTimelineEvent> = {}): CounselorTimelineEvent => ({
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
  it("handles zero events without inventing a date range", () => {
    const summary = generateCounselorSummary([], new Date("2026-07-12T00:00:00Z"));
    expect(summary.reflection_count).toBe(0);
    expect(summary.date_range).toEqual({ from: null, to: null });
    expect(summary.sections.every((section) => section.evidence_event_ids.length === 0)).toBe(true);
  });

  it("summarizes one event and keeps its evidence reference", () => {
    const summary = generateCounselorSummary([event(0)]);
    expect(summary.reflection_count).toBe(1);
    expect(summary.sections.find((section) => section.key === "recent_themes")?.items).toContain("anxious (1 reflection)");
    expect(summary.sections.find((section) => section.key === "intensity_trend")?.evidence_event_ids).toEqual(["event-0"]);
  });

  it("ranks recurring patterns across five events", () => {
    const summary = generateCounselorSummary([0, 1, 2, 3, 4].map((index) => event(index)));
    expect(summary.reflection_count).toBe(5);
    expect(summary.sections.find((section) => section.key === "recurring_triggers")?.items[0]).toBe("school workload (5)");
    expect(summary.sections.find((section) => section.key === "intensity_trend")?.items[0]).toContain("increased from 1/5 to 5/5");
  });

  it("shows crisis flags clearly", () => {
    const summary = generateCounselorSummary([event(0), event(1, { safety_level: "crisis", safety_reasons: ["inability_to_stay_safe"] })]);
    expect(summary.safety_flags).toEqual([expect.objectContaining({ level: "crisis", reasons: ["inability_to_stay_safe"] })]);
  });

  it("uses only structured fields and remains non-diagnostic", () => {
    const summary = generateCounselorSummary([event(0, { protective_factors: ["music", "friend support"] })]);
    const text = counselorSummaryToText(summary).toLowerCase();
    expect(text).toContain("music");
    expect(text).not.toContain("private raw quote");
    expect(text).not.toMatch(/you have|diagnosed with|clinical diagnosis/);
    expect(text).toContain("not a clinical assessment or diagnosis");
  });
});
