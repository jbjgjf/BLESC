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
 */

import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireUser } from "@/lib/server/api";
import { loadConsentState, recordConsent, revokeConsent } from "@/lib/server/consentStore";
import { serviceRoleClient } from "@/lib/server/supabaseWriter";
import { consentSnapshot } from "@/lib/consent";

export const runtime = "nodejs";

type ConsentRequest = {
  app_use?: boolean;
  research_analysis?: boolean;
  anonymized_export?: boolean;
  raw_text_retention?: boolean;
  future_fine_tuning?: boolean;
  minor_assent?: boolean;
  guardian_consent?: boolean;
  document_version?: string;
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

  // A minor's own agreement does not stand in for a guardian's, and the reverse
  // is worse. Recording research consent with only one of them would produce a
  // record that reads as complete, so the route refuses rather than storing a
  // half-consent the gates would then have to interpret.
  if (body.research_analysis === true && !(body.minor_assent === true && body.guardian_consent === true)) {
    return jsonError(
      "研究利用への同意には、本人の同意と保護者の同意の両方が必要です。",
      422,
      { code: "research_consent_requires_both_parties" },
    );
  }

  try {
    const consent = await recordConsent(
      resolved.service,
      resolved.ownerUserId,
      resolved.participantId,
      body,
    );
    return NextResponse.json({ consent, snapshot: consentSnapshot(consent) });
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
