import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  DEMO_PARTICIPANT_CODE,
  demoAuditTrails,
  demoChatReply,
  demoCohortRoster,
  demoCounselorSummary,
  demoGraphSnapshots,
  demoStudentOverview,
  demoTimeline,
} from "../src/lib/blesc/demoApi.ts";
import { MY_ENTRIES } from "../src/lib/blesc/fixtures.ts";
import { RAMP_UP_DAYS } from "../src/lib/baseline.ts";

/**
 * The demo is what a school sees first (#17), and it is the one part of the
 * product with no user to notice when it breaks. These tests hold the
 * properties a demo actually depends on: that the story is long enough to show
 * the thing being demonstrated, that the screens agree with each other, and
 * that the two promises made out loud while demonstrating — the summary carries
 * no diary text, and a worrying sentence routes to a person — are true.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

describe("the demo story", () => {
  it("is long enough to show both sides of the baseline gate", () => {
    // A six-day demo can only ever show "not enough data". The point of the
    // signal is not demonstrable until a participant is past the ramp.
    assert.ok(
      MY_ENTRIES.length > RAMP_UP_DAYS,
      `the demo diary is ${MY_ENTRIES.length} days and the ramp is ${RAMP_UP_DAYS}`,
    );
  });

  it("withholds a score for exactly the ramp, then produces one", () => {
    const timeline = demoTimeline();
    const withheld = timeline.filter((day) => day.anomaly_score === null);
    const scored = timeline.filter((day) => day.anomaly_score !== null);

    assert.equal(withheld.length, RAMP_UP_DAYS);
    assert.ok(scored.length > 0);
    // Chronological: every withheld day comes before every scored one, so the
    // timeline reads as a gate lifting rather than as gaps.
    assert.ok(timeline.slice(0, RAMP_UP_DAYS).every((day) => day.anomaly_score === null));
  });

  it("draws no relation to a node that is not in that day's graph", () => {
    for (const snapshot of demoGraphSnapshots()) {
      const ids = new Set(snapshot.nodes_json.map((node) => node.id));
      for (const relation of snapshot.relations_json) {
        assert.ok(ids.has(relation.source_id), `${snapshot.day}: ${relation.source_id} is not in the graph`);
        assert.ok(ids.has(relation.target_id), `${snapshot.day}: ${relation.target_id} is not in the graph`);
      }
    }
  });

  it("gives every day an audit trail, so the last step of the walk is never empty", () => {
    assert.equal(demoAuditTrails().length, MY_ENTRIES.length);
    for (const trail of demoAuditTrails()) {
      assert.ok(trail.events.length > 0);
      assert.ok(trail.events.some((event) => event.stage === "safety_assessment"));
    }
  });
});

describe("what the demo promises out loud", () => {
  it("keeps the diary text out of the shared summary", () => {
    // Said on every walk-through: "共有されるのはこのサマリーだけで、日記の
    // 本文は送られません". A fixture that pasted an entry in would make the
    // sentence false in front of the person being asked to trust it.
    const summary = demoCounselorSummary();
    const shared = JSON.stringify(summary);
    for (const entry of MY_ENTRIES) {
      const sentence = entry.body.split("。")[0];
      assert.ok(sentence.length > 5);
      assert.ok(!shared.includes(sentence), `the summary repeats a diary sentence: ${sentence}`);
    }
  });

  it("shows an educator no observation it cannot explain", () => {
    for (const student of demoCohortRoster()) {
      if (!student.safety_level) continue;
      assert.ok(student.safety_reasons.length > 0, `${student.code} carries a level with no reason`);
      assert.ok(student.safety_at, `${student.code} carries a level with no time`);
    }
  });

  it("gives every student on the roster a distinct code", () => {
    const codes = demoCohortRoster().map((student) => student.code);
    assert.equal(new Set(codes).size, codes.length);
    assert.ok(codes.includes(DEMO_PARTICIPANT_CODE));
  });

  it("routes a worrying sentence to a person, with no model involved", () => {
    const worrying = demoChatReply("もう消えてしまいたい");
    assert.match(worrying.answer, /信頼できる大人|緊急/);
    assert.equal(worrying.status, "demo_fixture");

    const ordinary = demoChatReply("今日は部活のあとに課題をやりました。");
    assert.doesNotMatch(ordinary.answer, /緊急の連絡先/);
  });
});

describe("the wiring", () => {
  it("answers the reads the five-step walk makes", () => {
    // Asserted against the source rather than by calling through Supabase: the
    // failure this catches is a new screen whose read has no demo branch, which
    // shows up as "ログインが必要です" in the middle of a demo.
    const client = readFileSync(resolve(HERE, "../src/api/client.ts"), "utf8");
    const needed = [
      "getEntries",
      "getTimeline",
      "getAnomaly",
      "getExplanation",
      "getGraphSnapshots",
      "getAuditTrails",
      "generateCounselorSummary",
      "listOversightRequests",
      "listMySummaryShares",
      "counselorListSharedSummaries",
      "getCohortRoster",
      "getStudentOverviewForEducator",
      "createChat",
    ];
    for (const method of needed) {
      const body = client.slice(client.indexOf(`static async ${method}(`));
      assert.ok(
        body.slice(0, 600).includes("readDemoFlag()"),
        `${method} has no demo branch, so the demo stops at this screen`,
      );
    }
  });

  it("shows the educator the same participant the student screens follow", () => {
    const overview = demoStudentOverview(demoCohortRoster()[0].participant_id);
    assert.ok(overview);
    assert.equal(overview.signals.length, MY_ENTRIES.length);
    assert.ok(overview.themes.length > 0);
  });
});
