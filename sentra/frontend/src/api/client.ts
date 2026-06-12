import {
  AnomalyResult,
  ConsentSnapshot,
  DailyFeatureAggregation,
  Entry,
  EntryTelemetryPayload,
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
  observation_type?: string;
  extraction_provider?: string;
  extraction_model?: string;
};

type GraphSnapshotRow = {
  id: string;
  entry_id: string | null;
  day: string;
  nodes_json: JsonValue;
  relations_json: JsonValue;
  graph_summary_json: JsonValue;
  temporal_diff_json: JsonValue;
  extraction_provider?: string;
  extraction_model?: string;
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
  extraction_provider?: string;
  extraction_model?: string;
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

function throwSupabaseError(context: string, error: unknown): never {
  if (error instanceof Error) {
    throw new Error(`${context}: ${error.message}`);
  }
  if (error && typeof error === "object") {
    const details = error as { message?: unknown; details?: unknown; hint?: unknown; code?: unknown };
    const parts = [details.message, details.details, details.hint, details.code].filter(Boolean).map(String);
    throw new Error(`${context}: ${parts.join(" | ") || JSON.stringify(error)}`);
  }
  throw new Error(`${context}: ${String(error)}`);
}

async function stableHash(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toEntry(row: EntryRow, userId: string): Entry {
  return {
    id: row.id,
    user_id: participantCode(row, userId),
    raw_text: row.raw_text ?? undefined,
    is_masked: row.is_masked,
    created_at: row.created_at,
    expires_at: row.expires_at ?? undefined,
    observation_type: row.observation_type,
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
    extraction_provider: row.extraction_provider ?? "unknown",
    extraction_model: row.extraction_model ?? "unknown",
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

    if (error) throwSupabaseError("Load participant failed", error);
    return data;
  }

  private static async persistResearchTelemetry(params: {
    ownerUserId: string;
    participantId: string;
    entryId: string;
    journalText: string;
    recallText: string;
    telemetry?: EntryTelemetryPayload;
    consent?: ConsentSnapshot;
  }): Promise<void> {
    const { ownerUserId, participantId, entryId, journalText, recallText, telemetry, consent } = params;
    if (!telemetry) return;

    try {
      const consentSnapshot = consent ?? {
        app_use: true,
        research_analysis: true,
        anonymized_export: false,
        future_fine_tuning: false,
        consent_version: "research-consent-v1",
      };

      await supabase.from("consent_records").insert({
        owner_user_id: ownerUserId,
        participant_id: participantId,
        app_use: consentSnapshot.app_use,
        research_analysis: consentSnapshot.research_analysis,
        anonymized_export: consentSnapshot.anonymized_export,
        future_fine_tuning: consentSnapshot.future_fine_tuning,
        consent_version: consentSnapshot.consent_version,
        source: "student_ui",
      });

      const sessionInsert = await supabase
        .from("entry_sessions")
        .insert({
          owner_user_id: ownerUserId,
          participant_id: participantId,
          client_session_id: telemetry.session_id,
          status: "submitted",
          started_at: telemetry.started_at,
          submitted_at: telemetry.submitted_at,
          client_timezone: telemetry.client_timezone ?? null,
          user_agent: telemetry.user_agent ?? null,
          consent_snapshot_json: consentSnapshot as unknown as Record<string, JsonValue>,
          aggregate_metrics_json: telemetry.aggregate_metrics,
        })
        .select("id")
        .single();

      if (sessionInsert.error || !sessionInsert.data) {
        console.warn("[research] entry_sessions insert skipped", sessionInsert.error);
        return;
      }

      const entrySessionId = sessionInsert.data.id;
      const fieldRows = await Promise.all([
        {
          field_name: "journal_entry",
          final_text_hash: await stableHash(journalText),
          char_count: journalText.length,
          word_count: journalText.trim() ? journalText.trim().split(/\s+/).length : 0,
          metrics_json: telemetry.field_metrics.journal_entry ?? {},
        },
        {
          field_name: "first_recall_30",
          final_text_hash: await stableHash(recallText),
          char_count: recallText.length,
          word_count: recallText.trim() ? recallText.trim().split(/\s+/).length : 0,
          metrics_json: telemetry.field_metrics.first_recall_30 ?? {},
        },
      ].map(async (row) => ({
        owner_user_id: ownerUserId,
        participant_id: participantId,
        entry_session_id: entrySessionId,
        ...row,
        started_at: typeof row.metrics_json.first_input_at === "string" ? row.metrics_json.first_input_at : null,
        completed_at: typeof row.metrics_json.last_input_at === "string" ? row.metrics_json.last_input_at : null,
      })));

      await supabase.from("entry_fields").insert(fieldRows);

      const eventRows = telemetry.events.slice(0, 1200).map((event) => ({
        owner_user_id: ownerUserId,
        participant_id: participantId,
        entry_session_id: entrySessionId,
        field_name: event.field_name,
        event_type: event.event_type,
        occurred_at: event.occurred_at,
        relative_ms: event.relative_ms,
        value_length: event.value_length ?? null,
        selection_start: event.selection_start ?? null,
        selection_end: event.selection_end ?? null,
        metadata_json: event.metadata ?? {},
      }));
      if (eventRows.length > 0) await supabase.from("interaction_events").insert(eventRows);

      await supabase.from("entry_research_links").insert({
        owner_user_id: ownerUserId,
        participant_id: participantId,
        entry_id: entryId,
        entry_session_id: entrySessionId,
        field_name: "combined_submission",
        source_hash: await stableHash(`${journalText}\n\n${recallText}`),
      });
    } catch (err) {
      console.warn("[research] telemetry persistence skipped", err);
    }
  }

  private static async persistResearchArtifacts(params: {
    ownerUserId: string;
    participantId: string;
    entryId: string;
    computed: EntrySubmissionResponse;
  }): Promise<void> {
    const artifacts = params.computed.research_artifacts?.embedding_artifacts ?? [];
    if (artifacts.length === 0) return;
    try {
      const rows = artifacts.map((artifact) => ({
        owner_user_id: params.ownerUserId,
        participant_id: params.participantId,
        entry_id: params.entryId,
        content_kind: artifact.content_kind,
        embedding_model: artifact.embedding_model,
        embedding: artifact.vector_json && artifact.vector_json.length > 0 ? `[${artifact.vector_json.join(",")}]` : null,
        content_hash: artifact.content_hash,
        metadata_json: {
          ...(artifact.metadata_json ?? {}),
          backend_local_id: artifact.local_id ?? null,
          synced_from_backend_response: true,
          pipeline_version: params.computed.research_artifacts?.pipeline_version ?? "research-pipeline-v1",
        },
      }));
      const { error } = await supabase.from("entry_embeddings").insert(rows);
      if (error) console.warn("[research] entry_embeddings insert skipped", error);
    } catch (err) {
      console.warn("[research] artifact persistence skipped", err);
    }
  }

  static async getEntries(userId: string): Promise<Entry[]> {
    const participant = await this.getParticipant(userId);
    const { data, error } = await supabase
      .from("entries")
      .select("id, raw_text, is_masked, extraction_json, expires_at, created_at, participant_id, observation_type, extraction_provider, extraction_model, participants!entries_participant_id_fkey(code)")
      .eq("participant_id", participant.id)
      .order("created_at", { ascending: false });

    if (error) throwSupabaseError("Load entries failed", error);
    return (data ?? []).map((row) => toEntry(row as unknown as EntryRow, userId));
  }

  static async createEntry(
    userId: string,
    text: string,
    observationType: string = "daily",
    researchPayload?: {
      journal_text?: string;
      recall_text?: string;
      telemetry?: EntryTelemetryPayload;
      consent?: ConsentSnapshot;
    },
  ): Promise<EntrySubmissionResponse> {
    const ownerUserId = await this.requireOwnerId();
    const participant = await this.getParticipant(userId);
    const computed = await this.fetch<EntrySubmissionResponse>(`/entries?user_id=${encodeURIComponent(userId)}&observation_type=${encodeURIComponent(observationType)}`, {
      method: "POST",
      body: JSON.stringify({
        text,
        journal_text: researchPayload?.journal_text ?? text,
        recall_text: researchPayload?.recall_text ?? "",
        telemetry: researchPayload?.telemetry,
        consent: researchPayload?.consent,
      }),
    });

    const entryInsert = await supabase
      .from("entries")
      .insert({
        owner_user_id: ownerUserId,
        participant_id: participant.id,
        raw_text: null,
        is_masked: true,
        extraction_json: computed.extraction as unknown as Record<string, JsonValue>,
        extraction_provider: computed.extraction.extraction_provider,
        extraction_model: computed.extraction.extraction_model,
        expires_at: computed.entry.expires_at ?? null,
        observation_type: observationType,
      })
      .select("id, raw_text, is_masked, extraction_json, expires_at, created_at, participant_id, observation_type, extraction_provider, extraction_model, participants!entries_participant_id_fkey(code)")
      .single();

    if (entryInsert.error) throwSupabaseError("Save entry failed", entryInsert.error);
    const entry = toEntry(entryInsert.data as unknown as EntryRow, userId);
    await this.persistResearchTelemetry({
      ownerUserId,
      participantId: participant.id,
      entryId: entry.id as string,
      journalText: researchPayload?.journal_text ?? text,
      recallText: researchPayload?.recall_text ?? "",
      telemetry: researchPayload?.telemetry,
      consent: researchPayload?.consent,
    });
    await this.persistResearchArtifacts({
      ownerUserId,
      participantId: participant.id,
      entryId: entry.id as string,
      computed,
    });

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
          extraction_provider: computed.extraction.extraction_provider,
          extraction_model: computed.extraction.extraction_model,
        })
        .select("id, entry_id, day, nodes_json, relations_json, graph_summary_json, temporal_diff_json, extraction_provider, extraction_model, created_at, participants!graph_snapshots_participant_id_fkey(code)")
        .single();

      if (graphInsert.error) throwSupabaseError("Save graph snapshot failed", graphInsert.error);
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
          extraction_provider: computed.extraction.extraction_provider,
          extraction_model: computed.extraction.extraction_model,
        })
        .select("id, day, anomaly_score, z_scores_json, triggered_rules_json, baseline_deviation_json, changed_relations_json, protective_decline_json, uncertainty_json, evidence_summaries, graph_summary_json, score_breakdown_json, key_relations, extraction_provider, extraction_model, created_at, participants!insights_participant_id_fkey(code)")
        .single();

      if (insightInsert.error) throwSupabaseError("Save insight failed", insightInsert.error);
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
      .select("id, day, anomaly_score, z_scores_json, triggered_rules_json, baseline_deviation_json, changed_relations_json, protective_decline_json, uncertainty_json, evidence_summaries, graph_summary_json, score_breakdown_json, key_relations, extraction_provider, extraction_model, created_at, participants!insights_participant_id_fkey(code)")
      .eq("participant_id", participant.id)
      .order("day", { ascending: true });

    if (error) throwSupabaseError("Load timeline failed", error);
    return (data ?? []).map((row) => toAnomaly(row as unknown as InsightRow, userId));
  }

  static async getExplanation(explanationId: RecordId): Promise<ExplanationPayload> {
    const { data, error } = await supabase
      .from("insights")
      .select("id, day, anomaly_score, z_scores_json, triggered_rules_json, baseline_deviation_json, changed_relations_json, protective_decline_json, uncertainty_json, evidence_summaries, graph_summary_json, score_breakdown_json, key_relations, extraction_provider, extraction_model, created_at, participants!insights_participant_id_fkey(code)")
      .eq("id", String(explanationId))
      .single();

    if (error) throwSupabaseError("Load explanation failed", error);
    return toExplanation(data as unknown as InsightRow, participantCode(data, ""));
  }

  static getFeatures(): Promise<DailyFeatureAggregation[]> {
    return Promise.resolve([]);
  }

  static async getAnomaly(userId: string): Promise<AnomalyResult> {
    const participant = await this.getParticipant(userId);
    const { data, error } = await supabase
      .from("insights")
      .select("id, day, anomaly_score, z_scores_json, triggered_rules_json, baseline_deviation_json, changed_relations_json, protective_decline_json, uncertainty_json, evidence_summaries, graph_summary_json, score_breakdown_json, key_relations, extraction_provider, extraction_model, created_at, participants!insights_participant_id_fkey(code)")
      .eq("participant_id", participant.id)
      .order("day", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (error) throwSupabaseError("Load anomaly failed", error);
    return toAnomaly(data as unknown as InsightRow, userId);
  }

  static async getGraphSnapshots(userId: string, limit = 12): Promise<GraphSnapshotResponse[]> {
    const participant = await this.getParticipant(userId);
    const { data, error } = await supabase
      .from("graph_snapshots")
      .select("id, entry_id, day, nodes_json, relations_json, graph_summary_json, temporal_diff_json, extraction_provider, extraction_model, created_at, participants!graph_snapshots_participant_id_fkey(code)")
      .eq("participant_id", participant.id)
      .order("day", { ascending: true })
      .order("created_at", { ascending: true })
      .limit(limit);

    if (error) throwSupabaseError("Load graph snapshots failed", error);
    return (data ?? []).map((row) => toGraphSnapshot(row as unknown as GraphSnapshotRow, userId));
  }
}
