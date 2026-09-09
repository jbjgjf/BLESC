/**
 * Turning stored entries into a research dataset that cannot be re-identified
 * from its own contents (#167).
 *
 * The export that existed before this module was honest about consent and
 * careless about identity: it emitted `participant_id`, the database's own key,
 * and `created_at`, a wall-clock timestamp. Either one re-identifies a
 * participant to anyone holding a second table — and the study holds several.
 * Two changes fix that, and they are the whole idea here.
 *
 * **The pseudonym replaces the key.** Rows carry `research_code`, which
 * `pilot_enrollments` already mints for exactly this purpose. Nothing in a row
 * joins to `auth.users`.
 *
 * **Relative days replace dates.** A row says "day 3 of this participant's
 * collection window", not "2026-09-08T22:14:31Z". A timestamp that precise is
 * an identifier: cross it with a school calendar, an absence record, or a
 * single known event and the pseudonym is undone.
 *
 * The absolute dates still exist — in `pilot_enrollments.collection_started_at`,
 * reachable through the identity map, which is a different endpoint behind a
 * different allowlist. Someone holding *both* outputs can reconstruct wall-clock
 * time, and that is the intended design: re-identification stays possible for
 * the coordinator who must contact a participant, and stays impossible for the
 * analyst who was handed a dataset.
 *
 * **What `evidence_text` was doing.** The ontology extraction quotes the
 * sentence each node came from, verbatim, into `extraction_json.nodes[].
 * evidence_text`. The old export gated `raw_text` on retention consent and then
 * emitted `extraction_json` whole — so the journal text left anyway, in
 * fragments, for participants who had never agreed to retention. Stripping it
 * is not a refinement of this module; it is the point of it.
 */

import { localDayKey } from "./journalStats.ts";
import { scanForPii, summarizePii, type PiiFinding } from "./piiScanner.ts";

/** An entry as the export route reads it. */
export type ExportEntryRow = {
  id: string;
  participant_id: string;
  created_at: string;
  observation_type: string | null;
  extraction_json: Record<string, unknown> | null;
  raw_text_ciphertext: string | null;
  raw_text_expires_at: string | null;
};

/** The enrollment fields the dataset needs. Never the whole row. */
export type ExportEnrollmentRow = {
  participant_id: string;
  research_code: string;
  cohort: string;
  state: string;
  collection_started_at: string | null;
  withdrawn_at: string | null;
};

export type ExportConsentState = {
  research: boolean;
  retention: boolean;
  consent_version: string | null;
  document_version: string | null;
};

export type ExclusionReason =
  | "withdrawn"
  | "not_enrolled"
  | "no_research_consent"
  | "collection_not_started";

export type ResearchRow = {
  research_code: string;
  cohort: string;
  /** 1 on the first day of this participant's window. Never a wall-clock date. */
  day_index: number;
  observation_type: string | null;
  /** Counts only — how much structure the extraction found, not what it said. */
  measures: {
    node_count: number;
    relation_count: number;
    node_kinds: Record<string, number>;
    relation_kinds: Record<string, number>;
  };
  /** The graph, with every verbatim quotation removed unless text was allowed. */
  ontology: { nodes: unknown[]; relations: unknown[] };
  provenance: Record<string, unknown>;
  /**
   * The handle an operator uses to fetch the encrypted original through the
   *管理 path. It is the entry's primary key: opaque on its own, resolvable
   * only with database access, and never a login id.
   */
  raw_text_ref: string;
  raw_text_available: boolean;
  raw_text_expires_at: string | null;
  /** Present only when text was actually included in this export. */
  raw_text?: string | null;
  /** Present only when text was scanned, which requires having had the text. */
  pii?: ReturnType<typeof summarizePii> & { findings: PiiFinding[] };
};

export type DatasetResult = {
  rows: ResearchRow[];
  excluded: Record<ExclusionReason, number>;
  /** Distinct participants that contributed at least one row. */
  participant_count: number;
};

const NO_EXCLUSIONS: Record<ExclusionReason, number> = {
  withdrawn: 0,
  not_enrolled: 0,
  no_research_consent: 0,
  collection_not_started: 0,
};

/**
 * Day 1 is the first day of the participant's own window, in the study's
 * timezone.
 *
 * Both instants are reduced to a calendar day before subtracting. Subtracting
 * the instants themselves and dividing by 86400 would make an entry written at
 * 23:50 on day 1 and one written at 00:10 on day 2 land twenty minutes apart
 * and therefore on the same day — which is exactly the boundary a nightly
 * journal sits on.
 */
export function dayIndex(createdAt: string, startedAt: string, timeZone: string): number | null {
  const entryDay = localDayKey(createdAt, timeZone);
  const startDay = localDayKey(startedAt, timeZone);
  if (!entryDay || !startDay) return null;
  const entryMs = Date.parse(`${entryDay}T00:00:00Z`);
  const startMs = Date.parse(`${startDay}T00:00:00Z`);
  if (Number.isNaN(entryMs) || Number.isNaN(startMs)) return null;
  return Math.floor((entryMs - startMs) / 86_400_000) + 1;
}

function isWithdrawn(enrollment: ExportEnrollmentRow): boolean {
  // Either signal alone is enough. The state machine sets both, but a row
  // repaired by hand in the dashboard might carry only the timestamp, and a
  // dataset that shipped a withdrawn participant's entries because one column
  // disagreed with the other would be the kind of failure nobody notices.
  return enrollment.state === "withdrawn" || enrollment.withdrawn_at !== null;
}

/** `extraction_json` with every verbatim quotation removed. */
function stripEvidence(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripEvidence);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (key === "evidence_text" || key === "evidence" || key === "quote") continue;
      out[key] = stripEvidence(inner);
    }
    return out;
  }
  return value;
}

