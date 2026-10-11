import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MATRIX, SYNTHETIC_ACCOUNTS } from "../src/config.ts";
import { UsageError, parseArgs, runCli, selectScenarios, type CliDeps } from "../src/commands.ts";
import { PERSONAS, personaEmail } from "../src/personas.ts";
import type { RunOptions } from "../src/runner.ts";
import { buildMatrix } from "../src/scenarios.ts";
import { FAKE_ENV, fakeAccounts } from "./fakes/runner.ts";

// The CLI's decisions, with every side effect faked (#385). Which command does
// what, and what it refuses, used to be reachable only by running it.

function cli(overrides: Partial<CliDeps> = {}) {
  const calls: string[] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  const runs: RunOptions[] = [];
  const deps: CliDeps = {
    loadEnv: () => { calls.push("loadEnv"); return FAKE_ENV; },
    resetSyntheticData: async () => {
      calls.push("reset");
      return { wipedUsers: 33, deleted: [{ table: "entries", rows: 4 }], missing: [], excluded: [{ table: "legal_acceptances", reason: "append-only" }] };
    },
    provisionAccounts: async () => { calls.push("provision"); return fakeAccounts(); },
    adminClient: () => { calls.push("adminClient"); return {} as ReturnType<CliDeps["adminClient"]>; },
    executeRun: async (options) => {
      calls.push("executeRun");
      runs.push(options);
      return { runId: "run-1", summary: { verdict: "ready" } as Awaited<ReturnType<CliDeps["executeRun"]>>["summary"] };
    },
    now: () => new Date("2026-10-11T01:02:03.456Z"),
    log: (message) => logs.push(message),
    error: (message) => errors.push(message),
    ...overrides,
  };
  return { deps, calls, logs, errors, runs };
}

describe("argument parsing", () => {
  it("defaults every flag off", () => {
    assert.deepEqual(parseArgs(["smoke"]), {
      command: "smoke", confirmFull: false, resumeRunId: undefined, limit: undefined, media: false, registerEval: false,
    });
  });

  it("reads the flags", () => {
    const args = parseArgs(["full", "--confirm-full", "--resume", "abc", "--media", "--register-eval"]);
    assert.equal(args.confirmFull, true);
    assert.equal(args.resumeRunId, "abc");
    assert.equal(args.media, true);
    assert.equal(args.registerEval, true);
    assert.equal(parseArgs(["smoke", "--limit", "3"]).limit, 3);
  });

  it("refuses a limit that is not a positive integer instead of running everything", () => {
    for (const bad of ["abc", "0", "-2", "1.5"]) assert.throws(() => parseArgs(["full", "--limit", bad]), UsageError, bad);
  });

  it("refuses a flag that is missing its value", () => {
    assert.throws(() => parseArgs(["full", "--resume"]), UsageError);
    assert.throws(() => parseArgs(["full", "--resume", "--confirm-full"]), UsageError);
  });
});

describe("case selection", () => {
  const all = buildMatrix();
  it("smoke is the 12 stratified cases, full is the matrix, a limit cuts either", () => {
    assert.equal(selectScenarios(parseArgs(["smoke"]), all).length, MATRIX.smokeCases);
    assert.equal(selectScenarios(parseArgs(["full"]), all).length, MATRIX.conversations);
    assert.equal(selectScenarios(parseArgs(["full", "--limit", "5"]), all).length, 5);
  });
});

describe("command dispatch", () => {
  it("rejects an unknown command before reading the environment", async () => {
    const { deps, calls, errors } = cli();
    assert.equal(await runCli(["smok"], deps), 2);
    assert.deepEqual(calls, []);
    assert.match(errors.join("\n"), /usage:/);
  });

  it("provision provisions and nothing else", async () => {
    const { deps, calls } = cli();
    assert.equal(await runCli(["provision"], deps), 0);
    assert.deepEqual(calls, ["loadEnv", "provision"]);
  });

  it("reset resets and prints what it did not reset", async () => {
    const { deps, calls, logs } = cli();
    assert.equal(await runCli(["reset"], deps), 0);
    assert.deepEqual(calls, ["loadEnv", "reset"]);
    assert.ok(logs.some((line) => line.includes("not reset: legal_acceptances")), logs.join("\n"));
  });

  it("full refuses without --confirm-full, before resetting anything", async () => {
    const { deps, calls, errors } = cli();
    assert.equal(await runCli(["full"], deps), 2);
    assert.deepEqual(calls, ["loadEnv"]);
    assert.match(errors.join("\n"), /--confirm-full/);
  });

  it("smoke resets, provisions, then runs the 12 smoke cases with media", async () => {
    const { deps, calls, runs } = cli();
    assert.equal(await runCli(["smoke"], deps), 0);
    assert.deepEqual(calls, ["loadEnv", "reset", "provision", "adminClient", "executeRun"]);
    const [run] = runs;
    assert.equal(run.mode, "smoke");
    assert.equal(run.scenarios.length, MATRIX.smokeCases);
    assert.equal(run.captureMedia, true);
    assert.equal(run.registerEval, false);
    assert.equal(run.label, "smoke-2026-10-11T01-02-03");
  });

  it("full --confirm-full runs the whole matrix, media only when asked", async () => {
    const plain = cli();
    assert.equal(await runCli(["full", "--confirm-full"], plain.deps), 0);
    assert.equal(plain.runs[0].scenarios.length, MATRIX.conversations);
    assert.equal(plain.runs[0].captureMedia, false);
    const withMedia = cli();
    await runCli(["full", "--confirm-full", "--media", "--resume", "run-9"], withMedia.deps);
    assert.equal(withMedia.runs[0].captureMedia, true);
    assert.equal(withMedia.runs[0].resumeRunId, "run-9");
  });
});

describe("personas", () => {
  it("has 28 personas: 20 writing English, then 8 writing Japanese", () => {
    assert.equal(PERSONAS.length, MATRIX.personas);
    assert.deepEqual(PERSONAS.map((persona) => persona.language), [...Array(20).fill("en"), ...Array(8).fill("ja")]);
    assert.deepEqual(PERSONAS.map((persona) => persona.accountIndex), Array.from({ length: 28 }, (_, index) => index + 1));
  });

  it("maps each persona to its provisioned student account", () => {
    assert.deepEqual(PERSONAS.map(personaEmail), [...SYNTHETIC_ACCOUNTS.students]);
  });
});
