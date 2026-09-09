/**
 * The operations dashboard (#167).
 *
 * What an operator needs during a running pilot is not the data — it is whether
 * the data is what it should be. Ten participants times three days is thirty
 * submissions; a run where twenty-six arrived is only interpretable if the four
 * can be attributed.
 *
 * So this route answers in counts and states, and never in text. There is no
 * parameter that returns a journal entry, no field that carries one, and the
 * SELECT lists below do not name a text column — `entries` is read for its id,
 * its timestamp and its participant, and nothing else. A dashboard that can
 * show a passage is a dashboard someone will leave open on a projector during a
 * staff meeting.
 *
 * It is deliberately available to the same allowlist as the export rather than
 * to a wider one. It contains no text, but it does contain a per-participant
 * compliance table under a pseudonym, and "who wrote least this week" is not a
 * thing a school should be able to look up casually.
 */

import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireUser } from "@/lib/server/api";
import { serviceRoleClient } from "@/lib/server/supabaseWriter";
import { normalizeConsent, researchUseAllowed } from "@/lib/consent";
import { relativeDay } from "@/lib/pilotExport";
import {
  expectedDays,
  reconcileParticipant,
  retentionStatus,
  tally,
  totalsFor,
  type ParticipantReconciliation,
} from "@/lib/pilotOps";
import { authorizedExporters } from "@/lib/server/researchExportAudit";

export const runtime = "nodejs";
export const maxDuration = 60;

type EnrollmentRow = {
  participant_id: string;
  research_code: string;
  cohort: string;
  state: string;
  is_minor: boolean;
  collection_started_at: string | null;
  withdrawn_at: string | null;
  completed_at: string | null;
};

