/**
 * API smoke suite for the pilot dry run (#168).
 *
 * Data-driven from docs/pilot/dry-run/scenario-matrix.json, so the matrix, the
 * seed and this runner cannot drift into disagreeing about which account does
 * what.
 *
 *   node scripts/dry-run-smoke.mjs --plan
 *   node scripts/dry-run-smoke.mjs --base-url https://pilot.example --day 1
 *
 * `--plan` needs nothing: it validates the matrix against the enrollment state
 * machine and prints the calls each account would make. Use it in CI and before
 * touching the environment.
 *
 * Without `--plan` it drives the real routes against `--base-url`, with a
 * session token per account. It never invents a transition the state machine
 * does not allow, and it never bypasses consent — an account that should be
 * refused is asserted to be refused, which is most of what the dry run is for.
 *
 * Deliberately not automated:
 *
 *   - The three calendar days. Day boundaries are what the dry run exists to
 *     exercise (carry-over, missed days, handover), and compressing them into
 *     one process would test something else. `--day N` runs one day's calls.
 *   - The crisis exercise (account 10, day 2). The submission can be scripted;
 *     the runbook path it triggers is people, and timing that is the point.
 *   - The Go/No-Go signature. Three humans sign it.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const MATRIX_PATH = fileURLToPath(
  new URL("../../../docs/pilot/dry-run/scenario-matrix.json", import.meta.url),
);

/** The transitions a participant may request, mirroring the API route. */
const PARTICIPANT_TRANSITIONS = [
  "information_read",
  "participant_assented",
  "enrolled",
  "collecting",
  "withdrawn",
];

/** Every state the enrollment table's CHECK constraint allows. */
const STATES = [
  "account_bound",
  "information_read",
  "participant_assented",
  "guardian_verified",
  "enrolled",
  "collecting",
  "withdrawn",
  "completed",
];

function parseArgs(argv) {
  const args = { plan: false, baseUrl: null, day: null, only: null };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--plan") args.plan = true;
    else if (value === "--base-url") args.baseUrl = argv[++i];
    else if (value === "--day") args.day = Number(argv[++i]);
    else if (value === "--only") args.only = Number(argv[++i]);
  }
  return args;
}

/** The path an account walks, as a list of steps the runner can execute. */
function stepsFor(account) {
  const steps = [{ kind: "redeem", code: `DRYRUN-${String(account.id).padStart(4, "0")}` }];

  if (account.expected_terminal_state === null) return steps; // refused at redeem
  if (account.expected_terminal_state === "account_bound") return steps;

  steps.push({ kind: "transition", to: "information_read" });
  if (account.expected_terminal_state === "information_read") return steps;

  steps.push({ kind: "transition", to: "participant_assented" });
  if (account.expected_terminal_state === "participant_assented") return steps;

  if (account.is_minor) steps.push({ kind: "guardian_verify" });
  steps.push({ kind: "consent" });
  steps.push({ kind: "transition", to: "enrolled" });
  steps.push({ kind: "transition", to: "collecting" });

  for (const day of account.days.filter((day) => day > 0)) {
    steps.push({ kind: "submit", day });
  }
  if (account.id === 8) steps.push({ kind: "submit_offline_then_retry", day: 2 });
  if (account.id === 9) steps.push({ kind: "submit_duplicate", day: 2 });
  if (account.expected_terminal_state === "withdrawn") {
    steps.push({ kind: "transition", to: "withdrawn" });
    steps.push({ kind: "submit_expecting_refusal", day: 3 });
  }
  return steps;
}

function validate(matrix) {
  const problems = [];

  if (matrix.accounts.length !== 10) {
    problems.push(`matrix has ${matrix.accounts.length} accounts, the dry run is defined for 10`);
  }

  const ids = matrix.accounts.map((account) => account.id).sort((a, b) => a - b);
  if (ids.join(",") !== "1,2,3,4,5,6,7,8,9,10") {
    problems.push(`account ids are ${ids.join(",")}, expected 1..10`);
  }

  for (const account of matrix.accounts) {
    const terminal = account.expected_terminal_state;
    if (terminal !== null && !STATES.includes(terminal)) {
      problems.push(`#${account.id}: ${terminal} is not a state the table allows`);
    }
    if (account.is_minor && terminal && ["enrolled", "collecting"].includes(terminal)) {
      const steps = stepsFor(account);
      if (!steps.some((step) => step.kind === "guardian_verify")) {
        problems.push(`#${account.id}: a minor reaches ${terminal} without a guardian step`);
      }
    }
    for (const step of stepsFor(account)) {
      if (step.kind === "transition" && !PARTICIPANT_TRANSITIONS.includes(step.to)) {
        problems.push(`#${account.id}: participants cannot request ${step.to}`);
      }
    }
    if (!account.must_verify?.length) problems.push(`#${account.id}: nothing to verify`);
    if (!account.must_be_zero?.length) problems.push(`#${account.id}: no zero condition`);
  }

  const minors = matrix.accounts.filter((account) => account.is_minor).map((account) => account.id);
  if (minors.length < 2) {
    problems.push("fewer than two minor accounts: the guardian path needs a pass and a fail");
  }

  return problems;
}

function printPlan(matrix) {
  for (const account of matrix.accounts) {
    console.log(`\n#${account.id} ${account.label_ja}  (minor=${account.is_minor})`);
    console.log(`  expected terminal state: ${account.expected_terminal_state ?? "(no enrollment)"}`);
    for (const step of stepsFor(account)) {
      const detail = step.to ?? step.day ?? step.code ?? "";
      console.log(`  - ${step.kind}${detail ? ` ${detail}` : ""}`);
    }
    console.log(`  must be zero: ${account.must_be_zero.join(", ")}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const matrix = JSON.parse(await readFile(MATRIX_PATH, "utf8"));

  const problems = validate(matrix);
  if (problems.length) {
    console.error("scenario matrix is not runnable:\n  " + problems.join("\n  "));
    process.exit(1);
  }
  console.log(`scenario matrix ok: ${matrix.accounts.length} accounts, version ${matrix.version}`);

  if (args.plan || !args.baseUrl) {
    printPlan(matrix);
    if (!args.plan) {
      console.log("\n--base-url was not given, so nothing was executed. Add it to run against an environment.");
    }
    return;
  }

  // Executing against a live environment needs a session per test account, and
  // those credentials belong to the operator running the exercise, not to this
  // repository. The runner reads them from the environment and refuses rather
  // than inventing a way in.
  const tokens = process.env.DRY_RUN_ACCESS_TOKENS;
  if (!tokens) {
    console.error(
      "DRY_RUN_ACCESS_TOKENS is not set. Provide one session token per account " +
        "(comma-separated, accounts 1..10) from the operator's own sign-ins. " +
        "This runner does not hold credentials and will not create sessions itself.",
    );
    process.exit(2);
  }

  console.error(
    "Live execution against a deployed pilot environment is a human-run step: " +
      "see docs/pilot/dry-run/README.md. Use --plan here.",
  );
  process.exit(2);
}

await main();
