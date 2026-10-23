#!/usr/bin/env node
// Lists the work that is finished but has not reached `main` (#464).
//
//   node scripts/ci/unlanded-work.mjs
//
// #464 is about a loop: a run implements an issue, commits with `Closes #N`,
// pushes the branch, and stops. No pull request is opened, so nothing merges
// and the issue stays open — and because the issue stays open, the next run
// picks it up and writes the same fix again. Five rebuilds were confirmed by
// hand before anyone noticed.
//
// Counting branches that are ahead of `main` does not find them. CONTRIBUTING
// §2 settles on squash merge, so a squashed branch's original commits never
// enter `main`'s history and `origin/main..branch` stays non-empty forever.
// On 2026-10-22 that count was 133 of 136 branches, nearly all of it residue
// from merged work; the three that mattered were lost in it.
//
// So the question this asks of a branch is not "is it ahead" but "does it
// close an issue that is still open, and is there no pull request carrying
// it". Those two facts separate live work from residue, because an issue that
// is still open is the repository's own statement that the work has not
// landed. That is the metric #464 asks for in place of the branch count.
//
// The pure half of this — reading the refs, classifying a branch — is what
// `unlanded-work.test.mjs` runs in CI. The repository facts come from `git`
// and from `gh api`, so the command itself is run by hand; #464 leaves the
// choice between a hand-run script and a scheduled workflow to the owner, and
// this is the smaller of the two.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Branches whose commits are never this script's business: `main` itself, and
 * the bots that open their own pull requests.
 */
export const IGNORED_BRANCH_PREFIXES = ["main", "HEAD", "dependabot/"];

/**
 * Issue numbers a commit message claims to close.
 *
 * Two forms count, and both are the repository's own conventions:
 *
 *   - `Closes #479` — the trailer CONTRIBUTING §4 asks commits to carry.
 *   - `…（#471）` or `…(#471)` at the end of the subject — the form
 *     CONTRIBUTING §2 uses for pull request titles, which squash merge then
 *     makes the commit subject.
 *
 * A bare `#244` elsewhere in the body does not count. Those are citations —
 * ly8y44's message cites #181 and #244 to explain a test rename and a Python
 * version, and neither is work that branch would land. Counting them would
 * put a branch on this list for every issue it merely discusses.
 */
