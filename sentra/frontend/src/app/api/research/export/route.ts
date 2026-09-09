/**
 * Research export (#131, extended for #167).
 *
 * Three outputs, three different things, deliberately not one:
 *
 *   - `kind=dataset` — the pseudonymised research file. Research codes,
 *     relative days, the fixed self-report, process telemetry and provenance.
 *     No account id, no email, no calendar date, no journal text.
 *   - `kind=identity_map` — research code to participant record, behind its
 *     **own** allowlist (`RESEARCH_IDENTITY_USER_IDS`). Somebody has to be able
 *     to make this join — a participant who withdraws has to be findable — and
 *     the person doing analysis is not that somebody.
 *   - `kind=entries` (the default, unchanged) — retained journal text for the
 *     human evaluation of extraction accuracy that #131 exists for.
 *
 * Properties every kind holds:
 *
 *   - Authorization is an explicit allowlist, not a role anyone can end up in.
 *     An empty allowlist means nobody.
 *   - Only consented rows leave, re-checked at export time rather than
 *     inherited from whatever was true when the row was written.
 *   - **A withdrawn participant is not in any export**, whatever their consent
 *     record still says and whether or not their text has been purged yet.
 *     Withdrawal is a decision about the future, and the next export is the
 *     future.
 *   - Every attempt writes a `research_exports` row, including the denied ones.
 *     An export log that only records successes cannot answer "who tried".
 */

import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireUser } from "@/lib/server/api";
import { serviceRoleClient } from "@/lib/server/supabaseWriter";
import { decryptRawText } from "@/lib/server/rawTextCrypto";
import { normalizeConsent, rawTextRetentionAllowed, researchUseAllowed } from "@/lib/consent";
import { datasetRow, type DatasetSource } from "@/lib/server/researchDataset";
import { scanForPii, summarizePii } from "@/lib/piiScan";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_ROWS = 1000;

/** Bumped when the detectors change, so a queue row says which pattern set
 *  produced it. */
const PII_SCANNER_VERSION = "pii-scan-v1";

