/**
 * The pseudonymised research dataset (#167).
 *
 * `api/research/export` (#131) is the operator's read of retained journal text:
 * it exists so extraction accuracy can be evaluated by a human, and it hands
 * back `participant_id` and plaintext under an allowlist. This route is the
 * other output — the file an analysis actually runs on — and it deliberately
 * cannot do that:
 *
 *   - `research_code`, never `participant_id` and never `owner_user_id`.
 *   - Relative day, never a calendar date. A dataset with dates can be aligned
 *     against a school timetable, an exam week or a news event, and a cohort of
 *     fifty in one school is small enough for that to name people.
 *   - A reference to the encrypted original, never the original.
 *
 * Re-identification therefore requires `api/research/pilot-identity-map`, which
 * is a different route, a different allowlist and a different audit row. That
 * separation is the requirement (#167: identity mapとresearch datasetを別権限・
 * 別出力に), and having them as two files is what makes it hold: a reviewer can
 * see who holds which env var without reading any code.
 *
 * Four exclusions, all counted and all reported in the response and the audit
 * row, because a small export has to be explicable:
 *
 *   - withdrawn participants (the study must forget them going forward);
 *   - participants whose consent does not currently cover research use;
 *   - enrollments that never opened a collection window;
 *   - dry-run studies, unless the caller names one explicitly.
 */

import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireUser } from "@/lib/server/api";
import { serviceRoleClient } from "@/lib/server/supabaseWriter";
import { normalizeConsent, researchUseAllowed } from "@/lib/consent";
import { PII_SCANNER_LIMITS, PII_SCANNER_VERSION } from "@/lib/piiScan";
import {
  PILOT_DATASET_VERSION,
  buildDatasetRow,
  forbiddenKeysIn,
  type DatasetSource,
} from "@/lib/pilotExport";
import { authorizedExporters, auditExport, loadResearchConsent } from "@/lib/server/researchExportAudit";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_ROWS = 5000;

type EnrollmentRow = {
  participant_id: string;
  research_code: string;
  cohort: string;
  is_minor: boolean;
  state: string;
  collection_started_at: string | null;
};

type EntryRow = {
  id: string;
  participant_id: string;
  created_at: string;
  observation_type: string | null;
  extraction_provider: string | null;
  extraction_model: string | null;
  raw_text_ciphertext: string | null;
  raw_text_key_version: string | null;
  raw_text_expires_at: string | null;
};

