// blesc-eval CLI.
//   tsx src/cli.ts provision            — create/refresh synthetic accounts
//   tsx src/cli.ts reset                — wipe synthetic-account content
//   tsx src/cli.ts smoke                — 12 stratified live smoke cases
//   tsx src/cli.ts full --confirm-full  — full 420-conversation matrix
//   flags: --resume <runId>  --limit <n>  --media  --register-eval
//
// The decisions live in commands.ts, where they are tested; this file only
// connects them to the real environment.

import { runCli } from "./commands.ts";
import { loadEnv } from "./config.ts";
import { adminClient, provisionAccounts, resetSyntheticData } from "./provision.ts";
import { executeRun } from "./runner.ts";

runCli(process.argv.slice(2), {
  loadEnv,
  provisionAccounts,
  resetSyntheticData: (env) => resetSyntheticData(adminClient(env)),
  adminClient,
  executeRun: (options) => executeRun(options),
  now: () => new Date(),
  log: (message) => console.log(message),
  error: (message) => console.error(message),
}).then((code) => {
  // Exit explicitly only on failure: on success the process ends when the trace
  // exporter has flushed, as it did before.
  if (code !== 0) process.exit(code);
}, (error: unknown) => {
  console.error("[fatal]", error instanceof Error ? error.message : error);
  process.exit(1);
});
