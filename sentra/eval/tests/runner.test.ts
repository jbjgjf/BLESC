import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ObservationNotReady } from "../src/browser.ts";
import { executeRun } from "../src/runner.ts";
import { buildMatrix } from "../src/scenarios.ts";
import { FakeSupabase } from "./fakes/supabase.ts";
import { PASSING_JUDGE, fakeDeps, runOptions } from "./fakes/runner.ts";

// executeRun end to end, with every outside dependency faked (#385). These are
// the only tests that exercise the run loop itself — resume, status, cost,
// what gets written where — and they spend nothing.

const firstCases = (count: number) => buildMatrix().filter((scenario) => scenario.turnTarget <= 12).slice(0, count);

describe("executeRun with fakes", () => {
  it("drives each case through the product, grades it, and records a completed run", async () => {
    const db = new FakeSupabase();
    const deps = fakeDeps();
    const scenarios = firstCases(3);
    const { runId, summary } = await executeRun(runOptions(db, scenarios), deps);

    assert.equal(summary.totals.conversations, 3);
    assert.equal(summary.totals.passed, 3, JSON.stringify(summary.findings));
    assert.equal(summary.verdict, "ready");
    assert.equal(deps.driver.calls.filter((call) => call === "submitJournal").length, 3);

    const cases = db.rows("evaluation_cases");
    assert.deepEqual(cases.map((row) => row.case_key).sort(), scenarios.map((scenario) => scenario.caseKey).sort());
    assert.ok(cases.every((row) => row.status === "passed"));

    const [run] = db.rows("evaluation_runs");
    assert.equal(run.id, runId);
    assert.equal(run.status, "completed");
    assert.equal(run.verdict, "ready");
  });
});

describe("a case the judge could not grade (#285)", () => {
  it("is incomplete, counted, queued for review, and keeps the run from ready", async () => {
    const db = new FakeSupabase();
    const scenarios = firstCases(2);
    let calls = 0;
    const deps = fakeDeps({
      // The first case's judge refuses; the second passes.
      judge: async () => (calls++ === 0
        ? { kind: "unavailable", reason: "judge refused to grade" }
        : { kind: "verdict", result: { ...PASSING_JUDGE } }),
    });
    const { summary } = await executeRun(runOptions(db, scenarios), deps);

    const ungraded = db.rows("evaluation_cases").find((row) => row.case_key === scenarios[0].caseKey)!;
    assert.equal(ungraded.status, "incomplete", "an ungraded case is never a pass");
    assert.ok((ungraded.failure_kinds as string[]).includes("judge_unavailable"));
    assert.equal(ungraded.human_review, true);

    assert.equal(summary.totals.judgeUnavailable, 1);
    assert.equal(summary.totals.passed, 1);
    assert.notEqual(summary.verdict, "ready");
    assert.ok(summary.recommendedActions.some((action) => /could not grade/i.test(action)), summary.recommendedActions.join(" | "));
    assert.ok(summary.findings.some((finding) => /could not grade/i.test(finding)), summary.findings.join(" | "));
  });
});

describe("a case whose journal the product never finished processing (#305)", () => {
  it("is an error marked observation_not_ready, not a graded case", async () => {
    const db = new FakeSupabase();
    const deps = fakeDeps({
      submitJournal: async () => { throw new ObservationNotReady("journal", "the journal submission did not finish within 90s"); },
    });
    const { summary } = await executeRun(runOptions(db, firstCases(1)), deps);
    const [row] = db.rows("evaluation_cases");
    assert.equal(row.status, "error");
    assert.ok((row.failure_kinds as string[]).includes("observation_not_ready"), JSON.stringify(row.failure_kinds));
    assert.match(String(row.human_review_reason), /did not finish/);
    assert.equal(deps.driver.calls.includes("chat"), false, "no observation was taken after the journal");
    assert.equal(summary.totals.passed, 0);
    assert.notEqual(summary.verdict, "ready");
    assert.ok(summary.findings.some((finding) => finding.includes("observation_not_ready")), summary.findings.join(" | "));
  });
});
