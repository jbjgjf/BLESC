import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";

import { buildInvitationSql } from "../scripts/dry-run-invitations.mjs";
import { dryRunInviteCode } from "../scripts/dry-run-codes.mjs";
import { hashInviteCode, normalizeInviteCode } from "../src/lib/server/inviteCodes.ts";

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

  it("has a seed that creates the ten accounts and leaves the state machine alone", () => {
    assert.ok(SEED.includes("generate_series(1, 10)"), "seed does not create ten accounts");
    assert.ok(SEED.includes("is_dry_run"), "seed does not mark the study as a dry run");
    assert.ok(!SEED.match(/insert into public\.pilot_enrollments/), "seed walks the state machine itself");
    // The hash is keyed with a secret SQL does not hold, so a seed that
    // inserts invitations is inserting ones nobody can redeem (#384).
    assert.ok(!SEED.match(/insert into public\.pilot_invitations/), "seed creates invitations in SQL");
  });

  describe("the invitation script", () => {
    const KEY = Buffer.alloc(32, 5).toString("base64");

    afterEach(() => {
      delete process.env.PILOT_INVITE_HMAC_KEY;
    });

    it("issues one invitation per account, stored as the hash the redeem route computes", () => {
      process.env.PILOT_INVITE_HMAC_KEY = KEY;
      const sql = buildInvitationSql(MATRIX);

      for (const account of MATRIX.accounts) {
        const code = dryRunInviteCode(account.id);
        assert.ok(normalizeInviteCode(code), `${code} would be refused before it is hashed`);
        assert.ok(sql.includes(`'${hashInviteCode(code)}'`), `no row carries the hash of ${code}`);
        assert.ok(!sql.includes(code), `${code} is stored in the clear`);
        assert.ok(!sql.includes(normalizeInviteCode(code)), `${code} is stored in the clear`);
      }
      assert.equal(sql.match(/'dry-run scenario \d+'/g).length, MATRIX.accounts.length);
    });

    it("puts the age band on the invitation for exactly the accounts the matrix calls minors", () => {
      process.env.PILOT_INVITE_HMAC_KEY = KEY;
      const sql = buildInvitationSql(MATRIX);
      for (const account of MATRIX.accounts) {
        const row = sql.split("\n").find((line) => line.includes(`'dry-run scenario ${account.id}'`));
        const expected = account.is_minor ? "'minor', true," : "'adult', false,";
        assert.ok(row.includes(expected), `#${account.id} should carry ${expected}`);
      }
    });

    it("expires only the account whose scenario is an expired code", () => {
      process.env.PILOT_INVITE_HMAC_KEY = KEY;
      const expired = buildInvitationSql(MATRIX)
        .split("\n")
        .filter((line) => line.includes("now() - interval"));
      assert.equal(expired.length, 1);
      assert.ok(expired[0].includes("'dry-run scenario 3'"));
    });

    it("refuses to print anything without the key", () => {
      assert.throws(() => buildInvitationSql(MATRIX), /PILOT_INVITE_HMAC_KEY/);
    });

    it("uses the codes the smoke runner types", () => {
      const output = execFileSync("node", ["--no-warnings", "scripts/dry-run-smoke.mjs", "--plan"], {
        encoding: "utf8",
      });
      assert.ok(output.includes(dryRunInviteCode(1)), "the plan does not redeem the seeded code");
    });
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
