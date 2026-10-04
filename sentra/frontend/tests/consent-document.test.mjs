import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  CONSENT_DOCUMENT_V1,
  CONSENT_DOCUMENT_V3,
  consentDocumentV3Enacted,
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
const APPROVALS = read("../../../docs/pilot/approvals.md");

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
  it("stamps v1 while v3 is not enacted", () => {
    withEnv(undefined, () => {
      assert.equal(currentConsentDocumentVersion(), CONSENT_DOCUMENT_V1);
      // And the page says so, rather than presenting the draft as final.
      assert.equal(researchDocumentLabel(), `${CONSENT_DOCUMENT_V3}-draft`);
    });
  });

  it("stamps v3 and drops the draft label together", () => {
    withEnv(CONSENT_DOCUMENT_V3, () => {
      assert.equal(currentConsentDocumentVersion(), CONSENT_DOCUMENT_V3);
      assert.equal(researchDocumentLabel(), CONSENT_DOCUMENT_V3);
    });
  });

  it("ignores a value that is not the exact version string", () => {
    // `=1` or `=true` would be the natural guess and must not enact anything:
    // the variable names the document, so a deployment cannot enact "whatever
    // v3 happens to mean later".
    for (const value of ["1", "true", "v3", "research-consent-doc-v3-draft"]) {
      withEnv(value, () => assert.equal(consentDocumentV3Enacted(), false, value));
    }
  });

  it("no longer enacts v2, whose text this build does not carry (#315)", () => {
    // A deployment that set the flag to v2 before the period changed must fall
    // back to v1, not keep stamping a document that said 21 days.
    withEnv("research-consent-doc-v2", () => {
      assert.equal(consentDocumentV3Enacted(), false);
      assert.equal(currentConsentDocumentVersion(), CONSENT_DOCUMENT_V1);
    });
  });

  it("the two constants stay distinct", () => {
    assert.notEqual(CONSENT_DOCUMENT_V1, CONSENT_DOCUMENT_V3);
  });
});

describe("what has to be true before v2 may be enacted", () => {
  /*
   * This suite is the gate. It does not stop a deployment from setting the
   * variable — nothing in a test can — but it stops the repository from
   * reaching a state where doing so looks finished when it is not.
   */

  it("the pack still has blanks, so this build must not be stamping v3", () => {
    const placeholders = PACK.split("【要記入】").length - 1;

    if (placeholders > 0) {
      assert.equal(
        process.env.NEXT_PUBLIC_CONSENT_DOCUMENT_ENACTED,
        undefined,
        `consent-pack.md still has ${placeholders} 【要記入】 placeholder(s). ` +
          "Enacting v3 now would stamp rows as agreement to a document that does not exist yet.",
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
    assert.match(
      PACK,
      new RegExp(`\\| 文書版名 \\| \`${CONSENT_DOCUMENT_V3}\` \\|`),
      "the pack no longer names the version this build would stamp",
    );
  });

  it("v3 is not enacted until all three signatories have approved v3", () => {
    // approvals.md is where the version and the approval meet. The v2 rows
    // approved a 21-day text; they must not be read as approval of v3, and the
    // flag must not be set while any v3 row is still waiting.
    const v3Rows = APPROVALS.split("\n").filter(
      (line) => line.startsWith("|") && line.includes(`\`${CONSENT_DOCUMENT_V3}\``),
    );
    assert.equal(v3Rows.length, 3, "approvals.md needs one v3 row per signatory");
    const approved = v3Rows.filter((line) => line.includes("承認済み")).length;
    if (approved < 3) {
      assert.notEqual(
        process.env.NEXT_PUBLIC_CONSENT_DOCUMENT_ENACTED,
        CONSENT_DOCUMENT_V3,
        `only ${approved} of 3 signatories have approved ${CONSENT_DOCUMENT_V3}`,
      );
    }
  });
});
