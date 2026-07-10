import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/server/api";

export const runtime = "nodejs";
export const maxDuration = 60;

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

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

type ConversationRecallRow = {
  id: string;
  window_turn_count: number;
  message_start: string | null;
  message_end: string | null;
  summary_json: Record<string, JsonValue>;
  source_message_hashes_json: JsonValue;
  pipeline_version: string;
  status: string;
  created_at: string;
};

const REQUIRED_USER_TURNS = 6;
const MAX_MESSAGES = 30;
const PIPELINE_VERSION = "conversation-recall-30-v1";

function isMissingTable(error: unknown) {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "PGRST205",
  );
}

function asArray<T>(value: JsonValue | undefined, fallback: T[] = []): T[] {
  return Array.isArray(value) ? value as T[] : fallback;
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
    pipeline_version: row.pipeline_version,
    created_at: row.created_at,
  };
}

function extractTopics(messages: ChatMessageRow[]) {
  const counts = new Map<string, number>();
  const stopWords = new Set([
    "about",
    "after",
    "again",
    "bleSC".toLowerCase(),
    "could",
    "from",
    "have",
    "that",
    "this",
    "with",
    "what",
    "when",
    "where",
    "your",
    "recent",
    "patterns",
    "reflect",
  ]);
  for (const message of messages) {
    for (const word of (message.content_redacted ?? "").toLowerCase().match(/[a-z][a-z'-]{3,}/g) ?? []) {
      if (!stopWords.has(word)) counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 5)
    .map(([topic, count]) => ({ topic, count }));
}

function summarize(messages: ChatMessageRow[]) {
  const userMessages = messages.filter((message) => message.role === "user");
  const assistantMessages = messages.filter((message) => message.role === "assistant");
  const topics = extractTopics(messages);
  const latestUserText = [...userMessages].reverse().find((message) => message.content_redacted)?.content_redacted;
  const summary = latestUserText
    ? `Recent conversation includes ${userMessages.length} user turns and ${assistantMessages.length} assistant responses. The latest user turn focused on: ${latestUserText.slice(0, 180)}`
    : `Recent conversation includes ${userMessages.length} user turns and ${assistantMessages.length} assistant responses.`;
  return {
    summary,
    recurring_topics: topics,
    top_topics: topics,
    tone_trends: {},
    open_loops: [],
    non_diagnostic: true,
  };
}

function notEnoughHistory(messages: ChatMessageRow[]) {
  return NextResponse.json({
    status: "not_enough_history",
    window_turn_count: messages.filter((message) => message.role === "user").length,
    required_turn_count: REQUIRED_USER_TURNS,
    message_start: messages[0]?.created_at ?? null,
    message_end: messages[messages.length - 1]?.created_at ?? null,
    summary_json: {
      summary: "Not enough conversation history.",
      recurring_topics: [],
      top_topics: [],
      tone_trends: {},
      open_loops: [],
      non_diagnostic: true,
    },
    source_message_hashes: messages.map((message) => message.content_hash),
    pipeline_version: PIPELINE_VERSION,
  });
}

export async function GET(request: NextRequest) {
  const auth = await requireUser(request);
  if ("error" in auth) return auth.error;
  const supabase = auth.client;

  const userId = request.nextUrl.searchParams.get("user_id")?.trim();
  const refresh = request.nextUrl.searchParams.get("refresh") === "true";
  if (!userId) {
    return NextResponse.json({ detail: "user_id is required." }, { status: 422 });
  }

  const participantResult = await supabase
    .from("participants")
    .select("id, code")
    .eq("code", userId)
    .limit(1)
    .maybeSingle();
  if (participantResult.error) {
    return NextResponse.json({ detail: participantResult.error.message }, { status: 502 });
  }
  const participant = participantResult.data as ParticipantRow | null;
  if (!participant) {
    return notEnoughHistory([]);
  }

  if (!refresh) {
    const latest = await supabase
      .from("conversation_recall_summaries")
      .select("id, window_turn_count, message_start, message_end, summary_json, source_message_hashes_json, pipeline_version, status, created_at")
      .eq("participant_id", participant.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (isMissingTable(latest.error)) {
      return NextResponse.json(
        { detail: "Supabase migration is missing public.conversation_recall_summaries." },
        { status: 503 },
      );
    }
    if (latest.error) {
      return NextResponse.json({ detail: latest.error.message }, { status: 502 });
    }
    if (latest.data) {
      return NextResponse.json(toRecall(latest.data as ConversationRecallRow));
    }
  }

  const messagesResult = await supabase
    .from("chat_messages")
    .select("id, role, content_hash, content_redacted, created_at")
    .eq("participant_id", participant.id)
    .order("created_at", { ascending: false })
    .limit(MAX_MESSAGES);
  if (messagesResult.error) {
    return NextResponse.json({ detail: messagesResult.error.message }, { status: 502 });
  }

  const messages = ((messagesResult.data ?? []) as ChatMessageRow[]).reverse();
  const userTurnCount = messages.filter((message) => message.role === "user").length;
  if (userTurnCount < REQUIRED_USER_TURNS) {
    return notEnoughHistory(messages);
  }

  const payload = {
    window_turn_count: userTurnCount,
    message_start: messages[0]?.created_at ?? null,
    message_end: messages[messages.length - 1]?.created_at ?? null,
    summary_json: summarize(messages),
    source_message_hashes_json: messages.map((message) => message.content_hash),
    pipeline_version: PIPELINE_VERSION,
    status: "completed",
  };

  const inserted = await supabase
    .from("conversation_recall_summaries")
    .insert({
      owner_user_id: auth.user.id,
      participant_id: participant.id,
      ...payload,
    })
    .select("id, window_turn_count, message_start, message_end, summary_json, source_message_hashes_json, pipeline_version, status, created_at")
    .single();

  if (isMissingTable(inserted.error)) {
    return NextResponse.json(
      { detail: "Supabase migration is missing public.conversation_recall_summaries." },
      { status: 503 },
    );
  }
  if (inserted.error) {
    return NextResponse.json({
      ...payload,
      required_turn_count: REQUIRED_USER_TURNS,
      source_message_hashes: payload.source_message_hashes_json,
      created_at: new Date().toISOString(),
      warning: inserted.error.message,
    });
  }

  return NextResponse.json(toRecall(inserted.data as ConversationRecallRow));
}
