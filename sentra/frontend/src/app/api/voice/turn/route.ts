import { NextRequest, NextResponse } from "next/server";
import { isMissingTable, jsonError, requireUser, sha256 } from "@/lib/server/api";
import { assessConversation, recordSafetyAudit } from "@/lib/server/safety";
import { serviceRoleClient } from "@/lib/server/supabaseWriter";
import { escalate, notifiableLevel } from "@/lib/server/safetyEscalation";

export const runtime = "nodejs";
export const maxDuration = 20;

const PIPELINE_VERSION = "voice-realtime-v1";

type VoiceTurnPayload = {
  participant_code?: string;
  /** The student's transcribed utterance. */
  message?: string;
  /** The assistant's spoken reply, when the turn has already been answered. */
  reply?: string;
};

/**
 * Safety and audit for the realtime voice path.
 *
 * The realtime session streams from the browser straight to OpenAI, so voice
 * never passed through /api/chat and inherited none of its safety work: no
 * deterministic floor, no audit row, no persistence, and — because the window
 * is read from chat_messages — nothing said aloud could influence a later text
 * conversation either. The client posts each settled turn here.
 *
 * This does NOT generate a reply; the realtime model already spoke. It returns
 * the assessment so the client can have the canned support response spoken when
 * the model's own answer pointed at no real person.
 *
 * It also escalates, as chat and the journal do (#237) — see the block after
 * the audit write.
 */
export async function POST(request: NextRequest) {
  const auth = await requireUser(request);
  if ("error" in auth) return auth.error;

  const payload = (await request.json().catch(() => ({}))) as VoiceTurnPayload;
  const userId = (payload.participant_code || "").trim();
  const message = (payload.message || "").trim();
  const reply = (payload.reply || "").trim();

  if (!userId) return jsonError("participant_code is required.", 422);
  if (!message) return jsonError("message is required.", 422);

  const participantResult = await auth.client
    .from("participants")
    .select("id, code")
    .eq("code", userId)
    .limit(1)
    .maybeSingle();
  if (participantResult.error) return jsonError(participantResult.error.message, 502);
  // `code` is selected above and is what the educator's alert names the
  // student by; the narrower cast predated the escalation call.
  const participant = participantResult.data as { id: string; code: string | null } | null;
  if (!participant) return jsonError("Participant was not found.", 404);

  const recentResult = await auth.client
    .from("chat_messages")
    .select("role, content_redacted")
    .eq("participant_id", participant.id)
    .order("created_at", { ascending: false })
    .limit(20);
  if (recentResult.error && !isMissingTable(recentResult.error)) {
    return jsonError(recentResult.error.message, 502);
  }
  const recentMessages = ((recentResult.data ?? []) as { role: string; content_redacted: string | null }[]).reverse();

  const safety = await assessConversation(auth.client, participant.id, "voice", recentMessages, message);

  // Persist into the same table text chat uses, so a spoken disclosure is part
  // of the window the next text turn assesses, and lands in the audit trail.
  const chatSession = await auth.client
    .from("chat_sessions")
    .insert({
      owner_user_id: auth.user.id,
      participant_id: participant.id,
      consent_snapshot_json: { app_use: true, research_analysis: true, source: "student_voice" },
    })
    .select("id")
    .single();
  if (chatSession.error || !chatSession.data) {
    return jsonError(chatSession.error?.message ?? "Voice turn could not be saved.", 502);
  }

  const rows = [
    {
      owner_user_id: auth.user.id,
      participant_id: participant.id,
      chat_session_id: chatSession.data.id,
      role: "user",
      content_hash: await sha256(message),
      content_redacted: message.slice(0, 500),
      evidence_refs_json: [],
    },
  ];
  if (reply) {
    rows.push({
      owner_user_id: auth.user.id,
      participant_id: participant.id,
      chat_session_id: chatSession.data.id,
      role: "assistant",
      content_hash: await sha256(reply),
      content_redacted: reply.slice(0, 1000),
      evidence_refs_json: [],
    });
  }
  const inserted = await auth.client.from("chat_messages").insert(rows);
  if (inserted.error) return jsonError(inserted.error.message, 502);

  await recordSafetyAudit(auth.client, {
    ownerUserId: auth.user.id,
    participantId: participant.id,
    artifactId: chatSession.data.id,
    surface: "voice",
    pipelineVersion: PIPELINE_VERSION,
    safety,
  });

  /*
   * Voice was the third surface a crisis arrives on, and the only one that
   * still told nobody (#237). Chat and the journal escalate; this route
   * assessed the turn, wrote the audit row, had the support line spoken — and
   * stopped there. A student who says out loud what they would not type
   * reached an audit table that nobody is paged by.
   *
   * Same shape as the chat route deliberately. `escalate` records the row and
   * returns, leaving delivery to run on: a student in crisis must not wait on
   * a school's mail server, and an undelivered row is retried by
   * `/api/safety/dispatch`, where an unwritten one is simply lost.
   *
   * Under the service-role client because the recipients are other people's
   * rows — the student's own session cannot read their educators' addresses,
   * and should not be able to.
   */
  const notifiable = notifiableLevel(safety.risk_level);
  if (notifiable) {
    const service = serviceRoleClient();
    if (service) {
      await escalate(service, {
        ownerUserId: auth.user.id,
        participantId: participant.id,
        participantCode: participant.code,
        riskLevel: notifiable,
        reasons: safety.reasons,
        surface: "voice",
        sourceArtifactId: chatSession.data.id,
      });
    } else {
      console.error(
        "[safety-escalation] a crisis was assessed and Supabase is not configured; nobody will be told",
        { participant: participant.id },
      );
    }
  }

  return NextResponse.json({
    chat_session_id: chatSession.data.id,
    safety_assessment: safety,
    safety_flags: safety.reasons,
    /** Non-empty when the client should have this spoken. */
    safe_response: safety.safe_response,
  });
}
