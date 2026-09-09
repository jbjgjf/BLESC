/**
 * The allowlists and the audit row that every research output shares (#167).
 *
 * Three routes disclose research data — the raw-text export (#131), the
 * pseudonymised dataset and the identity map — and each one writes to
 * `research_exports`. Keeping the allowlist read and the audit insert here
 * rather than in each route is not tidiness: an audit table that three routes
 * write three slightly different shapes into cannot answer "who has ever been
 * able to re-identify a participant", which is the only question it exists for.
 *
 * Every attempt writes a row, including the denied ones. A log that records
 * only successes cannot answer "who tried".
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Who may pull the pseudonymised dataset and the retained text.
 *
 * An explicit list of user ids, not a role. A role is something an account can
 * end up holding; this is something a person had to be named in. An unset or
 * empty variable means nobody, so a deployment that has not decided who may
 * export cannot export.
 */
export function authorizedExporters(): Set<string> {
  return parseIdList(process.env.RESEARCH_EXPORT_USER_IDS);
}

/**
 * Who may resolve a research code back to an account.
 *
 * A **separate** variable from the one above, and deliberately not a superset
 * computed in code. Re-identification is a different decision from analysis,
 * usually made about a different person (a data-protection lead rather than an
 * analyst), and if the two lists were derived from each other then granting
 * someone the dataset would quietly grant them the map.
 *
 * The two may of course name the same person. That is then visible in the
 * deployment's environment, where it can be reviewed.
 */
export function authorizedIdentityMappers(): Set<string> {
  return parseIdList(process.env.RESEARCH_IDENTITY_MAP_USER_IDS);
}

function parseIdList(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

export type ExportAudit = {
  requestedBy: string;
  /** `pilot_dataset`, `pilot_identity_map`, `entries_with_raw_text`, … */
  exportKind: string;
  /** The request's parameters, as sent. Never a result. */
  scope: Record<string, unknown>;
  rowCount: number;
  includedRawText: boolean;
  includedIdentityMap: boolean;
  status: "completed" | "denied" | "failed";
  studyId?: string | null;
  reason?: string | null;
  /** Participants left out and why, as {withdrawn: n, …}. */
  excluded?: Record<string, number>;
};

/**
 * Write one audit row.
 *
 * Never throws and never blocks the response: an export that succeeded and
 * whose audit insert failed is still an export that happened, and turning that
 * into a 500 would hide the disclosure entirely rather than record it. The
 * failure is logged loudly instead, because an audit table with silent gaps is
 * worse than one with none.
 */
export async function auditExport(client: SupabaseClient, audit: ExportAudit): Promise<void> {
  const { error } = await client.from("research_exports").insert({
    requested_by: audit.requestedBy,
    export_kind: audit.exportKind,
    participant_scope_json: audit.scope,
    row_count: audit.rowCount,
    included_raw_text: audit.includedRawText,
    included_identity_map: audit.includedIdentityMap,
    study_id: audit.studyId ?? null,
    excluded_json: audit.excluded ?? {},
    status: audit.status,
    reason: audit.reason ?? null,
  });
  if (error) console.error("[research-export] audit row not written", audit.exportKind, error.message);
}

/**
/**
 * The outcome of a consent lookup, as a value the caller has to open.
 *
 * Not a bare map. An outage, a permission error or a migration lag would
 * otherwise come back as "nobody consented", and an export would report a
 * successful zero-row pull — making an operational failure indistinguishable
 * from a cohort that declined. Both fail closed, which is right; only one of
 * them should be recorded as a completed export.
 */
export type ConsentLookup =
  | { ok: true; byParticipant: Map<string, Record<string, unknown>> }
  | { ok: false; error: string };

/**
 * Current consent for each participant, newest record first.
 *
 * Read at export time rather than inherited from what was true when a row was
 * written: a participant who revoked yesterday is not in today's file even
 * though their rows are still in the table. One lookup for the whole cohort;
 * the caller applies `researchUseAllowed` (or whichever grant it needs) to the
 * state — `normalizeConsent` turns a record into one.
 *
 * A participant with no record is absent from the map, which every caller must
 * treat as "not allowed" — never as "not yet decided".
 */
export async function loadResearchConsent(
  client: SupabaseClient,
  participantIds: string[],
): Promise<ConsentLookup> {
  const byParticipant = new Map<string, Record<string, unknown>>();
  if (participantIds.length === 0) return { ok: true, byParticipant };

  const result = await client
    .from("consent_records")
    .select(
      "participant_id, app_use, research_analysis, anonymized_export, raw_text_retention, future_fine_tuning, minor_assent, guardian_consent, consent_version, document_version, status, granted_at, revoked_at, created_at",
    )
    .in("participant_id", participantIds)
    .order("granted_at", { ascending: false });
  if (result.error) {
    console.error("[research-export] consent lookup failed", result.error.message);
    return { ok: false, error: result.error.message };
  }

  for (const record of (result.data ?? []) as Array<Record<string, unknown>>) {
    const key = String(record.participant_id);
    // Ordered newest first, so the first row seen for a participant is the
    // current one and the rest are superseded history.
    if (!byParticipant.has(key)) byParticipant.set(key, record);
  }
  return { ok: true, byParticipant };
}
