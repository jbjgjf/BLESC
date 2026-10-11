// The CLI's decisions, separate from its entry point so they can be tested
// without running anything (#385): argument parsing, case selection, the
// pre-run cost gate, and which command does what. `cli.ts` only wires these to
// the real environment.

import type { SupabaseClient } from "@supabase/supabase-js";
import { COST_LIMITS, MATRIX, type EvalEnv } from "./config.ts";
import type { ScenarioCase } from "./contracts.ts";
import { UnpricedModel, estimateRunUsd } from "./cost.ts";
import type { ProvisionedAccounts, ResetReport } from "./provision.ts";
import type { RunOptions } from "./runner.ts";
import type { RunSummary } from "./artifacts.ts";
import { buildMatrix, smokeSelection } from "./scenarios.ts";

export const USAGE =
  "usage: cli.ts provision|reset|smoke|full [--confirm-full] [--resume <runId>] [--limit <n>] [--media] [--register-eval]";

/** A refusal before anything runs. The CLI exits 2 with the message. */
export class UsageError extends Error {}

export interface CliArgs {
  command: string | undefined;
  confirmFull: boolean;
  resumeRunId?: string;
  limit?: number;
  media: boolean;
  /** Also register the graded cases with OpenAI Evals, paid through the cost guard (#266). */
  registerEval: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const valueOf = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    if (index < 0) return undefined;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`${name} needs a value`);
    return value;
  };
  const limitText = valueOf("--limit");
  let limit: number | undefined;
  if (limitText !== undefined) {
    // `Number("abc") > 0` is false, which used to mean "no limit" — a typo
    // silently ran the whole matrix.
    limit = Number(limitText);
    if (!Number.isInteger(limit) || limit <= 0) throw new UsageError(`--limit must be a positive integer (got ${limitText})`);
  }
  return {
    command: argv[0],
    confirmFull: argv.includes("--confirm-full"),
    resumeRunId: valueOf("--resume"),
    limit,
    media: argv.includes("--media"),
    registerEval: argv.includes("--register-eval"),
  };
}

/** The cases a smoke or full run will drive. */
export function selectScenarios(args: CliArgs, all: ScenarioCase[] = buildMatrix()): ScenarioCase[] {
  if (args.resumeRunId && args.limit !== undefined) {
    // A resumed run must cover the run it resumes (#376); a limit can only
    // narrow it. Refused here, before reset and provisioning, as well as in
    // executeRun, which also catches `smoke --resume <a full run>`.
    throw new UsageError("--resume cannot be combined with --limit: a resumed run must cover every case of the run it resumes");
  }
  const scenarios = args.command === "smoke" ? smokeSelection(all) : all;
  return args.limit !== undefined ? scenarios.slice(0, args.limit) : scenarios;
}

/** What the CLI needs from the outside world. Tests pass fakes. */
export interface CliDeps {
  loadEnv(): EvalEnv;
  provisionAccounts(env: EvalEnv): Promise<ProvisionedAccounts>;
  resetSyntheticData(env: EvalEnv): Promise<ResetReport>;
  adminClient(env: EvalEnv): SupabaseClient;
  executeRun(options: RunOptions): Promise<{ runId: string; summary: RunSummary }>;
  now(): Date;
  log(message: string): void;
  error(message: string): void;
}

/** What a reset did and did not do, for the operator (#375). */
export function describeReset(report: ResetReport): string[] {
  const rows = report.deleted.reduce((sum, entry) => sum + (entry.rows ?? 0), 0);
  const lines = [`[reset] emptied ${report.deleted.length} table(s) for ${report.wipedUsers} synthetic accounts (${rows} rows)`];
  if (report.missing.length) {
    lines.push(`[reset] WARNING: ${report.missing.length} table(s) the reset expects are missing from this database — its schema is behind the migrations: ${report.missing.join(", ")}`);
  }
  for (const { table, reason } of report.excluded) lines.push(`[reset] not reset: ${table} — ${reason}`);
  return lines;
}

/** Runs one CLI invocation and returns the exit code. */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      deps.error(`[plan] ${error.message}`);
      return 2;
    }
    throw error;
  }
  const { command } = args;
  if (command !== "provision" && command !== "reset" && command !== "smoke" && command !== "full") {
    deps.error(USAGE);
    return 2;
  }

  const env = deps.loadEnv();
  if (command === "provision") {
    const accounts = await deps.provisionAccounts(env);
    deps.log(`[provision] ${accounts.passwords.size} synthetic accounts ready · org ${accounts.orgId}`);
    deps.log("[provision] passwords generated in memory for this process only (not persisted)");
    return 0;
  }
  if (command === "reset") {
    for (const line of describeReset(await deps.resetSyntheticData(env))) deps.log(line);
    return 0;
  }

  let scenarios: ScenarioCase[];
  try {
    scenarios = selectScenarios(args);
  } catch (error) {
    if (error instanceof UsageError) {
      deps.error(`[plan] ${error.message}`);
      return 2;
    }
    throw error;
  }
  let estimate: ReturnType<typeof estimateRunUsd>;
  try {
    estimate = estimateRunUsd(scenarios.length, (MATRIX.minTurns + MATRIX.maxTurns) / 2, { registerEval: args.registerEval });
  } catch (error) {
    // An estimate without a price is not US$0.00 (#286).
    if (error instanceof UnpricedModel) {
      deps.error(`[plan] refusing to start: ${error.message}`);
      return 2;
    }
    throw error;
  }
  deps.log(`[plan] ${scenarios.length} conversations · est ~${Math.round(estimate.tokens / 1000)}k tokens ≈ US$${estimate.usd.toFixed(2)} (warn $${COST_LIMITS.warnUsd} / stop $${COST_LIMITS.hardStopUsd})`);
  if (command === "full" && !args.confirmFull) {
    deps.error("[plan] full run requires --confirm-full");
    return 2;
  }
  if (estimate.usd >= COST_LIMITS.hardStopUsd) {
    deps.error("[plan] refusing to start: estimate exceeds the hard stop");
    return 2;
  }

  for (const line of describeReset(await deps.resetSyntheticData(env))) deps.log(line);
  const accounts = await deps.provisionAccounts(env);
  const admin = deps.adminClient(env);
  const stamp = deps.now().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const { runId, summary } = await deps.executeRun({
    env, admin, accounts, scenarios,
    mode: command,
    label: `${command}-${stamp}`,
    artifactsDir: `artifacts/${command}-${stamp}`,
    captureMedia: command === "smoke" || args.media,
    resumeRunId: args.resumeRunId,
    registerEval: args.registerEval,
  });
  deps.log(`[done] run ${runId}: ${summary.verdict} · artifacts in artifacts/${command}-${stamp}/`);
  return 0;
}
