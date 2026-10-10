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
import {
  expectedDays,
  reconcileParticipant,
  retentionStatus,
  studyDaysElapsed,
  tally,
  totalsFor,
  type ParticipantReconciliation,
} from "@/lib/pilotOps";
import { authorizedExporters } from "@/lib/server/researchExportAudit";
import { cronSecretConfigured } from "@/lib/server/cronAuth";
import { pilotGateEnforced, pilotStudySlug } from "@/lib/server/pilotGate";
import { channelsConfigured } from "@/lib/server/safetyEscalation";
import { fetchAllRows } from "@/lib/server/pagedSelect";

export const runtime = "nodejs";
export const maxDuration = 60;

type EntryRow = {
  id: string;
  participant_id: string;
  created_at: string;
  client_submission_id: string | null;
  /** Read as "is there ciphertext", never decrypted and never returned. */
  raw_text_ciphertext: string | null;
  raw_text_expires_at: string | null;
};

type SelfReportRow = { entry_id: string; participant_id: string; schema_version: string };
type FailureRow = { participant_id: string; outcome: string };
type PiiReviewRow = {
  participant_id: string;
  status: string;
  max_confidence: string | null;
  scanner_version: string;
};
type ConsentRow = Record<string, unknown> & { participant_id: string };

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
  // The 503 carries the same diagnostic the normal body does, so a reader of
  // this response learns that the collection-only gate cannot decide — and, on
  // a pilot deployment, is withholding every external call (#296).
  if (!service) {
    return jsonError("Supabase is not configured.", 503, { collection_only_gate: collectionOnlyGate(false) });
  }

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
  //
  // Every one of them is paged (#275). A plain `.in(...)` stops at
  // `db-max-rows` — 1,000 on a stock Supabase project — without an error, and
  // 50 participants x 21 days is up to 1,050 entries and the same number of
  // self-report rows. Truncated, this handler reports days a student did write
  // as missing, and reports retained text that is past its expiry as purged.
  //
  // None of the five can be replaced by a count. `submissions`, `self_reports`
  // and `integrity` group by participant or by value, and `retention` buckets
  // expiry dates into overdue / within-7-days — a `head: true` count answers
  // none of those questions. So the rows are fetched, completely, and the
  // ordering on each is deterministic (the primary key last) because paging
  // without a total order skips and repeats rows.
  const [entriesResult, selfReportResult, failureResult, reviewResult, consentResult] = await Promise.all([
    fetchAllRows<EntryRow>((from, to) =>
      service
        .from("entries")
        .select(
          "id, participant_id, created_at, client_submission_id, raw_text_ciphertext, raw_text_expires_at",
          { count: "exact" },
        )
        .in("participant_id", participantIds)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to),
    ),
    fetchAllRows<SelfReportRow>((from, to) =>
      service
        .from("pilot_self_reports")
        .select("entry_id, participant_id, schema_version", { count: "exact" })
        .in("participant_id", participantIds)
        .order("id", { ascending: true })
        .range(from, to),
    ),
    fetchAllRows<FailureRow>((from, to) =>
      service
        .from("submission_failures")
        .select("participant_id, outcome", { count: "exact" })
        .in("participant_id", participantIds)
        .order("id", { ascending: true })
        .range(from, to),
    ),
    fetchAllRows<PiiReviewRow>((from, to) =>
      service
        .from("pilot_pii_reviews")
        .select("participant_id, status, max_confidence, scanner_version", { count: "exact" })
        .in("participant_id", participantIds)
        .order("id", { ascending: true })
        .range(from, to),
    ),
    fetchAllRows<ConsentRow>((from, to) =>
      service
        .from("consent_records")
        .select(
          "participant_id, app_use, research_analysis, anonymized_export, raw_text_retention, model_training_use, minor_assent, guardian_consent, consent_version, document_version, status, granted_at, revoked_at, created_at",
          { count: "exact" },
        )
        .in("participant_id", participantIds)
        .order("granted_at", { ascending: false })
        // Newest first is what "the newest row wins" below reads, and `id`
        // makes that order total so the pages do not overlap. It is a tie-break
        // for paging, not a rule about which consent row is current (#272).
        .order("id", { ascending: false })
        .range(from, to),
    ),
  ]);

  // A read that could not be completed is a failure, never a shorter list.
  if ("error" in entriesResult) return jsonError(entriesResult.error, 502);
  if ("error" in selfReportResult) return jsonError(selfReportResult.error, 502);
  if ("error" in failureResult) return jsonError(failureResult.error, 502);
  if ("error" in reviewResult) return jsonError(reviewResult.error, 502);
  if ("error" in consentResult) return jsonError(consentResult.error, 502);

  const entries = entriesResult.rows;
  const selfReports = selfReportResult.rows;
  const failures = failureResult.rows;
  const piiReviews = reviewResult.rows;
  const consentRows = consentResult.rows;

  const selfReportEntryIds = new Set(selfReports.map((row) => row.entry_id));

  const failuresByParticipant = new Map<string, number>();
  for (const row of failures) {
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
  for (const record of consentRows) {
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
      submittedDayNumbers: own.map((entry) => studyDaysElapsed(enrollment.collection_started_at, entry.created_at)),
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

    scheduled_jobs: scheduledJobs(),
    pilot_enforcement: pilotEnforcement(study.slug),
    collection_only_gate: collectionOnlyGate(true),

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
      by_schema_version: tally(selfReports.map((row) => row.schema_version)),
    },

    integrity: {
      failures_by_outcome: tally(failures.map((row) => row.outcome)),
      // An entry without an idempotency key cannot be de-duplicated on retry.
      // Zero is the expected value once every client sends one.
      entries_without_submission_id: entries.filter((entry) => !entry.client_submission_id).length,
    },

    pii_review: {
      by_status: tally(piiReviews.map((row) => row.status)),
      by_confidence: tally(piiReviews.map((row) => row.max_confidence)),
      by_scanner_version: tally(piiReviews.map((row) => row.scanner_version)),
    },

    // Now counted over every entry in the study rather than the first 1,000
    // (#275), so `overdue` is no longer the wrong half of the answer.
    //
    // It can still differ from `observed.retention_purge.overdue` on
    // `/api/pilot/admin/ops`, and both remaining differences are deliberate:
    // that endpoint counts the whole deployment where this counts one study,
    // and it compares instants where this compares JST calendar days — the
    // same day boundary `expiring_within_7_days` is bucketed on. A row that
    // expired four hours ago is overdue there and overdue here tomorrow.
    retention: retentionStatus(
      entries.filter((entry) => entry.raw_text_ciphertext !== null).map((entry) => entry.raw_text_expires_at),
      now,
    ),

    // Per participant, under the pseudonym. This is the table a coordinator
    // reconciles against: which code is short, by how many days, and which days.
    participants,
  });
}

