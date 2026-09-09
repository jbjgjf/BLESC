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
import { normalizeConsent, rawTextRetentionAllowed, researchUseAllowed } from "@/lib/consent";
import { auditExport, authorizedExporters, loadResearchConsent } from "@/lib/server/researchExportAudit";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_ROWS = 1000;

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

  // The audit insert is shared with the pseudonymised dataset and the identity
  // map (`lib/server/researchExportAudit.ts`), so all three disclosures land in
  // `research_exports` in one shape and the table can be read as one log.
  const audit = (status: "completed" | "denied" | "failed", rowCount: number, reason?: string) =>
    auditExport(service, {
      requestedBy: auth.user.id,
      exportKind: includeRawText ? "entries_with_raw_text" : "entries_metadata",
      scope: { participant_id: participantId, limit },
      rowCount,
      includedRawText: includeRawText,
      includedIdentityMap: false,
      status,
      reason,
    });

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

  // Consent per participant, read now — not inherited from whatever was true
  // when the row was written. One lookup per distinct participant rather than
  // per row.
  const participantIds = Array.from(new Set(rows.map((row) => row.participant_id)));
  const researchAllowed = new Map<string, boolean>();
  const retentionAllowed = new Map<string, boolean>();
  if (participantIds.length > 0) {
    // Same lookup the pseudonymised export uses, so a participant these two
    // outputs disagree about is impossible rather than merely unlikely.
    const consent = await loadResearchConsent(service, participantIds);
    // A failed lookup is a failed export, not an export of nothing. Both fail
    // closed; only one of them may be recorded as completed.
    if (!consent.ok) {
      await audit("failed", 0, consent.error);
      return jsonError(consent.error, 502);
    }
    for (const [key, record] of consent.byParticipant) {
      const state = normalizeConsent(record);
      researchAllowed.set(key, researchUseAllowed(state));
      retentionAllowed.set(key, rawTextRetentionAllowed(state));
    }
  }

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
  // `?? false` keeps them out.
  const consented = rows.filter((row) => researchAllowed.get(row.participant_id) ?? false);
  const withheld = rows.length - consented.length;

  const exported = await Promise.all(
    consented.map(async (row) => {
      const mayIncludeText =
        includeRawText &&
        row.raw_text_ciphertext !== null &&
        (retentionAllowed.get(row.participant_id) ?? false);
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

  // The audit row records what left, and the count that did not — so a pull
  // that returned little because consent is thin is distinguishable from one
  // that returned little because the cohort is small.
  await audit("completed", exported.length, withheld > 0 ? `withheld_without_consent:${withheld}` : undefined);
  return NextResponse.json({ rows: exported, count: exported.length, withheld_without_consent: withheld });
}
