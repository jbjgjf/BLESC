/**
 * The shape of the pseudonymised research dataset, and the arithmetic that
 * produces it (#167).
 *
 * Pure — no database, no network, no environment. The route in
 * `app/api/research/pilot-export` reads the rows; everything about what a row
 * *is* lives here, so it can be tested against synthetic input, which is the
 * only input it is ever given in development.
 *
 * ===========================================================================
 * The rule the whole file exists to keep
 *
 * A research dataset carries `research_code`. It does not carry
 * `owner_user_id`, `participant_id`, an email address, an invitation code, or
 * a calendar date. Re-identification is then a deliberate act against
 * `pilot_enrollments` — a separate route, a separate allowlist, a separate
 * audit row — rather than a property of every file that leaves the system.
 *
 * `buildDatasetRow` below constructs rows by naming each field explicitly. It
 * never spreads a database row, because a spread exports whatever column
 * somebody adds next.
 * ===========================================================================
 */

import type { PiiKind, PiiSeverity } from "@/lib/piiScan";

/**
 * Bump when a field is added, removed or redefined. Carried in the export
 * envelope so an analysis file can say which contract produced it.
 */
export const PILOT_DATASET_VERSION = "pilot-dataset-v1";

/**
 * The study runs in Japanese schools and a school day is a JST day.
 *
 * Relative day has to be computed in the participant's calendar, not in UTC. A
 * submission at 23:30 JST is 14:30 UTC the same day, but one at 00:20 JST is
 * 15:20 UTC the *previous* day — so a UTC-based day number would move a late
 * writer's entry to yesterday and a night-owl's to the day before, which is a
 * systematic error correlated with exactly the sleep variable the study
 * measures.
 *
 * Fixed rather than read from the browser: `Intl` in a serverless region is
 * whatever the region is, and a participant's device clock is not evidence.
 * Japan has no daylight saving, so a constant offset is exact rather than an
 * approximation.
 */
export const STUDY_UTC_OFFSET_MINUTES = 9 * 60;

/** The JST calendar date of an instant, as `YYYY-MM-DD`. */
export function studyLocalDate(instant: string | Date): string | null {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.getTime())) return null;
  const shifted = new Date(date.getTime() + STUDY_UTC_OFFSET_MINUTES * 60_000);
  return shifted.toISOString().slice(0, 10);
}

/**
 * Days elapsed since collection opened, counting the opening day as 0.
 *
 * Calendar days in JST, not 24-hour periods: two entries written 20 hours apart
 * can be on different study days, and two written 4 hours apart across midnight
 * always are. Returns null when either instant is unusable — an enrollment that
 * never started collecting has no day 0, and a row with no day number is
 * reported as such rather than defaulted to 0.
 */
export function relativeDay(collectionStartedAt: string | null, submittedAt: string): number | null {
  if (!collectionStartedAt) return null;
  const start = studyLocalDate(collectionStartedAt);
  const submitted = studyLocalDate(submittedAt);
  if (!start || !submitted) return null;
  const startMs = Date.parse(`${start}T00:00:00.000Z`);
  const submittedMs = Date.parse(`${submitted}T00:00:00.000Z`);
  return Math.round((submittedMs - startMs) / 86_400_000);
}

export type StudyPhase = "baseline" | "observation" | "before_window" | "after_window";

/**
 * Which half of the protocol a day belongs to.
 *
 * The two windows are not interchangeable: the baseline days build the
 * within-person reference and cannot also be used to test deviation from it.
 * An analysis that loses the split silently trains and tests on the same days,
 * so the phase travels with every row rather than being recomputed downstream
 * from a day number and a remembered constant.
 *
 * A day outside both windows is labelled, not dropped. A submission on day 22
 * of a 21-day protocol is a protocol deviation, and the dry run has to be able
 * to see it (#168).
 */
export function studyPhase(day: number | null, baselineDays: number, observationDays: number): StudyPhase | null {
  if (day === null) return null;
  if (day < 0) return "before_window";
  if (day < baselineDays) return "baseline";
  if (day < baselineDays + observationDays) return "observation";
  return "after_window";
}

