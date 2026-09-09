/**
 * Shaping the pseudonymised research dataset (#167).
 *
 * The export that existed before this returned `participant_id` and
 * `created_at`: an internal identifier that joins straight back to the account
 * table, and a calendar date that aligns to a school timetable. Both are
 * re-identification handed over in the dataset itself — one directly, one by
 * "which of the fifty was absent on the 14th".
 *
 * So the dataset carries a pseudonym and a relative day, and the mapping from
 * pseudonym to person lives in a **separate output behind a separate
 * allowlist**. Somebody has to be able to make that join — a participant who
 * withdraws has to be findable to delete — but the person doing analysis does
 * not need it, and a dataset that carries it cannot be shared with anyone who
 * should not have it.
 *
 * The pure functions here are separated from the route so the rules — which
 * day is day 1, when baseline ends, what may appear in a row — can be tested
 * without a database.
 */

import { flattenSelfReport, normalizeSelfReport, SELF_REPORT_SCHEMA_ID } from "@/lib/selfReport";

/**
 * The participant's own day 1, from the day their collection window opened.
 *
 * Calendar-independent by construction: two participants who started a week
 * apart both have a day 3, and neither row says which Tuesday it was.
 *
 * Whole days from the window's start, in UTC. Not local midnights — a
 * participant who writes at 23:50 and again at 00:10 has written on two
 * calendar days but is 20 minutes into the same one here, and the analysis
 * cares about elapsed time in the study, not about which side of midnight the
 * entry fell on. The protocol fixes this; changing it changes what a day means.
 */
export function relativeDay(submittedAt: string, collectionStartedAt: string | null): number | null {
  if (!collectionStartedAt) return null;
  const start = Date.parse(collectionStartedAt);
  const at = Date.parse(submittedAt);
  if (!Number.isFinite(start) || !Number.isFinite(at)) return null;

  const elapsedDays = Math.floor((at - start) / 86_400_000);
  // Day 1 is the first day of the window, not day 0: the protocol counts days
  // the way a participant would.
  const day = elapsedDays + 1;
  // A submission before the window opened is not part of the study. It should
  // not exist — the gate refuses it — and if one does, it is reported as
  // out-of-window rather than as a negative day the analysis has to interpret.
  return day >= 1 ? day : null;
}

export type StudyPhase = "baseline" | "observation" | "out_of_window";

export function studyPhase(
  day: number | null,
  baselineDays: number,
  observationDays: number,
): StudyPhase {
  if (day === null || day < 1) return "out_of_window";
  if (day <= baselineDays) return "baseline";
  if (day <= baselineDays + observationDays) return "observation";
  return "out_of_window";
}

/**
 * Keys that must never appear in a dataset row, at any depth.
 *
 * A list rather than a convention, because the dataset is assembled from four
 * tables and the next person to add a join will not remember which columns are
 * safe. `tests/research-dataset.test.mjs` walks a built row against this.
 */
export const FORBIDDEN_DATASET_KEYS = [
  "owner_user_id",
  "user_id",
  "email",
  "participant_id",
  "code",
  "invitation_id",
  "code_hash",
  "token_hash",
  "raw_text",
  "raw_text_ciphertext",
  "created_at",
] as const;

export type DatasetSource = {
  research_code: string;
  cohort: string;
  collection_started_at: string | null;
  baseline_days: number;
  observation_days: number;
  entry_id: string;
  submitted_at: string;
  observation_type: string | null;
  extraction_provider: string | null;
  extraction_model: string | null;
  raw_text_expires_at: string | null;
  has_retained_text: boolean;
  self_report: { schema_id: string; responses: unknown } | null;
  session: {
    started_at: string | null;
    submitted_at: string | null;
    client_timezone: string | null;
    aggregate_metrics: Record<string, unknown> | null;
  } | null;
  fields: Array<{ field_name: string; char_count: number | null; metrics: Record<string, unknown> | null }>;
  consent_document_version: string | null;
  pii_findings: Record<string, number> | null;
};

/**
 * One row of the dataset.
 *
 * `text_ref` is the entry id: an administrative reference the identity-scoped
 * export can resolve and the analyst cannot. It is what makes "row 41 needs its
 * text deleted" actionable without putting the text, or a route to the person,
 * into the analysis file.
 */
export function datasetRow(source: DatasetSource) {
  const day = relativeDay(source.submitted_at, source.collection_started_at);

  return {
    research_code: source.research_code,
    cohort: source.cohort,
    relative_day: day,
    study_phase: studyPhase(day, source.baseline_days, source.observation_days),
    observation_type: source.observation_type,

    self_report: {
      schema_id: source.self_report?.schema_id ?? SELF_REPORT_SCHEMA_ID,
      answered: source.self_report !== null,
      ...flattenSelfReport(normalizeSelfReport(source.self_report?.responses ?? {})),
    },

    process_telemetry: {
      client_timezone: source.session?.client_timezone ?? null,
      compose_duration_ms:
        source.session?.started_at && source.session?.submitted_at
          ? Math.max(0, Date.parse(source.session.submitted_at) - Date.parse(source.session.started_at))
          : null,
      aggregate_metrics: source.session?.aggregate_metrics ?? null,
      fields: source.fields.map((field) => ({
        field_name: field.field_name,
        char_count: field.char_count,
        metrics: field.metrics,
      })),
    },

    provenance: {
      extraction_provider: source.extraction_provider,
      extraction_model: source.extraction_model,
      self_report_schema_id: source.self_report?.schema_id ?? null,
      consent_document_version: source.consent_document_version,
    },

    text_ref: source.entry_id,
    text_retained: source.has_retained_text,
    text_expires_at: source.raw_text_expires_at,
    pii_findings: source.pii_findings,
  };
}

/** Every key present in an object, at any depth. Used by the test that walks a
 *  built row against `FORBIDDEN_DATASET_KEYS`. */
export function deepKeys(value: unknown, seen: string[] = []): string[] {
  if (!value || typeof value !== "object") return seen;
  if (Array.isArray(value)) {
    for (const item of value) deepKeys(item, seen);
    return seen;
  }
  for (const [key, child] of Object.entries(value)) {
    seen.push(key);
    deepKeys(child, seen);
  }
  return seen;
}
