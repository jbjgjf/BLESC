// blesc-eval CLI.
//   tsx src/cli.ts provision            — create/refresh synthetic accounts
//   tsx src/cli.ts reset                — wipe synthetic-account content
//   tsx src/cli.ts smoke                — 12 stratified live smoke cases
//   tsx src/cli.ts full --confirm-full  — full 300-conversation matrix
//   flags: --resume <runId>  --limit <n>  --media

import { loadEnv, COST_LIMITS, MATRIX } from "./config.ts";
import { estimateRunUsd } from "./cost.ts";
import { adminClient, provisionAccounts, resetSyntheticData } from "./provision.ts";
import { executeRun } from "./runner.ts";
import { buildMatrix, smokeSelection } from "./scenarios.ts";

const args = process.argv.slice(2);
const command = args[0];
const flag = (name: string) => args.includes(name);
const flagValue = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

async function main() {
  const env = loadEnv();
  if (command === "provision") {
    const accounts = await provisionAccounts(env);
    console.log(`[provision] ${accounts.passwords.size} synthetic accounts ready · org ${accounts.orgId}`);
    console.log("[provision] passwords generated in memory for this process only (not persisted)");
    return;
  }
  if (command === "reset") {
    const { wipedUsers } = await resetSyntheticData(env);
    console.log(`[reset] wiped content for ${wipedUsers} synthetic accounts`);
    return;
  }
  if (command === "smoke" || command === "full") {
    const all = buildMatrix();
    let scenarios = command === "smoke" ? smokeSelection(all) : all;
    const limit = Number(flagValue("--limit") ?? 0);
    if (limit > 0) scenarios = scenarios.slice(0, limit);

    const estimate = estimateRunUsd(scenarios.length, (MATRIX.minTurns + MATRIX.maxTurns) / 2);
    console.log(`[plan] ${scenarios.length} conversations · est ~${Math.round(estimate.tokens / 1000)}k tokens ≈ US$${estimate.usd.toFixed(2)} (warn $${COST_LIMITS.warnUsd} / stop $${COST_LIMITS.hardStopUsd})`);
    if (command === "full" && !flag("--confirm-full")) {
      console.error("[plan] full run requires --confirm-full");
      process.exit(2);
    }
    if (estimate.usd >= COST_LIMITS.hardStopUsd) {
      console.error("[plan] refusing to start: estimate exceeds the hard stop");
      process.exit(2);
    }

    await resetSyntheticData(env);
    const accounts = await provisionAccounts(env);
    const admin = adminClient(env);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const { runId, summary } = await executeRun({
      env, admin, accounts, scenarios,
      mode: command,
      label: `${command}-${stamp}`,
      artifactsDir: `artifacts/${command}-${stamp}`,
      captureMedia: command === "smoke" || flag("--media"),
      resumeRunId: flagValue("--resume"),
    });
    console.log(`[done] run ${runId}: ${summary.verdict} · artifacts in artifacts/${command}-${stamp}/`);
    return;
  }
  console.error("usage: cli.ts provision|reset|smoke|full [--confirm-full] [--resume <runId>] [--limit <n>] [--media]");
  process.exit(2);
}

main().catch((error) => {
  console.error("[fatal]", error instanceof Error ? error.message : error);
  process.exit(1);
});
