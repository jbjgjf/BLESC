/**
 * Pseudonymous research export (#131, #167).
 *
 * Four properties make this safe to have, and each one is enforced here rather
 * than trusted to the caller:
 *
 *   - **Authorization is an explicit allowlist** (`RESEARCH_EXPORT_USER_IDS`),
 *     not a role anyone can end up in. An empty allowlist means nobody, so a
 *     deployment that has not decided who may export cannot export.
 *   - **Only consented rows leave.** Consent is re-checked at export time, not
 *     inherited from whatever was true when the row was written — a participant
 *     who revoked yesterday is not in today's export even if their text has not
 *     been purged yet.
 *   - **Withdrawn participants are gone.** Withdrawal is an enrollment state,
 *     separate from consent, and #167 requires that it removes a participant
 *     from every subsequent export. Checked before consent so that a withdrawal
 *     whose consent row has not caught up still excludes.
 *   - **The dataset cannot be re-identified from itself.** Rows carry
 *     `research_code` and a relative day index. The map from code to database
 *     identity is a different endpoint behind a different allowlist
 *     (`/api/research/identity-map`).
 *
 * Every attempt writes a `research_exports` row, including the denied ones. An
 * export log that only records successes cannot answer "who tried".
 */

import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireUser } from "@/lib/server/api";
import { serviceRoleClient } from "@/lib/server/supabaseWriter";
import { decryptRawText } from "@/lib/server/rawTextCrypto";
import {
  modelTrainingUseAllowed,
  normalizeConsent,
  rawTextRetentionAllowed,
  researchUseAllowed,
} from "@/lib/consent";
import {
  buildResearchDataset,
  identityLeakIn,
  type ExportConsentState,
  type ExportEnrollmentRow,
  type ExportEntryRow,
  type ExportSelfReportRow,
} from "@/lib/researchExport";
import { fetchAllRows } from "@/lib/server/pagedSelect";

export const runtime = "nodejs";
export const maxDuration = 60;

const DEFAULT_TIMEZONE = "Asia/Tokyo";

function studyTimezone(): string {
  return process.env.PILOT_TIMEZONE?.trim() || DEFAULT_TIMEZONE;
}

