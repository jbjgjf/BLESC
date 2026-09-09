/**
 * The guardian's side of verification (#164).
 *
 * **This route takes no session, and that is the design.** A guardian is not a
 * user of this system: they have no account, they are answering on their own
 * phone, and requiring them to sign up would either stop the study or push the
 * step back into the student's session — which is the thing this whole path
 * exists to prevent. What authenticates the request is the token: 256 bits,
 * issued once to one enrollment, single-use, and expiring in 72 hours.
 *
 * Three properties it has to hold:
 *
 *   - **A decision is recorded once.** The claim is an atomic UPDATE
 *     (`guardianStore.claimVerification`); a second presentation of the same
 *     link is told the question has been answered rather than answering it
 *     again.
 *
 *   - **The guardian is shown a pseudonym, not a student.** What the screen
 *     renders — the study title, the research code and what is being asked — is
 *     read by the page itself, on the server. Neither it nor this route
 *     discloses the participant's name, e-mail, class or anything they wrote:
 *     the link may have been forwarded, and a link that reveals a child's
 *     identity to whoever holds it is a disclosure, not a consent form.
 *
 *   - **Declining is a first-class answer.** It records the decline, leaves the
 *     enrollment where it is, and returns the same 200 as a confirmation. No
 *     retry prompt, no second link, no error styling: the participant's screen
 *     shows how to reach the study team and nothing else (#164).
 */

import { NextRequest, NextResponse } from "next/server";
import { jsonError } from "@/lib/server/api";
import { serviceRoleClient } from "@/lib/server/supabaseWriter";
import { advanceEnrollment, loadEnrollmentById, loadStudyById } from "@/lib/server/pilotStore";
import { loadConsentState, recordConsent } from "@/lib/server/consentStore";
import { claimVerification, recordDecision, releaseClaim, requestedGrantsOf } from "@/lib/server/guardianStore";
import { looksLikeGuardianToken } from "@/lib/server/guardianTokens";
import { guardianConsentGrant } from "@/lib/guardianVerification";

export const runtime = "nodejs";

/**
 * One message for a token that cannot be used, whatever the reason.
 *
 * Same reasoning as the redemption route: distinguishing "no such token" from
 * "already answered" would let a holder of one link learn about others. The
 * expiry case is separated, because it is the one a guardian can act on — they
 * ask the student for a new link — and saying so is worth the little it
 * reveals about a token they already hold.
 */
const UNUSABLE = "この確認用リンクは使用できません。お子さまにご確認のうえ、新しいリンクをお受け取りください。";

type ConfirmBody = {
  token?: string;
  decision?: string;
};

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as ConfirmBody;
  const token = typeof body.token === "string" ? body.token : "";
  const decision = body.decision === "confirmed" ? "confirmed" : body.decision === "declined" ? "declined" : null;

  if (!decision) return jsonError("回答が指定されていません。", 422);
  if (!looksLikeGuardianToken(token)) return jsonError(UNUSABLE, 404, { code: "unusable" });

  const service = serviceRoleClient();
  if (!service) return jsonError("Supabase is not configured.", 503);

  const claim = await claimVerification(service, token);
  if (claim.outcome !== "claimed" || !claim.record) {
    if (claim.outcome === "expired") {
      return jsonError("この確認用リンクは有効期限が切れています。新しいリンクをお受け取りください。", 410, {
        code: "expired",
      });
    }
    if (claim.outcome === "already_decided") {
      // Not an error. A guardian who taps twice, or opens the link again to
      // check, should be told the answer stands — not shown a failure.
      return NextResponse.json(
        { status: "already_decided", decision: claim.record?.decision ?? null },
        { status: 200 },
      );
    }
    if (claim.outcome === "unconfigured") return jsonError(UNUSABLE, 503, { code: "unconfigured" });
    return jsonError(UNUSABLE, claim.outcome === "not_found" ? 404 : 502, { code: claim.outcome });
  }

  const verification = claim.record;

  if (decision === "declined") {
    // The enrollment is left at `participant_assented` rather than withdrawn.
    // Withdrawal is terminal in the state machine, and a guardian who declined
    // by mis-tap — or who wants to talk to the school first — would otherwise
    // have ended their child's participation with no way back that does not
    // involve editing rows by hand. The decline is recorded; what happens next
    // is a conversation, and the operator has the record to start it from.
    const recorded = await recordDecision(service, verification.id, "declined");
    if (!recorded) {
      await releaseClaim(service, verification.id);
      return jsonError("回答を記録できませんでした。時間をおいて、もう一度お試しください。", 502);
    }
    return NextResponse.json({ status: "recorded", decision: "declined" });
  }

  const enrollment = await loadEnrollmentById(service, verification.enrollment_id);
  const study = enrollment ? await loadStudyById(service, enrollment.study_id) : null;
  if (!enrollment || !study) {
    await releaseClaim(service, verification.id);
    return jsonError("参加登録を読み込めませんでした。時間をおいて、もう一度お試しください。", 502);
  }

  // The participant's own record supplies `app_use` and `minor_assent`; the
  // token supplies what they chose to ask for. Nothing in this request body
  // reaches the consent row — the guardian's decision is a yes or a no, not a
  // set of grants they can edit on the student's behalf.
  const participantRecord = await loadConsentState(service, enrollment.owner_user_id, enrollment.participant_id);
  const grant = guardianConsentGrant(requestedGrantsOf(verification, study.consent_document_version), participantRecord);

  try {
    await recordConsent(service, enrollment.owner_user_id, enrollment.participant_id, grant, "guardian_link");
  } catch (err) {
    await releaseClaim(service, verification.id);
    console.warn("[pilot-guardian] consent write failed", err instanceof Error ? err.message : err);
    return jsonError("同意を記録できませんでした。時間をおいて、もう一度お試しください。", 502);
  }

  const advanced = await advanceEnrollment(service, {
    enrollmentId: enrollment.id,
    ownerUserId: enrollment.owner_user_id,
    to: "guardian_verified",
    // Not 'operator'. The vocabulary was widened in 20260908000000 precisely so
    // that this row can say what actually happened.
    actor: "guardian",
    reason: `guardian_${verification.channel}`,
  });

  if (advanced.outcome !== "ok") {
    // The consent record stands — it is append-only and describes a decision
    // that was really made. What did not happen is the transition, and the
    // claim goes back so the guardian can retry once the cause is fixed.
    await releaseClaim(service, verification.id);
    console.warn("[pilot-guardian] transition after confirmation failed", advanced.outcome);
    return jsonError("確認は記録しましたが、登録の更新に失敗しました。研究担当にご連絡ください。", 502, {
      code: advanced.outcome,
    });
  }

  const recorded = await recordDecision(service, verification.id, "confirmed");
  if (!recorded) {
    // The transition succeeded, so the enrollment is correct and the study is
    // not blocked. What is missing is the row that says which link produced it,
    // which the operator needs for the dry-run record but the guardian cannot
    // do anything about — so this reports success and warns on the server.
    console.warn("[pilot-guardian] decision row was not updated after a successful transition", verification.id);
  }

  return NextResponse.json({ status: "recorded", decision: "confirmed" });
}
