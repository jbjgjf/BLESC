import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchWithTimeout, isMissingTable, jsonError, JsonValue, openAIKey, providerError, requireUser, sha256 } from "@/lib/server/api";

export const runtime = "nodejs";
export const maxDuration = 60;

type ParticipantRow = {
  id: string;
  code: string;
};

type ChatMessageRow = {
  id: string;
  role: string;
  content_hash: string;
  content_redacted: string | null;
  created_at: string;
};

type ChatPayload = {
  user_id?: string;
  participant_code?: string;
  message?: string;
  limit?: number;
  mode?: "general" | "recall_workspace";
  conversation_context?: string[];
};

type ConversationRecallRow = {
  id: string;
  window_turn_count: number;
  message_start: string | null;
  message_end: string | null;
  summary_json: Record<string, JsonValue>;
  source_message_hashes_json: JsonValue;
  memory_object_ids_json?: JsonValue;
  pipeline_version: string;
  status: string;
  created_at: string;
};

const CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || process.env.LLM_MODEL_NAME || "gpt-4.1-mini";
const PIPELINE_VERSION = "conversation-recall-30-v1";
const REQUIRED_USER_TURNS = 6;
const MAX_RECALL_MESSAGES = 30;

function asArray<T>(value: JsonValue | undefined, fallback: T[] = []): T[] {
  return Array.isArray(value) ? value as T[] : fallback;
}

function outputText(response: Record<string, unknown>): string | null {
  if (typeof response.output_text === "string") return response.output_text;
  const output = Array.isArray(response.output) ? response.output : [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = Array.isArray((item as { content?: unknown }).content) ? (item as { content: unknown[] }).content : [];
    for (const part of content) {
      if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
        return (part as { text: string }).text;
      }
    }
  }
  return null;
}

function fallbackAnswer(mode: ChatPayload["mode"]) {
  if (mode === "recall_workspace") {
    return "I have recorded that turn. Let us keep this cautious and non-diagnostic: what part of that feels most important to remember next time?";
  }
  return "I can reflect on the latest message, but the model provider is temporarily unavailable. Treat this as a prompt for reflection rather than a conclusion.";
}

