/**
 * One place that says which consent document this build asks people to agree to.
 *
 * Before this, three constants disagreed:
 *
 *   `consent.ts`         `CONSENT_DOCUMENT_VERSION = "research-consent-doc-v1"`
 *   `legalDocuments.ts`  `RESEARCH_DRAFT_VERSION  = "research-consent-doc-v2-draft"`
 *   `consent-pack.md`    「文書版名 research-consent-doc-v2」
 *
 * So the screen headed 「説明文書 research-consent-doc-v1」 rendered prose from a
 * document labelled `-draft`, and both were stamped onto rows as v1. The pack
 * is explicit about why that cannot stand: 「版が違う文書で取得した同意を、新しい
 * 版の同意として扱わない」 — a consent record is only worth anything if the string
 * in `document_version` identifies the text the person actually read.
 *
 * ## Why a gate and not just a new string
 *
 * The obvious change is to set the constant to `research-consent-doc-v2` and
 * move on. That would make it worse. The pack's 附則 lists blanks that must be
 * filled before it may be distributed — the implementer's address, the named
 * officers and their acceptance, the sub-processor details — and stamping v2
 * onto a row while the distributed document still contains 【要記入】 produces
 * exactly the artefact the pack forbids: a record asserting agreement to a
 * finished document that does not exist.
 *
 * So the version this build stamps is derived, not declared:
 *
 *   - **v2 is enacted only when `CONSENT_DOCUMENT_ENACTED` says so**, which a
 *     deployment sets after the blanks are filled and the approvals recorded.
 *   - Until then the build stamps v1 and the legal page keeps its `-draft`
 *     suffix, so nothing claims agreement to a document nobody has finished.
 *
 * `tests/consent-document.test.mjs` refuses to let the flag be enabled while
 * `docs/pilot/consent-pack.md` still contains a placeholder, so turning it on
 * is a decision somebody has to actually complete rather than one they can make
 * by typing `1`.
 */

/** The formal name the pack gives the revised document. */
export const CONSENT_DOCUMENT_V2 = "research-consent-doc-v2";

/** The version currently in force on rows written before the revision. */
export const CONSENT_DOCUMENT_V1 = "research-consent-doc-v1";

/**
 * Whether this deployment has enacted v2.
 *
 * Read from the environment rather than hard-coded so that enactment is a
 * deployment decision with a date on it, not a commit that quietly takes effect
 * wherever it lands.
 */
export function consentDocumentV2Enacted(): boolean {
  return process.env.NEXT_PUBLIC_CONSENT_DOCUMENT_ENACTED === "research-consent-doc-v2";
}

/** The version string stamped onto consent records written by this build. */
export function currentConsentDocumentVersion(): string {
  return consentDocumentV2Enacted() ? CONSENT_DOCUMENT_V2 : CONSENT_DOCUMENT_V1;
}

/**
 * What the legal page calls the research/guardian documents.
 *
 * The `-draft` suffix is the honest label while the pack has blanks in it, and
 * it disappears at the same moment the stamped version changes — one switch,
 * so the page and the record cannot describe different documents.
 */
export function researchDocumentLabel(): string {
  return consentDocumentV2Enacted() ? CONSENT_DOCUMENT_V2 : `${CONSENT_DOCUMENT_V2}-draft`;
}