/**
 * Whether the scheduled work is in a position to happen at all (#205).
 *
 * Both jobs added in #179 and #185 fail closed: with `CRON_SECRET` unset,
 * `/api/cron/retention-purge` and `/api/cron/safety-dispatch` answer 403 to
 * every caller including Vercel's own scheduler. That is the right default —
 * a purge or a mail send anyone on the internet can trigger is worse — but it
 * is also invisible. The refusal is a line in a function log, and nobody reads
 * function logs on a morning where nothing appeared to go wrong.
 *
 * `retention.overdue` below is the *evidence* the purge ran, and it is the
 * number to trust once the study has data. It cannot be the alarm: on day 1 of
 * a dry run no retained text has reached its expiry yet, so a deployment with
 * no `CRON_SECRET` and a deployment with a working schedule both report zero.
 * These booleans are what separates them, and they are readable before the
 * first participant writes anything.
 *
 * Environment facts only — no counts, no identities, nothing that is not
 * already decided by the deployment's own configuration.
 */
function scheduledJobs() {
  return {
    // Unset means every /api/cron/* route refuses: no retention purge, no
    // crisis-notification retry. Expected true on any deployment collecting
    // data.
    cron_secret_configured: cronSecretConfigured(),
    // The retry job can run and still reach nobody. Unset means a crisis
    // escalation stays queued rather than being delivered (#178).
    safety_alert_channel_configured: channelsConfigured(),
  };
}

/**
 * Whether this deployment actually applies the pilot's rules to the study being
 * looked at (#296).
 *
 * Not "can the gate reach the database" — that is `collection_only_gate`
 * below, and without the service-role client this route answers 503 carrying
 * it, before any number does.
 *
 * What *can* be true while this dashboard renders normally is worse, because it
 * looks like nothing: `PILOT_STUDY_SLUG` is read from the environment, the
 * study shown here comes from the `?study=` parameter, and nothing has ever
 * required them to be the same string. `pilotGateEnforced()` is what switches
 * on the enrollment gate (#164) and, since #296, the fail-closed side of the
 * collection-only gate (#165). Off, both stand down — an uninvited account can
 * open the journal, and a participant inside their window has their text sent
 * for inference. The counts on this page stay plausible throughout.
 *
 * So the two facts are reported side by side: whether the rules are on at all,
 * and whether they are on *for this study*. A reader who sees `enforced: true`
 * with `study_matches_deployment: false` is reading a dashboard for one study on
 * a deployment collecting under another's rules.
 */
function pilotEnforcement(requestedSlug: string) {
  const configured = pilotStudySlug();
  return {
    // False means PILOT_STUDY_SLUG is unset, NEXT_PUBLIC_DEMO_MODE is 1, or
    // NODE_ENV is development. Expected true on any deployment collecting data.
    enforced: pilotGateEnforced(),
    // The deployment's own slug, so a mismatch names itself. Null is the same
    // fact as `enforced: false`, repeated where it is actionable.
    deployment_study_slug: configured,
    study_matches_deployment: configured !== null && configured === requestedSlug,
  };
}

/**
 * Whether the collection-only gate (#165) can decide at all (#296).
 *
 * `collectionMode.ts` asks the database, through the service-role client,
 * whether a participant's window is open. Without that client it cannot ask;
 * on a pilot deployment it then withholds every external call rather than
 * guessing "open". `decidable` is whether this process holds the client — the
 * same `serviceRoleClient()` every send point passes to the gate — and
 * `withholding_all_external_calls` is what the gate does when it does not.
 */
function collectionOnlyGate(serviceClientAvailable: boolean) {
  return {
    decidable: serviceClientAvailable,
    withholding_all_external_calls: !serviceClientAvailable && pilotGateEnforced(),
  };
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
    // Present here too, and deliberately. A study with no participants yet is
    // exactly when a missing CRON_SECRET is cheapest to fix and least visible
    // in the counts.
    scheduled_jobs: scheduledJobs(),
    pilot_enforcement: pilotEnforcement(study.slug),
    collection_only_gate: collectionOnlyGate(true),
    enrollment: { total: 0, by_state: {}, minors: 0, withdrawn: 0 },
    submissions: totalsFor([]),
    consent: { records: 0, without_record: 0, research_use_allowed: 0, by_document_version: {}, revoked: 0 },
    self_reports: { stored: 0, entries_without_self_report: 0, by_schema_version: {} },
    integrity: { failures_by_outcome: {}, entries_without_submission_id: 0 },
    pii_review: { by_status: {}, by_confidence: {}, by_scanner_version: {} },
    retention: { retained: 0, expiring_within_7_days: 0, overdue: 0 },
    participants: [],
  };
}
