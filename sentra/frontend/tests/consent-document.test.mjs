import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  CONSENT_DOCUMENT_V1,
  CONSENT_DOCUMENT_V2,
  consentDocumentV2Enacted,
  currentConsentDocumentVersion,
  researchDocumentLabel,
} from "../src/lib/consentDocument.ts";

/**
 * The version stamped on a consent record names the document the person read.
 *
 * Three constants used to disagree: the screen said `research-consent-doc-v1`,
 * the prose it rendered was labelled `research-consent-doc-v2-draft`, and
 * `consent-pack.md` called the real document `research-consent-doc-v2`. A row
 * written in that state asserts agreement to a document that was never shown.
 *
 * The pack states the rule this file enforces: 「版が違う文書で取得した同意を、
 * 新しい版の同意として扱わない」.
 */

const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
const PACK = read("../../../docs/pilot/consent-pack.md");

function withEnv(value, run) {
  const prior = process.env.NEXT_PUBLIC_CONSENT_DOCUMENT_ENACTED;
  if (value === undefined) delete process.env.NEXT_PUBLIC_CONSENT_DOCUMENT_ENACTED;
  else process.env.NEXT_PUBLIC_CONSENT_DOCUMENT_ENACTED = value;
  try {
    return run();
  } finally {
    if (prior === undefined) delete process.env.NEXT_PUBLIC_CONSENT_DOCUMENT_ENACTED;
    else process.env.NEXT_PUBLIC_CONSENT_DOCUMENT_ENACTED = prior;
  }
}

describe("one source for the document version", () => {
  it("stamps v1 while v2 is not enacted", () => {
    withEnv(undefined, () => {
      assert.equal(currentConsentDocumentVersion(), CONSENT_DOCUMENT_V1);
      // And the page says so, rather than presenting the draft as final.
      assert.equal(researchDocumentLabel(), `${CONSENT_DOCUMENT_V2}-draft`);
    });
  });

  it("stamps v2 and drops the draft label together", () => {
    withEnv(CONSENT_DOCUMENT_V2, () => {
      assert.equal(currentConsentDocumentVersion(), CONSENT_DOCUMENT_V2);
      assert.equal(researchDocumentLabel(), CONSENT_DOCUMENT_V2);
    });
  });

  it("ignores a value that is not the exact version string", () => {
    // `=1` or `=true` would be the natural guess and must not enact anything:
    // the variable names the document, so a deployment cannot enact "whatever
    // v2 happens to mean later".
    for (const value of ["1", "true", "v2", "research-consent-doc-v2-draft"]) {
      withEnv(value, () => assert.equal(consentDocumentV2Enacted(), false, value));
    }
  });

  it("the two constants stay distinct", () => {
    assert.notEqual(CONSENT_DOCUMENT_V1, CONSENT_DOCUMENT_V2);
  });
});

describe("what has to be true before v2 may be enacted", () => {
  /*
   * This suite is the gate. It does not stop a deployment from setting the
   * variable — nothing in a test can — but it stops the repository from
   * reaching a state where doing so looks finished when it is not.
   */

  it("the pack still has blanks, so this build must not be stamping v2", () => {
    const placeholders = PACK.split("【要記入】").length - 1;

    if (placeholders > 0) {
      assert.equal(
        process.env.NEXT_PUBLIC_CONSENT_DOCUMENT_ENACTED,
        undefined,
        `consent-pack.md still has ${placeholders} 【要記入】 placeholder(s). ` +
          "Enacting v2 now would stamp rows as agreement to a document that does not exist yet.",
      );
    }
  });

  it("names the conditions rather than leaving them to memory", () => {
    // 附則 3 is the checklist. If it is edited away, whoever removed it should
    // have to notice this test.
    assert.match(PACK, /### 3\. 施行条件/);
    assert.match(PACK, /演習/);
  });

  it("the pack and the code agree on the formal version string", () => {
    assert.ok(
      PACK.includes(CONSENT_DOCUMENT_V2),
      "the pack no longer names the version this build would stamp",
    );
  });
});
