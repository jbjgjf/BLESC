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
import { normalizeConsent, rawTextRetentionAllowed, researchUseAllowed } from "@/lib/consent";
import {
  buildResearchDataset,
  identityLeakIn,
  type ExportConsentState,
  type ExportEnrollmentRow,
  type ExportEntryRow,
} from "@/lib/researchExport";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_ROWS = 1000;
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
  const limit = Math.min(Number(request.nextUrl.searchParams.get("limit") ?? 200) || 200, MAX_ROWS);

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
      participant_scope_json: { research_code: researchCode, limit },
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

  // Enrollments first. They carry the pseudonym, the window start every day
  // index is measured from, and the withdrawal flag — so a caller scoping by
  // `research_code` is resolved here and never has to name a participant id.
  let enrollmentQuery = service
    .from("pilot_enrollments")
    .select("participant_id, research_code, cohort, state, collection_started_at, collection_ends_at, withdrawn_at");
  if (researchCode) enrollmentQuery = enrollmentQuery.eq("research_code", researchCode);

  const enrollmentResult = await enrollmentQuery;
  if (enrollmentResult.error) {
    await audit("failed", 0, enrollmentResult.error.message);
    return jsonError(enrollmentResult.error.message, 502);
  }
  const enrollments = (enrollmentResult.data ?? []) as ExportEnrollmentRow[];

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

  const entryResult = await service
    .from("entries")
    .select(
      "id, participant_id, created_at, observation_type, extraction_json, raw_text_ciphertext, raw_text_expires_at",
    )
    .in("participant_id", activeParticipantIds)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (entryResult.error) {
    await audit("failed", 0, entryResult.error.message);
    return jsonError(entryResult.error.message, 502);
  }
  const entries = (entryResult.data ?? []) as ExportEntryRow[];

  // Consent per participant, read now — not inherited from whatever was true
  // when the row was written. One lookup per distinct participant.
  const consentByParticipant = new Map<string, ExportConsentState>();
  const participantIds = Array.from(new Set(entries.map((row) => row.participant_id)));
  if (participantIds.length > 0) {
    const consentRows = await service
      .from("consent_records")
      .select(
        "participant_id, app_use, research_analysis, anonymized_export, raw_text_retention, future_fine_tuning, minor_assent, guardian_consent, consent_version, document_version, status, granted_at, revoked_at, created_at",
      )
      .in("participant_id", participantIds)
      .order("granted_at", { ascending: false });
    if (consentRows.error) {
      await audit("failed", 0, consentRows.error.message);
      return jsonError(consentRows.error.message, 502);
    }
    for (const record of (consentRows.data ?? []) as Array<Record<string, unknown>>) {
      const key = String(record.participant_id);
      // Ordered newest first, so the first row seen for a participant is the
      // current one and later ones are superseded history.
      if (consentByParticipant.has(key)) continue;
      const state = normalizeConsent(record);
      consentByParticipant.set(key, {
        research: researchUseAllowed(state),
        retention: rawTextRetentionAllowed(state),
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

  const dataset = buildResearchDataset({
    entries,
    enrollments,
    consentByParticipant,
    timeZone: studyTimezone(),
    decryptedText,
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
