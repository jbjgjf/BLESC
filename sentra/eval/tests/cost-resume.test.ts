import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MODELS } from "../src/config.ts";
import { CostGuard, CostHardStop } from "../src/cost.ts";
import { executeRun } from "../src/runner.ts";
import { buildMatrix } from "../src/scenarios.ts";
import { FakeSupabase } from "./fakes/supabase.ts";
import { fakeDeps, runOptions } from "./fakes/runner.ts";

// #266: every executeRun started a fresh CostGuard, so a run stopped at US$80
// could be resumed into another US$80, and the resumed run overwrote
// actual_cost_usd with only its own spend. OpenAI Evals registration ran
// outside the guard entirely.

const cases = buildMatrix().filter((scenario) => scenario.turnTarget <= 12).slice(0, 3);
// 200k input tokens on the simulator model: US$0.05 per student message at
// today's price. Five messages per case, so US$0.25 a case.
const spendingStudent = async (_scenario: unknown, _transcript: unknown, cost: CostGuard) => {
  cost.add(MODELS.studentSimulator, { inputTokens: 200_000, outputTokens: 0 });
  return "hi";
};

function resumable(db: FakeSupabase, actualCostUsd: number | null) {
  db.seed("evaluation_runs", [{ id: "run-1", mode: "full", status: "aborted", actual_cost_usd: actualCostUsd }]);
}

const costWrites = (db: FakeSupabase) => db.calls("evaluation_runs", "update")
  .map((call) => (call.values as Record<string, unknown>).actual_cost_usd)
  .filter((value): value is number => typeof value === "number");

describe("spend across a resumed run (#266)", () => {
  it("a cost guard can start from what was already spent", () => {
    const guard = new CostGuard({ alreadySpentUsd: 79.9 });
    assert.equal(guard.total(), 79.9);
    assert.throws(() => guard.add(MODELS.studentSimulator, { inputTokens: 1_000_000, outputTokens: 0 }), CostHardStop);
  });

  it("resumes from the recorded spend and never writes less than it", async () => {
    const db = new FakeSupabase();
    resumable(db, 50);
    const deps = fakeDeps({ studentMessage: spendingStudent });
    await executeRun(runOptions(db, cases, { resumeRunId: "run-1" }), deps);
    const messages = deps.driver.calls.filter((call) => call === "chat").length;
    const writes = costWrites(db);
    assert.ok(writes.length > 0);
    for (let i = 0; i < writes.length; i += 1) {
      assert.ok(writes[i] >= 50, `write ${i} = ${writes[i]} is below the US$50 recorded before the resume`);
      if (i > 0) assert.ok(writes[i] >= writes[i - 1], `actual_cost_usd went down: ${writes[i - 1]} -> ${writes[i]}`);
    }
    const final = db.rows("evaluation_runs")[0].actual_cost_usd as number;
    assert.ok(Math.abs(final - (50 + messages * 0.05)) < 1e-9, `final ${final} after ${messages} messages`);
  });

  it("records spend after every case, so a crash does not lose it", async () => {
    const db = new FakeSupabase();
    await executeRun(runOptions(db, cases), fakeDeps({ studentMessage: spendingStudent }));
    assert.ok(costWrites(db).length >= cases.length, `only ${costWrites(db).length} spend writes for ${cases.length} cases`);
  });

  it("does not give a run that reached the hard stop a fresh budget", async () => {
    const db = new FakeSupabase();
    resumable(db, 79.9);
    const deps = fakeDeps({ studentMessage: spendingStudent });
    await assert.rejects(executeRun(runOptions(db, cases, { resumeRunId: "run-1" }), deps), CostHardStop);
    const [run] = db.rows("evaluation_runs");
    assert.equal(run.status, "aborted");
    assert.ok((run.actual_cost_usd as number) >= 79.9);
  });

  it("refuses before driving anything when the run is already at the hard stop", async () => {
    const db = new FakeSupabase();
    resumable(db, 80);
    const deps = fakeDeps({ studentMessage: spendingStudent });
    await assert.rejects(executeRun(runOptions(db, cases, { resumeRunId: "run-1" }), deps), CostHardStop);
    assert.deepEqual(deps.driver.calls, []);
  });
});

describe("OpenAI Evals registration (#266)", () => {
  it("does not register unless asked", async () => {
    const db = new FakeSupabase();
    let called = false;
    await executeRun(runOptions(db, cases), fakeDeps({ registerEval: async () => { called = true; return {}; } }));
    assert.equal(called, false);
  });

  it("when asked, charges the guard first, and reports a failure as a finding", async () => {
    const db = new FakeSupabase();
    let spentBefore = -1;
    const { summary } = await executeRun(runOptions(db, cases, { registerEval: true }), fakeDeps({
      registerEval: async () => ({ error: "evals endpoint said no" }),
      judge: async (_scenario, _transcript, cost) => {
        spentBefore = cost.total();
        return { kind: "verdict", result: { verdict: "pass", safetyScore: 1, empathyScore: 1, boundaryScore: 1, rationale: "" } };
      },
    }));
    assert.ok(summary.estimatedCostUsd > spentBefore, "the registration's estimated cost was charged");
    assert.ok(summary.findings.some((finding) => finding.includes("evals endpoint said no")), summary.findings.join(" | "));
  });

  it("skips registration that would cross the hard stop, and says so", async () => {
    const db = new FakeSupabase();
    resumable(db, 79.5);
    let called = false;
    // Spend the run up to just under the limit, so the conversations finish
    // and only the registration would cross it.
    const topUp = async (_scenario: unknown, _transcript: unknown, cost: CostGuard) => {
      const usd = 79.995 - cost.total();
      if (usd > 0) cost.add(MODELS.studentSimulator, { inputTokens: Math.floor((usd / 0.25) * 1_000_000), outputTokens: 0 });
      return "hi";
    };
    const { summary } = await executeRun(runOptions(db, cases.slice(0, 1), { resumeRunId: "run-1", registerEval: true }), fakeDeps({
      studentMessage: topUp,
      registerEval: async () => { called = true; return {}; },
    }));
    assert.equal(called, false);
    assert.ok(summary.findings.some((finding) => /hard stop/i.test(finding)), summary.findings.join(" | "));
  });
});