/** The five settled self-report items. Null means the item was not answered. */
export type SelfReportExport = {
  schema_version: string | null;
  mood: number | null;
  stress: number | null;
  sleep_quality: number | null;
  sleep_hours: number | null;
  event_intensity: number | null;
  /** How many values the client sent that the scale refused. Usually 0. */
  rejected_count: number;
};

export type PiiReviewExport = {
  status: string;
  scanner_version: string | null;
  finding_count: number;
  max_severity: PiiSeverity | null;
  kinds: PiiKind[];
};

export type DatasetRow = {
  /** The pseudonym. The only participant identifier in this file. */
  research_code: string;
  cohort: string;
  /**
   * Age band, not an age and not a birthdate. Carried because guardian consent
   * and the analysis both depend on it, and because it is already the coarsest
   * form of the fact.
   */
  is_minor: boolean;
  study_slug: string;
  protocol_version: string;
  consent_document_version: string;

  /** Days since collection opened, JST calendar. No absolute date is exported. */
  relative_day: number | null;
  study_phase: StudyPhase | null;
  observation_type: string | null;

  self_report: SelfReportExport;
  /**
   * Writing-process aggregates, allowlisted by key. Never the text, never the
   * keystroke stream — a per-keystroke series can reconstruct what was typed.
   */
  process_telemetry: Record<string, number>;

  /**
   * How to reach the encrypted original, for an operator who has decided they
   * need to. Not the text and not a key: an entry id, whether ciphertext
   * exists, which key version sealed it and when the purge job will remove it.
   *
   * `entry_id` is the administrative reference #167 asks for. It is not a login
   * id and does not resolve to one without privileged access to `entries`,
   * which is the point — the reference is usable by the operator who already
   * holds that access and inert in the hands of anyone else.
   */
  raw_text_ref: {
    entry_id: string;
    retained: boolean;
    key_version: string | null;
    expires_at: string | null;
  };

  /** Null when the entry has no queue row — no text was retained to scan. */
  pii_review: PiiReviewExport | null;

  provenance: {
    extraction_provider: string | null;
    extraction_model: string | null;
    /** True when the submission was collected with external inference off. */
    collection_only: boolean;
    dataset_version: string;
  };
};

/** The rows the builder reads. Named so the route's SELECT list is checkable. */
export type DatasetSource = {
  enrollment: {
    research_code: string;
    cohort: string;
    is_minor: boolean;
    collection_started_at: string | null;
  };
  study: {
    slug: string;
    protocol_version: string;
    consent_document_version: string;
    baseline_days: number;
    observation_days: number;
  };
  entry: {
    id: string;
    created_at: string;
    observation_type: string | null;
    extraction_provider: string | null;
    extraction_model: string | null;
    raw_text_ciphertext: string | null;
    raw_text_key_version: string | null;
    raw_text_expires_at: string | null;
  };
  selfReport: {
    schema_version: string;
    mood: number | null;
    stress: number | null;
    sleep_quality: number | null;
    sleep_hours: number | null;
    event_intensity: number | null;
    rejected_json: Record<string, unknown> | null;
  } | null;
  session: { aggregate_metrics_json: Record<string, unknown> | null } | null;
  piiReview: {
    status: string;
    scanner_version: string;
    finding_count: number;
    max_severity: string | null;
    kinds: string[] | null;
  } | null;
};

/**
 * The process-telemetry keys that may leave.
 *
 * An allowlist and not a filter: `aggregate_metrics_json` is written by the
 * browser, so its key set is whatever a future client version decides to put
 * there. Exporting the object as it arrives would make the dataset's contents
 * depend on a client release, and a client that starts recording a title, a
 * URL or a paste source would export it without anyone editing this file.
 */
export const TELEMETRY_EXPORT_KEYS: readonly string[] = [
  "compose_duration_ms",
  "pause_count",
  "revision_count",
  "backspace_count",
  "paste_count",
  "char_count",
  "word_count",
] as const;

