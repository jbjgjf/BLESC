/**
 * Consent grant and revocation (#134).
 *
 * The write path reads `consent_records` and nothing else, so this is the only
 * route that can turn research collection on for a participant. Two properties
 * it has to hold:
 *
 *   - The participant is derived from the session, never from the body. The
 *     insert below uses the service-role key, which bypasses RLS; a body-supplied
 *     participant id would let any caller record consent on someone else's behalf.
 *
 *   - Revocation deletes. Recording that consent was withdrawn while the
 *     retained journal text stays in the table would satisfy the record and not
 *     the promise, so `DELETE` purges the text before it answers (#131).
 *
 *   - **A guardian's consent never arrives through this route (#164).** It used
 *     to: the body carried `guardian_consent`, and whoever was signed in could
 *     set it. For a fifteen-year-old that is the participant ticking a box on
 *     their own behalf and a `consent_records` row that reads, to a reviewer,
 *     as a parent's agreement. The flag is now dropped from every request here
 *     and can only be written by `/api/pilot/guardian/confirm`, which is
 *     reached with a token on a different device and no session at all.
 */

import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireUser } from "@/lib/server/api";
import { loadConsentState, recordConsent, revokeConsent } from "@/lib/server/consentStore";
import { serviceRoleClient } from "@/lib/server/supabaseWriter";
import { loadEnrollmentByParticipant } from "@/lib/server/pilotStore";
import { consentSnapshot } from "@/lib/consent";
import { guardianRequired, participantConsentGrant } from "@/lib/guardianVerification";

export const runtime = "nodejs";

type ConsentRequest = {
  app_use?: boolean;
  research_analysis?: boolean;
  anonymized_export?: boolean;
  raw_text_retention?: boolean;
  future_fine_tuning?: boolean;
  minor_assent?: boolean;
  document_version?: string;
  /**
   * Not a field. Named here so that a request still sending it — an old tab, a
   * script written against the previous contract — is visibly ignored rather
   * than silently accepted by a spread. `participantConsentGrant` drops it.
   */
  guardian_consent?: never;
};

async function resolve(request: NextRequest) {
  const userId = request.nextUrl.searchParams.get("user_id");
  if (!userId) return { error: jsonError("user_id is required.", 422) };

  const auth = await requireUser(request);
  if ("error" in auth) return auth;

  const participantResult = await auth.client
    .from("participants")
    .select("id")
    .eq("code", userId)
    .limit(1)
    .maybeSingle();
  if (participantResult.error) return { error: jsonError(participantResult.error.message, 502) };
  const participant = participantResult.data as { id: string } | null;
  if (!participant) return { error: jsonError("Participant was not found.", 404) };

  const service = serviceRoleClient();
  if (!service) return { error: jsonError("Supabase is not configured.", 503) };

  return { ownerUserId: auth.user.id, participantId: participant.id, service };
}

export async function GET(request: NextRequest) {
  const resolved = await resolve(request);
  if ("error" in resolved) return resolved.error;
  const consent = await loadConsentState(resolved.service, resolved.ownerUserId, resolved.participantId);
  return NextResponse.json({ consent, snapshot: consentSnapshot(consent) });
}

export async function POST(request: NextRequest) {
  const resolved = await resolve(request);
  if ("error" in resolved) return resolved.error;
  const body = (await request.json().catch(() => ({}))) as ConsentRequest;

  // The participant's own agreement is theirs to give and is required for
  // research use. It is the one half this route can record.
  if (body.research_analysis === true && body.minor_assent !== true) {
    return jsonError(
      "研究利用への同意には、本人の同意が必要です。",
      422,
      { code: "research_consent_requires_assent" },
    );
  }

  // Whether a guardian is needed comes from the enrollment, which a coordinator
  // set when the invitation was issued — not from the body, and not from a date
  // of birth this study has no reason to hold.
  const enrollment = await loadEnrollmentByParticipant(
    resolved.service,
    resolved.ownerUserId,
    resolved.participantId,
  );

  // No enrollment, no study to consent to. The first cut of this made "unknown"
  // mean "a guardian is required", which on a non-pilot deployment produced a
  // requirement nobody could ever satisfy — no enrollment means no way to ask a
  // guardian, so research consent was silently unreachable. Refusing out loud
  // is the honest version of the same safety property, and it is also true:
  // research collection here is invitation-only (#163), so consent to it
  // outside a study would describe nothing.
  //
  // What is *not* refused is ordinary app use. A participant with no enrollment
  // still records `app_use` exactly as before.
  if (body.research_analysis === true && !enrollment) {
    return jsonError(
      "研究利用への同意は、研究への参加登録がある場合にのみ記録できます。招待コードをお持ちの場合は、参加の手続きから進めてください。",
      409,
      { code: "research_requires_enrollment" },
    );
  }

  const needsGuardian = enrollment ? guardianRequired(enrollment) : false;

  // Read, never trusted from the request: the guardian half is whatever the
  // stored record already says, which only the confirm route can have written.
  // The same record is the ceiling on what a minor may (re-)grant — a guardian
  // who approved a narrower scope is not consenting to a wider one later.
  const stored = await loadConsentState(resolved.service, resolved.ownerUserId, resolved.participantId);
  const guardianConfirmed = stored.guardian_consent === true;

  const grant = participantConsentGrant(body as Record<string, unknown>, {
    guardianRequired: needsGuardian,
    guardianConfirmed,
    approvedScope: stored,
  });

  // Asking for research use before a guardian has answered is the ordinary
  // path, not an error: the participant assents first and the guardian is asked
  // second. So the assent is recorded as given, the research grants are held
  // back, and the response names what the enrollment is waiting for so the
  // screen can move to the guardian step instead of showing a failure.
  const pending = body.research_analysis === true && needsGuardian && !guardianConfirmed
    ? "guardian_verification"
    : null;

  // A grant the guardian has not approved is dropped rather than refused, but
  // the caller is told which, so a screen can say "this needs a new
  // confirmation" instead of silently unticking a box the participant ticked.
  const outsideApprovedScope = needsGuardian && guardianConfirmed
    ? (["research_analysis", "anonymized_export", "raw_text_retention", "future_fine_tuning"] as const)
        .filter((key) => body[key] === true && grant[key] !== true)
    : [];

  try {
    const consent = await recordConsent(
      resolved.service,
      resolved.ownerUserId,
      resolved.participantId,
      { ...grant, document_version: body.document_version },
    );
    return NextResponse.json({
      consent,
      snapshot: consentSnapshot(consent),
      pending,
      outside_approved_scope: outsideApprovedScope,
    });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "同意を記録できませんでした。", 502);
  }
}

export async function DELETE(request: NextRequest) {
  const resolved = await resolve(request);
  if ("error" in resolved) return resolved.error;

  try {
    const consent = await revokeConsent(resolved.service, resolved.ownerUserId, resolved.participantId);

    // Purge before answering. A revocation that returns success while the text
    // is still stored is the failure this route exists to prevent, so a purge
    // failure is reported as one — the participant can retry, and the operator
    // sees it.
    const purge = await resolved.service.rpc("purge_raw_text_for_participant", {
      target_participant: resolved.participantId,
    });
    if (purge.error) {
      console.error("[consent] raw text purge failed after revocation", purge.error);
      return NextResponse.json(
        {
          consent,
          purged_raw_text: null,
          detail: "同意は撤回しましたが、保存済みの本文の削除に失敗しました。",
        },
        { status: 502 },
      );
    }

    return NextResponse.json({ consent, purged_raw_text: purge.data ?? 0 });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "同意を撤回できませんでした。", 502);
  }
}
