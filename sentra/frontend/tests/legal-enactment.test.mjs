/**
 * The terms and the privacy policy can be enacted, and cannot be enacted by
 * accident.
 *
 * Both documents were headed 「（案）」 with 「施行日・承認日：未設定」, and the
 * page said — correctly — that reading them is not agreement. There was no way
 * to change that: no effective date to enact them from, and nowhere to record
 * that a person accepted a particular version at a particular moment. So the
 * documents could never stop being drafts.
 *
 * The prerequisite is this pair: a declared effective date, and a record. The
 * approval itself is a human decision and stays one.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  LEGAL_ENACTED_VERSION,
  currentLegalVersion,
  legalEffectiveDate,
  legalEnacted,
} from "../src/lib/legalEnactment.ts";

const read = (relative) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, " ");

const route = read("../src/app/api/legal/acceptance/route.ts");
const page = read("../src/app/legal/page.tsx");
const migration = read("../../supabase/migrations/20260921040000_legal_acceptances.sql");

function withEnv(values, run) {
  const saved = {};
  for (const [key, value] of Object.entries(values)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("enactment needs both halves", () => {
  it("is off by default", () => {
    withEnv({ NEXT_PUBLIC_LEGAL_ENACTED: undefined, NEXT_PUBLIC_LEGAL_EFFECTIVE_DATE: undefined }, () => {
      assert.equal(legalEnacted(), false);
      assert.match(currentLegalVersion(), /-draft$/);
    });
  });

  it("a version with no date does not enact", () => {
    // Nothing can be shown to anyone as binding without saying from when.
    withEnv(
      { NEXT_PUBLIC_LEGAL_ENACTED: LEGAL_ENACTED_VERSION, NEXT_PUBLIC_LEGAL_EFFECTIVE_DATE: undefined },
      () => assert.equal(legalEnacted(), false),
    );
  });

  it("a date with no version does not enact", () => {
    // A date does not say binding *to what*.
    withEnv(
      { NEXT_PUBLIC_LEGAL_ENACTED: undefined, NEXT_PUBLIC_LEGAL_EFFECTIVE_DATE: "2026-10-01" },
      () => assert.equal(legalEnacted(), false),
    );
  });

  it("a wrong version string does not enact", () => {
    withEnv(
      { NEXT_PUBLIC_LEGAL_ENACTED: "true", NEXT_PUBLIC_LEGAL_EFFECTIVE_DATE: "2026-10-01" },
      () => assert.equal(legalEnacted(), false),
    );
  });

  it("a malformed date does not enact", () => {
    withEnv(
      { NEXT_PUBLIC_LEGAL_ENACTED: LEGAL_ENACTED_VERSION, NEXT_PUBLIC_LEGAL_EFFECTIVE_DATE: "2026/10/01" },
      () => {
        assert.equal(legalEffectiveDate(), null);
        assert.equal(legalEnacted(), false);
      },
    );
  });

  it("both together enact, and drop the draft suffix", () => {
    withEnv(
      { NEXT_PUBLIC_LEGAL_ENACTED: LEGAL_ENACTED_VERSION, NEXT_PUBLIC_LEGAL_EFFECTIVE_DATE: "2026-10-01" },
      () => {
        assert.equal(legalEnacted(), true);
        assert.equal(currentLegalVersion(), LEGAL_ENACTED_VERSION);
      },
    );
  });
});

describe("an acceptance is a record of something that happened", () => {
  it("the client cannot name the version it accepted", () => {
    // Otherwise a client could claim agreement to a document it never showed.
    assert.match(code(route), /document_version: currentLegalVersion\(\)/);
    assert.doesNotMatch(code(route), /body\.document_version/);
  });

  it("is refused while the documents are drafts", () => {
    assert.match(code(route), /if \(!legalEnacted\(\)\)/);
    assert.match(route, /まだ施行されていないため、同意を記録できません/);
  });

  it("is written through the caller's own client, not service role", () => {
    assert.match(code(route), /auth\.client\s*\n?\s*\.from\("legal_acceptances"\)/);
    assert.doesNotMatch(code(route), /serviceRoleClient/);
  });

  it("cannot be edited or deleted afterwards", () => {
    // A consent record that can be rewritten is not a record.
    assert.match(migration, /legal_acceptances_select_own/);
    assert.match(migration, /legal_acceptances_insert_own/);
    assert.doesNotMatch(migration, /for update to authenticated/);
    assert.doesNotMatch(migration, /for delete to authenticated/);
  });

  it("does not add a row for the same version twice", () => {
    assert.match(migration, /unique \(user_id, document_id, document_version\)/);
    assert.match(code(route), /"23505"/);
  });

  it("keeps terms and privacy as separate rows", () => {
    // One of them can be revised without the other, and re-acceptance is then
    // owed for that one only.
    assert.match(migration, /document_id in \('terms', 'privacy'\)/);
  });

  it("stores the effective date beside the version", () => {
    // So a later change to the date cannot silently rewrite what someone
    // agreed to.
    assert.match(migration, /effective_date date/);
    assert.match(code(route), /effective_date: legalEffectiveDate\(\)/);
  });
});

describe("the page tells the truth in both states", () => {
  it("still says reading a draft is not agreement", () => {
    assert.match(page, /閲覧しても同意した扱いにはなりません/);
  });

  it("shows the effective date once enacted", () => {
    assert.match(code(page), /enacted \? effectiveDate : "未設定"/);
  });

  it("does not let the legal acceptance read as research consent", () => {
    assert.match(page, /この書類への同意は研究同意ではありません/);
  });
});