function countBy(items: unknown[], field: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const raw = (item as Record<string, unknown>)[field];
    const key = typeof raw === "string" && raw ? raw : "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/**
 * Build the pseudonymous dataset.
 *
 * `decryptedText` is a lookup the caller fills only for rows it was allowed to
 * decrypt; this function never decrypts anything itself, so the module stays
 * pure and testable without a key.
 */
export function buildResearchDataset(input: {
  entries: ExportEntryRow[];
  enrollments: ExportEnrollmentRow[];
  consentByParticipant: Map<string, ExportConsentState>;
  timeZone: string;
  /** Text by entry id. An entry absent from the map exports no text. */
  decryptedText?: Map<string, string | null>;
}): DatasetResult {
  const { entries, enrollments, consentByParticipant, timeZone } = input;
  const decrypted = input.decryptedText ?? new Map<string, string | null>();

  const enrollmentByParticipant = new Map<string, ExportEnrollmentRow>();
  for (const enrollment of enrollments) {
    enrollmentByParticipant.set(enrollment.participant_id, enrollment);
  }

  const excluded: Record<ExclusionReason, number> = { ...NO_EXCLUSIONS };
  const rows: ResearchRow[] = [];
  const contributors = new Set<string>();

  for (const entry of entries) {
    const enrollment = enrollmentByParticipant.get(entry.participant_id);

    // Order matters. Withdrawal is checked before consent because a withdrawn
    // participant whose consent row still reads `active` — the state machine
    // writes both, but not in one transaction — must still be excluded, and
    // must be counted as withdrawn rather than as a consent failure.
    if (!enrollment) {
      excluded.not_enrolled += 1;
      continue;
    }
    if (isWithdrawn(enrollment)) {
      excluded.withdrawn += 1;
      continue;
    }

    const consent = consentByParticipant.get(entry.participant_id);
    if (!consent?.research) {
      excluded.no_research_consent += 1;
      continue;
    }
    if (!enrollment.collection_started_at) {
      excluded.collection_not_started += 1;
      continue;
    }

    const index = dayIndex(entry.created_at, enrollment.collection_started_at, timeZone);
    if (index === null) {
      excluded.collection_not_started += 1;
      continue;
    }

    const extraction = (entry.extraction_json ?? {}) as Record<string, unknown>;
    const nodes = Array.isArray(extraction.nodes) ? (extraction.nodes as unknown[]) : [];
    const relations = Array.isArray(extraction.relations)
      ? (extraction.relations as unknown[])
      : [];

    const text = decrypted.get(entry.id) ?? null;
    const textIncluded = typeof text === "string" && text.length > 0;

    const row: ResearchRow = {
      research_code: enrollment.research_code,
      cohort: enrollment.cohort,
      day_index: index,
      observation_type: entry.observation_type,
      measures: {
        node_count: nodes.length,
        relation_count: relations.length,
        node_kinds: countBy(nodes, "type"),
        relation_kinds: countBy(relations, "type"),
      },
      // When the text is in the row anyway, keeping the quotations costs
      // nothing and lets a reviewer see which sentence a node came from.
      // When it is not, they are the leak this module exists to close.
      ontology: textIncluded
        ? { nodes, relations }
        : (stripEvidence({ nodes, relations }) as { nodes: unknown[]; relations: unknown[] }),
      provenance: {
        schema_version: extraction.schema_version ?? null,
        prompt_version: extraction.prompt_version ?? null,
        extraction_provider: extraction.provider ?? null,
        extraction_model: extraction.model ?? null,
        consent_version: consent.consent_version,
        consent_document_version: consent.document_version,
      },
      raw_text_ref: entry.id,
      raw_text_available: entry.raw_text_ciphertext !== null,
      raw_text_expires_at: entry.raw_text_expires_at,
    };

    if (textIncluded) {
      const findings = scanForPii(text);
      row.raw_text = text;
      row.pii = { ...summarizePii(findings), findings };
    }

    rows.push(row);
    contributors.add(enrollment.research_code);
  }

  return { rows, excluded, participant_count: contributors.size };
}

/**
 * The other half: pseudonym to database identity.
 *
 * Deliberately small and deliberately separate. This is the re-identification
 * key, so it is its own output behind its own allowlist, and it carries no
 * journal content whatsoever — someone who obtains it learns who a code is,
 * not what they wrote.
 */
export function buildIdentityMap(enrollments: ExportEnrollmentRow[]): Array<{
  research_code: string;
  participant_id: string;
  cohort: string;
  state: string;
  collection_started_at: string | null;
  withdrawn_at: string | null;
}> {
  return enrollments.map((enrollment) => ({
    research_code: enrollment.research_code,
    participant_id: enrollment.participant_id,
    cohort: enrollment.cohort,
    state: enrollment.state,
    collection_started_at: enrollment.collection_started_at,
    withdrawn_at: enrollment.withdrawn_at,
  }));
}

/**
 * Fields that must never appear in a dataset row, checked at runtime.
 *
 * A guard rather than a comment because the row is assembled from database
 * output: a column added to `entries` and spread into a row by a later change
 * would otherwise ship silently. The export route calls this and fails the
 * request rather than returning a row that carries an identifier.
 */
const FORBIDDEN_ROW_FIELDS = [
  "participant_id",
  "owner_user_id",
  "email",
  "user_id",
  "invitation_id",
  "code_hash",
  "created_at",
];

export function identityLeakIn(rows: ResearchRow[]): string | null {
  for (const row of rows) {
    for (const field of FORBIDDEN_ROW_FIELDS) {
      if (field in (row as unknown as Record<string, unknown>)) return field;
    }
  }
  return null;
}
