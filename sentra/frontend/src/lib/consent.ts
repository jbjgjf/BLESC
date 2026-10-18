/**
 * The research consent model (#134).
 *
 * Consent used to be a default: `DEFAULT_CONSENT` in `supabaseWriter.ts` set
 * `research_analysis: true`, the journal screen sent no consent at all, and so
 * every submission was written to `consent_records` as agreed-to research use
 * by a participant who had never been asked. The record then read, to an
 * auditor, as evidence that consent had been obtained.
 *
 * So the defaults here are all false and every grant is separate. Nothing in
 * this module reads a checkbox: a checkbox is a claim by the browser, and the
 * server decides research use from the stored record (`server/consentStore.ts`)
 * — this module only says what a record means.
 */

/** The individual grants. Each is opted into on its own; none implies another. */
export type ConsentGrants = {
  /** Use the app at all. Separate from research: declining research still
   *  leaves a usable journal. */
  app_use: boolean;
  /** Analyse this participant's submissions as research data. */
  research_analysis: boolean;
  /** Include them in de-identified exports shared outside the study team. */
  anonymized_export: boolean;
  /** Retain their journal text (encrypted, expiring) for human evaluation of
   *  extraction accuracy — the retention #131 gates on. */
  raw_text_retention: boolean;
  /**
   * Always false. Blesc does not use participant data to train a model, with
   * or without consent (#469, consent-pack 第15条). The field stays because the
   * column does: past rows are evidence of what was asked.
   */
  model_training_use: boolean;
};

/**
 * For a minor, two people have to agree, and the record has to say which of
 * them did. Assent is the participant's own agreement; guardian consent is the
 * legally required one. Neither substitutes for the other.
 */
export type ConsentParties = {
  minor_assent: boolean;
  guardian_consent: boolean;
};

import { currentConsentDocumentVersion } from "./consentDocument.ts";

export type ConsentState = ConsentGrants &
  ConsentParties & {
    /** Version of the consent *schema* — what the flags mean. */
    consent_version: string;
    /** Version of the document the participant was actually shown. */
    document_version: string;
    status: "active" | "revoked";
    granted_at: string | null;
    revoked_at: string | null;
  };

export const CONSENT_VERSION = "research-consent-v2";

/**
 * Which document version is stamped onto a consent record.
 *
 * Derived from `consentDocument.ts` rather than written here, so the screen,
 * the legal page and the stored row cannot name three different documents —
 * which is exactly what they did until 2026-09-20.
 */
export const CONSENT_DOCUMENT_VERSION = currentConsentDocumentVersion();

/**
 * What a participant has agreed to when nothing is known about them: nothing.
 *
 * `app_use` is false here too. It is granted by the same flow as the rest, and
 * a participant with no record has not been through that flow — inferring it
 * would put the one bit that gates the whole app back on a default.
 */
export const NO_CONSENT: ConsentState = {
  app_use: false,
  research_analysis: false,
  anonymized_export: false,
  raw_text_retention: false,
  model_training_use: false,
  minor_assent: false,
  guardian_consent: false,
  consent_version: CONSENT_VERSION,
  document_version: CONSENT_DOCUMENT_VERSION,
  status: "active",
  granted_at: null,
  revoked_at: null,
};

function bool(value: unknown): boolean {
  return value === true;
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function timestamp(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/**
 * Read an arbitrary record — a `consent_records` row, a request body — as a
 * consent state. Every flag defaults to false: an absent field is not
 * agreement, and a malformed one is not either.
 */
export function normalizeConsent(input: unknown): ConsentState {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ...NO_CONSENT };
  const raw = input as Record<string, unknown>;
  const status = raw.status === "revoked" ? "revoked" : "active";
  return {
    app_use: bool(raw.app_use),
    research_analysis: bool(raw.research_analysis),
    anonymized_export: bool(raw.anonymized_export),
    raw_text_retention: bool(raw.raw_text_retention),
    // Read as false whatever the row says: the database refuses true since
    // 20261018000000, and a row from before that is not a permission (#469).
    model_training_use: false,
    minor_assent: bool(raw.minor_assent),
    guardian_consent: bool(raw.guardian_consent),
    consent_version: text(raw.consent_version, CONSENT_VERSION),
    document_version: text(raw.document_version, CONSENT_DOCUMENT_VERSION),
    status,
    granted_at: timestamp(raw.granted_at) ?? timestamp(raw.created_at),
    revoked_at: status === "revoked" ? timestamp(raw.revoked_at) : null,
  };
}

/**
 * Whether this participant's data may be used as research data at all.
 *
 * All four conditions, not any of them: an active record, the research grant,
 * the participant's own assent, and a guardian's consent. The pilot runs on
 * minors, so the guardian condition is unconditional here rather than applied
 * per-participant by age — an adult participant would need a separate branch,
 * and the safe direction for a study of high-school students is to require it.
 */
export function researchUseAllowed(state: ConsentState): boolean {
  return (
    state.status === "active" &&
    state.research_analysis &&
    state.minor_assent &&
    state.guardian_consent
  );
}

/** Whether the journal text itself may be retained (#131). Strictly narrower
 *  than research use: retention is its own grant on top of it. */
export function rawTextRetentionAllowed(state: ConsentState): boolean {
  return researchUseAllowed(state) && state.raw_text_retention;
}

/**
 * Whether this participant's data may be used to train a model: never (#469).
 *
 * blesc.jp promises 「日記を…AIモデルの学習に使うこともありません」, and on
 * 2026-10-18 the owner chose to keep that promise rather than qualify it. So
 * this no longer reads a consent item; there is no item to read. It is kept as
 * a function so the export and the transfer study ask the question in one
 * place, and get the same answer.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function modelTrainingUseAllowed(_state: ConsentState): boolean {
  return false;
}

/** Whether behavioural input telemetry may be stored (#135). */
export function telemetryAllowed(state: ConsentState): boolean {
  return researchUseAllowed(state);
}

/** Whether the submission may be added to the evaluation dataset. */
export function evalDatasetAllowed(state: ConsentState): boolean {
  return researchUseAllowed(state);
}

/** Whether the participant may be included in de-identified exports. */
export function anonymizedExportAllowed(state: ConsentState): boolean {
  return researchUseAllowed(state) && state.anonymized_export;
}

/**
 * The snapshot written alongside a row (`consent_snapshot_json`). It records
 * the decision *and* what it was based on, so a stored row can be re-checked
 * later without re-deriving it from a `consent_records` history.
 */
export function consentSnapshot(state: ConsentState): Record<string, unknown> {
  return {
    app_use: state.app_use,
    research_analysis: state.research_analysis,
    anonymized_export: state.anonymized_export,
    raw_text_retention: state.raw_text_retention,
    model_training_use: state.model_training_use,
    minor_assent: state.minor_assent,
    guardian_consent: state.guardian_consent,
    consent_version: state.consent_version,
    document_version: state.document_version,
    status: state.status,
    granted_at: state.granted_at,
    revoked_at: state.revoked_at,
    research_use_allowed: researchUseAllowed(state),
  };
}
