import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { LEGAL_DOCUMENTS, LEGAL_CONTACT, LEGAL_ORGANIZATION, LEGAL_DRAFT_VERSION, RESEARCH_DRAFT_VERSION } from "../src/lib/legalDocuments.ts";

test("legal review covers all four documents with delegated organization facts", () => {
  assert.deepEqual(LEGAL_DOCUMENTS.map((document) => document.id), ["privacy", "terms", "research", "guardian"]);
  assert.equal(LEGAL_CONTACT, "blesc.jp@gmail.com");
  assert.equal(LEGAL_ORGANIZATION.name, "Blesc株式会社");
  assert.equal(LEGAL_ORGANIZATION.representative, "田雨竜");
  assert.equal(LEGAL_ORGANIZATION.researchLead, "王謙蘊");
  assert.equal(LEGAL_DRAFT_VERSION, "legal-review-2026-09-14-v1");
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
  assert.match(read("../src/lib/consent.ts"), /CONSENT_DOCUMENT_VERSION = "research-consent-doc-v1"/);
});
