/**
 * Issuing a guardian verification link. **Coordinator only** (#164).
 *
 * This route exists because the participant must not hold the token. The
 * confirm route authenticates with the token and nothing else, so whoever
 * holds it is, to the server, the guardian — which means handing it to the
 * student hands them their own parent's consent. The first cut of #170 did
 * exactly that; review caught it.
 *
 * So the flow has three parties and three steps:
 *
 *   1. The participant assents and asks for their guardian to be contacted
 *      (`POST /api/pilot/guardian`), recording what they are asking the
 *      guardian to approve. No token is created.
 *   2. A coordinator on the allowlist issues the link here and receives the
 *      URL **once**. They deliver it to the guardian through the channel the
 *      school already uses for consent forms — the same channel that carries
 *      the paper form, and the same one that establishes it reached a parent
 *      rather than the student.
 *   3. The guardian answers on their own device
 *      (`POST /api/pilot/guardian/confirm`), with no session.
 *
 * `GET` lists the outstanding requests for a study so a coordinator can see
 * who is waiting. It returns research codes, never names: the coordinator can
 * map a research code to a person through the enrollment records the school
 * holds, and this surface does not need to do it for them.
 */

import { NextRequest, NextResponse } from "next/server";
import { jsonError } from "@/lib/server/api";
import { requireOperator } from "@/lib/server/pilotOperator";
import { loadEnrollmentById, loadStudyBySlug } from "@/lib/server/pilotStore";
import { issueVerification, latestVerification } from "@/lib/server/guardianStore";
import { guardianHashingConfigured, guardianVerificationUrl } from "@/lib/server/guardianTokens";
import { guardianVerificationStatus } from "@/lib/guardianVerification";

export const runtime = "nodejs";

/** How a coordinator says they delivered it. Recorded on the enrollment as
 *  `guardian_verification_method` when the guardian answers. */
const CHANNELS = new Set(["school", "email", "paper", "phone"]);

export async function GET(request: NextRequest) {
  const operator = await requireOperator(request);
  if ("error" in operator) return operator.error;

  const slug = request.nextUrl.searchParams.get("study");
  if (!slug) return jsonError("study is required.", 422);

  const study = await loadStudyBySlug(operator.service, slug);
  if (!study) return jsonError("Study was not found.", 404);

  const result = await operator.service
    .from("pilot_guardian_verifications")
    .select(
      "id, enrollment_id, channel, requested_grants, requested_at, issued_at, expires_at, " +
        "claimed_at, decision, decided_at, revoked_at, " +
        "pilot_enrollments!inner(research_code, cohort, state, study_id)",
    )
    .is("decision", null)
    .is("revoked_at", null)
    .eq("pilot_enrollments.study_id", study.id)
    .order("requested_at", { ascending: true });

  if (result.error) return jsonError(result.error.message, 502);

  type Row = {
    id: string;
    enrollment_id: string;
    channel: string;
    requested_grants: Record<string, unknown>;
    requested_at: string;
    issued_at: string | null;
    expires_at: string | null;
    claimed_at: string | null;
    decision: "confirmed" | "declined" | null;
    decided_at: string | null;
    revoked_at: string | null;
    pilot_enrollments: { research_code: string; cohort: string; state: string } | null;
  };

  return NextResponse.json({
    study: study.slug,
    outstanding: ((result.data ?? []) as unknown as Row[]).map((row) => ({
      verification_id: row.id,
      research_code: row.pilot_enrollments?.research_code ?? null,
      cohort: row.pilot_enrollments?.cohort ?? null,
      status: guardianVerificationStatus(row),
      channel: row.channel,
      requested_grants: row.requested_grants,
      requested_at: row.requested_at,
      issued_at: row.issued_at,
      expires_at: row.expires_at,
    })),
  });
}

type IssueBody = {
  verification_id?: string;
  channel?: string;
};

export async function POST(request: NextRequest) {
  const operator = await requireOperator(request);
  if ("error" in operator) return operator.error;

  if (!guardianHashingConfigured()) {
    console.warn("[pilot-guardian] PILOT_GUARDIAN_HMAC_KEY is not configured; refusing to issue");
    return jsonError("PILOT_GUARDIAN_HMAC_KEY is not configured.", 503, {
      code: "guardian_hashing_unconfigured",
    });
  }

  const body = (await request.json().catch(() => ({}))) as IssueBody;
  const verificationId = typeof body.verification_id === "string" ? body.verification_id : "";
  if (!verificationId) return jsonError("verification_id is required.", 422);

  const channel = typeof body.channel === "string" && CHANNELS.has(body.channel) ? body.channel : "school";

  const issued = await issueVerification(operator.service, {
    verificationId,
    issuedBy: operator.userId,
    channel,
  });

  if ("error" in issued) {
    if (issued.error === "not_issuable") {
      // Already answered, already superseded, or never existed. One message
      // for all three: an operator who mistypes an id should not learn which.
      return jsonError("This verification cannot be issued.", 409, { code: "not_issuable" });
    }
    return jsonError("Issuing the verification link failed.", issued.error === "unconfigured" ? 503 : 502);
  }

  const enrollment = await loadEnrollmentById(operator.service, issued.record.enrollment_id);

  // The one response that carries the token, to the one party that is not the
  // participant. Not logged here or anywhere else: a link in a server log is a
  // credential in a server log.
  return NextResponse.json({
    status: "issued",
    url: guardianVerificationUrl(issued.token),
    research_code: enrollment?.research_code ?? null,
    token_prefix: issued.record.token_prefix,
    channel: issued.record.channel,
    expires_at: issued.record.expires_at,
  });
}

type RevokeBody = { verification_id?: string; enrollment_id?: string };

/** Pull a link back — a wrong address, a parent who asked for it to stop, a
 *  code handed to the wrong class. The participant can ask again afterwards. */
export async function DELETE(request: NextRequest) {
  const operator = await requireOperator(request);
  if ("error" in operator) return operator.error;

  const body = (await request.json().catch(() => ({}))) as RevokeBody;
  const verificationId =
    typeof body.verification_id === "string"
      ? body.verification_id
      : typeof body.enrollment_id === "string"
        ? ((await latestVerification(operator.service, body.enrollment_id))?.id ?? "")
        : "";

  if (!verificationId) return jsonError("verification_id or enrollment_id is required.", 422);

  const result = await operator.service
    .from("pilot_guardian_verifications")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", verificationId)
    .is("decision", null)
    .is("revoked_at", null)
    .select("id")
    .maybeSingle();

  if (result.error) return jsonError(result.error.message, 502);
  if (!result.data) return jsonError("This verification cannot be revoked.", 409, { code: "not_revocable" });

  return NextResponse.json({ status: "revoked", verification_id: verificationId });
}
