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
import {
  loadConsentState,
  recordConsent,
  type RetainedDataDisposition,
} from "@/lib/server/consentStore";
import { withdrawParticipation, withdrawalMessage } from "@/lib/server/withdrawal";
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
  model_training_use?: boolean;
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
    ? (["research_analysis", "anonymized_export", "raw_text_retention", "model_training_use"] as const)
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

/**
 * Withdraw.
 *
 * `retained_data` decides what happens to journal text already stored (#224).
 * Only the exact string `"keep"` keeps it: anything else — absent, misspelled,
 * a boolean, a value from a client that has drifted — is read as `"delete"`.
 * The two mistakes are not symmetric. Reading a garbled request as "delete"
 * destroys text the participant may have wanted kept, which is bad; reading it
 * as "keep" retains text after a withdrawal that may well have meant "get rid
 * of it", which is the failure this route was written to prevent.
 *
 * Withdrawal is withdrawal either way. `keep` does not resume collection, does
 * not re-open the export gate and does not permit training use; it only means
 * the stored text is left to its ordinary retention window.
 *
 * **It also ends the participation (#263).** This route used to write the
 * revocation, purge the text, and leave `pilot_enrollments` alone — so a
 * student who withdrew here stayed `collecting`: `pilotGate` kept admitting
 * them to `/journal`, and the dashboard kept counting them as someone who owed
 * a daily entry while reporting `withdrawn: 0`. The whole act now lives in
 * `withdrawal.ts` and is shared with `/pilot/join`, which had the opposite half
 * of the same defect.
 */
export async function DELETE(request: NextRequest) {
  const resolved = await resolve(request);
  if ("error" in resolved) return resolved.error;

  const body = (await request.json().catch(() => ({}))) as { retained_data?: unknown };
  const disposition: RetainedDataDisposition = body.retained_data === "keep" ? "keep" : "delete";

  const result = await withdrawParticipation(resolved.service, {
    ownerUserId: resolved.ownerUserId,
    participantId: resolved.participantId,
    disposition,
    actor: "participant",
    source: "student_ui",
  });

  // The consent row could not be written, so there is no consent state to
  // answer with and the screen has nothing to re-render from. The message still
  // comes from `withdrawalMessage`, because the other two steps were attempted
  // and the participant needs to know which of the three did not finish —
  // 「同意を撤回できませんでした」 alone would be wrong about the two that did.
  if (result.consent.outcome === "failed") {
    return jsonError(withdrawalMessage(result), 502, { code: "consent_not_recorded" });
  }

  // `purged_raw_text` keeps its old meaning for existing callers: a count when
  // text was destroyed, 0 when it was kept, null when the purge failed. A
  // caller cannot mistake "kept" for "deleted zero", because `retained_data`
  // says which.
  const payload = {
    consent: result.consent.state,
    retained_data: result.retained_data,
    purged_raw_text: result.raw_text.purged,
    enrollment: result.enrollment,
    complete: result.complete,
    detail: withdrawalMessage(result),
  };

  // A partial withdrawal is reported as one. Answering 200 over a purge that
  // failed, or over an enrollment still marked `collecting`, is the failure
  // this route exists to prevent — the participant can retry, and the operator
  // sees it.
  return NextResponse.json(payload, { status: result.complete ? 200 : 502 });
}