function numericSubset(source: Record<string, unknown> | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!source) return out;
  for (const key of TELEMETRY_EXPORT_KEYS) {
    const value = source[key];
    // Numbers only. A key whose value is a string is not silently coerced: a
    // string in a numeric telemetry field is a client bug, and coercing it
    // would put "3" and 3 in the same column of the research file.
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

const SEVERITIES = new Set<PiiSeverity>(["high", "medium", "low"]);

/**
 * One dataset row, built field by field.
 *
 * Every property is named. Nothing is spread from a database row, so a column
 * added to `entries` tomorrow does not appear in tomorrow's export.
 */
export function buildDatasetRow(source: DatasetSource): DatasetRow {
  const day = relativeDay(source.enrollment.collection_started_at, source.entry.created_at);
  const severity = source.piiReview?.max_severity;
  return {
    research_code: source.enrollment.research_code,
    cohort: source.enrollment.cohort,
    is_minor: source.enrollment.is_minor,
    study_slug: source.study.slug,
    protocol_version: source.study.protocol_version,
    consent_document_version: source.study.consent_document_version,

    relative_day: day,
    study_phase: studyPhase(day, source.study.baseline_days, source.study.observation_days),
    observation_type: source.entry.observation_type,

    self_report: {
      schema_version: source.selfReport?.schema_version ?? null,
      mood: source.selfReport?.mood ?? null,
      stress: source.selfReport?.stress ?? null,
      sleep_quality: source.selfReport?.sleep_quality ?? null,
      sleep_hours: source.selfReport?.sleep_hours ?? null,
      event_intensity: source.selfReport?.event_intensity ?? null,
      rejected_count: Object.keys(source.selfReport?.rejected_json ?? {}).length,
    },
    process_telemetry: numericSubset(source.session?.aggregate_metrics_json),

    raw_text_ref: {
      entry_id: source.entry.id,
      retained: source.entry.raw_text_ciphertext !== null,
      key_version: source.entry.raw_text_key_version,
      expires_at: source.entry.raw_text_expires_at,
    },

    pii_review: source.piiReview
      ? {
          status: source.piiReview.status,
          scanner_version: source.piiReview.scanner_version,
          finding_count: source.piiReview.finding_count,
          max_severity:
            severity && SEVERITIES.has(severity as PiiSeverity) ? (severity as PiiSeverity) : null,
          kinds: (source.piiReview.kinds ?? []) as PiiKind[],
        }
      : null,

    provenance: {
      extraction_provider: source.entry.extraction_provider,
      extraction_model: source.entry.extraction_model,
      // `withheld_collection_only` is what `collectionMode.ts` stores in the
      // model column for a submission whose external inference was withheld.
      collection_only: source.entry.extraction_model === "withheld_collection_only",
      dataset_version: PILOT_DATASET_VERSION,
    },
  };
}

/**
 * Keys that must never appear anywhere in a serialised dataset.
 *
 * Exported so the test can assert against the same list the reviewer reads,
 * rather than a copy of it that can drift.
 */
export const FORBIDDEN_DATASET_KEYS: readonly string[] = [
  "owner_user_id",
  "participant_id",
  "user_id",
  "email",
  "code_hash",
  "code_prefix",
  "invitation_id",
  "raw_text",
  "raw_text_ciphertext",
] as const;

/**
 * Every forbidden key present in `value`, at any depth.
 *
 * Used by the export route before it responds, and by the test. Running it in
 * the route is not belt-and-braces: the route builds its rows through
 * `buildDatasetRow`, but the envelope around them is assembled by hand, and
 * this is the check that a future field added to that envelope has to pass.
 */
export function forbiddenKeysIn(value: unknown, path: string[] = []): string[] {
  const found: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => found.push(...forbiddenKeysIn(item, [...path, String(index)])));
    return found;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_DATASET_KEYS.includes(key)) found.push([...path, key].join("."));
      found.push(...forbiddenKeysIn(child, [...path, key]));
    }
  }
  return found;
}