export async function GET(request: NextRequest) {
  const auth = await requireUser(request);
  if ("error" in auth) return auth.error;

  const service = serviceRoleClient();
  if (!service) return jsonError("Supabase is not configured.", 503);

  const params = request.nextUrl.searchParams;
  const studySlug = params.get("study");
  const includeDryRun = params.get("include_dry_run") === "1";
  const limit = Math.min(Number(params.get("limit") ?? 2000) || 2000, MAX_ROWS);

  const audit = (status: "completed" | "denied" | "failed", rows: number, extra: Record<string, unknown>) =>
    auditExport(service, {
      requestedBy: auth.user.id,
      exportKind: "pilot_dataset",
      scope: { study: studySlug, limit, include_dry_run: includeDryRun },
      rowCount: rows,
      includedRawText: false,
      includedIdentityMap: false,
      status,
      ...extra,
    });

  if (!authorizedExporters().has(auth.user.id)) {
    await audit("denied", 0, { reason: "caller is not in RESEARCH_EXPORT_USER_IDS" });
    return jsonError("この操作は許可されていません。", 403);
  }

  // A study, named. Not "everything in the database": two studies in one file
  // is a merge nobody asked for, and the phase boundaries that make the rows
  // interpretable belong to one protocol version at a time.
  if (!studySlug) {
    await audit("denied", 0, { reason: "study slug is required" });
    return jsonError("study パラメータが必要です。", 422);
  }

  const studyResult = await service
    .from("pilot_studies")
    .select("id, slug, protocol_version, consent_document_version, baseline_days, observation_days, is_dry_run")
    .eq("slug", studySlug)
    .maybeSingle();
  if (studyResult.error) {
    await audit("failed", 0, { reason: studyResult.error.message });
    return jsonError(studyResult.error.message, 502);
  }
  const study = studyResult.data as
    | {
        id: string;
        slug: string;
        protocol_version: string;
        consent_document_version: string;
        baseline_days: number;
        observation_days: number;
        is_dry_run: boolean;
      }
    | null;
  if (!study) {
    await audit("denied", 0, { reason: "study not found" });
    return jsonError("その study は見つかりません。", 404);
  }

  // A dry run's rows must never join the analysis dataset by accident.
  //
  // Not "never exported": the dry run has to prove this route works before
  // fifty people are recruited (#168), and its text is synthetic, written by
  // trained adult staff. So the data is reachable only when the caller names
  // the study AND asks for it, the envelope is labelled `dry_run`, and the
  // audit row records the flag. What is prevented is the silent merge, which is
  // the failure that actually happens.
  if (study.is_dry_run && !includeDryRun) {
    await audit("denied", 0, {
      studyId: study.id,
      reason: "dry-run study requires include_dry_run=1",
      excluded: { dry_run: 1 },
    });
    return jsonError(
      "これは dry run の study です。include_dry_run=1 を明示してください。研究用datasetへは統合しないでください。",
      409,
    );
  }

  const enrollmentResult = await service
    .from("pilot_enrollments")
    .select("participant_id, research_code, cohort, is_minor, state, collection_started_at")
    .eq("study_id", study.id);
  if (enrollmentResult.error) {
    await audit("failed", 0, { studyId: study.id, reason: enrollmentResult.error.message });
    return jsonError(enrollmentResult.error.message, 502);
  }
  const allEnrollments = (enrollmentResult.data ?? []) as EnrollmentRow[];

  const excluded = { withdrawn: 0, never_collected: 0, no_research_consent: 0 };
  const eligible = new Map<string, EnrollmentRow>();
  const withdrawnParticipants: string[] = [];
  for (const enrollment of allEnrollments) {
    // Withdrawal is forward-looking and absolute: a participant who withdrew is
    // out of every export from that moment, whether or not their rows have been
    // purged yet. Checked here, at export time, and not inherited from what was
    // true when the entry was written.
    if (enrollment.state === "withdrawn") {
      excluded.withdrawn += 1;
      withdrawnParticipants.push(enrollment.participant_id);
      continue;
    }
    if (!enrollment.collection_started_at) {
      excluded.never_collected += 1;
      continue;
    }
    eligible.set(enrollment.participant_id, enrollment);
  }

  // Consent, read now. Same rule and same helper as #131's export: a
  // participant who revoked yesterday is not in today's file even though their
  // rows are still in the table.
  const consentByParticipant = await loadResearchConsent(service, Array.from(eligible.keys()));
  for (const [participantId] of eligible) {
    const state = consentByParticipant.get(participantId);
    if (!state || !researchUseAllowed(normalizeConsent(state))) {
      eligible.delete(participantId);
      excluded.no_research_consent += 1;
    }
  }

  if (eligible.size === 0) {
    await audit("completed", 0, { studyId: study.id, excluded });
    return NextResponse.json(envelope(study, [], excluded, includeDryRun));
  }

  const participantIds = Array.from(eligible.keys());
  const entriesResult = await service
    .from("entries")
    .select(
      "id, participant_id, created_at, observation_type, extraction_provider, extraction_model, raw_text_ciphertext, raw_text_key_version, raw_text_expires_at",
    )
    .in("participant_id", participantIds)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (entriesResult.error) {
    await audit("failed", 0, { studyId: study.id, reason: entriesResult.error.message });
    return jsonError(entriesResult.error.message, 502);
  }
  const entries = (entriesResult.data ?? []) as EntryRow[];
  const entryIds = entries.map((entry) => entry.id);

  // Three side tables, keyed by entry. Fetched in one round each rather than
  // per row: fifty participants times twenty-one days is a thousand entries,
  // and a per-row lookup is a thousand round trips.
  const [selfReports, sessions, reviews] = await Promise.all([
    entryIds.length
      ? service
          .from("pilot_self_reports")
          .select("entry_id, entry_session_id, schema_version, mood, stress, sleep_quality, sleep_hours, event_intensity, rejected_json")
          .in("entry_id", entryIds)
      : Promise.resolve({ data: [], error: null }),
    entryIds.length
      ? service
          .from("entry_research_links")
          .select("entry_id, entry_session_id")
          .in("entry_id", entryIds)
      : Promise.resolve({ data: [], error: null }),
    entryIds.length
      ? service
          .from("pilot_pii_reviews")
          .select("entry_id, status, scanner_version, finding_count, max_severity, kinds")
          .in("entry_id", entryIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  for (const result of [selfReports, sessions, reviews]) {
    if (result.error) {
      await audit("failed", 0, { studyId: study.id, reason: result.error.message });
      return jsonError(result.error.message, 502);
    }
  }

  const selfReportByEntry = new Map(
    ((selfReports.data ?? []) as Array<Record<string, unknown>>).map((row) => [String(row.entry_id), row]),
  );
  const sessionIdByEntry = new Map(
    ((sessions.data ?? []) as Array<Record<string, unknown>>)
      .filter((row) => row.entry_session_id)
      .map((row) => [String(row.entry_id), String(row.entry_session_id)]),
  );
  const reviewByEntry = new Map(
    ((reviews.data ?? []) as Array<Record<string, unknown>>).map((row) => [String(row.entry_id), row]),
  );

  // Session aggregates, by session id. Only the sessions these entries point
  // at, so a participant's other sessions are not read at all.
  const sessionIds = Array.from(new Set(sessionIdByEntry.values()));
  const aggregateBySession = new Map<string, Record<string, unknown>>();
  if (sessionIds.length > 0) {
    const sessionRows = await service
      .from("entry_sessions")
      .select("id, aggregate_metrics_json")
      .in("id", sessionIds);
    if (sessionRows.error) {
      await audit("failed", 0, { studyId: study.id, reason: sessionRows.error.message });
      return jsonError(sessionRows.error.message, 502);
    }
    for (const row of (sessionRows.data ?? []) as Array<Record<string, unknown>>) {
      aggregateBySession.set(String(row.id), (row.aggregate_metrics_json ?? {}) as Record<string, unknown>);
    }
  }

  const rows = entries.map((entry) => {
    const enrollment = eligible.get(entry.participant_id)!;
    const sessionId = sessionIdByEntry.get(entry.id);
    const source: DatasetSource = {
      enrollment: {
        research_code: enrollment.research_code,
        cohort: enrollment.cohort,
        is_minor: enrollment.is_minor,
        collection_started_at: enrollment.collection_started_at,
      },
      study: {
        slug: study.slug,
        protocol_version: study.protocol_version,
        consent_document_version: study.consent_document_version,
        baseline_days: study.baseline_days,
        observation_days: study.observation_days,
      },
      entry,
      selfReport: (selfReportByEntry.get(entry.id) ?? null) as DatasetSource["selfReport"],
      session: sessionId ? { aggregate_metrics_json: aggregateBySession.get(sessionId) ?? null } : null,
      piiReview: (reviewByEntry.get(entry.id) ?? null) as DatasetSource["piiReview"],
    };
    return buildDatasetRow(source);
  });

  const body = envelope(study, rows, excluded, includeDryRun);

  // The last check before anything leaves.
  //
  // Every row is built field by field by `buildDatasetRow`, so in principle
  // this can never fire. It runs anyway because the envelope around the rows is
  // assembled here by hand, and the failure this guards against is a field
  // added in a hurry — not a field added carelessly. An export that would carry
  // an identifier fails as an export; it does not ship with a warning.
  const leaked = forbiddenKeysIn(body);
  if (leaked.length > 0) {
    console.error("[pilot-export] refused: identifying keys in payload", leaked);
    await audit("failed", 0, { studyId: study.id, reason: `identifying_keys:${leaked.join(",")}` });
    return jsonError("exportを中止しました。識別子が含まれています。", 500);
  }

  await audit("completed", rows.length, { studyId: study.id, excluded });
  return NextResponse.json(body);
}

function envelope(
  study: { slug: string; protocol_version: string; consent_document_version: string; is_dry_run: boolean },
  rows: unknown[],
  excluded: Record<string, number>,
  includeDryRun: boolean,
) {
  return {
    dataset_version: PILOT_DATASET_VERSION,
    study_slug: study.slug,
    protocol_version: study.protocol_version,
    consent_document_version: study.consent_document_version,
    // Labelled in the file itself, not only in the request that produced it. A
    // CSV two directories deep is read by someone who did not make the request.
    dataset_kind: study.is_dry_run ? "dry_run" : "research",
    dry_run_included: study.is_dry_run && includeDryRun,
    generated_at: new Date().toISOString(),
    row_count: rows.length,
    excluded,
    pii_scanner: {
      version: PII_SCANNER_VERSION,
      // Shipped with the data, not filed in a wiki. The person who reads this
      // file is the person who needs to know what the scanner cannot see, and
      // they will not go looking for a document that says so.
      limits: PII_SCANNER_LIMITS,
    },
    rows,
  };
}
