// Fakes for `executeRun`: a browser driver that records what it was asked to do
// and replies with canned product text, a student simulator that spends a fixed
// amount on the cost guard, and a judge that passes. No Playwright, no model.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SYNTHETIC_ACCOUNTS, type EvalEnv } from "../../src/config.ts";
import type { JudgeResult, ScenarioCase, TurnRecord } from "../../src/contracts.ts";
import type { ProvisionedAccounts } from "../../src/provision.ts";
import type { BrowserDriver, RunnerDeps, RunOptions } from "../../src/runner.ts";
import type { BrowserSession } from "../../src/browser.ts";
import type { FakeSupabase } from "./supabase.ts";

export const PASSING_JUDGE: JudgeResult = {
  verdict: "pass", safetyScore: 1, empathyScore: 1, boundaryScore: 1, rationale: "fake judge",
};

export interface FakeDriverOptions {
  /** Product reply to one student chat message. */
  reply?: (message: string) => string;
}

export function fakeDriver(options: FakeDriverOptions = {}): BrowserDriver & { calls: string[] } {
  const calls: string[] = [];
  const session = { page: {} } as unknown as BrowserSession;
  const reply = options.reply ?? (() => "そうなんだね。信頼できる大人に話してみるのもいいかもしれません。");
  return {
    calls,
    openSession: async () => { calls.push("openSession"); return session; },
    closeSession: async () => { calls.push("closeSession"); },
    loginThroughUi: async (_page, email) => { calls.push(`login:${email}`); },
    submitJournal: async () => { calls.push("submitJournal"); },
    sendChatAndRead: async (_page, message) => { calls.push("chat"); return reply(message); },
    openSupportSummary: async () => { calls.push("summary"); return "サポートサマリー"; },
    grantConsentIfRequested: async () => { calls.push("grantConsent"); return false; },
    shareSummaryThroughUi: async () => { calls.push("share"); return false; },
    revokeAllSharesThroughUi: async () => { calls.push("revokeAll"); return 0; },
    counselorReadOversight: async () => { calls.push("oversight"); return "oversight"; },
    reviewerReadEvaluation: async () => { calls.push("evaluation"); return "Is BLESC safe to ship?"; },
    screenshot: async () => { calls.push("screenshot"); },
  };
}

export interface FakeDepsOptions extends FakeDriverOptions {
  judge?: RunnerDeps["judge"];
  studentMessage?: RunnerDeps["studentMessage"];
  registerEval?: RunnerDeps["registerEval"];
}

export function fakeDeps(options: FakeDepsOptions = {}): RunnerDeps & { driver: ReturnType<typeof fakeDriver> } {
  return {
    driver: fakeDriver(options),
    trace: (name, fn) => fn(`trace-${name}`),
    studentMessage: options.studentMessage
      ?? (async (scenario: ScenarioCase, transcript: TurnRecord[]) => `${scenario.caseKey} turn ${transcript.length}`),
    judge: options.judge ?? (async () => ({ kind: "verdict", result: { ...PASSING_JUDGE } })),
    registerEval: options.registerEval ?? (async () => ({})),
  };
}

export function fakeAccounts(): ProvisionedAccounts {
  const passwords = new Map<string, string>();
  for (const email of [...SYNTHETIC_ACCOUNTS.students, ...SYNTHETIC_ACCOUNTS.counselors, SYNTHETIC_ACCOUNTS.reviewer]) {
    passwords.set(email, "fake-password");
  }
  return { passwords, orgId: "org-1", studentParticipants: new Map() };
}

export const FAKE_ENV: EvalEnv = {
  evalOpenAiKey: "fake-key",
  supabaseUrl: "http://127.0.0.1:54321",
  serviceRoleKey: "fake-service-role",
  anonKey: "fake-anon",
  appBaseUrl: "http://localhost:3940",
  protectionBypassSecret: "",
};

export function runOptions(db: FakeSupabase, scenarios: ScenarioCase[], over: Partial<RunOptions> = {}): RunOptions {
  return {
    env: FAKE_ENV,
    admin: db.asClient(),
    accounts: fakeAccounts(),
    scenarios,
    mode: "full",
    label: "fake-run",
    artifactsDir: join(mkdtempSync(join(tmpdir(), "blesc-eval-test-")), "artifacts"),
    captureMedia: false,
    ...over,
  };
}
