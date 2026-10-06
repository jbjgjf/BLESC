#!/usr/bin/env node
// Fails when `npm audit` reports a high or critical advisory that nobody has
// accepted in writing (#337).
//
//   node scripts/ci/npm-audit-gate.mjs sentra/frontend
//
// `npm audit --audit-level=high` alone cannot be the gate: some advisories have
// no fix at all (braces <=3.0.3 is the latest braces), and npm's only offer for
// them is a downgrade. A gate that is red for something nobody can fix gets
// switched off. So each such advisory is accepted, with the reason, in
// `npm-audit-accepted.json` next to this file — the one place that says why a
// known vulnerability is still in the tree. Everything else at high or above
// stays red.
//
// An accepted entry that no longer matches anything also fails the run: an
// exemption for a vulnerability that is gone only widens what the next one can
// hide behind.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BLOCKING_SEVERITIES = new Set(["high", "critical"]);

/**
 * Advisories in an `npm audit --json` (v2) report, one per package and
 * advisory. Entries in `via` that are plain strings are the transitive chain
 * (micromatch depends on a vulnerable braces); the advisory itself is reported
 * on the package that carries it, so those are not counted twice.
 */
export function advisories(report) {
  const found = [];
  for (const [pkg, entry] of Object.entries(report?.vulnerabilities ?? {})) {
    for (const via of entry.via ?? []) {
      if (typeof via !== "object" || via === null) continue;
      found.push({ package: pkg, url: via.url, title: via.title, severity: via.severity, range: via.range });
    }
  }
  return found;
}

/**
 * `accepted` entries are `{ project, package, advisory, reason }`.
 * Returns what blocks the run and which accepted entries matched nothing.
 */
export function evaluate(report, accepted, project) {
  const mine = accepted.filter((entry) => entry.project === project);
  for (const entry of mine) {
    if (!entry.reason || entry.reason.trim().length < 20) {
      throw new Error(`${project}: accepted advisory ${entry.advisory} on ${entry.package} has no reason written down`);
    }
  }
  const isAccepted = (item) => mine.some((entry) => entry.package === item.package && entry.advisory === item.url);

  const found = advisories(report);
  const blocking = found.filter((item) => BLOCKING_SEVERITIES.has(item.severity) && !isAccepted(item));
  const stale = mine.filter((entry) => !found.some((item) => item.package === entry.package && item.url === entry.advisory));
  const acceptedHits = found.filter((item) => isAccepted(item));
  return { blocking, stale, accepted: acceptedHits, total: found.length };
}

function runAudit(cwd) {
  try {
    return execFileSync("npm", ["audit", "--json"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  } catch (error) {
    // `npm audit` exits non-zero whenever it finds anything; the report is
    // still on stdout. No stdout means the audit itself failed (no network,
    // no lockfile), which must not read as "nothing found".
    if (error.stdout) return error.stdout;
    throw error;
  }
}

function main() {
  const project = process.argv[2];
  if (!project) {
    console.error("usage: node scripts/ci/npm-audit-gate.mjs <project-dir>");
    process.exit(2);
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, "..", "..");
  const accepted = JSON.parse(readFileSync(path.join(here, "npm-audit-accepted.json"), "utf8")).accepted;

  const report = JSON.parse(runAudit(path.resolve(repoRoot, project)));
  if (report.error) throw new Error(`npm audit failed in ${project}: ${JSON.stringify(report.error)}`);

  const result = evaluate(report, accepted, project);
  for (const item of result.accepted) {
    console.log(`accepted  ${item.severity.padEnd(8)} ${item.package} ${item.url}`);
  }
  for (const item of result.blocking) {
    console.log(`BLOCKING  ${item.severity.padEnd(8)} ${item.package} ${item.range ?? ""} ${item.url} — ${item.title}`);
  }
  for (const entry of result.stale) {
    console.log(`STALE     ${entry.package} ${entry.advisory} — no longer reported; remove it from npm-audit-accepted.json`);
  }
  console.log(`${project}: ${result.total} advisories, ${result.blocking.length} blocking, ${result.accepted.length} accepted, ${result.stale.length} stale`);
  if (result.blocking.length || result.stale.length) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
