import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  studyDayWindow,
  submittedDays,
  summarizeSubmissions,
  windowStartInstant,
} from "../src/lib/dailySubmissions.ts";

// CI runs in UTC, so every case uses fixed instants, several inside the
// 00:00–09:00 JST window where the UTC and JST calendars disagree.

describe("studyDayWindow", () => {
  it("ends on today's JST date, not the UTC one", () => {
    // 00:30 JST on 2026-11-15 is 15:30 UTC on 2026-11-14.
    const now = new Date("2026-11-14T15:30:00.000Z");
    const days = studyDayWindow(now, 3);
    assert.deepEqual(days, ["2026-11-13", "2026-11-14", "2026-11-15"]);
  });

  it("crosses a month boundary", () => {
    assert.deepEqual(studyDayWindow(new Date("2026-12-01T03:00:00.000Z"), 3), [
      "2026-11-29",
      "2026-11-30",
      "2026-12-01",
    ]);
  });

  it("starts the read a day early so the first morning is not lost", () => {
    const window = ["2026-11-09", "2026-11-10"];
    // 07:00 JST on 11-09 is 22:00 UTC on 11-08 — before 11-09T00:00Z.
    const firstMorning = "2026-11-08T22:00:00.000Z";
    assert.ok(firstMorning >= windowStartInstant(window));
  });
});

describe("submittedDays", () => {
  const window = ["2026-11-13", "2026-11-14"];

  it("files a 08:00 JST entry under that JST day", () => {
    const rows = [{ participant_id: "a", created_at: "2026-11-13T23:00:00.000Z" }]; // 08:00 JST 11-14
    assert.deepEqual([...submittedDays(rows, window).get("a")], ["2026-11-14"]);
  });

  it("counts two entries on one school day once", () => {
    const rows = [
      { participant_id: "a", created_at: "2026-11-13T22:00:00.000Z" }, // 07:00 JST 11-14
      { participant_id: "a", created_at: "2026-11-14T12:00:00.000Z" }, // 21:00 JST 11-14
    ];
    assert.equal(submittedDays(rows, window).get("a").size, 1);
  });

  it("drops rows outside the window", () => {
    const rows = [{ participant_id: "a", created_at: "2026-11-11T12:00:00.000Z" }];
    assert.equal(submittedDays(rows, window).get("a"), undefined);
  });
});

describe("summarizeSubmissions", () => {
  const now = new Date("2026-11-14T11:00:00.000Z"); // 20:00 JST 11-14

  it("counts who submitted today, including a student with no rows at all", () => {
    const rows = [
      { participant_id: "a", created_at: "2026-11-14T10:00:00.000Z" }, // today
      { participant_id: "b", created_at: "2026-11-13T10:00:00.000Z" }, // yesterday
    ];
    const summary = summarizeSubmissions(["a", "b", "c"], rows, now, 7);
    assert.equal(summary.today, "2026-11-14");
    assert.equal(summary.days.length, 7);
    assert.equal(summary.submittedToday, 1);
    assert.equal(summary.total, 3);
    assert.equal(summary.byParticipant.get("c"), undefined);
    assert.ok(summary.byParticipant.get("b").has("2026-11-13"));
  });

  it("ignores rows for students not on the roster", () => {
    const rows = [{ participant_id: "x", created_at: "2026-11-14T10:00:00.000Z" }];
    assert.equal(summarizeSubmissions(["a"], rows, now).submittedToday, 0);
  });
});

describe("the educator read stays inside the display policy", () => {
  const client = readFileSync(new URL("../src/api/client.ts", import.meta.url), "utf8");
  const start = client.indexOf("static async getCohortDailySubmissions");
  const body = client.slice(start, client.indexOf("\n  }\n", start));

  it("reads only the instant of safety-assessment rows", () => {
    assert.ok(start > 0, "getCohortDailySubmissions exists");
    assert.match(body, /"participant_id, created_at"/);
    assert.match(body, /artifact_type", "safety_assessment"/);
    assert.doesNotMatch(body, /from\("entries"\)/);
  });

  it("refuses a truncated read instead of showing a short list", () => {
    assert.match(body, /SUBMISSION_READ_LIMIT/);
    assert.match(body, /throw/);
  });
});
