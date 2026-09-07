import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/**
 * The dry-run scenario matrix (#168) has to stay runnable.
 *
 * The matrix, the seed and the smoke runner are three files that describe the
 * same ten accounts. They drift silently: someone adds a scenario to the JSON,
 * the seed still creates ten invitations, and the exercise runs with one
 * account that has no code. These tests hold them to each other.
 */

const MATRIX = JSON.parse(
  await readFile(
    fileURLToPath(new URL("../../../docs/pilot/dry-run/scenario-matrix.json", import.meta.url)),
    "utf8",
  ),
);

const SEED = await readFile(
  fileURLToPath(new URL("../../supabase/seed/pilot_dry_run.seed.sql", import.meta.url)),
  "utf8",
);

describe("the dry-run scenario matrix", () => {
  it("covers the ten paths the Wiki fixes", () => {
    assert.equal(MATRIX.accounts.length, 10);
    const labels = MATRIX.accounts.map((account) => account.label_ja);
    for (const needle of [
      "adult正常",
      "minor + guardian 正常",
      "invite期限切れ",
      "invite二重利用",
      "同意拒否",
      "guardian未確認",
      "2日目に撤回",
      "offline -> retry",
      "二重送信",
      "危機的記述の運用演習",
    ]) {
      assert.ok(
        labels.some((label) => label === needle),
        `no account covers ${needle}`,
      );
    }
  });

  it("gives every account something that must be exactly zero", () => {
    for (const account of MATRIX.accounts) {
      assert.ok(account.must_be_zero.length > 0, `#${account.id} has no zero condition`);
      assert.ok(account.must_verify.length > 0, `#${account.id} has nothing to verify`);
    }
  });

  it("keeps a minor on both sides of the guardian gate", () => {
    const minors = MATRIX.accounts.filter((account) => account.is_minor);
    assert.ok(minors.some((account) => account.expected_terminal_state === "collecting"));
    assert.ok(
      minors.some((account) => account.expected_terminal_state === "participant_assented"),
      "no account tests a minor stopped by the guardian gate",
    );
  });

  it("expects no research write for the accounts that must not produce one", () => {
    for (const id of [3, 5, 6]) {
      const account = MATRIX.accounts.find((entry) => entry.id === id);
      assert.ok(
        account.must_be_zero.includes("research_writes"),
        `#${id} should require zero research writes`,
      );
    }
  });

  it("has a seed that creates one invitation per account", () => {
    assert.ok(SEED.includes("generate_series(1, 10)"), "seed does not create ten invitations");
    assert.ok(SEED.includes("is_dry_run"), "seed does not mark the study as a dry run");
    assert.ok(
      SEED.includes("encode(digest("),
      "seed stores invitation codes in the clear; production hashes them and so must this",
    );
    assert.ok(!SEED.match(/insert into public\.pilot_enrollments/), "seed walks the state machine itself");
  });

  it("marks the minor cohorts in the seed for the accounts the matrix calls minors", () => {
    const minors = MATRIX.accounts.filter((account) => account.is_minor).map((account) => account.id);
    const seeded = SEED.match(/when n in \(([\d, ]+)\) then 'minor'/);
    assert.ok(seeded, "seed does not assign a minor cohort");
    const seededIds = seeded[1].split(",").map((value) => Number(value.trim()));
    assert.deepEqual(seededIds.sort(), minors.sort());
  });

  it("carries the Go conditions the issue lists", () => {
    const joined = MATRIX.go_conditions.join("\n");
    for (const needle of ["外部AI送信が0", "重複が0", "P0が0", "Discussion #137"]) {
      assert.ok(joined.includes(needle), `Go conditions omit ${needle}`);
    }
  });

  it("passes its own planner", () => {
    const output = execFileSync("node", ["scripts/dry-run-smoke.mjs", "--plan"], {
      encoding: "utf8",
    });
    assert.match(output, /scenario matrix ok: 10 accounts/);
    assert.match(output, /guardian_verify/);
  });
});
