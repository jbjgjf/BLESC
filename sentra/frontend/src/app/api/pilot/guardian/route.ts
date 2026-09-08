/**
 * Asking a guardian, from the participant's side (#164).
 *
 * `POST` issues a link. `GET` says whether it has been answered. Neither one
 * can confirm anything: the confirmation happens on `/api/pilot/guardian/confirm`,
 * without this session, and that separation is the entire reason both routes
 * exist rather than one flag on the consent route.
 *
 * What the participant is trusted with here is narrow and deliberate — they may
 * ask for a link to their *own* enrollment, and they may see whether it has
 * been used. They may not read the token back (`GET` never returns one; the
 * clear text exists in one response, at issue time, and nowhere else), and they
 * may not learn anything about the guardian beyond the decision.
 */

import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireUser } from "@/lib/server/api";
import { serviceRoleClient } from "@/lib/server/supabaseWriter";
import { loadEnrollmentsForUser, loadStudyById } from "@/lib/server/pilotStore";
import { issueVerification, latestVerification } from "@/lib/server/guardianStore";
import { guardianHashingConfigured, guardianVerificationUrl } from "@/lib/server/guardianTokens";
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
  // picked implicitly: reissuing a guardian link for a study someone has left
  // is not something a missing parameter should cause.
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

  return NextResponse.json({
    enrollment_id: enrollment.id,
    guardian_required: guardianRequired(enrollment),
    can_request: canRequestGuardianVerification(enrollment),
    status,
    message: GUARDIAN_STATUS_MESSAGE[status],
    // Enough to say "the link ending in …", never enough to present one.
    token_prefix: record?.token_prefix ?? null,
    expires_at: record?.expires_at ?? null,
    decided_at: record?.decided_at ?? null,
  });
}

type IssueBody = {
  enrollment_id?: string;
  requested_grants?: Record<string, unknown>;
  channel?: string;
};

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as IssueBody;
  const resolved = await resolveEnrollment(request, typeof body.enrollment_id === "string" ? body.enrollment_id : null);
  if ("error" in resolved) return resolved.error;

  const { service, ownerUserId, enrollment } = resolved;

  if (!guardianRequired(enrollment)) {
    // An adult asking for a guardian link is a UI bug, not an attack, and the
    // answer is the same either way: this study does not ask a guardian about
    // an adult participant, and will not create a record implying it did.
    return jsonError("この参加登録に保護者の確認は必要ありません。", 409, { code: "guardian_not_required" });
  }

  if (!canRequestGuardianVerification(enrollment)) {
    return NextResponse.json(
      {
        status: "illegal_state",
        state: enrollment.state,
        detail: "本人の同意が記録されてから、保護者の方に確認をお願いできます。",
      },
      { status: 409 },
    );
  }

  if (!guardianHashingConfigured()) {
    console.warn("[pilot-guardian] PILOT_GUARDIAN_HMAC_KEY is not configured; refusing to issue");
    return jsonError("保護者確認の設定が完了していません。研究担当にご連絡ください。", 503, {
      code: "guardian_hashing_unconfigured",
    });
  }

  const study = await loadStudyById(service, enrollment.study_id);
  if (!study) return jsonError("研究情報を読み込めませんでした。", 502);

  const issued = await issueVerification(service, {
    enrollmentId: enrollment.id,
    ownerUserId,
    requestedGrants: normalizeRequestedGrants(body.requested_grants, study.consent_document_version),
    channel: body.channel === "operator" ? "operator" : "link",
  });

  if ("error" in issued) {
    const status = issued.error === "unconfigured" ? 503 : 502;
    return jsonError("確認用リンクを発行できませんでした。", status);
  }

  // The one response that carries the token. Not logged here or anywhere else:
  // a link in a server log is a credential in a server log.
  return NextResponse.json({
    status: "issued",
    url: guardianVerificationUrl(issued.token),
    token_prefix: issued.record.token_prefix,
    expires_at: issued.record.expires_at,
  });
}
