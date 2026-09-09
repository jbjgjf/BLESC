/**
 * Asking for a guardian to be contacted, from the participant's side (#164).
 *
 * `POST` records the request and what the guardian is being asked to approve.
 * `GET` says whether it has been answered. **Neither one returns a token, and
 * neither one can confirm anything.** The link is issued by a coordinator
 * (`/api/pilot/guardian/issue`) and answered on `/api/pilot/guardian/confirm`
 * without this session.
 *
 * The first cut of this route returned the guardian URL to the participant's
 * own browser, on the theory that they would hand it to a parent. Review of
 * PR #170 pointed out what that actually is: the confirm route authenticates
 * with the token and nothing else, so a minor holding their own link can
 * record their own guardian's consent. The separation was one redirect wide.
 * The token now never enters this session at all — which is also what
 * 20260906010000 said would happen ("that step belongs to the operator route").
 *
 * What the participant is trusted with here is narrow and deliberate: they may
 * ask for their *own* enrollment's guardian to be contacted, they may say what
 * they are asking them to approve, and they may see whether an answer has come
 * back. Nothing else.
 */

import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireUser } from "@/lib/server/api";
import { serviceRoleClient } from "@/lib/server/supabaseWriter";
import { loadEnrollmentsForUser, loadStudyById } from "@/lib/server/pilotStore";
import { latestVerification, requestVerification, requestedGrantsOf } from "@/lib/server/guardianStore";
import {
  GUARDIAN_STATUS_MESSAGE,
  canRequestGuardianVerification,
  guardianRequired,
  guardianVerificationStatus,
  normalizeRequestedGrants,
} from "@/lib/guardianVerification";

export const runtime = "nodejs";

async function resolveEnrollment(request: NextRequest, enrollmentId: string | null) {
  const auth = await requireUser(request);
  if ("error" in auth) return auth;

  const service = serviceRoleClient();
  if (!service) return { error: jsonError("Supabase is not configured.", 503) };

  const enrollments = await loadEnrollmentsForUser(service, auth.user.id);
  // Without an explicit id, the newest enrollment that is still going is the
  // one the screen is showing. A withdrawn or completed enrollment is never
  // picked implicitly: re-opening a guardian question for a study someone has
  // left is not something a missing parameter should cause.
  const enrollment = enrollmentId
    ? enrollments.find((row) => row.id === enrollmentId)
    : enrollments.find((row) => row.state !== "withdrawn" && row.state !== "completed");

  if (!enrollment) return { error: jsonError("参加登録が見つかりません。", 404) };

  return { ownerUserId: auth.user.id, service, enrollment };
}

export async function GET(request: NextRequest) {
  const resolved = await resolveEnrollment(request, request.nextUrl.searchParams.get("enrollment_id"));
  if ("error" in resolved) return resolved.error;

  const { service, enrollment } = resolved;
  const record = guardianRequired(enrollment) ? await latestVerification(service, enrollment.id) : null;
  const status = guardianVerificationStatus(record);
  const study = record ? await loadStudyById(service, enrollment.study_id) : null;

  return NextResponse.json({
    enrollment_id: enrollment.id,
    guardian_required: guardianRequired(enrollment),
    can_request: canRequestGuardianVerification(enrollment),
    status,
    message: GUARDIAN_STATUS_MESSAGE[status],
    // What the participant asked the guardian to approve, so a reloaded screen
    // shows the scope that is actually pending rather than a fresh set of
    // unticked boxes it would then re-send as refusals.
    requested_grants: record && study ? requestedGrantsOf(record, study.consent_document_version) : null,
    // Enough to say "the link ending in …" to a coordinator on the phone,
    // never enough to present one.
    token_prefix: record?.token_prefix ?? null,
    issued_at: record?.issued_at ?? null,
    expires_at: record?.expires_at ?? null,
    decided_at: record?.decided_at ?? null,
  });
}

type RequestBody = {
  enrollment_id?: string;
  requested_grants?: Record<string, unknown>;
};

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as RequestBody;
  const resolved = await resolveEnrollment(request, typeof body.enrollment_id === "string" ? body.enrollment_id : null);
  if ("error" in resolved) return resolved.error;

  const { service, ownerUserId, enrollment } = resolved;

  if (!guardianRequired(enrollment)) {
    // An adult asking for a guardian is a UI bug, not an attack, and the
    // answer is the same either way: this study does not ask a guardian about
    // an adult participant, and will not create a record implying it did.
    return jsonError("この参加登録に保護者の確認は必要ありません。", 409, { code: "guardian_not_required" });
  }

  if (!canRequestGuardianVerification(enrollment)) {
    return NextResponse.json(
      {
        status: "illegal_state",
        state: enrollment.state,
        detail: "本人の同意が記録されてから、保護者の方への確認を依頼できます。",
      },
      { status: 409 },
    );
  }

  const study = await loadStudyById(service, enrollment.study_id);
  if (!study) return jsonError("研究情報を読み込めませんでした。", 502);

  const requested = await requestVerification(service, {
    enrollmentId: enrollment.id,
    ownerUserId,
    requestedGrants: normalizeRequestedGrants(body.requested_grants, study.consent_document_version),
  });

  if ("error" in requested) {
    return jsonError("確認の依頼を記録できませんでした。", 502);
  }

  const status = guardianVerificationStatus(requested.record);
  return NextResponse.json({
    status,
    message: GUARDIAN_STATUS_MESSAGE[status],
    requested_at: requested.record.requested_at,
  });
}
