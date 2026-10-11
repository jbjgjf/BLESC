import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeVerdict } from "../src/artifacts.ts";
import { runCli } from "../src/commands.ts";
import { ESCALATION_MARKERS, type CaseResult } from "../src/contracts.ts";
import { ResumeSelectionMismatch, executeRun } from "../src/runner.ts";
import { buildMatrix } from "../src/scenarios.ts";
import { restorePriorCases, summarizeRun, type PriorCaseRow } from "../src/summary.ts";
import { FakeSupabase } from "./fakes/supabase.ts";
import { FAKE_ENV, fakeDeps, runOptions } from "./fakes/runner.ts";

// #376: --resume restored graded cases into the result set, but marked a row
// "done" before checking it could be restored. A row whose case was not in the
// current selection was neither re-run nor counted, and the partial verdict was
// written as `completed`.

const cases = buildMatrix().filter((scenario) => scenario.turnTarget <= 12).slice(0, 4);

const GRADED = {
  criticalSafetyViolation: false, missedEscalation: false, falseEscalation: false,
  unsupportedInference: false, rawContentExposure: false, authConsentBypass: false,
  incomplete: false, providerFallback: false, details: [],
};

const priorRow = (caseKey: string, over: Partial<PriorCaseRow> = {}): PriorCaseRow => ({
  id: `case-${caseKey}`, case_key: caseKey, status: "passed",
  transcript_json: [], deterministic_json: GRADED, judge_json: null,
  failure_kinds: [], human_review: false, human_review_reason: null, trace_ref: null,
  ...over,
});

/** A prior run in the fake database: its row, and graded rows for `keys`. */
function priorRun(db: FakeSupabase, keys: string[], over: Record<string, unknown> = {}) {
  db.seed("evaluation_runs", [{ id: "run-1", mode: "full", status: "aborted", actual_cost_usd: 1, ...over }]);
  db.seed("evaluation_cases", keys.map((key) => ({ ...priorRow(key), run_id: "run-1" })));
}

describe("restoring a resumed run (#376)", () => {
  it("marks a case done only once it has actually been restored", () => {
    const rows = cases.map((scenario) => priorRow(scenario.caseKey));
    const restored = restorePriorCases(rows, cases.slice(0, 1));
    assert.equal(restored.results.length, 1);
    assert.deepEqual([...restored.doneKeys], [cases[0].caseKey]);
    assert.deepEqual(restored.outsideSelection.sort(), cases.slice(1).map((s) => s.caseKey).sort());
  });

  it("re-runs a graded row it cannot restore instead of skipping it", () => {
    const restored = restorePriorCases([priorRow(cases[0].caseKey, { deterministic_json: null })], cases);
    assert.equal(restored.doneKeys.has(cases[0].caseKey), false);
    assert.deepEqual(restored.rerunKeys, [cases[0].caseKey]);
  });

  it("refuses to resume with a narrower selection than the run's, before spending anything", async () => {
    const db = new FakeSupabase();
    priorRun(db, cases.map((s) => s.caseKey));
    const deps = fakeDeps();
    await assert.rejects(
      executeRun(runOptions(db, cases.slice(0, 1), { resumeRunId: "run-1" }), deps),
      ResumeSelectionMismatch,
    );
    assert.deepEqual(deps.driver.calls, [], "no case was driven");
    assert.notEqual(db.rows("evaluation_runs")[0].status, "completed");
  });

  it("refuses to resume a run of another mode", async () => {
    const db = new FakeSupabase();
    priorRun(db, [cases[0].caseKey], { mode: "full" });
    await assert.rejects(
      executeRun(runOptions(db, cases, { resumeRunId: "run-1", mode: "smoke" }), fakeDeps()),
      ResumeSelectionMismatch,
    );
  });

  it("re-runs the unrestorable row and covers the whole run when the selection matches", async () => {
    const db = new FakeSupabase();
    priorRun(db, cases.map((s) => s.caseKey));
    db.rows("evaluation_cases")[0].deterministic_json = null;
    const deps = fakeDeps();
    const { summary } = await executeRun(runOptions(db, cases, { resumeRunId: "run-1" }), deps);
    assert.equal(deps.driver.calls.filter((call) => call === "submitJournal").length, 1, "only the unrestorable case ran");
    assert.equal(summary.totals.conversations, cases.length);
    assert.equal(db.rows("evaluation_runs")[0].status, "completed");
  });
});

describe("a run that does not cover its cases (#376)", () => {
  const passed = (scenario: (typeof cases)[number]): CaseResult => ({
    scenario: { ...scenario, expected: { ...scenario.expected, escalationMarkers: ESCALATION_MARKERS } },
    transcript: [], deterministic: { ...GRADED }, status: "passed", failureKinds: [], humanReview: false,
    usage: { inputTokens: 0, outputTokens: 0 },
  });

  it("is never ready, and says how much it covered", () => {
    const summary = summarizeRun({
      label: "x", mode: "full", results: [passed(cases[0])], reviewerCheckPassed: true, spentUsd: 0, evalRefs: [],
      expectedCaseKeys: cases.map((s) => s.caseKey),
    });
    assert.equal(summary.verdict, "incomplete");
    assert.deepEqual(summary.coverage, { expected: cases.length, covered: 1 });
    assert.ok(summary.findings.some((finding) => /1 of 4/.test(finding)), summary.findings.join(" | "));
  });

  it("an empty result set is incomplete, not ready", () => {
    assert.equal(computeVerdict([]), "incomplete");
  });
});

describe("the CLI refuses a resume it cannot complete (#376)", () => {
  it("rejects --resume with --limit before resetting or provisioning anything", async () => {
    const calls: string[] = [];
    const errors: string[] = [];
    const code = await runCli(["full", "--confirm-full", "--resume", "run-1", "--limit", "5"], {
      loadEnv: () => FAKE_ENV,
      resetSyntheticData: async () => { calls.push("reset"); return { wipedUsers: 0, deleted: [], missing: [], excluded: [] }; },
      provisionAccounts: async () => { calls.push("provision"); throw new Error("not reached"); },
      adminClient: () => { throw new Error("not reached"); },
      executeRun: async () => { calls.push("executeRun"); throw new Error("not reached"); },
      now: () => new Date(0),
      log: () => undefined,
      error: (message) => errors.push(message),
    });
    assert.equal(code, 2);
    assert.deepEqual(calls, []);
    assert.match(errors.join("\n"), /--resume cannot be combined with --limit/);
  });
});
