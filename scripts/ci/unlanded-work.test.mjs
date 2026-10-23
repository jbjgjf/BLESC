/**
 * What `unlanded-work.mjs` counts as work that has not landed (#464).
 *
 * The repository facts come from `git` and `gh`, so those are not what this
 * tests. What it fixes is the reading: which refs in a commit message are a
 * claim to close an issue, and which of four states a branch is in. Those are
 * the two places where the metric in #464 can quietly go wrong — a classifier
 * that calls everything residue reports a clean repository forever.
 *
 *   node --test scripts/ci/unlanded-work.test.mjs
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classify, closingRefs, isIgnored, summarize } from "./unlanded-work.mjs";

describe("closingRefs: what a commit claims to close", () => {
  it("reads the Closes trailer CONTRIBUTING §4 asks for", () => {
    assert.deepEqual(closingRefs("fix(ci): drop the production ref\n\nCloses #479"), new Set([479]));
  });

  it("reads Fixes and Resolves, and ignores case", () => {
    assert.deepEqual(closingRefs("x\n\nfixes #1\nRESOLVES #2"), new Set([1, 2]));
  });

  it("reads the (#N) the pull request title convention leaves in the subject", () => {
    assert.deepEqual(closingRefs("[Fix] 支援サマリーを日本語にする（#471）"), new Set([471]));
    assert.deepEqual(closingRefs("[Fix] unify the rounding (#328)"), new Set([328]));
  });

  it("does not count issues the body merely cites", () => {
    // ly8y44's real message: it closes #479 and cites #181 for a test rename
    // and #244 for a Python version. Counting citations would list a branch
    // against every issue it discusses.
    const message = [
      "fix(ci): CI の placeholder を解決しない host にする",
      "",
      "テスト名は #181 の内容に合わせた。backend の pytest は走らせていない",
      "（#244 が既に指摘している）。",
      "",
      "Closes #479",
    ].join("\n");
    assert.deepEqual(closingRefs(message), new Set([479]));
  });

  it("finds nothing in a message that names no issue", () => {
    assert.deepEqual(closingRefs("chore: bump eslint"), new Set());
  });

  it("takes a (#N) only from the subject, not from a body line that ends in one", () => {
    assert.deepEqual(closingRefs("refactor: split the type\n\nsee the note (#999)"), new Set());
  });
});

describe("isIgnored: branches this says nothing about", () => {
  it("ignores main and HEAD", () => {
    assert.ok(isIgnored("main"));
    assert.ok(isIgnored("HEAD"));
  });

  it("ignores dependabot, which opens its own pull requests", () => {
    assert.ok(isIgnored("dependabot/npm_and_yarn/sentra/eval/typescript-7.0.2"));
  });

  it("does not ignore a branch whose name merely contains main", () => {
    assert.ok(!isIgnored("fix/maintenance-window"));
    assert.ok(!isIgnored("claude/busy-lamport-ly8y44"));
  });
});

const STATE = { openIssues: new Set([460, 471, 479]), prHeads: new Set(["claude/gifted-babbage-vrznv3"]) };

describe("classify: the four states", () => {
  it("calls a branch unlanded when it closes an open issue and has no pull request", () => {
    assert.deepEqual(classify("claude/busy-lamport-ly8y44", new Set([479]), STATE), {
      branch: "claude/busy-lamport-ly8y44",
      state: "unlanded",
      issues: [479],
    });
  });

  it("calls a branch residue when every issue it closes is already closed", () => {
    // The squash merge case: `origin/main..branch` is still non-empty because
    // the original commits never entered main's history, but #3 and #4 closed
    // in June. 133 of 136 branches were this on 2026-10-22.
    assert.deepEqual(classify("feat/oversight-consent", new Set([3, 4]), STATE), {
      branch: "feat/oversight-consent",
      state: "residue",
      issues: [],
    });
  });

  it("calls a branch pull-request when one carries it, even with open issues", () => {
    const entry = classify("claude/gifted-babbage-vrznv3", new Set([465, 471]), STATE);
    assert.equal(entry.state, "pull-request");
    // #474 is review, not loss — the correction that mattered on 2026-10-22.
    assert.deepEqual(entry.issues, [471]);
  });

  it("calls a branch unreferenced when it names no issue at all", () => {
    assert.deepEqual(classify("chore/eval-eslint", new Set(), STATE), {
      branch: "chore/eval-eslint",
      state: "unreferenced",
      issues: [],
    });
  });

  it("reports only the open issues of a branch that closes a mix", () => {
    assert.deepEqual(classify("claude/busy-lamport-uv0975", new Set([116, 365, 471]), STATE).issues, [471]);
  });

  it("is unlanded on the strength of one open issue among many closed", () => {
    assert.equal(classify("b", new Set([3, 4, 95, 460]), STATE).state, "unlanded");
  });
});

describe("summarize: the count that replaces 'branches ahead of main'", () => {
  const classified = [
    classify("residue-a", new Set([3]), STATE),
    classify("claude/busy-lamport-ly8y44", new Set([479]), STATE),
    classify("chore/eval-eslint", new Set(), STATE),
    classify("claude/gifted-babbage-vrznv3", new Set([471]), STATE),
    classify("claude/busy-lamport-yl1kal", new Set([460]), STATE),
  ];

  it("counts unlanded work rather than branches ahead of main", () => {
    const { unlanded, counts } = summarize(classified);
    // Five branches ahead of main; two of them are work nobody can see.
    assert.equal(classified.length, 5);
    assert.equal(unlanded, 2);
    assert.deepEqual(counts, { unlanded: 2, unreferenced: 1, "pull-request": 1, residue: 1 });
  });

  it("puts unlanded work first and residue last", () => {
    const states = summarize(classified).branches.map((b) => b.state);
    assert.deepEqual(states, ["unlanded", "unlanded", "unreferenced", "pull-request", "residue"]);
  });

  it("orders branches of the same state by name, so two runs print the same list", () => {
    const names = summarize(classified)
      .branches.filter((b) => b.state === "unlanded")
      .map((b) => b.branch);
    assert.deepEqual(names, ["claude/busy-lamport-ly8y44", "claude/busy-lamport-yl1kal"]);
  });

  it("reports zero for a repository with nothing outstanding", () => {
    assert.deepEqual(summarize([]).counts, { unlanded: 0, unreferenced: 0, "pull-request": 0, residue: 0 });
  });
});
