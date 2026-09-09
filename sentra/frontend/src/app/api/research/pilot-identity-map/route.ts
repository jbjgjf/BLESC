/**
 * The identity map: research code → account (#167).
 *
 * This is the file that undoes the pseudonymisation, and it exists because
 * three things genuinely require it — a participant exercising deletion, a
 * safeguarding disclosure that has to reach a named student, and an audit that
 * has to confirm a withdrawal was honoured. None of those is analysis.
 *
 * So it is a separate route with a separate allowlist
 * (`RESEARCH_IDENTITY_MAP_USER_IDS`, never derived from the export list) and
 * its own audit row carrying `included_identity_map = true`. An analyst who can
 * pull the dataset cannot pull this unless somebody named them here too, and
 * the fact that they were named is visible in the deployment's environment
 * rather than in code.
 *
 * What it returns is the mapping and nothing else: no journal text, no
 * self-report values, no PII findings. Someone who needs both has to make two
 * requests, and both are logged.
 */

import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireUser } from "@/lib/server/api";
import { serviceRoleClient } from "@/lib/server/supabaseWriter";
import { auditExport, authorizedIdentityMappers } from "@/lib/server/researchExportAudit";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(request: NextRequest) {
  const auth = await requireUser(request);
  if ("error" in auth) return auth.error;

  const service = serviceRoleClient();
  if (!service) return jsonError("Supabase is not configured.", 503);

  const params = request.nextUrl.searchParams;
  const studySlug = params.get("study");
  // Resolving one code is the ordinary case — a deletion request names one
  // participant. Narrowing here means the audit row records that one code was
  // resolved rather than that the whole cohort was.
  const researchCode = params.get("research_code");

  const audit = (status: "completed" | "denied" | "failed", rows: number, reason?: string, studyId?: string) =>
    auditExport(service, {
      requestedBy: auth.user.id,
      exportKind: "pilot_identity_map",
      scope: { study: studySlug, research_code: researchCode },
      rowCount: rows,
      includedRawText: false,
      includedIdentityMap: true,
      status,
      studyId: studyId ?? null,
      reason: reason ?? null,
    });

  if (!authorizedIdentityMappers().has(auth.user.id)) {
    await audit("denied", 0, "caller is not in RESEARCH_IDENTITY_MAP_USER_IDS");
    return jsonError("この操作は許可されていません。", 403);
  }
  if (!studySlug) {
    await audit("denied", 0, "study slug is required");
    return jsonError("study パラメータが必要です。", 422);
  }

  const studyResult = await service.from("pilot_studies").select("id, slug").eq("slug", studySlug).maybeSingle();
  if (studyResult.error) {
    await audit("failed", 0, studyResult.error.message);
    return jsonError(studyResult.error.message, 502);
  }
  const study = studyResult.data as { id: string; slug: string } | null;
  if (!study) {
    await audit("denied", 0, "study not found");
    return jsonError("その study は見つかりません。", 404);
  }

  let query = service
    .from("pilot_enrollments")
    .select("research_code, owner_user_id, participant_id, state, cohort, is_minor, enrolled_at, withdrawn_at")
    .eq("study_id", study.id);
  if (researchCode) query = query.eq("research_code", researchCode);

  const result = await query;
  if (result.error) {
    await audit("failed", 0, result.error.message, study.id);
    return jsonError(result.error.message, 502);
  }

  const rows = (result.data ?? []) as Array<Record<string, unknown>>;
  await audit("completed", rows.length, researchCode ? "single_code" : "whole_cohort", study.id);

  return NextResponse.json({
    study_slug: study.slug,
    generated_at: new Date().toISOString(),
    row_count: rows.length,
    // Withdrawn participants are *present* here, unlike in the dataset. The map
    // is how a withdrawal gets honoured: an operator asked to delete a person's
    // data needs to find their rows, and removing them from the map first would
    // make that impossible.
    rows: rows.map((row) => ({
      research_code: row.research_code,
      owner_user_id: row.owner_user_id,
      participant_id: row.participant_id,
      state: row.state,
      cohort: row.cohort,
      is_minor: row.is_minor,
      enrolled_at: row.enrolled_at,
      withdrawn_at: row.withdrawn_at,
    })),
  });
}
