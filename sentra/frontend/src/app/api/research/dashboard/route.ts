/**
 * The operations dashboard's data (#167).
 *
 * The question this answers is "is the study collecting what it should be",
 * and it answers it **entirely in counts**. No journal text, no self-report
 * values, no research codes attached to content — the point of the surface is
 * that somebody can watch the pilot every day without reading anybody's diary,
 * and a dashboard that showed one entry "just to check" would end that.
 *
 * What it is for, concretely: the dry run (#168) has to reconcile expected
 * submissions against actual ones and explain every gap. A missing day that
 * turns out to be a save failure is a bug; a missing day that turns out to be a
 * participant who did not write is data. Without this the two are
 * indistinguishable until the study is over.
 *
 * Behind the operator allowlist, not the export allowlist: watching the run is
 * an operations job, and the people doing it should not need the permission
 * that pulls text.
 */

import { NextRequest, NextResponse } from "next/server";
import { jsonError } from "@/lib/server/api";
import { requireOperator } from "@/lib/server/pilotOperator";
import { loadStudyBySlug } from "@/lib/server/pilotStore";
import { relativeDay, studyPhase } from "@/lib/server/researchDataset";

export const runtime = "nodejs";

type EnrollmentRow = {
  id: string;
  participant_id: string;
  research_code: string;
  cohort: string;
  state: string;
  collection_started_at: string | null;
  collection_ends_at: string | null;
  withdrawn_at: string | null;
};

export async function GET(request: NextRequest) {
  const operator = await requireOperator(request);
  if ("error" in operator) return operator.error;

  const slug = request.nextUrl.searchParams.get("study");
  if (!slug) return jsonError("study is required.", 422);

  const study = await loadStudyBySlug(operator.service, slug);
  if (!study) return jsonError("Study was not found.", 404);

  const enrollmentResult = await operator.service
    .from("pilot_enrollments")
    .select(
      "id, participant_id, research_code, cohort, state, collection_started_at, collection_ends_at, withdrawn_at",
    )
    .eq("study_id", study.id);
  if (enrollmentResult.error) return jsonError(enrollmentResult.error.message, 502);

  const enrollments = (enrollmentResult.data ?? []) as EnrollmentRow[];
  const participantIds = enrollments.map((row) => row.participant_id);

  const byState: Record<string, number> = {};
  for (const row of enrollments) byState[row.state] = (byState[row.state] ?? 0) + 1;

  // Counts per participant, never the entries themselves. `created_at` is read
  // to derive a relative day and is not returned.
  const submissionsByParticipant = new Map<string, string[]>();
  const consentVersions: Record<string, number> = {};
  let entriesTotal = 0;

  if (participantIds.length > 0) {
    const entries = await operator.service
      .from("entries")
      .select("participant_id, created_at")
      .in("participant_id", participantIds);
    if (entries.error) return jsonError(entries.error.message, 502);

    for (const row of (entries.data ?? []) as Array<{ participant_id: string; created_at: string }>) {
      const list = submissionsByParticipant.get(row.participant_id) ?? [];
      list.push(row.created_at);
      submissionsByParticipant.set(row.participant_id, list);
      entriesTotal += 1;
    }

    const consents = await operator.service
      .from("consent_records")
      .select("participant_id, document_version, status, granted_at")
      .in("participant_id", participantIds)
      .order("granted_at", { ascending: false });
    if (consents.error) return jsonError(consents.error.message, 502);
    const seen = new Set<string>();
    for (const row of (consents.data ?? []) as Array<Record<string, unknown>>) {
      const key = String(row.participant_id);
      if (seen.has(key)) continue;
      seen.add(key);
      const version = `${row.document_version ?? "none"}:${row.status ?? "none"}`;
      consentVersions[version] = (consentVersions[version] ?? 0) + 1;
    }
  }

  // Expected days per participant: how far into their own window they are,
  // capped at its length. A participant who started yesterday is not missing
  // twenty days.
  const now = Date.now();
  const perParticipant = enrollments
    .filter((row) => row.state === "collecting" || row.state === "completed")
    .map((row) => {
      const submissions = submissionsByParticipant.get(row.participant_id) ?? [];
      const days = new Set(
        submissions
          .map((at) => relativeDay(at, row.collection_started_at))
          .filter((day): day is number => day !== null),
      );
      const elapsed = row.collection_started_at
        ? Math.min(
            study.baseline_days + study.observation_days,
            Math.max(0, Math.floor((now - Date.parse(row.collection_started_at)) / 86_400_000) + 1),
          )
        : 0;
      const duplicates = submissions.length - days.size;
      return {
        research_code: row.research_code,
        cohort: row.cohort,
        state: row.state,
        expected_days: elapsed,
        submitted_days: days.size,
        missing_days: Math.max(0, elapsed - days.size),
        // Two entries on the same relative day. The unique index on
        // `client_submission_id` stops a retry becoming two rows; this catches
        // the other shape, which is a participant submitting twice in a day.
        same_day_repeats: duplicates,
        phase: studyPhase(elapsed, study.baseline_days, study.observation_days),
      };
    });

  const failures = await operator.service
    .from("submission_failures")
    .select("id, participant_id, created_at")
    .in("participant_id", participantIds.length > 0 ? participantIds : ["00000000-0000-0000-0000-000000000000"]);

  const pendingReviews = await operator.service
    .from("research_pii_reviews")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending");

  // Retention overdue: text whose expiry has passed but which is still stored.
  // The purge job should leave none; a non-zero count is the alarm.
  const overdue = await operator.service
    .from("entries")
    .select("id", { count: "exact", head: true })
    .not("raw_text_ciphertext", "is", null)
    .lt("raw_text_expires_at", new Date().toISOString());

  return NextResponse.json({
    study: {
      slug: study.slug,
      title: study.title,
      baseline_days: study.baseline_days,
      observation_days: study.observation_days,
      is_dry_run: study.is_dry_run,
    },
    enrollment: {
      total: enrollments.length,
      by_state: byState,
      withdrawn: enrollments.filter((row) => row.withdrawn_at !== null).length,
    },
    submissions: {
      total: entriesTotal,
      expected: perParticipant.reduce((sum, row) => sum + row.expected_days, 0),
      missing: perParticipant.reduce((sum, row) => sum + row.missing_days, 0),
      same_day_repeats: perParticipant.reduce((sum, row) => sum + row.same_day_repeats, 0),
      per_participant: perParticipant,
    },
    consent_versions: consentVersions,
    operations: {
      submission_failures: (failures.data ?? []).length,
      pii_reviews_pending: pendingReviews.count ?? 0,
      retention_overdue: overdue.count ?? 0,
    },
  });
}