export async function GET(request: NextRequest) {
  const auth = await requireUser(request);
  if ("error" in auth) return auth.error;
  if (!authorizedExporters().has(auth.user.id)) {
    return jsonError("この操作は許可されていません。", 403);
  }

  const service = serviceRoleClient();
  if (!service) return jsonError("Supabase is not configured.", 503);

  const studySlug = request.nextUrl.searchParams.get("study");
  if (!studySlug) return jsonError("study パラメータが必要です。", 422);

  const studyResult = await service
    .from("pilot_studies")
    .select("id, slug, status, protocol_version, baseline_days, observation_days, is_dry_run")
    .eq("slug", studySlug)
    .maybeSingle();
  if (studyResult.error) return jsonError(studyResult.error.message, 502);
  const study = studyResult.data as
    | {
        id: string;
        slug: string;
        status: string;
        protocol_version: string;
        baseline_days: number;
        observation_days: number;
        is_dry_run: boolean;
      }
    | null;
  if (!study) return jsonError("その study は見つかりません。", 404);

  const enrollmentResult = await service
    .from("pilot_enrollments")
    .select("participant_id, research_code, cohort, state, is_minor, collection_started_at, withdrawn_at, completed_at")
    .eq("study_id", study.id);
  if (enrollmentResult.error) return jsonError(enrollmentResult.error.message, 502);
  const enrollments = (enrollmentResult.data ?? []) as EnrollmentRow[];
  const participantIds = enrollments.map((row) => row.participant_id);

  const now = new Date().toISOString();

  if (participantIds.length === 0) {
    return NextResponse.json(emptyDashboard(study, now));
  }

  // Five reads, none of which names a text column.
  //
  // `entries` gives id, participant and timestamp — the timestamp becomes a
  // relative day and the absolute value never leaves this handler.
  const [entriesResult, selfReportResult, failureResult, reviewResult, consentResult] = await Promise.all([
    service
      .from("entries")
      .select("id, participant_id, created_at, client_submission_id, raw_text_ciphertext, raw_text_expires_at")
      .in("participant_id", participantIds),
    service.from("pilot_self_reports").select("entry_id, participant_id, schema_version").in("participant_id", participantIds),
    service.from("submission_failures").select("participant_id, outcome").in("participant_id", participantIds),
    service.from("pilot_pii_reviews").select("participant_id, status, max_severity, scanner_version").in("participant_id", participantIds),
    service
      .from("consent_records")
      .select(
        "participant_id, app_use, research_analysis, anonymized_export, raw_text_retention, future_fine_tuning, minor_assent, guardian_consent, consent_version, document_version, status, granted_at, revoked_at, created_at",
      )
      .in("participant_id", participantIds)
      .order("granted_at", { ascending: false }),
  ]);

  for (const result of [entriesResult, selfReportResult, failureResult, reviewResult, consentResult]) {
    if (result.error) return jsonError(result.error.message, 502);
  }

  const entries = (entriesResult.data ?? []) as Array<{
    id: string;
    participant_id: string;
    created_at: string;
    client_submission_id: string | null;
    // Read as "is there ciphertext", never decrypted and never returned.
    raw_text_ciphertext: string | null;
    raw_text_expires_at: string | null;
  }>;

  const selfReportEntryIds = new Set(
    ((selfReportResult.data ?? []) as Array<{ entry_id: string }>).map((row) => row.entry_id),
  );

  const failuresByParticipant = new Map<string, number>();
  for (const row of (failureResult.data ?? []) as Array<{ participant_id: string }>) {
    failuresByParticipant.set(row.participant_id, (failuresByParticipant.get(row.participant_id) ?? 0) + 1);
  }

  const entriesByParticipant = new Map<string, typeof entries>();
  for (const entry of entries) {
    const list = entriesByParticipant.get(entry.participant_id) ?? [];
    list.push(entry);
    entriesByParticipant.set(entry.participant_id, list);
  }

  // Current consent per participant, newest first — the same rule the export
  // applies, so a participant the dashboard shows as consented is one the
  // export would include.
  const currentConsent = new Map<string, Record<string, unknown>>();
  for (const record of (consentResult.data ?? []) as Array<Record<string, unknown>>) {
    const key = String(record.participant_id);
    if (!currentConsent.has(key)) currentConsent.set(key, record);
  }

  const participants: ParticipantReconciliation[] = enrollments.map((enrollment) => {
    const own = entriesByParticipant.get(enrollment.participant_id) ?? [];
    return reconcileParticipant({
      research_code: enrollment.research_code,
      cohort: enrollment.cohort,
      state: enrollment.state,
      expected_days: expectedDays({
        collectionStartedAt: enrollment.collection_started_at,
        withdrawnAt: enrollment.withdrawn_at,
        completedAt: enrollment.completed_at,
        baselineDays: study.baseline_days,
        observationDays: study.observation_days,
        now,
      }),
      submittedDayNumbers: own.map((entry) => relativeDay(enrollment.collection_started_at, entry.created_at)),
      failed_submissions: failuresByParticipant.get(enrollment.participant_id) ?? 0,
      entries_without_self_report: own.filter((entry) => !selfReportEntryIds.has(entry.id)).length,
    });
  });

  const consentStates = Array.from(currentConsent.values()).map((record) => normalizeConsent(record));

  return NextResponse.json({
    study: {
      slug: study.slug,
      status: study.status,
      protocol_version: study.protocol_version,
      is_dry_run: study.is_dry_run,
      protocol_days: study.baseline_days + study.observation_days,
    },
    generated_at: now,

    enrollment: {
      total: enrollments.length,
      by_state: tally(enrollments.map((row) => row.state)),
      minors: enrollments.filter((row) => row.is_minor).length,
      withdrawn: enrollments.filter((row) => row.state === "withdrawn").length,
    },

    submissions: totalsFor(participants),

    consent: {
      records: consentStates.length,
      // Participants with an enrollment and no consent record at all. Their
      // submissions are stored as their own journal and are excluded from every
      // export — a gap worth seeing, not an error.
      without_record: enrollments.length - currentConsent.size,
      research_use_allowed: consentStates.filter((state) => researchUseAllowed(state)).length,
      by_document_version: tally(
        Array.from(currentConsent.values()).map((record) => (record.document_version as string) ?? null),
      ),
      revoked: Array.from(currentConsent.values()).filter((record) => Boolean(record.revoked_at)).length,
    },

    self_reports: {
      stored: selfReportEntryIds.size,
      entries_without_self_report: entries.filter((entry) => !selfReportEntryIds.has(entry.id)).length,
      // More than one schema version in a running study means two instruments
      // are in the field at once, which the analysis has to know about.
      by_schema_version: tally(
        ((selfReportResult.data ?? []) as Array<{ schema_version: string }>).map((row) => row.schema_version),
      ),
    },

    integrity: {
      failures_by_outcome: tally(
        ((failureResult.data ?? []) as Array<{ outcome: string }>).map((row) => row.outcome),
      ),
      // An entry without an idempotency key cannot be de-duplicated on retry.
      // Zero is the expected value once every client sends one.
      entries_without_submission_id: entries.filter((entry) => !entry.client_submission_id).length,
    },

    pii_review: {
      by_status: tally(((reviewResult.data ?? []) as Array<{ status: string }>).map((row) => row.status)),
      by_severity: tally(
        ((reviewResult.data ?? []) as Array<{ max_severity: string | null }>).map((row) => row.max_severity),
      ),
      by_scanner_version: tally(
        ((reviewResult.data ?? []) as Array<{ scanner_version: string }>).map((row) => row.scanner_version),
      ),
    },

    retention: retentionStatus(
      entries.filter((entry) => entry.raw_text_ciphertext !== null).map((entry) => entry.raw_text_expires_at),
      now,
    ),

    // Per participant, under the pseudonym. This is the table a coordinator
    // reconciles against: which code is short, by how many days, and which days.
    participants,
  });
}

function emptyDashboard(
  study: { slug: string; status: string; protocol_version: string; baseline_days: number; observation_days: number; is_dry_run: boolean },
  now: string,
) {
  return {
    study: {
      slug: study.slug,
      status: study.status,
      protocol_version: study.protocol_version,
      is_dry_run: study.is_dry_run,
      protocol_days: study.baseline_days + study.observation_days,
    },
    generated_at: now,
    enrollment: { total: 0, by_state: {}, minors: 0, withdrawn: 0 },
    submissions: totalsFor([]),
    consent: { records: 0, without_record: 0, research_use_allowed: 0, by_document_version: {}, revoked: 0 },
    self_reports: { stored: 0, entries_without_self_report: 0, by_schema_version: {} },
    integrity: { failures_by_outcome: {}, entries_without_submission_id: 0 },
    pii_review: { by_status: {}, by_severity: {}, by_scanner_version: {} },
    retention: { retained: 0, expiring_within_7_days: 0, overdue: 0 },
    participants: [],
  };
}