export function closingRefs(message) {
  const refs = new Set();
  for (const match of message.matchAll(/\b(?:closes|fixes|resolves)\s+#(\d+)\b/gi)) {
    refs.add(Number(match[1]));
  }
  const subject = message.split("\n", 1)[0];
  for (const match of subject.matchAll(/[(（]#(\d+)[)）]/g)) {
    refs.add(Number(match[1]));
  }
  return refs;
}

/** Whether this script has anything to say about a branch with this name. */
export function isIgnored(branch) {
  return IGNORED_BRANCH_PREFIXES.some((p) => (p.endsWith("/") ? branch.startsWith(p) : branch === p));
}

/**
 * What a branch is, given its own facts and the state of the repository.
 *
 * `refs` are the issue numbers from `closingRefs` across the branch's commits
 * that are not on `main`; `openIssues` is the set of issue numbers currently
 * open; `prHeads` is the set of branch names that some pull request — open or
 * closed — has as its head.
 *
 *   unlanded      closes an open issue, and no pull request carries it. This
 *                 is the loop in #464: finished work nobody can see.
 *   pull-request  some pull request has this branch as its head. Whatever
 *                 became of it, the work was put up for review rather than
 *                 left where only the next run would find it.
 *   residue       every issue it closes is already closed. Squash merge left
 *                 the branch ahead of `main` with its work already in. Safe
 *                 to delete, but deleting is the owner's call (#464 notes).
 *   unreferenced  ahead of `main` and names no issue at all. Cannot be
 *                 classified from the message; someone has to read it.
 */
export function classify(branch, refs, { openIssues, prHeads }, facts = {}) {
  const open = [...refs].filter((n) => openIssues.has(n)).sort((a, b) => a - b);
  const of = (state, issues) => ({ branch, state, issues, ...facts });
  if (prHeads.has(branch)) return of("pull-request", open);
  if (refs.size === 0) return of("unreferenced", []);
  if (open.length === 0) return of("residue", []);
  return of("unlanded", open);
}

/**
 * The classified branches, worst first, and the count #464 asks to be tracked
 * in place of "branches ahead of main".
 */
export function summarize(classified) {
  const order = { unlanded: 0, unreferenced: 1, "pull-request": 2, residue: 3 };
  const branches = [...classified].sort(
    (a, b) => order[a.state] - order[b.state] || a.branch.localeCompare(b.branch),
  );
  const counts = { unlanded: 0, unreferenced: 0, "pull-request": 0, residue: 0 };
  for (const entry of classified) counts[entry.state] += 1;
  return { branches, counts, unlanded: counts.unlanded };
}

const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/** Remote branches, each with the issues its unmerged commits claim to close. */
function readBranches(repoRoot) {
  const names = git(["for-each-ref", "--format=%(refname:lstrip=3)", "refs/remotes/origin"], repoRoot)
    .split("\n")
    .filter((name) => name && !isIgnored(name));
  const found = [];
  for (const branch of names) {
    // `%x00` between messages: a commit body can contain anything, including
    // whatever separator looked safe.
    const log = git(["log", `origin/main..origin/${branch}`, "--format=%B%x00"], repoRoot);
    if (!log.trim()) continue;
    const refs = new Set();
    for (const message of log.split("\0")) {
      if (message.trim()) for (const ref of closingRefs(message)) refs.add(ref);
    }
    // Printed next to each branch so the list can be triaged without going
    // back to git. A branch of one commit that is level with `main` is ready
    // to open as it stands; one of 300 commits that is 200 behind is an old
    // base that happens to name a long-lived epic, and needs reading.
    found.push({
      branch,
      refs,
      ahead: Number(git(["rev-list", "--count", `origin/main..origin/${branch}`], repoRoot).trim()),
      behind: Number(git(["rev-list", "--count", `origin/${branch}..origin/main`], repoRoot).trim()),
      last: git(["log", "-1", "--format=%ad", "--date=short", `origin/${branch}`], repoRoot).trim(),
    });
  }
  return found;
}

/**
 * `owner/repo` from the origin remote, for both the https and ssh forms.
 *
 * Spelled out rather than left to `gh`'s `{owner}/{repo}`, which expands to a
 * `repositories/{id}` path that not every host serves.
 */
export function originSlug(url) {
  const match = url.trim().match(/^(?:https?:\/\/[^/]+\/|git@[^:]+:|ssh:\/\/[^/]+\/)(.+?)(?:\.git)?$/);
  if (!match) throw new Error(`cannot read owner/repo from the origin remote: ${url}`);
  return match[1];
}

/**
 * Issue and pull request state from `gh`. Returns null when `gh` cannot
 * answer, so the caller can say what is missing instead of reporting an empty
 * list as if everything were clean.
 */
function readGitHub(repoRoot) {
  try {
    const slug = originSlug(git(["remote", "get-url", "origin"], repoRoot));
    // Paged by hand with an explicit `page=`, not with `gh --paginate`: that
    // follows GitHub's `Link` header, whose next-page URLs are
    // `repositories/{id}/…` paths that some hosts and proxies refuse.
    const page = (endpoint) => {
      const all = [];
      for (let n = 1; n <= 50; n += 1) {
        const batch = JSON.parse(
          execFileSync("gh", ["api", `${endpoint}&page=${n}`], {
            cwd: repoRoot,
            encoding: "utf8",
            maxBuffer: 64 * 1024 * 1024,
          }),
        );
        all.push(...batch);
        if (batch.length < 100) return all;
      }
      throw new Error(`${endpoint} did not end within 50 pages`);
    };
    const issues = page(`repos/${slug}/issues?state=open&per_page=100`);
    const pulls = page(`repos/${slug}/pulls?state=all&per_page=100`);
    return {
      // `issues` includes pull requests; a pull request is not an issue this
      // script can call open work.
      openIssues: new Set(issues.filter((i) => !i.pull_request).map((i) => i.number)),
      prHeads: new Set(pulls.map((p) => p.head?.ref).filter(Boolean)),
    };
  } catch (error) {
    console.error(`gh api failed: ${error.message.split("\n")[0]}`);
    return null;
  }
}

function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const state = readGitHub(repoRoot);
  if (!state) {
    console.error("Cannot tell landed work from residue without issue and pull request state.");
    console.error("Authenticate with `gh auth login` and run this again.");
    process.exit(2);
  }

  const { branches, counts, unlanded } = summarize(
    readBranches(repoRoot).map(({ branch, refs, ...facts }) => classify(branch, refs, state, facts)),
  );

  const show = (entry, note) =>
    console.log(
      `  ${entry.branch.padEnd(42)} ${String(entry.ahead).padStart(4)} ahead ` +
        `${String(entry.behind).padStart(4)} behind  ${entry.last}  ${note}`,
    );

  const stranded = branches.filter((b) => b.state === "unlanded");
  if (stranded.length) {
    console.log("UNLANDED — closes an open issue, no pull request carries it:");
    for (const entry of stranded) show(entry, entry.issues.map((n) => `#${n}`).join(" "));
  }
  const unread = branches.filter((b) => b.state === "unreferenced");
  if (unread.length) {
    console.log("\nUNREFERENCED — ahead of main, names no issue, so only a person can place it:");
    for (const entry of unread) show(entry, "—");
  }

  console.log(
    `\n${unlanded} unlanded, ${counts.unreferenced} unreferenced, ` +
      `${counts["pull-request"]} carried by a pull request, ${counts.residue} residue of merged work.`,
  );
  if (unlanded) {
    console.log(
      "Open a pull request for each, or the next run rebuilds it (#464).\n" +
        "A branch level with main is ready as it stands; one far behind is an old base that\n" +
        "happens to name a long-lived epic, and needs reading before it is called outstanding.",
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
