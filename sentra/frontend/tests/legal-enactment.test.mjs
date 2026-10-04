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
  LEGAL_ACCEPTABLE_DOCUMENTS,
  LEGAL_ENACTED_VERSION,
  currentLegalVersion,
  isLegalAcceptableDocument,
  legalDisplayVersion,
  legalDocumentLabel,
  legalEffectiveDate,
  legalEffectiveDateLabel,
  legalEnacted,
  legalEnactmentState,
} from "../src/lib/legalEnactment.ts";
import {
  LEGAL_DOCUMENTS,
  LEGAL_DRAFT_VERSION,
  RESEARCH_DRAFT_VERSION,
  documentHeading,
  documentVersion,
} from "../src/lib/legalDocuments.ts";
import { ja } from "../src/lib/i18n/ja.ts";

const read = (relative) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, " ");

const route = read("../src/app/api/legal/acceptance/route.ts");
const page = read("../src/app/legal/page.tsx");
const control = read("../src/components/LegalAcceptance.tsx");
const migration = read("../../supabase/migrations/20260921040000_legal_acceptances.sql");
const nav = read("../src/components/AppNav.tsx");

const ENACTED = {
  NEXT_PUBLIC_LEGAL_ENACTED: LEGAL_ENACTED_VERSION,
  NEXT_PUBLIC_LEGAL_EFFECTIVE_DATE: "2026-10-01",
};
const UNENACTED = {
  NEXT_PUBLIC_LEGAL_ENACTED: undefined,
  NEXT_PUBLIC_LEGAL_EFFECTIVE_DATE: undefined,
};
const byId = (id) => LEGAL_DOCUMENTS.find((document) => document.id === id);

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

