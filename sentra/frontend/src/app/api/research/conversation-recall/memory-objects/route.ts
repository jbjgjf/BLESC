import { NextRequest, NextResponse } from "next/server";
import { isMissingTable, jsonError, JsonValue, requireUser } from "@/lib/server/api";

export const runtime = "nodejs";
export const maxDuration = 30;

type MemoryObjectRow = {
  id: string;
  source_message_ids_json: JsonValue;
  topic: string;
  summary: string;
  emotional_tone_json: Record<string, JsonValue>;
  importance_score: number;
  score_breakdown_json: Record<string, JsonValue>;
  recurrence_score: number;
  recurrence_count: number;
  confidence_score: number;
  extraction_mode: string;
  embedding_model: string;
  embedding_status: string;
  created_at: string;
  updated_at: string;
  last_reinforced_at: string;
  merged_into_id: string | null;
  merge_reason: string | null;
  superseded_by_id: string | null;
  contradiction_status: string;
  contradiction_detail_json: Record<string, JsonValue>;
  pipeline_version: string;
};

function asArray<T>(value: JsonValue | undefined, fallback: T[] = []): T[] {
  return Array.isArray(value) ? value as T[] : fallback;
}

function toMemoryObject(row: MemoryObjectRow) {
  const recencyMs = row.last_reinforced_at ? Date.now() - new Date(row.last_reinforced_at).getTime() : 0;
  const recencyDays = Math.max(0, recencyMs / 86400000);
  const recencyFactor = Math.exp(-recencyDays / 30);

  return {
    memory_id: row.id,
    source_message_ids: asArray<string | number>(row.source_message_ids_json),
    topic: row.topic,
    summary: row.summary,
    emotional_tone: row.emotional_tone_json,
    importance_score: row.importance_score,
    effective_importance: Number((row.importance_score * recencyFactor).toFixed(6)),
    score_breakdown: row.score_breakdown_json,
    recurrence_score: row.recurrence_score,
    recurrence_count: row.recurrence_count,
    confidence_score: row.confidence_score,
    extraction_mode: row.extraction_mode,
    embedding_model: row.embedding_model,
    embedding_status: row.embedding_status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_reinforced_at: row.last_reinforced_at,
    merged_into_id: row.merged_into_id,
    merge_reason: row.merge_reason,
    superseded_by_id: row.superseded_by_id,
    contradiction_status: row.contradiction_status,
    contradiction_detail: row.contradiction_detail_json,
    pipeline_version: row.pipeline_version,
  };
}

export async function GET(request: NextRequest) {
  const auth = await requireUser(request);
  if ("error" in auth) return auth.error;

  const userId = request.nextUrl.searchParams.get("user_id")?.trim();
  const activeOnly = request.nextUrl.searchParams.get("active_only") !== "false";
  const limit = Math.min(100, Math.max(1, Number(request.nextUrl.searchParams.get("limit") ?? 50)));
  if (!userId) return jsonError("user_id is required.", 422);

  const participantResult = await auth.client
    .from("participants")
    .select("id")
    .eq("code", userId)
    .limit(1)
    .maybeSingle();

  if (participantResult.error) return jsonError(participantResult.error.message, 502);
  if (!participantResult.data) return NextResponse.json({ memory_objects: [] });

  let query = auth.client
    .from("conversation_memory_objects")
    .select("id, source_message_ids_json, topic, summary, emotional_tone_json, importance_score, score_breakdown_json, recurrence_score, recurrence_count, confidence_score, extraction_mode, embedding_model, embedding_status, created_at, updated_at, last_reinforced_at, merged_into_id, merge_reason, superseded_by_id, contradiction_status, contradiction_detail_json, pipeline_version")
    .eq("participant_id", participantResult.data.id)
    .order("importance_score", { ascending: false })
    .limit(limit);

  if (activeOnly) {
    query = query.is("merged_into_id", null).is("superseded_by_id", null);
  }

  const result = await query;
  if (isMissingTable(result.error)) return NextResponse.json({ memory_objects: [] });
  if (result.error) return jsonError(result.error.message, 502);

  return NextResponse.json({ memory_objects: ((result.data ?? []) as MemoryObjectRow[]).map(toMemoryObject) });
}
