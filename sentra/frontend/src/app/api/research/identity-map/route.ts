/**
 * The re-identification key, kept apart from the data it re-identifies (#167).
 *
 * A study of minors has to be able to go from a row back to a person: to honour
 * a withdrawal, to answer a guardian, to act on something a participant wrote.
 * So the mapping must exist. What #167 requires is that holding the dataset is
 * not the same as holding the mapping —
 *
 *     「identity mapとresearch datasetを別権限・別出力にしてください」
 *
 * — which is why this is a second endpoint rather than a second column.
 *
 * Three things separate it from `/api/research/export`:
 *
 *   - **A different allowlist.** `RESEARCH_IDENTITY_MAP_USER_IDS`, not
 *     `RESEARCH_EXPORT_USER_IDS`. An analyst who may pull data is not thereby
 *     someone who may undo the pseudonyms, and the deployment says so by
 *     putting different user ids in the two variables. Empty means nobody.
 *   - **No content, ever.** The response is codes, database ids and enrollment
 *     timestamps. Whoever obtains it learns who a code belongs to, never what
 *     that person wrote — so the worst case of a leak here is bounded.
 *   - **Its own audit kind.** Rows land in `research_exports` as
 *     `identity_map`, so "who has de-anonymised this cohort, and when" is a
 *     question the log can answer separately from "who pulled data".
 *
 * Withdrawn enrollments are included on purpose. Honouring a withdrawal —
 * finding the rows, purging the text, confirming to the participant that it is
 * done — needs the mapping for exactly the person who asked to leave. Excluding
 * them here would make withdrawal harder to carry out, which is the opposite of
 * what excluding them from the dataset accomplishes.
 */

import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireUser } from "@/lib/server/api";
import { serviceRoleClient } from "@/lib/server/supabaseWriter";
import { buildIdentityMap, type ExportEnrollmentRow } from "@/lib/researchExport";

export const runtime = "nodejs";

function authorizedForIdentityMap(): Set<string> {
  return new Set(
    (process.env.RESEARCH_IDENTITY_MAP_USER_IDS ?? "")
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

  const researchCode = request.nextUrl.searchParams.get("research_code");

  const audit = async (status: "completed" | "denied" | "failed", rowCount: number, reason?: string) => {
    const { error } = await service.from("research_exports").insert({
      requested_by: auth.user.id,
      export_kind: "identity_map",
      participant_scope_json: { research_code: researchCode },
      row_count: rowCount,
      included_raw_text: false,
      status,
      reason: reason ?? null,
    });
    if (error) console.error("[identity-map] audit row not written", error.message);
  };

  if (!authorizedForIdentityMap().has(auth.user.id)) {
    await audit("denied", 0, "caller is not in RESEARCH_IDENTITY_MAP_USER_IDS");
    return jsonError("この操作は許可されていません。", 403);
  }

  let query = service
    .from("pilot_enrollments")
    .select("participant_id, research_code, cohort, state, collection_started_at, collection_ends_at, withdrawn_at")
    .order("research_code", { ascending: true });
  if (researchCode) query = query.eq("research_code", researchCode);

  const result = await query;
  if (result.error) {
    await audit("failed", 0, result.error.message);
    return jsonError(result.error.message, 502);
  }

  const rows = buildIdentityMap((result.data ?? []) as ExportEnrollmentRow[]);
  await audit("completed", rows.length);
  return NextResponse.json({ rows, count: rows.length });
}