describe("the page has somewhere to accept (#251)", () => {
  it("takes enactment from legalEnactment.ts and hands the same value to the control", () => {
    // One source for "in force". A screen that decided it on its own grounds
    // could offer a button for a version the server would stamp differently.
    // Judged once per request, at one instant shared with the notice (#282).
    assert.match(code(page), /const now = new Date\(\)/);
    assert.match(code(page), /const enacted = legalEnacted\(now\)/);
    assert.match(code(page), /const state = legalEnactmentState\(now\)/);
    assert.match(code(page), /<LegalAcceptanceProvider enacted=\{enacted\}/);
  });

  it("hands the control the scheduled day for display only, never as permission (#282)", () => {
    // `enacted` is false while scheduled, so no button; the date only explains why.
    assert.match(code(page), /scheduledDate=\{state === "scheduled" \? effectiveDate : null\}/);
    assert.match(code(control), /scheduledDate \? t\.legalAcceptance\.notYetEffective\(scheduledDate\) : t\.legalAcceptance\.notEnacted/);
    assert.doesNotMatch(code(control), /scheduledDate[^\n]*canAccept = true/);
    assert.match(ja.legalAcceptance.notYetEffective("2026-10-01"), /2026-10-01 に施行される予定です/);
    assert.doesNotMatch(ja.legalAcceptance.notYetEffective("2026-10-01"), /施行日が決まり/);
  });

  it("offers acceptance only beneath a document showing the version the route will stamp", () => {
    // Otherwise a row would attest to a version the person was never shown.
    withEnv(
      { NEXT_PUBLIC_LEGAL_ENACTED: LEGAL_ENACTED_VERSION, NEXT_PUBLIC_LEGAL_EFFECTIVE_DATE: "2026-10-01" },
      () => {
        for (const document of LEGAL_DOCUMENTS.filter((d) => isLegalAcceptableDocument(d.id))) {
          assert.equal(documentVersion(document), currentLegalVersion(), document.id);
          assert.doesNotMatch(documentHeading(document), /（案）/, document.id);
        }
      },
    );
    assert.match(code(page), /版：\{documentVersion\(document\)\}/);
  });

  it("the control does not compute enactment itself", () => {
    assert.doesNotMatch(code(control), /legalEnacted\(/);
    assert.doesNotMatch(code(control), /NEXT_PUBLIC_LEGAL/);
    assert.doesNotMatch(code(control), /LEGAL_ENACTED_VERSION/);
    // The only thing it imports from the enactment module is a type.
    assert.match(code(control), /import type \{ LegalAcceptableDocument \} from "@\/lib\/legalEnactment"/);
  });

  it("offers the button only when enacted", () => {
    // #282: the not-enacted branch now also covers "scheduled", naming the day.
    assert.match(code(control), /if \(!enacted\) \{\s*status = \(\s*<p className="bl-body">\s*\{scheduledDate \? t\.legalAcceptance\.notYetEffective\(scheduledDate\) : t\.legalAcceptance\.notEnacted\}/);
    assert.match(code(control), /canAccept \? \(/);
  });

  it("never sends a version, only which document", () => {
    assert.match(code(control), /JSON\.stringify\(\{ document_id: documentId \}\)/);
    assert.doesNotMatch(code(control), /JSON\.stringify\([^)]*(document_version|current_version)/);
  });

  it("judges 'accepted' against the version the server says is current", () => {
    assert.match(code(control), /row\.document_version === state\.status\.current_version/);
  });

  it("answers already_accepted and not_enacted differently", () => {
    assert.match(code(control), /body\.status === "already_accepted"/);
    assert.match(code(control), /response\.status === 409 && body\.code === "not_enacted"/);
    assert.match(code(control), /already_accepted: t\.legalAcceptance\.alreadyAccepted/);
    assert.match(code(control), /not_enacted: t\.legalAcceptance\.rejectedNotEnacted/);
    assert.notEqual(ja.legalAcceptance.alreadyAccepted, ja.legalAcceptance.rejectedNotEnacted);
  });

  it("answers not_yet_effective as its own refusal, not as a generic failure (#282)", () => {
    assert.match(code(control), /response\.status === 409 && body\.code === "not_yet_effective"/);
    assert.match(code(control), /not_yet_effective: t\.legalAcceptance\.rejectedNotYetEffective/);
    assert.notEqual(ja.legalAcceptance.rejectedNotYetEffective, ja.legalAcceptance.rejectedNotEnacted);
    assert.match(ja.legalAcceptance.rejectedNotYetEffective, /施行日を迎えていない/);
  });

  it("says, next to the button, that this is not research consent", () => {
    assert.match(code(control), /t\.legalAcceptance\.notResearchConsent/);
    assert.match(ja.legalAcceptance.notResearchConsent, /研究参加の同意ではありません/);
  });

  it("leaves the documents readable when signed out", () => {
    // Only the status is gated on a session; the articles render regardless.
    assert.match(code(control), /state\.kind === "signed_out"/);
    assert.doesNotMatch(code(page), /useAuth|redirect\(/);
  });

  it("only terms and privacy can be accepted, on the page and in the route alike", () => {
    assert.deepEqual([...LEGAL_ACCEPTABLE_DOCUMENTS], ["terms", "privacy"]);
    assert.equal(isLegalAcceptableDocument("terms"), true);
    assert.equal(isLegalAcceptableDocument("privacy"), true);
    assert.equal(isLegalAcceptableDocument("research"), false);
    assert.equal(isLegalAcceptableDocument("guardian"), false);
    assert.equal(isLegalAcceptableDocument(undefined), false);
    assert.match(code(route), /isLegalAcceptableDocument\(documentId\)/);
    assert.match(code(page), /isLegalAcceptableDocument\(document\.id\)/);
  });
});

/*
 * The gap this block exists for.
 *
 * `legalDocumentLabel()` had no callers while all four titles carried a
 * hard-coded 「（案）」 and the page headed itself 「確認用草案」 unconditionally.
 * Enacting therefore produced one screen naming itself two ways, and — worse —
 * the terms and the privacy policy displayed `legal-review-2026-09-14-v1` while
 * `POST /api/legal/acceptance` wrote `legal-2026-10-01-v1`. The row asserted
 * agreement to a version the page had never shown, which is the one failure the
 * route's refusal to take a version from the request exists to rule out.
 *
 * So these assert values, not the presence of identifiers in a source file: a
 * test that greps for `legalDocumentLabel` would have passed throughout the
 * period the function was dead (#288).
 */
describe("what the page names and what a row records are the same document", () => {
  for (const id of ["terms", "privacy"]) {
    it(`${id}: the displayed version is the version that would be recorded, once enacted`, () => {
      withEnv(ENACTED, () => {
        assert.equal(documentVersion(byId(id)), currentLegalVersion());
        assert.equal(documentVersion(byId(id)), LEGAL_ENACTED_VERSION);
      });
    });

    it(`${id}: while unenacted the page keeps naming the draft it is showing`, () => {
      withEnv(UNENACTED, () => {
        assert.equal(documentVersion(byId(id)), LEGAL_DRAFT_VERSION);
        // Nothing can be recorded in this state — the route answers 409 — so the
        // displayed version deliberately does not match `currentLegalVersion()`.
        assert.match(currentLegalVersion(), /-draft$/);
      });
    });

    it(`${id}: 「（案）」 is dropped by enactment rather than stored in the title`, () => {
      assert.doesNotMatch(byId(id).title, /（案）/);
      withEnv(UNENACTED, () => assert.match(documentHeading(byId(id)), /（案）$/));
      withEnv(ENACTED, () => {
        assert.equal(documentHeading(byId(id)), byId(id).title);
        assert.doesNotMatch(documentHeading(byId(id)), /（案）/);
      });
    });
  }

  it("the legal switch does not relabel the research and guardian documents", () => {
    // Two enactments, two decisions: counsel enacting the terms says nothing
    // about whether the consent pack's 附則 blanks are filled. Enacting one must
    // not quietly declare the other's documents final.
    withEnv(ENACTED, () => {
      for (const id of ["research", "guardian"]) {
        assert.match(documentHeading(byId(id)), /（案）$/);
        assert.equal(documentVersion(byId(id)), RESEARCH_DRAFT_VERSION);
        assert.match(documentVersion(byId(id)), /-draft$/);
      }
    });
  });

  it("every document declares which switch governs it", () => {
    for (const document of LEGAL_DOCUMENTS) {
      assert.ok(
        ["legal", "research"].includes(document.enactment),
        `${document.id} does not say which enactment decision governs it`,
      );
    }
  });

  it("legalDocumentLabel and legalDisplayVersion are reached from the page", () => {
    // The functions are unit-tested above; this is the wiring. `documentHeading`
    // / `documentVersion` are the only callers, and the page must use them
    // rather than reading `document.title` and `document.version` raw.
    assert.match(code(page), /documentHeading\(document\)/);
    assert.match(code(page), /documentVersion\(document\)/);
    assert.doesNotMatch(code(page), /\{document\.title\}/);
    assert.doesNotMatch(code(page), /版：\{document\.version\}/);
  });

  it("the helpers themselves switch", () => {
    withEnv(UNENACTED, () => {
      assert.equal(legalDocumentLabel("利用規約"), "利用規約（案）");
      assert.equal(legalDisplayVersion(LEGAL_DRAFT_VERSION), LEGAL_DRAFT_VERSION);
    });
    withEnv(ENACTED, () => {
      assert.equal(legalDocumentLabel("利用規約"), "利用規約");
      assert.equal(legalDisplayVersion(LEGAL_DRAFT_VERSION), LEGAL_ENACTED_VERSION);
    });
  });

  it("before the effective day the helpers still name the draft (#282)", () => {
    // A declared future date is not in force: the heading keeps 「（案）」 and the
    // displayed version stays the draft the page is actually showing.
    withEnv(ENACTED, () => {
      assert.equal(legalDocumentLabel("利用規約", DAY_BEFORE), "利用規約（案）");
      assert.equal(legalDisplayVersion(LEGAL_DRAFT_VERSION, DAY_BEFORE), LEGAL_DRAFT_VERSION);
      assert.equal(legalDisplayVersion(LEGAL_DRAFT_VERSION, EFFECTIVE_DAY), LEGAL_ENACTED_VERSION);
    });
  });

  it("the tab title and the eyebrow switch with the notice", () => {
    // A static `metadata` object cannot, which is why the page exports
    // `generateMetadata()`. The noindex must survive the change.
    assert.match(code(page), /export function generateMetadata\(\)/);
    assert.doesNotMatch(code(page), /export const metadata/);
    assert.match(code(page), /index: false, follow: false/);
    assert.match(code(page), /legalEnacted\(\) \? "規約・プライバシーポリシー \| blesc"/);
    assert.match(code(page), /enacted \? "blesc · 規約・ポリシー"/);
  });

  it("the account menu does not keep calling it a draft", () => {
    assert.match(code(nav), /legalEnacted\(\) \? "規約・ポリシー" : "書類（確認用草案）"/);
  });
});
