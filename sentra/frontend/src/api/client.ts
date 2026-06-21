import {
  AnomalyResult,
  AudioTranscriptionResponse,
  ChatResponse,
  ConsentSnapshot,
  ConversationMemoryObject,
  ConversationRecallSummary,
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

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "/api";

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

type ConversationRecallSummaryRow = {
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

function toConversationRecall(row: ConversationRecallSummaryRow): ConversationRecallSummary {
  return {
    id: row.id,
    status: row.status,
    window_turn_count: row.window_turn_count,
    required_turn_count: 6,
    message_start: row.message_start,
    message_end: row.message_end,
    summary_json: row.summary_json as ConversationRecallSummary["summary_json"],
    source_message_hashes: asArray<string>(row.source_message_hashes_json),
    memory_object_ids: asArray<string | number>(row.memory_object_ids_json),
    pipeline_version: row.pipeline_version,
    created_at: row.created_at,
  };
}

export class ApiClient {
  static async fetch<T>(path: string, options: RequestInit = {}): Promise<T> {
    const { data } = await supabase.auth.getSession();
    const headers = new Headers(options.headers);
    if (!headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    if (data.session?.access_token && !headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${data.session.access_token}`);
    }
    const res = await fetch(`${API_BASE_URL}${path}`, {
      ...options,
      headers,
    });
    if (!res.ok) {
      throw new Error(`API Error: ${res.statusText}`);
    }
    return res.json();
  }

  static async transcribeAudio(file: File): Promise<AudioTranscriptionResponse> {
    const body = new FormData();
    body.append("file", file);
    const res = await fetch(`${API_BASE_URL}/audio/transcriptions`, {
      method: "POST",
      body,
    });
    if (!res.ok) {
      let detail = res.statusText;
      try {
        const payload = await res.json();
        detail = typeof payload.detail === "string" ? payload.detail : detail;
      } catch {
        // Keep status text if the response is not JSON.
      }
      throw new Error(`Audio transcription failed (${res.status}): ${detail}`);
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
  }): Promise<string | null> {
    const { ownerUserId, participantId, entryId, journalText, recallText, telemetry, consent } = params;
    if (!telemetry) return null;

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
        return null;
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
      return entrySessionId;
    } catch (err) {
      console.warn("[research] telemetry persistence skipped", err);
      return null;
    }
  }

  private static async persistResearchArtifacts(params: {
    ownerUserId: string;
    participantId: string;
    entryId: string;
    entrySessionId: string | null;
    computed: EntrySubmissionResponse;
  }): Promise<void> {
    const artifacts = params.computed.research_artifacts?.embedding_artifacts ?? [];
    const writingArtifacts = params.computed.research_artifacts?.writing_feature_artifacts ?? [];
    const cognitiveArtifact = params.computed.research_artifacts?.cognitive_probe_artifact ?? null;
    try {
      if (artifacts.length > 0) {
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
      }

      if (params.entrySessionId && writingArtifacts.length > 0) {
        const writingRows = writingArtifacts.map((artifact) => ({
          owner_user_id: params.ownerUserId,
          participant_id: params.participantId,
          entry_id: params.entryId,
          entry_session_id: params.entrySessionId,
          field_name: artifact.field_name,
          feature_json: artifact.feature_json as Record<string, JsonValue>,
          pipeline_version: artifact.pipeline_version,
        }));
        const { error } = await supabase.from("writing_features").insert(writingRows);
        if (error) console.warn("[research] writing_features insert skipped", error);
      }

      if (cognitiveArtifact) {
        const { error } = await supabase.from("cognitive_probe_features").insert({
          owner_user_id: params.ownerUserId,
          participant_id: params.participantId,
          entry_id: params.entryId,
          entry_session_id: params.entrySessionId,
          probe_name: cognitiveArtifact.probe_name,
          journal_text_hash: cognitiveArtifact.journal_text_hash,
          recall_text_hash: cognitiveArtifact.recall_text_hash,
          feature_json: cognitiveArtifact.feature_json as Record<string, JsonValue>,
          pipeline_version: cognitiveArtifact.pipeline_version,
        });
        if (error) console.warn("[research] cognitive_probe_features insert skipped", error);
      }
    } catch (err) {
      console.warn("[research] artifact persistence skipped", err);
    }
  }

  private static async persistResearchMetadata(params: {
    ownerUserId: string;
    participantId: string;
    entryId: string;
    graphSnapshotId: string | null;
    journalText: string;
    recallText: string;
    computed: EntrySubmissionResponse;
    consent?: ConsentSnapshot;
  }): Promise<void> {
    const { ownerUserId, participantId, entryId, graphSnapshotId, journalText, recallText, computed, consent } = params;
    const pipelineVersion = computed.research_artifacts?.pipeline_version ?? "research-pipeline-v1";
    const provider = computed.extraction.extraction_provider ?? "unknown";
    const model = computed.extraction.extraction_model ?? "unknown";

    try {
      const modelRunInsert = await supabase
        .from("model_runs")
        .insert({
          owner_user_id: ownerUserId,
          participant_id: participantId,
          artifact_type: "extraction",
          artifact_id: String(entryId),
          provider,
          model,
          prompt_version: "sentra-production-extraction-v1",
          schema_version: "sentra-entry-extraction-v1",
          pipeline_version: pipelineVersion,
          temperature: 0.2,
          retrieval_config_json: {
            embedding_model: computed.research_artifacts?.embedding_artifacts?.[0]?.embedding_model ?? "unknown",
            source: "next_api_route",
          },
          input_provenance_json: {
            entry_id: entryId,
            field_names: ["journal_entry", "first_recall_30"],
            journal_text_hash: await stableHash(journalText),
            recall_text_hash: await stableHash(recallText),
          },
          output_hash: await stableHash(JSON.stringify(computed.extraction)),
          status: computed.explanation?.uncertainty_json?.extraction_status === "completed" ? "completed" : "completed",
        })
        .select("id")
        .single();

      const modelRunId = modelRunInsert.data?.id ?? null;
      if (modelRunInsert.error) console.warn("[research] model_runs insert skipped", modelRunInsert.error);

      await supabase.from("extractions").insert({
        owner_user_id: ownerUserId,
        participant_id: participantId,
        entry_id: entryId,
        model_run_id: modelRunId,
        nodes_json: computed.extraction.nodes_json as unknown as JsonValue,
        relations_json: computed.extraction.relations_json as unknown as JsonValue,
        temporal_json: { summary: computed.extraction.temporal_summary },
        uncertainty_json: computed.explanation?.uncertainty_json ?? {},
        safety_flags: [],
      });

      if (computed.graph_snapshot) {
        const existingVersions = await supabase
          .from("graph_versions")
          .select("id", { count: "exact", head: true })
          .eq("owner_user_id", ownerUserId)
          .eq("participant_id", participantId);
        const versionIndex = (existingVersions.count ?? 0) + 1;
        const graphVersionInsert = await supabase
          .from("graph_versions")
          .insert({
            owner_user_id: ownerUserId,
            participant_id: participantId,
            entry_id: entryId,
            graph_snapshot_id: graphSnapshotId,
            version_index: versionIndex,
            nodes_json: computed.graph_snapshot.nodes_json as unknown as JsonValue,
            relations_json: computed.graph_snapshot.relations_json as unknown as JsonValue,
            summary_json: computed.graph_snapshot.graph_summary_json as unknown as JsonValue,
          })
          .select("id")
          .single();

        const graphVersionId = graphVersionInsert.data?.id;
        if (graphVersionInsert.error) console.warn("[research] graph_versions insert skipped", graphVersionInsert.error);
        if (graphVersionId) {
          const changeRows = [
            ...computed.graph_snapshot.nodes_json.slice(0, 24).map((node) => ({
              owner_user_id: ownerUserId,
              participant_id: participantId,
              graph_version_id: graphVersionId,
              change_type: "added",
              entity_type: "node",
              entity_key: node.id,
              previous_json: null,
              current_json: node as unknown as JsonValue,
              semantic_drift_score: 0,
              trajectory_tags: [node.category],
            })),
            ...computed.graph_snapshot.relations_json.slice(0, 24).map((relation) => ({
              owner_user_id: ownerUserId,
              participant_id: participantId,
              graph_version_id: graphVersionId,
              change_type: "added",
              entity_type: "relation",
              entity_key: `${relation.source_id}:${relation.type}:${relation.target_id}`,
              previous_json: null,
              current_json: relation as unknown as JsonValue,
              semantic_drift_score: 0,
              trajectory_tags: [relation.type],
            })),
          ];
          if (changeRows.length > 0) await supabase.from("graph_change_events").insert(changeRows);
        }
      }

      const day = computed.graph_snapshot?.day ?? computed.anomaly_result?.day ?? new Date().toISOString().slice(0, 10);
      const nodeCount = computed.graph_snapshot?.nodes_json.length ?? 0;
      const protectiveCount = computed.graph_snapshot?.nodes_json.filter((node) => node.category === "Protective").length ?? 0;
      const triggerCount = computed.graph_snapshot?.nodes_json.filter((node) => node.category === "Trigger").length ?? 0;
      const relationCount = computed.graph_snapshot?.relations_json.length ?? 0;
      const windowRows = [7, 30].map((windowDays) => {
        const end = new Date(`${day}T00:00:00.000Z`);
        const start = new Date(end);
        start.setUTCDate(start.getUTCDate() - windowDays + 1);
        return {
          owner_user_id: ownerUserId,
          participant_id: participantId,
          window_days: windowDays,
          window_start: start.toISOString().slice(0, 10),
          window_end: day,
          pipeline_version: "longitudinal-v1",
          feature_json: {
            latest_anomaly_score: computed.anomaly_result?.anomaly_score ?? null,
            node_count: nodeCount,
            relation_count: relationCount,
            protective_count: protectiveCount,
            trigger_count: triggerCount,
            protective_ratio: nodeCount ? protectiveCount / nodeCount : 0,
            trigger_ratio: nodeCount ? triggerCount / nodeCount : 0,
            consistency_proxy: relationCount ? nodeCount / relationCount : nodeCount,
            change_rate_proxy: computed.graph_snapshot?.temporal_diff_json?.added_nodes?.length ?? nodeCount,
          },
        };
      });
      await supabase.from("longitudinal_features").insert(windowRows);

      if (consent?.research_analysis ?? true) {
        await supabase.from("eval_examples").insert({
          owner_user_id: ownerUserId,
          participant_id: participantId,
          source_entry_id: entryId,
          task_type: "entry_extraction",
          input_json: {
            journal_text_hash: await stableHash(journalText),
            recall_text_hash: await stableHash(recallText),
            field_names: ["journal_entry", "first_recall_30"],
            journal_char_count: journalText.length,
            recall_char_count: recallText.length,
          },
          expected_output_json: {
            nodes_json: computed.extraction.nodes_json,
            relations_json: computed.extraction.relations_json,
            graph_summary_json: computed.graph_snapshot?.graph_summary_json ?? {},
          },
          consent_snapshot_json: consent ?? {},
          review_status: "unreviewed",
        });
      }
    } catch (err) {
      console.warn("[research] metadata persistence skipped", err);
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
    console.info("[entries] supabase insert completed", { id: entryInsert.data.id, observationType });
    const entry = toEntry(entryInsert.data as unknown as EntryRow, userId);
    const entrySessionId = await this.persistResearchTelemetry({
      ownerUserId,
      participantId: participant.id,
      entryId: entry.id as string,
      journalText: researchPayload?.journal_text ?? text,
      recallText: researchPayload?.recall_text ?? "",
      telemetry: researchPayload?.telemetry,
      consent: researchPayload?.consent,
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

    await this.persistResearchArtifacts({
      ownerUserId,
      participantId: participant.id,
      entryId: entry.id as string,
      entrySessionId,
      computed,
    });
    await this.persistResearchMetadata({
      ownerUserId,
      participantId: participant.id,
      entryId: entry.id as string,
      graphSnapshotId,
      journalText: researchPayload?.journal_text ?? text,
      recallText: researchPayload?.recall_text ?? "",
      computed,
      consent: researchPayload?.consent,
    });

    return {
      entry,
      extraction: {
        ...computed.extraction,
        entry_id: entry.id,
      },
      graph_snapshot: graphSnapshot ?? computed.graph_snapshot,
      anomaly_result: anomalyResult,
      explanation,
      research_artifacts: computed.research_artifacts,
    };
  }

  static async createChat(userId: string, message: string, limit = 5): Promise<ChatResponse> {
    const ownerUserId = await this.requireOwnerId();
    const participant = await this.getParticipant(userId);
    const response = await this.fetch<ChatResponse>("/chat", {
      method: "POST",
      body: JSON.stringify({ user_id: userId, participant_code: userId, message, limit }),
    });

    try {
      const chatSession = await supabase
        .from("chat_sessions")
        .insert({
          owner_user_id: ownerUserId,
          participant_id: participant.id,
          consent_snapshot_json: { app_use: true, research_analysis: true, source: "student_ui" },
        })
        .select("id")
        .single();

      if (chatSession.error || !chatSession.data) {
        console.warn("[chat] Supabase session mirror skipped", chatSession.error);
        return response;
      }

      const userHash = await stableHash(message);
      const assistantHash = await stableHash(response.answer);
      const { error } = await supabase.from("chat_messages").insert([
        {
          owner_user_id: ownerUserId,
          participant_id: participant.id,
          chat_session_id: chatSession.data.id,
          role: "user",
          content_hash: userHash,
          content_redacted: message.slice(0, 500),
          evidence_refs_json: [],
        },
        {
          owner_user_id: ownerUserId,
          participant_id: participant.id,
          chat_session_id: chatSession.data.id,
          role: "assistant",
          content_hash: assistantHash,
          content_redacted: response.answer.slice(0, 1000),
          evidence_refs_json: response.evidence_refs as unknown as JsonValue,
        },
      ]);
      if (error) console.warn("[chat] Supabase message mirror skipped", error);
    } catch (err) {
      console.warn("[chat] Supabase mirror failed", err);
    }

    const recall = response.conversation_recall_30;
    if (recall) {
      try {
        const { error } = await supabase.from("conversation_recall_summaries").insert({
          owner_user_id: ownerUserId,
          participant_id: participant.id,
          window_turn_count: recall.window_turn_count,
          message_start: recall.message_start ?? null,
          message_end: recall.message_end ?? null,
          summary_json: recall.summary_json as Record<string, JsonValue>,
          source_message_hashes_json: recall.source_message_hashes ?? [],
          memory_object_ids_json: recall.memory_object_ids ?? [],
          pipeline_version: recall.pipeline_version,
          status: recall.status,
        });
        if (error) console.info("[conversation_recall_30] Supabase mirror skipped", error);
      } catch (err) {
        console.info("[conversation_recall_30] Supabase mirror failed", err);
      }

      // Mirror the discrete memory objects too (best-effort, non-blocking). Note:
      // merged_into_id/superseded_by_id/window_id reference the backend's own
      // integer ids and aren't remapped here, same as chat_session_id above --
      // the canonical merge/contradiction lineage lives in the backend DB; this
      // mirror is for Supabase-side realtime/RLS reads of the surface fields.
      if (recall.memory_objects?.length) {
        try {
          const rows = recall.memory_objects.map((memoryObject) => ({
            owner_user_id: ownerUserId,
            participant_id: participant.id,
            source_message_ids_json: memoryObject.source_message_ids as unknown as JsonValue,
            topic: memoryObject.topic,
            summary: memoryObject.summary,
            emotional_tone_json: memoryObject.emotional_tone as unknown as Record<string, JsonValue>,
            importance_score: memoryObject.importance_score,
            score_breakdown_json: memoryObject.score_breakdown,
            recurrence_score: memoryObject.recurrence_score,
            recurrence_count: memoryObject.recurrence_count,
            confidence_score: memoryObject.confidence_score,
            extraction_mode: memoryObject.extraction_mode,
            embedding_model: memoryObject.embedding_model,
            embedding_status: memoryObject.embedding_status,
            contradiction_status: memoryObject.contradiction_status,
            contradiction_detail_json: memoryObject.contradiction_detail ?? {},
            pipeline_version: memoryObject.pipeline_version,
          }));
          const { error } = await supabase.from("conversation_memory_objects").insert(rows);
          if (error) console.info("[conversation_memory_objects] Supabase mirror skipped", error);
        } catch (err) {
          console.info("[conversation_memory_objects] Supabase mirror failed", err);
        }
      }
    }

    return response;
  }

  static async getConversationRecall(userId: string, refresh = false): Promise<ConversationRecallSummary> {
    return this.fetch<ConversationRecallSummary>(
      `/research/conversation-recall?user_id=${encodeURIComponent(userId)}&refresh=${refresh ? "true" : "false"}`,
    );
  }

  static async getConversationMemoryObjects(userId: string, activeOnly = true): Promise<ConversationMemoryObject[]> {
    const response = await this.fetch<{ memory_objects: ConversationMemoryObject[] }>(
      `/research/conversation-recall/memory-objects?user_id=${encodeURIComponent(userId)}&active_only=${activeOnly ? "true" : "false"}`,
    );
    return response.memory_objects;
  }

  static async getMirroredConversationRecall(userId: string): Promise<ConversationRecallSummary | null> {
    const participant = await this.getParticipant(userId);
    const { data, error } = await supabase
      .from("conversation_recall_summaries")
      .select("id, window_turn_count, message_start, message_end, summary_json, source_message_hashes_json, memory_object_ids_json, pipeline_version, status, created_at")
      .eq("participant_id", participant.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throwSupabaseError("Load conversation recall failed", error);
    return data ? toConversationRecall(data as unknown as ConversationRecallSummaryRow) : null;
  }

  static async getConversationRecallWithFallback(userId: string, refresh = false): Promise<ConversationRecallSummary> {
    try {
      const mirrored = await this.getMirroredConversationRecall(userId);
      if (mirrored && !refresh) {
        console.info("[conversation_recall_30] source=supabase_mirror", {
          status: mirrored.status,
          turns: mirrored.window_turn_count,
        });
        return mirrored;
      }
    } catch (err) {
      console.info("[conversation_recall_30] Supabase mirror unavailable; using backend", err);
    }
    const backend = await this.getConversationRecall(userId, refresh);
    console.info("[conversation_recall_30] source=backend", {
      status: backend.status,
      turns: backend.window_turn_count,
    });
    return backend;
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
