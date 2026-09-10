/**
 * Follow-up answers (#133).
 *
 * The follow-up conversation fires for the entries that warranted asking — a
 * hard or low mood, or a body too short to read anything from. Its answers
 * lived in a `useState` array and were dropped on the transition to the
 * completion screen, so the most informative responses the product collected
 * were the only ones it never stored.
 *
 * One answer per request. The panel can be closed at any point, and a batch
 * sent at the end would lose exactly the sessions that ended early.
 */

import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireUser } from "@/lib/server/api";
import {
  COLLECTION_ONLY_MESSAGE,
  COLLECTION_ONLY_STATUS,
  collectionOnlyForParticipant,
} from "@/lib/server/collectionMode";
import { serviceRoleClient } from "@/lib/server/supabaseWriter";

export const runtime = "nodejs";

type FollowupRequest = {
  entry_id?: string;
  entry_session_id?: string | null;
  probe_id?: string;
  probe_index?: number;
  probe_version?: string;
  question_text?: string;
  answer_kind?: "choice" | "free_text" | "none";
  answer_text?: string | null;
  outcome?: "answered" | "declined" | "stopped" | "abandoned";
  answered_at?: string;
};

const OUTCOMES = new Set(["answered", "declined", "stopped", "abandoned"]);
const KINDS = new Set(["choice", "free_text", "none"]);

export async function POST(request: NextRequest) {
  const userId = request.nextUrl.searchParams.get("user_id");
  if (!userId) return jsonError("user_id is required.", 422);

  const body = (await request.json().catch(() => ({}))) as FollowupRequest;
  if (!body.entry_id) return jsonError("entry_id is required.", 422);
  if (!body.probe_id) return jsonError("probe_id is required.", 422);

  const outcome = body.outcome && OUTCOMES.has(body.outcome) ? body.outcome : "answered";
  const answerKind = body.answer_kind && KINDS.has(body.answer_kind) ? body.answer_kind : "choice";

  const auth = await requireUser(request);
  if ("error" in auth) return auth.error;

  // Same rule as the entry route: the participant is resolved through the
  // caller's own RLS-scoped client, so a code belonging to someone else is
  // simply not found. The insert below bypasses RLS.
  const participantResult = await auth.client
    .from("participants")
    .select("id")
    .eq("code", userId)
    .limit(1)
    .maybeSingle();
  if (participantResult.error) return jsonError(participantResult.error.message, 502);
  const participant = participantResult.data as { id: string } | null;
  if (!participant) return jsonError("Participant was not found.", 404);

  // And the entry has to be the caller's. Without this check a valid session
  // could attach answers to another participant's entry id.
  const entryResult = await auth.client
    .from("entries")
    .select("id")
    .eq("id", body.entry_id)
    .eq("participant_id", participant.id)
    .maybeSingle();
  if (entryResult.error) return jsonError(entryResult.error.message, 502);
  if (!entryResult.data) return jsonError("Entry was not found.", 404);

  const service = serviceRoleClient();
  if (!service) return jsonError("Supabase is not configured.", 503);

  // Adaptive follow-ups do not run during a collection window (#165).
  //
  // The follow-up script is adaptive by design: it fires for a hard day, a low
  // mood, or a body too short to read. That makes it an intervention — the
  // participant who is asked "何がいちばん大変でしたか" has been prompted to
  // reflect further, and tomorrow's entry is written by someone who was
  // prompted. A study measuring how people write cannot also be nudging them.
  //
  // The screen is the first control — the journal page does not offer the probe
  // during a window — and this is the backstop, for a stale tab, a replayed
  // request, or a client build from before the study started.
  //
  // What the backstop can still do is keep the answer out of the research
  // record; by the time a request arrives, the question has already been asked
  // and the nudge has already happened. That is why the refusal is worth having
  // even though it cannot undo the intervention, and why the display gate above
  // is the one that matters.
  //
  // The gate fails closed (`collectionMode.ts`), so a database error refuses the
  // write rather than allowing it. During an outage that costs a non-pilot
  // student's follow-up answer, which is the cheaper of the two mistakes: the
  // other direction puts an adaptive probe's answer into a study that says it
  // collected none.
  if (await collectionOnlyForParticipant(service, participant.id)) {
    return jsonError(COLLECTION_ONLY_MESSAGE, 409, { status: COLLECTION_ONLY_STATUS });
  }

  // Upsert on (owner, entry, probe): a retried request — the network dropped,
  // the student answered again after a reconnect — updates the answer rather
  // than storing it twice.
  const result = await service
    .from("followup_responses")
    .upsert(
      {
        owner_user_id: auth.user.id,
        participant_id: participant.id,
        entry_id: body.entry_id,
        entry_session_id: body.entry_session_id ?? null,
        probe_id: body.probe_id,
        probe_version: body.probe_version || "followup-script-v1",
        probe_index: body.probe_index ?? 0,
        question_text: body.question_text ?? "",
        answer_kind: answerKind,
        answer_text: body.answer_text ?? null,
        outcome,
        answered_at: body.answered_at ?? new Date().toISOString(),
      },
      { onConflict: "owner_user_id,entry_id,probe_id" },
    )
    .select("id")
    .single();

  if (result.error) return jsonError(result.error.message, 502);
  return NextResponse.json({ id: (result.data as { id: string }).id });
}