function summarize(messages: ChatMessageRow[]) {
  const counts = new Map<string, number>();
  for (const message of messages) {
    for (const word of (message.content_redacted ?? "").toLowerCase().match(/[a-z][a-z'-]{3,}|[ぁ-んァ-ン一-龥]{2,}/g) ?? []) {
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  const topics = Array.from(counts.entries())
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 5)
    .map(([topic, count]) => ({ topic, count }));
  const userMessages = messages.filter((message) => message.role === "user");
  const assistantMessages = messages.filter((message) => message.role === "assistant");
  const latest = [...userMessages].reverse().find((message) => message.content_redacted)?.content_redacted ?? "";

  return {
    summary: latest
      ? `Recent conversation includes ${userMessages.length} user turns and ${assistantMessages.length} assistant responses. The latest user turn focused on: ${latest.slice(0, 180)}`
      : `Recent conversation includes ${userMessages.length} user turns and ${assistantMessages.length} assistant responses.`,
    recurring_topics: topics,
    top_topics: topics,
    tone_trends: {},
    open_loops: [],
    non_diagnostic: true,
  };
}

function toRecall(row: ConversationRecallRow) {
  return {
    id: row.id,
    status: row.status,
    window_turn_count: row.window_turn_count,
    required_turn_count: REQUIRED_USER_TURNS,
    message_start: row.message_start,
    message_end: row.message_end,
    summary_json: row.summary_json,
    source_message_hashes: asArray<string>(row.source_message_hashes_json),
    memory_object_ids: asArray<string | number>(row.memory_object_ids_json),
    pipeline_version: row.pipeline_version,
    created_at: row.created_at,
  };
}

async function buildRecall(supabase: SupabaseClient, participantId: string, ownerUserId: string) {
  const messagesResult = await supabase
    .from("chat_messages")
    .select("id, role, content_hash, content_redacted, created_at")
    .eq("participant_id", participantId)
    .order("created_at", { ascending: false })
    .limit(MAX_RECALL_MESSAGES);

  if (isMissingTable(messagesResult.error)) return null;
  if (messagesResult.error) throw new Error(messagesResult.error.message);

  const messages = ((messagesResult.data ?? []) as ChatMessageRow[]).reverse();
  const userTurnCount = messages.filter((message) => message.role === "user").length;
  const payload = {
    window_turn_count: userTurnCount,
    message_start: messages[0]?.created_at ?? null,
    message_end: messages[messages.length - 1]?.created_at ?? null,
    summary_json: userTurnCount >= REQUIRED_USER_TURNS
      ? summarize(messages)
      : {
          summary: "Not enough conversation history.",
          recurring_topics: [],
          top_topics: [],
          tone_trends: {},
          open_loops: [],
          non_diagnostic: true,
        },
    source_message_hashes_json: messages.map((message) => message.content_hash),
    memory_object_ids_json: [],
    pipeline_version: PIPELINE_VERSION,
    status: userTurnCount >= REQUIRED_USER_TURNS ? "completed" : "not_enough_history",
  };

  const inserted = await supabase
    .from("conversation_recall_summaries")
    .insert({ owner_user_id: ownerUserId, participant_id: participantId, ...payload })
    .select("id, window_turn_count, message_start, message_end, summary_json, source_message_hashes_json, memory_object_ids_json, pipeline_version, status, created_at")
    .single();

  if (isMissingTable(inserted.error)) return null;
  if (inserted.error) throw new Error(inserted.error.message);
  return toRecall(inserted.data as ConversationRecallRow);
}

async function callOpenAI(message: string, payload: ChatPayload, recentMessages: ChatMessageRow[]) {
  const key = openAIKey();
  if (!key || process.env.USE_MOCK_LLM?.toLowerCase() === "true") {
    return {
      answer: fallbackAnswer(payload.mode),
      provider: "deterministic",
      status: "degraded",
      error_message: "OpenAI chat is not configured. Set OPENAI_API_KEY and ensure USE_MOCK_LLM is not true.",
    };
  }

  const instructions = [
    "You are Sentra's student-facing research assistant.",
    "Use simple, supportive, non-diagnostic language.",
    "Do not claim to diagnose, treat, predict, or replace doctors, therapists, school counselors, guardians, emergency services, or licensed professionals.",
    payload.mode === "recall_workspace"
      ? "For the 30-turn recall workspace, briefly reflect the latest answer and ask one concise next question."
      : "For general chat, answer briefly and ground claims in the supplied recent context.",
    ...(payload.conversation_context?.length ? payload.conversation_context : []),
  ].join(" ");

  try {
    const response = await fetchWithTimeout("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: CHAT_MODEL,
        store: false,
        instructions,
        input: [
          ...recentMessages.slice(-12).map((item) => ({
            role: item.role === "assistant" ? "assistant" : "user",
            content: item.content_redacted ?? "",
          })),
          { role: "user", content: message },
        ],
        text: { verbosity: "medium" },
      }),
    }, Number(process.env.OPENAI_CHAT_TIMEOUT_MS ?? 25000));

    if (!response.ok) {
      const error = await providerError(response, "OpenAI chat request failed.");
      return {
        answer: fallbackAnswer(payload.mode),
        provider: "openai",
        status: response.status === 429 ? "rate_limited_fallback" : "provider_fallback",
        error_message: error.detail,
        error_code: error.code,
      };
    }

    const json = await response.json() as Record<string, unknown>;
    return {
      answer: outputText(json) ?? fallbackAnswer(payload.mode),
      provider: "openai",
      status: "completed",
      error_message: null,
    };
  } catch (error) {
    return {
      answer: fallbackAnswer(payload.mode),
      provider: "openai",
      status: "timeout_fallback",
      error_message: error instanceof Error ? error.message : "OpenAI chat request timed out.",
    };
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireUser(request);
  if ("error" in auth) return auth.error;

  const payload = await request.json().catch(() => ({})) as ChatPayload;
  const userId = (payload.participant_code || payload.user_id || "").trim();
  const message = (payload.message || "").trim();
  const limit = Number.isFinite(payload.limit) ? Number(payload.limit) : 5;

  if (!userId) return jsonError("user_id or participant_code is required.", 422);
  if (!message) return jsonError("Message is required.", 422);

  const participantResult = await auth.client
    .from("participants")
    .select("id, code")
    .eq("code", userId)
    .limit(1)
    .maybeSingle();

  if (participantResult.error) return jsonError(participantResult.error.message, 502);
  const participant = participantResult.data as ParticipantRow | null;
  if (!participant) return jsonError("Participant was not found.", 404);

  const recentMessagesResult = await auth.client
    .from("chat_messages")
    .select("id, role, content_hash, content_redacted, created_at")
    .eq("participant_id", participant.id)
    .order("created_at", { ascending: false })
    .limit(Math.max(1, Math.min(limit * 2, 20)));

  if (recentMessagesResult.error && !isMissingTable(recentMessagesResult.error)) {
    return jsonError(recentMessagesResult.error.message, 502);
  }
  const recentMessages = ((recentMessagesResult.data ?? []) as ChatMessageRow[]).reverse();
  const llm = await callOpenAI(message, payload, recentMessages);

  const chatSession = await auth.client
    .from("chat_sessions")
    .insert({
      owner_user_id: auth.user.id,
      participant_id: participant.id,
      consent_snapshot_json: { app_use: true, research_analysis: true, source: "student_ui" },
    })
    .select("id")
    .single();

  if (chatSession.error || !chatSession.data) {
    return jsonError(chatSession.error?.message ?? "Chat session could not be saved.", 502);
  }

  const userHash = await sha256(message);
  const assistantHash = await sha256(llm.answer);
  const insertedMessages = await auth.client
    .from("chat_messages")
    .insert([
      {
        owner_user_id: auth.user.id,
        participant_id: participant.id,
        chat_session_id: chatSession.data.id,
        role: "user",
        content_hash: userHash,
        content_redacted: message.slice(0, 500),
        evidence_refs_json: [],
      },
      {
        owner_user_id: auth.user.id,
        participant_id: participant.id,
        chat_session_id: chatSession.data.id,
        role: "assistant",
        content_hash: assistantHash,
        content_redacted: llm.answer.slice(0, 1000),
        evidence_refs_json: [],
      },
    ])
    .select("id, role")
    .order("role", { ascending: true });

  if (insertedMessages.error) return jsonError(insertedMessages.error.message, 502);

  let recall = null;
  try {
    recall = await buildRecall(auth.client, participant.id, auth.user.id);
  } catch {
    recall = null;
  }

  const assistantMessage = (insertedMessages.data ?? []).find((row: { id: string; role: string }) => row.role === "assistant");
  return NextResponse.json({
    chat_session_id: chatSession.data.id,
    message_id: assistantMessage?.id ?? chatSession.data.id,
    answer: llm.answer,
    evidence_refs: {
      provider: llm.provider,
      source: "next_api_chat",
      mode: payload.mode ?? "general",
    },
    retrieval_context: {
      source: "supabase_recent_chat",
      recent_message_count: recentMessages.length,
      openai_status: llm.status,
    },
    conversation_recall_30: recall,
    model_run_id: null,
    status: llm.status,
    error_message: llm.error_message,
    mirrored: true,
  });
}
