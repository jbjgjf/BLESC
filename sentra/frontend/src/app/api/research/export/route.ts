/**
 * Research export of retained journal text (#131).
 *
 * The point of retaining text at all is human evaluation of extraction
 * accuracy, and that needs a way to get it out. Three properties make this
 * safe to have:
 *
 *   - Authorization is an explicit allowlist (`RESEARCH_EXPORT_USER_IDS`), not
 *     a role anyone can end up in. An empty allowlist means nobody, so a
 *     deployment that has not decided who may export cannot export.
 *   - Only consented rows leave. Consent is re-checked at export time, not
 *     inherited from whatever was true when the row was written — a
 *     participant who revoked yesterday is not in today's export even if their
 *     text has not been purged yet.
 *   - Every attempt writes a `research_exports` row, including the denied ones.
 *     An export log that only records successes cannot answer "who tried".
 */

import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireUser } from "@/lib/server/api";
import { serviceRoleClient } from "@/lib/server/supabaseWriter";
import { decryptRawText } from "@/lib/server/rawTextCrypto";
import { normalizeConsent, rawTextRetentionAllowed } from "@/lib/consent";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_ROWS = 1000;

function authorizedExporters(): Set<string> {
  return new Set(
    (process.env.RESEARCH_EXPORT_USER_IDS ?? "")
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
  raw_text_ciphertext: string | null;
  raw_text_expires_at: string | null;
};

export async function GET(request: NextRequest) {
  const auth = await requireUser(request);
  if ("error" in auth) return auth.error;

  const service = serviceRoleClient();
  if (!service) return jsonError("Supabase is not configured.", 503);

  const includeRawText = request.nextUrl.searchParams.get("include_raw_text") === "1";
  const participantId = request.nextUrl.searchParams.get("participant_id");
  const limit = Math.min(Number(request.nextUrl.searchParams.get("limit") ?? 200) || 200, MAX_ROWS);

  const audit = async (
    status: "completed" | "denied" | "failed",
    rowCount: number,
    reason?: string,
  ) => {
    const { error } = await service.from("research_exports").insert({
      requested_by: auth.user.id,
      export_kind: includeRawText ? "entries_with_raw_text" : "entries_metadata",
      participant_scope_json: { participant_id: participantId, limit },
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

  let query = service
    .from("entries")
    .select("id, participant_id, created_at, observation_type, extraction_json, raw_text_ciphertext, raw_text_expires_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (participantId) query = query.eq("participant_id", participantId);

  const result = await query;
  if (result.error) {
    await audit("failed", 0, result.error.message);
    return jsonError(result.error.message, 502);
  }

  const rows = (result.data ?? []) as EntryRow[];

  // Consent per participant, read now. One lookup per distinct participant
  // rather than per row.
  const participantIds = Array.from(new Set(rows.map((row) => row.participant_id)));
  const consentByParticipant = new Map<string, boolean>();
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
      if (!consentByParticipant.has(key)) {
        consentByParticipant.set(key, rawTextRetentionAllowed(normalizeConsent(record)));
      }
    }
  }

  const exported = await Promise.all(
    rows.map(async (row) => {
      const mayIncludeText =
        includeRawText && row.raw_text_ciphertext !== null && consentByParticipant.get(row.participant_id) === true;
      return {
        entry_id: row.id,
        participant_id: row.participant_id,
        created_at: row.created_at,
        observation_type: row.observation_type,
        extraction_json: row.extraction_json,
        raw_text_expires_at: row.raw_text_expires_at,
        raw_text: mayIncludeText ? await decryptRawText(row.raw_text_ciphertext as string) : null,
      };
    }),
  );

  await audit("completed", exported.length);
  return NextResponse.json({ rows: exported, count: exported.length });
}
