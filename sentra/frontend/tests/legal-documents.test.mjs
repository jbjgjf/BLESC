import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { LEGAL_DOCUMENTS, LEGAL_CONTACT, LEGAL_ORGANIZATION, LEGAL_DRAFT_VERSION, RESEARCH_DRAFT_VERSION } from "../src/lib/legalDocuments.ts";
import { currentConsentDocumentVersion, researchDocumentLabel } from "../src/lib/consentDocument.ts";

test("legal review covers all four documents with delegated organization facts", () => {
  assert.deepEqual(LEGAL_DOCUMENTS.map((document) => document.id), ["privacy", "terms", "research", "guardian"]);
  assert.equal(LEGAL_CONTACT, "blesc.jp@gmail.com");
  assert.equal(LEGAL_ORGANIZATION.name, "Blesc株式会社");
  assert.equal(LEGAL_ORGANIZATION.representative, "田雨竜");
  assert.equal(LEGAL_ORGANIZATION.researchLead, "王謙蘊");
  assert.equal(LEGAL_DRAFT_VERSION, "legal-review-2026-09-14-v1");
  // Carries the `-draft` suffix until a deployment enacts v2, and drops it at
  // the same moment the stamped version changes (consentDocument.ts). Asserted
  // against the same helper so the two cannot drift back apart.
  assert.equal(RESEARCH_DRAFT_VERSION, researchDocumentLabel());
  assert.equal(RESEARCH_DRAFT_VERSION, "research-consent-doc-v2-draft");
  for (const document of LEGAL_DOCUMENTS) {
    assert.ok(document.sections.length > 0);
    assert.ok(document.sections.every((section) => section.paragraphs.length > 0));
  }
});

test("review route is public, non-indexed and does not replace active consent version", () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  assert.match(read("../src/components/AuthShell.tsx"), /PUBLIC_ROUTES[^;]*["']\/legal["']/s);
  const page = read("../src/app/legal/page.tsx");
  assert.match(page, /index: false, follow: false/);
  assert.match(page, /未施行・未承認/);
  assert.match(page, /閲覧しても同意した扱いにはなりません/);
  /*
   * The point of this line: reading the draft on /legal must not become the
   * version stamped on a consent record.
   *
   * It used to assert the literal `CONSENT_DOCUMENT_VERSION = "…v1"` in
   * `consent.ts`. That constant is now derived from `consentDocument.ts`, so
   * the literal is gone while the property is unchanged — and checking the
   * property is the stronger test anyway, because it also covers the case
   * where somebody enacts v2 without finishing the pack.
   */
  assert.equal(currentConsentDocumentVersion(), "research-consent-doc-v1");
  assert.equal(researchDocumentLabel(), "research-consent-doc-v2-draft");
});
