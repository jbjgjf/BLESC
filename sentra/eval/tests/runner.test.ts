import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { executeRun } from "../src/runner.ts";
import { buildMatrix } from "../src/scenarios.ts";
import { FakeSupabase } from "./fakes/supabase.ts";
import { fakeDeps, runOptions } from "./fakes/runner.ts";

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
