/**
 * The notices that link to `/legal` follow the same switches as `/legal` (#291).
 *
 * `/legal` was fixed to stop naming itself a draft once enacted. The login page
 * and the consent screens kept saying 「未施行の案」 and 「確認用草案」 as fixed
 * text. These call the functions those screens now render, under each
 * combination of the two enactment switches.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CONSENT_DOCUMENT_V2 } from "../src/lib/consentDocument.ts";
import { LEGAL_DOCUMENTS, documentHeading } from "../src/lib/legalDocuments.ts";
import { LEGAL_ENACTED_VERSION } from "../src/lib/legalEnactment.ts";
import { loginLegalNotice, researchDocumentNotice } from "../src/lib/legalNotices.ts";

const LEGAL_ON = { NEXT_PUBLIC_LEGAL_ENACTED: LEGAL_ENACTED_VERSION, NEXT_PUBLIC_LEGAL_EFFECTIVE_DATE: "2026-10-01" };
const LEGAL_OFF = { NEXT_PUBLIC_LEGAL_ENACTED: undefined, NEXT_PUBLIC_LEGAL_EFFECTIVE_DATE: undefined };
const CONSENT_ON = { NEXT_PUBLIC_CONSENT_DOCUMENT_ENACTED: CONSENT_DOCUMENT_V2 };
const CONSENT_OFF = { NEXT_PUBLIC_CONSENT_DOCUMENT_ENACTED: undefined };

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

const DRAFT_WORDS = /草案|未施行|（案）|改訂案/;
const text = (notice) => `${notice.link} ${notice.note}`;
const heading = (id) => documentHeading(LEGAL_DOCUMENTS.find((document) => document.id === id));

describe("the login page's notice about the terms and the privacy policy", () => {
  it("calls them a draft while they are one", () => {
    withEnv({ ...LEGAL_OFF, ...CONSENT_OFF }, () => {
      assert.match(text(loginLegalNotice()), /確認用草案/);
      assert.match(text(loginLegalNotice()), /未施行/);
    });
  });

  it("stops calling them a draft once they are in force", () => {
    withEnv({ ...LEGAL_ON, ...CONSENT_OFF }, () => {
      assert.doesNotMatch(text(loginLegalNotice()), DRAFT_WORDS);
    });
  });

  it("agrees with the heading `/legal` shows for the same document, in both states", () => {
    for (const env of [LEGAL_OFF, LEGAL_ON]) {
      withEnv({ ...env, ...CONSENT_OFF }, () => {
        assert.equal(
          DRAFT_WORDS.test(text(loginLegalNotice())),
          /（案）/.test(heading("terms")),
          "the login page and /legal disagree about whether the terms are a draft",
        );
      });
    }
  });

  it("never says that signing up is agreement", () => {
    for (const env of [LEGAL_OFF, LEGAL_ON]) {
      withEnv(env, () => assert.match(loginLegalNotice().note, /同意として記録(しません|されません)/));
    }
  });

  it("is not moved by the research documents' switch", () => {
    withEnv({ ...LEGAL_OFF, ...CONSENT_ON }, () => assert.match(text(loginLegalNotice()), /確認用草案/));
  });
});

describe("the consent screens' notice about the research documents", () => {
  for (const audience of ["research", "guardian"]) {
    it(`${audience}: calls them a draft while they are one`, () => {
      withEnv({ ...CONSENT_OFF, ...LEGAL_OFF }, () => {
        assert.match(text(researchDocumentNotice(audience)), /確認用草案/);
        assert.match(text(researchDocumentNotice(audience)), /改訂案/);
      });
    });

    it(`${audience}: stops once the consent document is enacted, and still says reading is not consent`, () => {
      withEnv({ ...CONSENT_ON, ...LEGAL_OFF }, () => {
        const notice = researchDocumentNotice(audience);
        assert.doesNotMatch(text(notice), DRAFT_WORDS);
        assert.match(notice.note, /同意として記録されません/);
      });
    });

    it(`${audience}: agrees with the heading \`/legal\` shows, in both states`, () => {
      for (const env of [CONSENT_OFF, CONSENT_ON]) {
        withEnv({ ...env, ...LEGAL_OFF }, () => {
          assert.equal(DRAFT_WORDS.test(text(researchDocumentNotice(audience))), /（案）/.test(heading(audience)));
        });
      }
    });

    it(`${audience}: is not moved by the terms' switch`, () => {
      // Two enactments, two decisions. Counsel enacting the terms must not
      // relabel a consent pack that still has blanks in it.
      withEnv({ ...CONSENT_OFF, ...LEGAL_ON }, () => {
        assert.match(text(researchDocumentNotice(audience)), /確認用草案/);
      });
    });
  }

  it("names the right document for each audience", () => {
    for (const env of [CONSENT_OFF, CONSENT_ON]) {
      withEnv(env, () => {
        assert.match(researchDocumentNotice("guardian").link, /保護者/);
        assert.doesNotMatch(researchDocumentNotice("research").link, /保護者/);
      });
    }
  });
});
