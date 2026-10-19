/**
 * The enrollment gate for the routes that talk to a model (#344).
 *
 * `pilotGate.ts` answers "may this account produce rows right now?", and until
 * this module only `/journal` and `POST /api/entries` asked it. `POST /api/chat`
 * did not, so on a pilot deployment a withdrawn participant — whose journal was
 * closed — could keep chatting, and their text went to OpenAI precisely
 * because they were withdrawn: `collectionOnlyForParticipant` asks "is a
 * window open?", reads "no", and lifts the restriction. The same held for an
 * account that was never enrolled, and for the two voice routes.
 *
 * On a deployment without `PILOT_STUDY_SLUG` this does nothing, as the rest of
 * the pilot gating does: demo, school evaluation and local development keep
 * the behaviour they had.
 *
 * The refusal is the JSON `/api/entries` already returns — `code` is the gate's
 * reason and `pending` what is still missing — plus `redirect`, the join screen
 * that explains which step is next.
 */

import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { gateForUser, pilotGateEnforced, redirectFor, type GateOutcome } from "./pilotGate";
import { loadEnrollmentsForUser } from "./pilotStore";
import { serviceRoleClient } from "./supabaseWriter";

export const OUTSIDE_ENROLLMENT_MESSAGE =
  "いまは研究に参加している期間ではないため、この機能は使えません。参加の状態は参加登録の画面で確認できます。";

/** The gate's answer for a signed-in account; `allowed` on every non-pilot deployment. */
export async function enrollmentGate(
  ownerUserId: string,
  participantId: string | null,
  service: SupabaseClient | null = serviceRoleClient(),
): Promise<GateOutcome> {
  if (!pilotGateEnforced()) return { allowed: true, reason: "not_enforced" };
  const enrollments = service ? await loadEnrollmentsForUser(service, ownerUserId) : [];
  return gateForUser(service, ownerUserId, enrollments, participantId);
}

/** The participant row an account owns, for routes that are not handed one. */
export async function ownParticipantId(service: SupabaseClient | null, ownerUserId: string): Promise<string | null> {
  if (!service) return null;
  const result = await service
    .from("participants")
    .select("id")
    .eq("owner_user_id", ownerUserId)
    .limit(1)
    .maybeSingle();
  return (result.data as { id: string } | null)?.id ?? null;
}

export function outsideEnrollmentResponse(
  outcome: Extract<GateOutcome, { allowed: false }>,
  extra: Record<string, unknown> = {},
): NextResponse {
  return NextResponse.json(
    {
      detail: OUTSIDE_ENROLLMENT_MESSAGE,
      code: outcome.reason,
      pending: outcome.pending,
      redirect: redirectFor(outcome),
      ...extra,
    },
    { status: 403 },
  );
}