function authorizedExporters(): Set<string> {
  return new Set(
    (process.env.RESEARCH_EXPORT_USER_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

export async function GET(request: NextRequest) {
  const auth = await requireUser(request);
  if ("error" in auth) return auth.error;

  const service = serviceRoleClient();
  if (!service) return jsonError("Supabase is not configured.", 503);

  const includeRawText = request.nextUrl.searchParams.get("include_raw_text") === "1";
  const researchCode = request.nextUrl.searchParams.get("research_code");
  // `limit` is gone (#509). It used to cap `entries` at a caller-chosen number,
  // itself capped at 1,000 — below the pilot's 50 x 28 = 1,400 — and the
  // response could not say whether it had been cut. The export now reads every
  // row in scope or fails; the only way to narrow it is `research_code`, which
  // the audit row records. A caller still sending `limit` is refused rather than
  // silently handed more than it asked for.
  const limitRequested = request.nextUrl.searchParams.has("limit");

  const audit = async (
    status: "completed" | "denied" | "failed",
    rowCount: number,
    reason?: string,
  ) => {
    const { error } = await service.from("research_exports").insert({
      requested_by: auth.user.id,
      export_kind: includeRawText ? "entries_with_raw_text" : "entries_metadata",
      // The scope is recorded as the pseudonym the caller asked for. Writing a
      // `participant_id` here would put the identifier this export exists to
      // avoid into the audit log of the export that avoided it.
      //
      // `complete: true` marks rows written after #509: the read behind
      // `row_count` was the whole scope, never a cap. Older rows carry `limit`
      // instead, and theirs may have been cut at it.
      participant_scope_json: { research_code: researchCode, complete: true },
      row_count: rowCount,
      included_raw_text: includeRawText,
      status,
      reason: reason ?? null,
    });
    if (error) console.error("[research-export] audit row not written", error.message);
  };

  if (!authorizedExporters().has(auth.user.id)) {
    await audit("denied", 0, "caller is not in RESEARCH_EXPORT_USER_IDS");
    return jsonError("この操作は許可されていません。", 403);
  }

  if (limitRequested) {
    await audit("failed", 0, "limit parameter is no longer supported");
    return jsonError(
      "limit は廃止されました。エクスポートは範囲内の全件を返します。絞り込むには research_code を指定してください。",
      400,
    );
  }

  // Enrollments first. They carry the pseudonym, the window start every day
  // index is measured from, and the withdrawal flag — so a caller scoping by
  // `research_code` is resolved here and never has to name a participant id.
  //
  // Every read below that can grow with the pilot goes through `fetchAllRows`
  // (#509): PostgREST caps a response at `db-max-rows` without reporting it, so
  // a plain select returns a shorter list as a success. A read that cannot be
  // completed fails the export instead of shortening it.
  const enrollmentResult = await fetchAllRows<ExportEnrollmentRow>((from, to) => {
    let query = service
      .from("pilot_enrollments")
      .select(
        "participant_id, research_code, cohort, study_id, state, collection_started_at, collection_ends_at, withdrawn_at",
        { count: "exact" },
      );
    if (researchCode) query = query.eq("research_code", researchCode);
    return query.order("id", { ascending: true }).range(from, to);
  });
  if ("error" in enrollmentResult) {
    await audit("failed", 0, enrollmentResult.error);
    return jsonError(enrollmentResult.error, 502);
  }
  const enrollments = enrollmentResult.rows;

  if (enrollments.length === 0) {
    await audit("completed", 0, "no enrollments in scope");
    return NextResponse.json({
      rows: [],
      count: 0,
      participant_count: 0,
      excluded: { withdrawn: 0, not_enrolled: 0, no_research_consent: 0, collection_not_started: 0 },
    });
  }

  // Withdrawn participants are excluded from the query itself, not only from
  // the assembled rows. Fetching their entries and dropping them later would
  // work, but it would also mean the rows of someone who asked to leave the
  // study keep passing through this process on every export.
  const activeParticipantIds = enrollments
    .filter((enrollment) => enrollment.state !== "withdrawn" && enrollment.withdrawn_at === null)
    .map((enrollment) => enrollment.participant_id);
  const withdrawnCount = enrollments.length - activeParticipantIds.length;

  if (activeParticipantIds.length === 0) {
    await audit("completed", 0, `all_in_scope_withdrawn:${withdrawnCount}`);
    return NextResponse.json({
      rows: [],
      count: 0,
      participant_count: 0,
      excluded: {
        withdrawn: withdrawnCount,
        not_enrolled: 0,
        no_research_consent: 0,
        collection_not_started: 0,
      },
    });
  }

  const entryResult = await fetchAllRows<ExportEntryRow>((from, to) =>
    service
      .from("entries")
      .select(
        "id, participant_id, created_at, observation_type, extraction_json, raw_text_ciphertext, raw_text_expires_at",
        { count: "exact" },
      )
      .in("participant_id", activeParticipantIds)
      .order("created_at", { ascending: false })
      // `id` makes the order total, so consecutive ranges neither overlap nor skip.
      .order("id", { ascending: false })
      .range(from, to),
  );
  if ("error" in entryResult) {
    await audit("failed", 0, entryResult.error);
    return jsonError(entryResult.error, 502);
  }
  const entries = entryResult.rows;

  // Consent per participant, read now — not inherited from whatever was true
  // when the row was written. One lookup per distinct participant.
  const consentByParticipant = new Map<string, ExportConsentState>();
  const participantIds = Array.from(new Set(entries.map((row) => row.participant_id)));
  if (participantIds.length > 0) {
    // Consent history, not one row per participant: grants, revocations and a
    // guardian's item-by-item answers all add rows. Cut at `db-max-rows`, the
    // global newest-first order drops whoever consented earliest and never
    // changed it, and they would be counted as `no_research_consent` — a false
    // reason in the audit row, not just a shorter dataset (#509).
    const consentRows = await fetchAllRows<Record<string, unknown>>((from, to) =>
      service
        .from("consent_records")
        .select(
          "participant_id, app_use, research_analysis, anonymized_export, raw_text_retention, model_training_use, minor_assent, guardian_consent, consent_version, document_version, status, granted_at, revoked_at, created_at",
          { count: "exact" },
        )
        .in("participant_id", participantIds)
        .order("granted_at", { ascending: false })
        // A tie-break for paging, as in the dashboard; not a rule about which
        // consent row is current (#272).
        .order("id", { ascending: false })
        .range(from, to),
    );
    if ("error" in consentRows) {
      await audit("failed", 0, consentRows.error);
      return jsonError(consentRows.error, 502);
    }
    for (const record of consentRows.rows) {
      const key = String(record.participant_id);
      // Ordered newest first, so the first row seen for a participant is the
      // current one and later ones are superseded history.
      if (consentByParticipant.has(key)) continue;
      const state = normalizeConsent(record);
      consentByParticipant.set(key, {
        research: researchUseAllowed(state),
        retention: rawTextRetentionAllowed(state),
        model_training_use: modelTrainingUseAllowed(state),
        consent_version: state.consent_version,
        document_version: state.document_version,
      });
    }
  }

  // Decryption happens before the dataset is built and only for rows that pass
  // both gates, so the builder never has text it was not allowed to have.
  const decryptedText = new Map<string, string | null>();
  if (includeRawText) {
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.raw_text_ciphertext) return;
        if (!consentByParticipant.get(entry.participant_id)?.retention) return;
        decryptedText.set(entry.id, await decryptRawText(entry.raw_text_ciphertext));
      }),
    );
  }

  // The window closes at each study's own `study_days`, so the studies in scope
  // are read rather than assuming the column default. One query for the whole
  // export, not one per enrollment.
  const studyDaysByStudy = new Map<string, number>();
  const studyIds = Array.from(new Set(enrollments.map((row) => row.study_id).filter(Boolean)));
  if (studyIds.length > 0) {
    const studies = await service
      .from("pilot_studies")
      .select("id, study_days")
      .in("id", studyIds);
    if (studies.error) {
      await audit("failed", 0, studies.error.message);
      return jsonError(studies.error.message, 502);
    }
    for (const row of (studies.data ?? []) as Array<{ id: string; study_days: number }>) {
      studyDaysByStudy.set(row.id, row.study_days);
    }
  }

  // The fixed daily self-report, keyed to the entry it was submitted with.
  //
  // Still one `in("entry_id", …)` without paging: that read is #451's, and is
  // fixed there rather than here (#509 §3).
  //
  // Scoped by `entry_id` and not by participant: an entry excluded above — a
  // day outside the window, a withdrawn participant — must not pull its
  // readings into the export through a second query that does not know about
  // the exclusion. Only the columns the data dictionary promises are selected,
  // so `answered_at` cannot ride along; it is the submission instant, which is
  // the calendar date this module withholds.
  const selfReportByEntry = new Map<string, ExportSelfReportRow>();
  const entryIds = entries.map((row) => row.id);
  if (entryIds.length > 0) {
    const readings = await service
      .from("pilot_self_reports")
      .select("entry_id, schema_version, mood, stress, sleep_quality, sleep_hours, event_intensity")
      .in("entry_id", entryIds);
    if (readings.error) {
      await audit("failed", 0, readings.error.message);
      return jsonError(readings.error.message, 502);
    }
    for (const row of (readings.data ?? []) as ExportSelfReportRow[]) {
      selfReportByEntry.set(row.entry_id, row);
    }
  }

  const dataset = buildResearchDataset({
    entries,
    enrollments,
    consentByParticipant,
    timeZone: studyTimezone(),
    decryptedText,
    studyDaysByStudy,
    selfReportByEntry,
  });

  // The rows are assembled from database output, so a column added to `entries`
  // by a later change could ride along into the response. Refusing is the right
  // failure: an export that silently carries an identifier is worse than one
  // that does not run.
  const leak = identityLeakIn(dataset.rows);
  if (leak) {
    await audit("failed", 0, `identity_field_in_row:${leak}`);
    return jsonError("Export aborted: a row carried an identifying field.", 500);
  }

  const excluded = { ...dataset.excluded, withdrawn: dataset.excluded.withdrawn + withdrawnCount };
  const reasons = Object.entries(excluded)
    .filter(([, count]) => count > 0)
    .map(([key, count]) => `${key}:${count}`)
    .join(",");

  await audit("completed", dataset.rows.length, reasons || undefined);
  return NextResponse.json({
    rows: dataset.rows,
    count: dataset.rows.length,
    participant_count: dataset.participant_count,
    excluded,
    timezone: studyTimezone(),
  });
}
