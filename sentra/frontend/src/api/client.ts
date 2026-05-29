import {
  AnomalyResult,
  DailyFeatureAggregation,
  Entry,
  EntrySubmissionResponse,
  ExplanationPayload,
  GraphSnapshot,
  GraphSnapshotResponse,
  JsonValue,
  RecordId,
} from "./models";
import { supabase } from "@/lib/supabase/client";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000/api";

type ParticipantRow = {
  id: string;
  code: string;
};

type EntryRow = {
  id: string;
  raw_text: string | null;
  is_masked: boolean;
  extraction_json: Record<string, JsonValue>;
  expires_at: string | null;
  created_at: string;
  participant_id: string;
  participants?: { code: string } | { code: string }[] | null;
};

type GraphSnapshotRow = {
  id: string;
  entry_id: string | null;
  day: string;
  nodes_json: JsonValue;
  relations_json: JsonValue;
  graph_summary_json: JsonValue;
  temporal_diff_json: JsonValue;
  created_at: string;
  participants?: { code: string } | { code: string }[] | null;
};

type InsightRow = {
  id: string;
  day: string;
  anomaly_score: number;
  z_scores_json: Record<string, number> | null;
  triggered_rules_json: JsonValue;
  baseline_deviation_json: Record<string, JsonValue> | null;
  changed_relations_json: JsonValue;
  protective_decline_json: Record<string, JsonValue> | null;
  uncertainty_json: Record<string, JsonValue> | null;
  evidence_summaries: JsonValue;
  graph_summary_json: JsonValue;
  score_breakdown_json: Record<string, JsonValue> | null;
  key_relations: JsonValue;
  created_at: string;
  participants?: { code: string } | { code: string }[] | null;
};

function asArray<T>(value: JsonValue | undefined, fallback: T[] = []): T[] {
  return Array.isArray(value) ? value as T[] : fallback;
}

function asRecord<T extends Record<string, unknown>>(value: JsonValue | null | undefined, fallback: T): T {
  return value && typeof value === "object" && !Array.isArray(value) ? value as T : fallback;
}

function participantCode(row: { participants?: { code: string } | { code: string }[] | null }, fallback: string): string {
  const participant = Array.isArray(row.participants) ? row.participants[0] : row.participants;
  return participant?.code ?? fallback;
}

function toEntry(row: EntryRow, userId: string): Entry {
  return {
    id: row.id,
    user_id: participantCode(row, userId),
    raw_text: row.raw_text ?? undefined,
    is_masked: row.is_masked,
    created_at: row.created_at,
    expires_at: row.expires_at ?? undefined,
  };
}

function toGraphSnapshot(row: GraphSnapshotRow, userId: string): GraphSnapshot {
  return {
    id: row.id,
    entry_id: row.entry_id ?? row.id,
    user_id: participantCode(row, userId),
    day: row.day,
    nodes_json: asArray(row.nodes_json),
    relations_json: asArray(row.relations_json),
    graph_summary_json: asRecord(row.graph_summary_json, {
      node_count: 0,
      relation_count: 0,
      event_count: 0,
      key_nodes: [],
      key_relations: [],
      summary: "",
    }),
    temporal_diff_json: asRecord(row.temporal_diff_json, {
      added_nodes: [],
      removed_nodes: [],
      added_relations: [],
      removed_relations: [],
      changed_relations: [],
      relation_shift_summary: "",
      protective_decline: {},
      uncertainty: {},
    }),
    created_at: row.created_at,
  };
}

function toAnomaly(row: InsightRow, userId: string): AnomalyResult {
  return {
    id: row.id,
    user_id: participantCode(row, userId),
    day: row.day,
    anomaly_score: row.anomaly_score,
    z_scores_json: row.z_scores_json ?? {},
    explanation_id: row.id,
  };
}

function toExplanation(row: InsightRow, userId: string): ExplanationPayload {
  return {
    id: row.id,
    user_id: participantCode(row, userId),
    day: row.day,
    triggered_rules_json: asArray(row.triggered_rules_json),
    baseline_deviation_json: row.baseline_deviation_json ?? {},
    changed_relations_json: asArray(row.changed_relations_json),
    protective_decline_json: row.protective_decline_json ?? {},
    uncertainty_json: row.uncertainty_json ?? {},
    evidence_summaries: asArray<string>(row.evidence_summaries),
    graph_summary_json: asRecord(row.graph_summary_json, {
      node_count: 0,
      relation_count: 0,
      event_count: 0,
      key_nodes: [],
      key_relations: [],
      summary: "",
    }),
    score_breakdown_json: row.score_breakdown_json ?? {},
    key_relations: asArray(row.key_relations),
    created_at: row.created_at,
  };
}

