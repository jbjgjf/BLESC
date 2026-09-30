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
 *
 * Every clock-dependent assertion below passes its own `Date`. A suite that
 * read the wall clock would start failing on 2026-10-01 for reasons that have
 * nothing to do with the code (#282).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  LEGAL_ENACTED_VERSION,
  currentLegalVersion,
  legalDocumentLabel,
  legalEffectiveDate,
  legalEffectiveDateLabel,
  legalEnacted,
  legalEnactmentState,
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

/** The day before `legal-2026-10-01-v1` takes effect, and the day of. */
const DAY_BEFORE = new Date("2026-09-30T12:00:00Z");
const EFFECTIVE_DAY = new Date("2026-10-01T12:00:00Z");

const enactedEnv = {
  NEXT_PUBLIC_LEGAL_ENACTED: LEGAL_ENACTED_VERSION,
  NEXT_PUBLIC_LEGAL_EFFECTIVE_DATE: "2026-10-01",
};

describe("enactment needs both halves", () => {
  it("is off by default", () => {
    withEnv({ NEXT_PUBLIC_LEGAL_ENACTED: undefined, NEXT_PUBLIC_LEGAL_EFFECTIVE_DATE: undefined }, () => {
      assert.equal(legalEnactmentState(EFFECTIVE_DAY), "draft");
      assert.equal(legalEnacted(EFFECTIVE_DAY), false);
      assert.match(currentLegalVersion(EFFECTIVE_DAY), /-draft$/);
    });
  });

  it("a version with no date does not enact", () => {
    // Nothing can be shown to anyone as binding without saying from when.
    withEnv(
      { NEXT_PUBLIC_LEGAL_ENACTED: LEGAL_ENACTED_VERSION, NEXT_PUBLIC_LEGAL_EFFECTIVE_DATE: undefined },
      () => assert.equal(legalEnacted(EFFECTIVE_DAY), false),
    );
  });

  it("a date with no version does not enact", () => {
    // A date does not say binding *to what*.
    withEnv(
      { NEXT_PUBLIC_LEGAL_ENACTED: undefined, NEXT_PUBLIC_LEGAL_EFFECTIVE_DATE: "2026-10-01" },
      () => assert.equal(legalEnacted(EFFECTIVE_DAY), false),
    );
  });

  it("a wrong version string does not enact", () => {
    withEnv(
      { NEXT_PUBLIC_LEGAL_ENACTED: "true", NEXT_PUBLIC_LEGAL_EFFECTIVE_DATE: "2026-10-01" },
      () => assert.equal(legalEnacted(EFFECTIVE_DAY), false),
    );
  });

  it("a malformed date does not enact", () => {
    withEnv(
      { NEXT_PUBLIC_LEGAL_ENACTED: LEGAL_ENACTED_VERSION, NEXT_PUBLIC_LEGAL_EFFECTIVE_DATE: "2026/10/01" },
      () => {
        assert.equal(legalEffectiveDate(), null);
        assert.equal(legalEnacted(EFFECTIVE_DAY), false);
      },
    );
  });

  it("a date that is not a day does not enact (#282)", () => {
    // `\d{4}-\d{2}-\d{2}` matches these. The calendar does not, and an
    // unchecked one reached the page as 「施行日：2026-13-45」.
    for (const impossible of ["2026-13-45", "2026-02-31", "2026-00-10", "2026-04-31"]) {
      withEnv(
        { ...enactedEnv, NEXT_PUBLIC_LEGAL_EFFECTIVE_DATE: impossible },
        () => {
          assert.equal(legalEffectiveDate(), null, impossible);
          assert.equal(legalEnactmentState(EFFECTIVE_DAY), "draft", impossible);
        },
      );
    }
  });

  it("accepts a real leap day", () => {
    withEnv({ ...enactedEnv, NEXT_PUBLIC_LEGAL_EFFECTIVE_DATE: "2028-02-29" }, () => {
      assert.equal(legalEffectiveDate(), "2028-02-29");
    });
  });

  it("both together enact on the effective day, and drop the draft suffix", () => {
    withEnv(enactedEnv, () => {
      assert.equal(legalEnactmentState(EFFECTIVE_DAY), "in_force");
      assert.equal(legalEnacted(EFFECTIVE_DAY), true);
      assert.equal(currentLegalVersion(EFFECTIVE_DAY), LEGAL_ENACTED_VERSION);
      assert.equal(legalDocumentLabel("利用規約", EFFECTIVE_DAY), "利用規約");
    });
  });
});

describe("a date in the future is scheduled, not in force (#282)", () => {
  it("does not enact the day before", () => {
    // The failure this replaces: `legalEnacted()` asked whether a date existed,
    // not whether it had arrived, so a deployment configured ahead of its own
    // effective date accepted binding agreements early — into a table with no
    // UPDATE and no DELETE policy, so the rows could not be taken back.
    withEnv(enactedEnv, () => {
      assert.equal(legalEnactmentState(DAY_BEFORE), "scheduled");
      assert.equal(legalEnacted(DAY_BEFORE), false);
    });
  });

  it("stamps a draft version on anything written before the day", () => {
    withEnv(enactedEnv, () => {
      assert.match(currentLegalVersion(DAY_BEFORE), /-draft$/);
      assert.equal(legalDocumentLabel("利用規約", DAY_BEFORE), "利用規約（案）");
    });
  });

  it("is a different state from draft, because the fix differs", () => {
    // 「まだ決まっていない」 and 「決まっているが、まだその日ではない」 are not the
    // same thing to tell a participant, and only the second has a date to show.
    withEnv({ NEXT_PUBLIC_LEGAL_ENACTED: undefined, NEXT_PUBLIC_LEGAL_EFFECTIVE_DATE: undefined }, () => {
      assert.equal(legalEnactmentState(DAY_BEFORE), "draft");
    });
    withEnv(enactedEnv, () => {
      assert.notEqual(legalEnactmentState(DAY_BEFORE), "draft");
    });
  });

  it("turns over in JST, not UTC", () => {
    // 2026-10-01 00:30 JST is 2026-09-30 15:30 UTC. The documents are Japanese
    // and the date is a Japanese effective date, so this instant is in force.
    withEnv(enactedEnv, () => {
      assert.equal(legalEnacted(new Date("2026-09-30T15:30:00Z")), true);
      // ...and 2026-09-30 23:30 JST is not.
      assert.equal(legalEnacted(new Date("2026-09-30T14:30:00Z")), false);
    });
  });

  it("names the scheduled day rather than saying 未設定", () => {
    // A deployment that has decided its effective date should not tell
    // participants that nothing has been decided.
    withEnv(enactedEnv, () => {
      assert.equal(legalEffectiveDateLabel(DAY_BEFORE), "2026-10-01（施行予定）");
      assert.equal(legalEffectiveDateLabel(EFFECTIVE_DAY), "2026-10-01");
    });
    withEnv({ NEXT_PUBLIC_LEGAL_ENACTED: undefined, NEXT_PUBLIC_LEGAL_EFFECTIVE_DATE: undefined }, () => {
      assert.equal(legalEffectiveDateLabel(DAY_BEFORE), "未設定");
    });
  });
});

describe("an acceptance is a record of something that happened", () => {
  it("the client cannot name the version it accepted", () => {
    // Otherwise a client could claim agreement to a document it never showed.
    assert.match(code(route), /document_version: currentLegalVersion\(\)/);
    assert.doesNotMatch(code(route), /body\.document_version/);
  });

  it("is refused while the documents are drafts", () => {
    assert.match(code(route), /state !== "in_force"/);
    assert.match(route, /まだ施行されていないため、同意を記録できません/);
  });

  it("is refused before the effective day, and says so differently (#282)", () => {
    // Separate code because the fix differs and neither is the client's:
    // `not_enacted` means nobody decided, `not_yet_effective` means somebody
    // did and the day has not come.
    assert.match(code(route), /state === "scheduled"/);
    assert.match(code(route), /code: "not_yet_effective"/);
    assert.match(route, /施行日より前に同意を記録することはできません/);
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

  it("gets the effective-date line from one tested function", () => {
    // The three states are asserted above by calling `legalEffectiveDateLabel`.
    // What is checked here is only that the page uses it rather than deciding
    // again — a second copy of the rule is a second place to get it wrong.
    assert.match(code(page), /\{effectiveDateLabel\}/);
    assert.doesNotMatch(code(page), /"未設定"/);
  });

  it("is not prerendered, because the clock is not a build-time value (#282)", () => {
    // Checked statically because it is a build-time declaration: there is no
    // runtime call that can be made to observe it from this suite. A
    // prerendered page would keep saying 「施行予定」 after the day arrived.
    assert.match(code(page), /export const dynamic = "force-dynamic"/);
  });

  it("says a scheduled document is not yet in force (#282)", () => {
    assert.match(code(page), /state === "scheduled"/);
    assert.match(page, /施行予定の案です。施行日まではまだ効力がなく/);
  });

  it("does not let the legal acceptance read as research consent", () => {
    assert.match(page, /この書類への同意は研究同意ではありません/);
  });
});