function allowlist(name: "RESEARCH_EXPORT_USER_IDS" | "RESEARCH_IDENTITY_USER_IDS"): Set<string> {
  return new Set(
    (process.env[name] ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

type EntryRow = {
  id: string;
  participant_id: string;
  created_at: string;
  observation_type: string | null;
  extraction_json: Record<string, unknown> | null;
  extraction_provider: string | null;
  extraction_model: string | null;
  raw_text_ciphertext: string | null;
  raw_text_expires_at: string | null;
};

type EnrollmentRow = {
  participant_id: string;
  research_code: string;
  cohort: string;
  state: string;
  collection_started_at: string | null;
  study_id: string;
};

export async function GET(request: NextRequest) {
  const auth = await requireUser(request);
  if ("error" in auth) return auth.error;

  const service = serviceRoleClient();
  if (!service) return jsonError("Supabase is not configured.", 503);

  const params = request.nextUrl.searchParams;
  const kind = params.get("kind") ?? "entries";
  const includeRawText = params.get("include_raw_text") === "1";
  const participantId = params.get("participant_id");
  const studySlug = params.get("study");
  const limit = Math.min(Number(params.get("limit") ?? 200) || 200, MAX_ROWS);

  const audit = async (
    status: "completed" | "denied" | "failed",
    rowCount: number,
    reason?: string,
    exportKind = kind === "entries" ? (includeRawText ? "entries_with_raw_text" : "entries_metadata") : kind,
  ) => {
    const { error } = await service.from("research_exports").insert({
      requested_by: auth.user.id,
      export_kind: exportKind,
      participant_scope_json: { participant_id: participantId, study: studySlug, limit },
      row_count: rowCount,
      included_raw_text: includeRawText && kind === "entries",
      status,
      reason: reason ?? null,
    });
    if (error) console.error("[research-export] audit row not written", error.message);
  };

  if (kind !== "entries" && kind !== "dataset" && kind !== "identity_map") {
    await audit("denied", 0, `unknown kind: ${kind}`);
    return jsonError("Unknown export kind.", 422);
  }

  // The identity map is the one output that can re-identify, so it has its own
  // allowlist. Being able to run the analysis file does not carry the right to
  // undo its pseudonymisation.
  const required = kind === "identity_map" ? "RESEARCH_IDENTITY_USER_IDS" : "RESEARCH_EXPORT_USER_IDS";
  if (!allowlist(required).has(auth.user.id)) {
    await audit("denied", 0, `caller is not in ${required}`);
    return jsonError("この操作は許可されていません。", 403);
  }

  // Enrollments carry the pseudonym, the window start and the withdrawal.
  // Loaded first because every kind filters on them.
  let enrollmentQuery = service
    .from("pilot_enrollments")
    .select("participant_id, research_code, cohort, state, collection_started_at, study_id");
  if (participantId) enrollmentQuery = enrollmentQuery.eq("participant_id", participantId);

  if (studySlug) {
    const study = await service.from("pilot_studies").select("id").eq("slug", studySlug).maybeSingle();
    if (study.error) {
      await audit("failed", 0, study.error.message);
      return jsonError(study.error.message, 502);
    }
    if (!study.data) {
      await audit("failed", 0, "study not found");
      return jsonError("Study was not found.", 404);
    }
    enrollmentQuery = enrollmentQuery.eq("study_id", (study.data as { id: string }).id);
  }

  const enrollmentResult = await enrollmentQuery;
  if (enrollmentResult.error) {
    await audit("failed", 0, enrollmentResult.error.message);
    return jsonError(enrollmentResult.error.message, 502);
  }

  const enrollments = (enrollmentResult.data ?? []) as EnrollmentRow[];
  const withdrawn = new Set(
    enrollments.filter((row) => row.state === "withdrawn").map((row) => row.participant_id),
  );
  const enrollmentByParticipant = new Map(
    enrollments.filter((row) => row.state !== "withdrawn").map((row) => [row.participant_id, row]),
  );

  if (kind === "identity_map") {
    // Research code to participant record, and nothing further. Not
    // `owner_user_id`: the study team joins this to the enrollment paperwork
    // the school holds, which is where a name lives. Putting the login id here
    // would make this file a credential-adjacent artefact rather than a
    // research one.
    const rows = enrollments.map((row) => ({
      research_code: row.research_code,
      participant_id: row.participant_id,
      cohort: row.cohort,
      state: row.state,
      collection_started_at: row.collection_started_at,
    }));
    await audit("completed", rows.length);
    return NextResponse.json({ rows, count: rows.length });
  }

  const participantIds = Array.from(enrollmentByParticipant.keys());

  // Consent, read now. A participant who revoked yesterday is not in today's
  // export even if their text has not been purged yet.
  const researchAllowed = new Map<string, boolean>();
  const retentionAllowed = new Map<string, boolean>();
  const documentVersion = new Map<string, string | null>();
  const consentScope = participantId ? [participantId] : participantIds;
  if (consentScope.length > 0) {
    const consentRows = await service
      .from("consent_records")
      .select(
        "participant_id, app_use, research_analysis, anonymized_export, raw_text_retention, future_fine_tuning, minor_assent, guardian_consent, consent_version, document_version, status, granted_at, revoked_at, created_at",
      )
      .in("participant_id", consentScope)
      .order("granted_at", { ascending: false });
    if (consentRows.error) {
      await audit("failed", 0, consentRows.error.message);
      return jsonError(consentRows.error.message, 502);
    }
    for (const record of (consentRows.data ?? []) as Array<Record<string, unknown>>) {
      const key = String(record.participant_id);
      // Ordered newest first, so the first row seen for a participant is the
      // current one and later ones are superseded history.
      if (!researchAllowed.has(key)) {
        const state = normalizeConsent(record);
        researchAllowed.set(key, researchUseAllowed(state));
        retentionAllowed.set(key, rawTextRetentionAllowed(state));
        documentVersion.set(key, state.document_version ?? null);
      }
    }
  }

  let entryQuery = service
    .from("entries")
    .select(
      "id, participant_id, created_at, observation_type, extraction_json, extraction_provider, extraction_model, raw_text_ciphertext, raw_text_expires_at",
    )
    .order("created_at", { ascending: false })
    .limit(limit);
  if (participantId) entryQuery = entryQuery.eq("participant_id", participantId);
  if (kind === "dataset" && participantIds.length > 0) {
    entryQuery = entryQuery.in("participant_id", participantIds);
  }

  const result = await entryQuery;
  if (result.error) {
    await audit("failed", 0, result.error.message);
    return jsonError(result.error.message, 502);
  }

  const rows = (result.data ?? []) as EntryRow[];

  // The consent gate applies to the whole row, not just the text.
  //
  // `extraction_json` is the structured reading of a journal entry — its
  // events, its emotions, the relations between them. Handing that to a
  // researcher is research use of the participant's data, and the rest of this
  // change refuses to write it to `eval_examples` without consent. Filtering
  // only the plaintext here would have let the same data out through a
  // different door for participants who were never asked, who declined, or who
  // revoked (#134).
  //
  // A participant with no consent record at all is not in the map, and
  // `?? false` keeps them out. A withdrawn one is excluded before that (#167).
  const eligible = rows.filter(
    (row) => !withdrawn.has(row.participant_id) && (researchAllowed.get(row.participant_id) ?? false),
  );
  const withheld = rows.length - eligible.length;
  const withheldWithdrawn = rows.filter((row) => withdrawn.has(row.participant_id)).length;

  if (kind === "entries") {
    const exported = await Promise.all(
      eligible.map(async (row) => {
        const mayIncludeText =
          includeRawText &&
          row.raw_text_ciphertext !== null &&
          (retentionAllowed.get(row.participant_id) ?? false);
        const text = mayIncludeText ? await decryptRawText(row.raw_text_ciphertext as string) : null;

        // Scanned here, where the text is already in memory because somebody
        // asked for it, rather than at submission time: the detectors change,
        // and a queue built at export is a queue built with today's patterns.
        if (text) await queuePiiReview(service, row.id, row.participant_id, text);

        return {
          entry_id: row.id,
          participant_id: row.participant_id,
          created_at: row.created_at,
          observation_type: row.observation_type,
          extraction_json: row.extraction_json,
          raw_text_expires_at: row.raw_text_expires_at,
          raw_text: text,
        };
      }),
    );

    await audit(
      "completed",
      exported.length,
      withheld > 0 ? `withheld:${withheld} withdrawn:${withheldWithdrawn}` : undefined,
    );
    return NextResponse.json({
      rows: exported,
      count: exported.length,
      withheld_without_consent: withheld - withheldWithdrawn,
      withheld_withdrawn: withheldWithdrawn,
    });
  }

  // kind === "dataset"
  const entryIds = eligible.map((row) => row.id);
  const studyById = new Map<string, { baseline_days: number; observation_days: number }>();
  const studyIds = Array.from(new Set(enrollments.map((row) => row.study_id)));
  if (studyIds.length > 0) {
    const studies = await service
      .from("pilot_studies")
      .select("id, baseline_days, observation_days")
      .in("id", studyIds);
    for (const study of (studies.data ?? []) as Array<{
      id: string;
      baseline_days: number;
      observation_days: number;
    }>) {
      studyById.set(study.id, { baseline_days: study.baseline_days, observation_days: study.observation_days });
    }
  }

  const selfReports = new Map<string, { schema_id: string; responses: unknown }>();
  const sessions = new Map<string, DatasetSource["session"]>();
  const fields = new Map<string, DatasetSource["fields"]>();
  const piiByEntry = new Map<string, Record<string, number>>();

  if (entryIds.length > 0) {
    // `entry_sessions` carries no `entry_id`: the writer keys a session by
    // `client_session_id` and links it to the entry through
    // `entry_research_links`. So the mapping is read from the link table
    // rather than assumed onto the session row.
    const [selfReportRows, linkRows, piiRows] = await Promise.all([
      service
        .from("entry_self_reports")
        .select("entry_id, entry_session_id, schema_id, responses_json")
        .in("entry_id", entryIds),
      service.from("entry_research_links").select("entry_id, entry_session_id").in("entry_id", entryIds),
      service.from("research_pii_reviews").select("entry_id, findings_json").in("entry_id", entryIds),
    ]);

    for (const row of (selfReportRows.data ?? []) as Array<Record<string, unknown>>) {
      selfReports.set(String(row.entry_id), {
        schema_id: String(row.schema_id),
        responses: row.responses_json,
      });
    }

    for (const row of (piiRows.data ?? []) as Array<Record<string, unknown>>) {
      piiByEntry.set(String(row.entry_id), (row.findings_json as Record<string, number>) ?? {});
    }

    const sessionIdByEntry = new Map<string, string>();
    for (const row of (linkRows.data ?? []) as Array<Record<string, unknown>>) {
      if (row.entry_session_id) sessionIdByEntry.set(String(row.entry_id), String(row.entry_session_id));
    }
    // A self-report written outside a telemetry session still names one when it
    // has it, so it fills any gap the link table leaves.
    for (const row of (selfReportRows.data ?? []) as Array<Record<string, unknown>>) {
      if (row.entry_session_id && !sessionIdByEntry.has(String(row.entry_id))) {
        sessionIdByEntry.set(String(row.entry_id), String(row.entry_session_id));
      }
    }

    const sessionIds = Array.from(new Set(sessionIdByEntry.values()));
    if (sessionIds.length > 0) {
      const [sessionRows, fieldRows] = await Promise.all([
        service
          .from("entry_sessions")
          .select("id, started_at, submitted_at, client_timezone, aggregate_metrics_json")
          .in("id", sessionIds),
        service
          .from("entry_fields")
          .select("entry_session_id, field_name, char_count, metrics_json")
          .in("entry_session_id", sessionIds),
      ]);

      const sessionById = new Map<string, DatasetSource["session"]>();
      for (const row of (sessionRows.data ?? []) as Array<Record<string, unknown>>) {
        sessionById.set(String(row.id), {
          started_at: (row.started_at as string) ?? null,
          submitted_at: (row.submitted_at as string) ?? null,
          client_timezone: (row.client_timezone as string) ?? null,
          aggregate_metrics: (row.aggregate_metrics_json as Record<string, unknown>) ?? null,
        });
      }

      const fieldsBySession = new Map<string, DatasetSource["fields"]>();
      for (const row of (fieldRows.data ?? []) as Array<Record<string, unknown>>) {
        const key = String(row.entry_session_id);
        const list = fieldsBySession.get(key) ?? [];
        list.push({
          field_name: String(row.field_name),
          char_count: (row.char_count as number) ?? null,
          metrics: (row.metrics_json as Record<string, unknown>) ?? null,
        });
        fieldsBySession.set(key, list);
      }

      for (const [entryId, sessionId] of sessionIdByEntry) {
        const session = sessionById.get(sessionId);
        if (session) sessions.set(entryId, session);
        fields.set(entryId, fieldsBySession.get(sessionId) ?? []);
      }
    }
  }

  const dataset = eligible.map((row) => {
    const enrollment = enrollmentByParticipant.get(row.participant_id);
    const study = enrollment ? studyById.get(enrollment.study_id) : undefined;
    return datasetRow({
      research_code: enrollment?.research_code ?? "UNENROLLED",
      cohort: enrollment?.cohort ?? "unknown",
      collection_started_at: enrollment?.collection_started_at ?? null,
      baseline_days: study?.baseline_days ?? 14,
      observation_days: study?.observation_days ?? 7,
      entry_id: row.id,
      submitted_at: row.created_at,
      observation_type: row.observation_type,
      extraction_provider: row.extraction_provider,
      extraction_model: row.extraction_model,
      raw_text_expires_at: row.raw_text_expires_at,
      has_retained_text: row.raw_text_ciphertext !== null,
      self_report: selfReports.get(row.id) ?? null,
      session: sessions.get(row.id) ?? null,
      fields: fields.get(row.id) ?? [],
      consent_document_version: documentVersion.get(row.participant_id) ?? null,
      pii_findings: piiByEntry.get(row.id) ?? null,
    });
  });

  await audit(
    "completed",
    dataset.length,
    withheld > 0 ? `withheld:${withheld} withdrawn:${withheldWithdrawn}` : undefined,
  );
  return NextResponse.json({
    rows: dataset,
    count: dataset.length,
    withheld_without_consent: withheld - withheldWithdrawn,
    withheld_withdrawn: withheldWithdrawn,
    self_report_schema_id: dataset[0]?.self_report.schema_id ?? null,
  });
}

/**
 * Put an entry on the review queue if the scanner found anything.
 *
 * Counts per kind, never offsets and never the matched text: the operator
 * surfaces built on this table exist so that the study can be watched without
 * reading anyone's journal.
 *
 * A failure here does not fail the export. The queue is a review aid; losing a
 * row means a reviewer does not get a prompt, which is recoverable by
 * re-running the export. Failing the export would mean the evaluation work
 * stops because a secondary table was unavailable.
 */
async function queuePiiReview(
  service: ReturnType<typeof serviceRoleClient>,
  entryId: string,
  participantId: string,
  text: string,
): Promise<void> {
  if (!service) return;
  const findings = scanForPii(text);
  if (findings.length === 0) return;

  const { error } = await service.from("research_pii_reviews").upsert(
    {
      entry_id: entryId,
      participant_id: participantId,
      findings_json: summarizePii(findings),
      scanner_version: PII_SCANNER_VERSION,
      status: "pending",
    },
    { onConflict: "entry_id,scanner_version", ignoreDuplicates: true },
  );
  if (error) console.warn("[research-export] pii review row not written", error.message);
}