export class ApiClient {
  static async fetch<T>(path: string, options: RequestInit = {}): Promise<T> {
    const res = await fetch(`${API_BASE_URL}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options.headers,
      },
    });
    if (!res.ok) {
      throw new Error(`API Error: ${res.statusText}`);
    }
    return res.json();
  }

  private static async requireOwnerId(): Promise<string> {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) {
      throw new Error("Not authenticated");
    }
    return data.user.id;
  }

  private static async getParticipant(userId: string): Promise<ParticipantRow> {
    const ownerUserId = await this.requireOwnerId();
    const { data, error } = await supabase
      .from("participants")
      .select("id, code")
      .eq("owner_user_id", ownerUserId)
      .eq("code", userId)
      .single();

    if (error) throw error;
    return data;
  }

  static async getEntries(userId: string): Promise<Entry[]> {
    const participant = await this.getParticipant(userId);
    const { data, error } = await supabase
      .from("entries")
      .select("id, raw_text, is_masked, extraction_json, expires_at, created_at, participant_id, participants(code)")
      .eq("participant_id", participant.id)
      .order("created_at", { ascending: false });

    if (error) throw error;
    return (data ?? []).map((row) => toEntry(row as unknown as EntryRow, userId));
  }

  static async createEntry(userId: string, text: string): Promise<EntrySubmissionResponse> {
    const ownerUserId = await this.requireOwnerId();
    const participant = await this.getParticipant(userId);
    const computed = await this.fetch<EntrySubmissionResponse>(`/entries?user_id=${encodeURIComponent(userId)}`, {
      method: "POST",
      body: JSON.stringify({ text }),
    });

    const entryInsert = await supabase
      .from("entries")
      .insert({
        owner_user_id: ownerUserId,
        participant_id: participant.id,
        raw_text: null,
        is_masked: true,
        extraction_json: computed.extraction as unknown as Record<string, JsonValue>,
        expires_at: computed.entry.expires_at ?? null,
      })
      .select("id, raw_text, is_masked, extraction_json, expires_at, created_at, participant_id, participants(code)")
      .single();

    if (entryInsert.error) throw entryInsert.error;
    const entry = toEntry(entryInsert.data as unknown as EntryRow, userId);

    let graphSnapshot: GraphSnapshot | null = null;
    let graphSnapshotId: string | null = null;
    if (computed.graph_snapshot) {
      const graphInsert = await supabase
        .from("graph_snapshots")
        .insert({
          owner_user_id: ownerUserId,
          participant_id: participant.id,
          entry_id: entry.id,
          day: computed.graph_snapshot.day,
          nodes_json: computed.graph_snapshot.nodes_json as unknown as JsonValue,
          relations_json: computed.graph_snapshot.relations_json as unknown as JsonValue,
          graph_summary_json: computed.graph_snapshot.graph_summary_json as unknown as JsonValue,
          temporal_diff_json: computed.graph_snapshot.temporal_diff_json as unknown as JsonValue,
        })
        .select("id, entry_id, day, nodes_json, relations_json, graph_summary_json, temporal_diff_json, created_at, participants(code)")
        .single();

      if (graphInsert.error) throw graphInsert.error;
      graphSnapshotId = graphInsert.data.id;
      graphSnapshot = toGraphSnapshot(graphInsert.data as unknown as GraphSnapshotRow, userId);
    }

    let anomalyResult: AnomalyResult | null = null;
    let explanation: ExplanationPayload | null = null;
    if (computed.anomaly_result || computed.explanation) {
      const day = computed.anomaly_result?.day ?? computed.explanation?.day ?? new Date().toISOString().slice(0, 10);
      const insightInsert = await supabase
        .from("insights")
        .insert({
          owner_user_id: ownerUserId,
          participant_id: participant.id,
          entry_id: entry.id,
          graph_snapshot_id: graphSnapshotId,
          day,
          anomaly_score: computed.anomaly_result?.anomaly_score ?? 0,
          z_scores_json: computed.anomaly_result?.z_scores_json ?? {},
          triggered_rules_json: computed.explanation?.triggered_rules_json ?? [],
          baseline_deviation_json: computed.explanation?.baseline_deviation_json ?? {},
          changed_relations_json: computed.explanation?.changed_relations_json ?? [],
          protective_decline_json: computed.explanation?.protective_decline_json ?? {},
          uncertainty_json: computed.explanation?.uncertainty_json ?? {},
          evidence_summaries: computed.explanation?.evidence_summaries ?? [],
          graph_summary_json: computed.explanation?.graph_summary_json ?? graphSnapshot?.graph_summary_json ?? {},
          score_breakdown_json: computed.explanation?.score_breakdown_json ?? {},
          key_relations: computed.explanation?.key_relations ?? [],
        })
        .select("id, day, anomaly_score, z_scores_json, triggered_rules_json, baseline_deviation_json, changed_relations_json, protective_decline_json, uncertainty_json, evidence_summaries, graph_summary_json, score_breakdown_json, key_relations, created_at, participants(code)")
        .single();

      if (insightInsert.error) throw insightInsert.error;
      anomalyResult = toAnomaly(insightInsert.data as unknown as InsightRow, userId);
      explanation = toExplanation(insightInsert.data as unknown as InsightRow, userId);
    }

    return {
      entry,
      extraction: {
        ...computed.extraction,
        entry_id: entry.id,
      },
      graph_snapshot: graphSnapshot ?? computed.graph_snapshot,
      anomaly_result: anomalyResult,
      explanation,
    };
  }

  static async getTimeline(userId: string): Promise<AnomalyResult[]> {
    const participant = await this.getParticipant(userId);
    const { data, error } = await supabase
      .from("insights")
      .select("id, day, anomaly_score, z_scores_json, triggered_rules_json, baseline_deviation_json, changed_relations_json, protective_decline_json, uncertainty_json, evidence_summaries, graph_summary_json, score_breakdown_json, key_relations, created_at, participants(code)")
      .eq("participant_id", participant.id)
      .order("day", { ascending: true });

    if (error) throw error;
    return (data ?? []).map((row) => toAnomaly(row as unknown as InsightRow, userId));
  }

  static async getExplanation(explanationId: RecordId): Promise<ExplanationPayload> {
    const { data, error } = await supabase
      .from("insights")
      .select("id, day, anomaly_score, z_scores_json, triggered_rules_json, baseline_deviation_json, changed_relations_json, protective_decline_json, uncertainty_json, evidence_summaries, graph_summary_json, score_breakdown_json, key_relations, created_at, participants(code)")
      .eq("id", String(explanationId))
      .single();

    if (error) throw error;
    return toExplanation(data as unknown as InsightRow, participantCode(data, ""));
  }

  static getFeatures(): Promise<DailyFeatureAggregation[]> {
    return Promise.resolve([]);
  }

  static async getAnomaly(userId: string): Promise<AnomalyResult> {
    const participant = await this.getParticipant(userId);
    const { data, error } = await supabase
      .from("insights")
      .select("id, day, anomaly_score, z_scores_json, triggered_rules_json, baseline_deviation_json, changed_relations_json, protective_decline_json, uncertainty_json, evidence_summaries, graph_summary_json, score_breakdown_json, key_relations, created_at, participants(code)")
      .eq("participant_id", participant.id)
      .order("day", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (error) throw error;
    return toAnomaly(data as unknown as InsightRow, userId);
  }

  static async getGraphSnapshots(userId: string, limit = 12): Promise<GraphSnapshotResponse[]> {
    const participant = await this.getParticipant(userId);
    const { data, error } = await supabase
      .from("graph_snapshots")
      .select("id, entry_id, day, nodes_json, relations_json, graph_summary_json, temporal_diff_json, created_at, participants(code)")
      .eq("participant_id", participant.id)
      .order("day", { ascending: true })
      .order("created_at", { ascending: true })
      .limit(limit);

    if (error) throw error;
    return (data ?? []).map((row) => toGraphSnapshot(row as unknown as GraphSnapshotRow, userId));
  }
}
