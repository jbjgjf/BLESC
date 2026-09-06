/**
 * Invitation redemption (#163).
 *
 * The only way into a study. Four things it has to hold:
 *
 *   - **The user comes from the session.** `requireUser` decides who is
 *     redeeming; the body only carries the code and the age band. Under a
 *     service-role client, a body-supplied user id would enroll anyone into
 *     anything.
 *
 *   - **Every rejection looks the same.** No such code, expired, revoked,
 *     already spent, study not recruiting — all of them return the same 403
 *     with the same message. Distinguishing them lets a caller confirm which
 *     codes exist.
 *
 *   - **The code never reaches a log.** Not on success, not on failure, not in
 *     an error path. What gets logged is the outcome and the prefix, and the
 *     prefix only on the operator side.
 *
 *   - **Redeeming twice is not an error.** A double tap or a re-opened link
 *     returns the existing enrollment. The uniqueness that matters is enforced
 *     by `pilot_enrollments (study_id, owner_user_id)`, not by asking the
 *     participant to be careful.
 */

import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireUser } from "@/lib/server/api";
import { serviceRoleClient } from "@/lib/server/supabaseWriter";
import { redeemInvitation } from "@/lib/server/pilotStore";
import { inviteHashingConfigured } from "@/lib/server/inviteCodes";

export const runtime = "nodejs";

/**
 * One message for every rejection. Deliberately says nothing about which of the
 * reasons applied — see the header.
 */
const REJECTED = "このコードは使用できません。配布元に確認してください。";

type RedeemBody = {
  code?: string;
  /**
   * The participant's own statement of whether they are under 18. It decides
   * whether a guardian step is required, so getting it wrong in the permissive
   * direction would skip that step — which is why the state machine also
   * refuses to leave `participant_assented` without a guardian timestamp when
   * this is true, and why an operator confirms it before collection opens
   * rather than trusting the checkbox alone.
   */
  is_minor?: boolean;
};

export async function POST(request: NextRequest) {
  const auth = await requireUser(request);
  if ("error" in auth) return auth.error;

  const userId = request.nextUrl.searchParams.get("user_id");
  if (!userId) return jsonError("user_id is required.", 422);

  if (!inviteHashingConfigured()) {
    // 503 and not 403: this is the deployment being wrong, not the code. The
    // participant should be told to come back, not that their code is invalid.
    return jsonError("参加登録は現在利用できません。運営に連絡してください。", 503);
  }

  let body: RedeemBody;
  try {
    body = (await request.json()) as RedeemBody;
  } catch {
    return jsonError("Request body must be JSON.", 400);
  }

  const code = typeof body.code === "string" ? body.code : "";
  if (!code.trim()) return jsonError(REJECTED, 403);

  // The age band defaults to "minor". A missing field must not silently skip
  // guardian verification, and every participant in this study is expected to
  // be a high-school student anyway.
  const isMinor = body.is_minor !== false;

  const service = serviceRoleClient();
  if (!service) return jsonError("Supabase is not configured.", 503);

  const participantResult = await auth.client
    .from("participants")
    .select("id")
    .eq("code", userId)
    .limit(1)
    .maybeSingle();

  if (participantResult.error) return jsonError(participantResult.error.message, 502);
  const participant = participantResult.data as { id: string } | null;
  if (!participant) return jsonError("Participant was not found.", 404);

  const result = await redeemInvitation(service, {
    rawCode: code,
    ownerUserId: auth.user.id,
    participantId: participant.id,
    isMinor,
  });

  switch (result.outcome) {
    case "enrolled":
    case "already_enrolled":
      return NextResponse.json({
        status: result.outcome,
        enrollment_id: result.enrollment_id,
        study_slug: result.study_slug,
        state: result.state,
        cohort: result.cohort,
      });
    case "unconfigured":
      return jsonError("参加登録は現在利用できません。運営に連絡してください。", 503);
    case "rejected":
      return jsonError(REJECTED, 403);
    default:
      return jsonError("参加登録に失敗しました。時間をおいて再試行してください。", 502);
  }
}
