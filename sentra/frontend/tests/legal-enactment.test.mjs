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
  LEGAL_ACCEPTABLE_DOCUMENTS,
  LEGAL_ENACTED_VERSION,
  currentLegalVersion,
  isLegalAcceptableDocument,
  legalDisplayVersion,
  legalDocumentLabel,
  legalEffectiveDate,
  legalEnacted,
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
    // The service-role client appears in the route for one thing only, the
    // attempt counter (#253). That no acceptance is written through it is
    // checked by calling the route, in tests/rate-limit-routes.test.mjs.
    assert.doesNotMatch(code(route), /serviceRoleClient\(\)\s*\n?\s*\.from/);
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

describe("the page has somewhere to accept (#251)", () => {
  it("takes enactment from legalEnactment.ts and hands the same value to the control", () => {
    // One source for "in force". A screen that decided it on its own grounds
    // could offer a button for a version the server would stamp differently.
    assert.match(code(page), /const enacted = legalEnacted\(\)/);
    assert.match(code(page), /<LegalAcceptanceProvider enacted=\{enacted\}>/);
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
    assert.match(code(control), /if \(!enacted\) \{\s*status = <p className="bl-body">\{t\.legalAcceptance\.notEnacted\}/);
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
