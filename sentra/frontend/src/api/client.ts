import {
  AnomalyResult,
  AudioTranscriptionResponse,
  ChatResponse,
  CounselorSupportSummary,
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
  CohortAlert,
  EducatorStudentStatus,
  OrgCounselor,
  OversightRequest,
  ReflectionAuditTrail,
  SharedSupportSummary,
  StudentAccessRecord,
} from "./models";
import { supabase } from "@/lib/supabase/client";
import { generateCounselorSummary, type CounselorTimelineEvent } from "@/lib/counselor-summary";
import { buildAuditTrails, type ModelRunRecord } from "@/lib/audit-trail";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "/api";
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;

function shouldAttachAuthorizationHeader() {
  if (typeof window === "undefined") return true;
  if (API_BASE_URL.startsWith("/")) return false;
  try {
    return new URL(API_BASE_URL, window.location.origin).origin !== window.location.origin;
  } catch {
    return true;
  }
}

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

type SummaryEntryRow = Pick<EntryRow, "id" | "created_at" | "extraction_json">;

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

function summaryEvent(row: SummaryEntryRow): CounselorTimelineEvent {
  const extraction = asRecord(row.extraction_json, {} as Record<string, JsonValue>);
  const emotional = asRecord(extraction.emotional_state_json, {} as Record<string, JsonValue>);
  const assessment = asRecord(extraction.safety_assessment_json, {} as Record<string, JsonValue>);
  const nodes = asArray<Record<string, JsonValue>>(extraction.nodes_json);
  const labels = (values: JsonValue | undefined) => asArray<Record<string, JsonValue>>(values).map((item) => String(item.label ?? "")).filter(Boolean);
  const nodeLabels = (category: string) => nodes.filter((node) => node.category === category).map((node) => String(node.label ?? "")).filter(Boolean);
  const unique = (values: string[]) => [...new Set(values)];
  const primaryEmotion = asArray<Record<string, JsonValue>>(emotional.primary_emotions)[0]?.label ?? nodes.find((node) => node.category === "State")?.label;
  const safetyClassification = asRecord(emotional.safety_classification, {} as Record<string, JsonValue>);
  return {
    event_id: String(row.id),
    timestamp: row.created_at,
    primary_emotion: primaryEmotion ? String(primaryEmotion) : undefined,
    intensity: typeof emotional.intensity === "number" ? emotional.intensity : undefined,
    triggers: unique([...labels(emotional.trigger_candidates), ...nodeLabels("Trigger")]),
    support_needs: unique(labels(emotional.support_needs)),
    protective_factors: unique([...labels(emotional.protective_factors), ...nodeLabels("Protective")]),
    safety_level: String(assessment.risk_level ?? safetyClassification.level ?? "none"),
    safety_reasons: asArray<string>(assessment.reasons, asArray<string>(extraction.safety_flags_json, asArray<string>(safetyClassification.flags))),
  };
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

async function responseError(prefix: string, res: Response): Promise<Error> {
  let detail = res.statusText || `HTTP ${res.status}`;
  try {
    const payload = await res.json();
    if (typeof payload.detail === "string") detail = payload.detail;
    else if (typeof payload.error === "string") detail = payload.error;
  } catch {
    // Keep status text when the body is not JSON.
  }
  return new Error(`${prefix} (${res.status}): ${detail}`);
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
    const headers = new Headers(options.headers);
    if (!headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    if (shouldAttachAuthorizationHeader() && !headers.has("Authorization")) {
      const { data } = await supabase.auth.getSession();
      if (data.session?.access_token) {
        headers.set("Authorization", `Bearer ${data.session.access_token}`);
      }
    }
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), DEFAULT_REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${API_BASE_URL}${path}`, {
        ...options,
        headers,
        signal: options.signal ?? controller.signal,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new Error(`API request timed out after ${DEFAULT_REQUEST_TIMEOUT_MS / 1000}s: ${path}`);
      }
      throw err;
    } finally {
      window.clearTimeout(timeout);
    }
    if (!res.ok) {
      throw await responseError("API Error", res);
    }
    return res.json();
  }

  static async transcribeAudio(file: File): Promise<AudioTranscriptionResponse> {
    const body = new FormData();
    const headers = new Headers();
    if (shouldAttachAuthorizationHeader()) {
      const { data } = await supabase.auth.getSession();
      if (data.session?.access_token) headers.set("Authorization", `Bearer ${data.session.access_token}`);
    }
    body.append("file", file);
    const res = await fetch(`${API_BASE_URL}/audio/transcriptions`, {
      method: "POST",
      headers,
      body,
    });
    if (!res.ok) {
      throw await responseError("Audio transcription failed", res);
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

      const safetyAssessment = computed.extraction.safety_assessment_json;
      if (safetyAssessment) {
        const { error: safetyAuditError } = await supabase.from("model_runs").insert({
          owner_user_id: ownerUserId,
          participant_id: participantId,
          artifact_type: "safety_assessment",
          artifact_id: String(entryId),
          provider: "rules",
          model: "safety-assessment-v1",
          prompt_version: "safety-assessment-v1",
          schema_version: "safety-assessment-v1",
          pipeline_version: pipelineVersion,
          temperature: 0,
          retrieval_config_json: {
            risk_level: safetyAssessment.risk_level,
            escalation_required: safetyAssessment.escalation_required,
            reasons: safetyAssessment.reasons,
            policy_refs: safetyAssessment.policy_refs,
          },
          input_provenance_json: { entry_id: entryId },
          output_hash: await stableHash(JSON.stringify(safetyAssessment)),
          status: "completed",
        });
        if (safetyAuditError) console.warn("[research] safety model_runs insert skipped", safetyAuditError);
      }

      await supabase.from("extractions").insert({
        owner_user_id: ownerUserId,
        participant_id: participantId,
        entry_id: entryId,
        model_run_id: modelRunId,
        nodes_json: computed.extraction.nodes_json as unknown as JsonValue,
        relations_json: computed.extraction.relations_json as unknown as JsonValue,
        temporal_json: { summary: computed.extraction.temporal_summary },
        uncertainty_json: computed.explanation?.uncertainty_json ?? {},
        safety_flags: computed.extraction.safety_flags_json ?? [],
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

  static async createChat(userId: string, message: string, limit = 5, options: { mode?: "general" | "recall_workspace"; conversationContext?: string[] } = {}): Promise<ChatResponse> {
    const ownerUserId = await this.requireOwnerId();
    const participant = await this.getParticipant(userId);
    const response = await this.fetch<ChatResponse>("/chat", {
      method: "POST",
      body: JSON.stringify({
        user_id: userId,
        participant_code: userId,
        message,
        limit,
        mode: options.mode ?? "general",
        conversation_context: options.conversationContext ?? [],
      }),
    });
    if (response.mirrored) return response;

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

  static async generateCounselorSummary(userId: string, limit = 10): Promise<CounselorSupportSummary> {
    const ownerUserId = await this.requireOwnerId();
    const participant = await this.getParticipant(userId);
    const { data, error } = await supabase
      .from("entries")
      .select("id, extraction_json, created_at")
      .eq("owner_user_id", ownerUserId)
      .eq("participant_id", participant.id)
      .order("created_at", { ascending: false })
      .limit(Math.max(1, Math.min(limit, 30)));
    if (error) throwSupabaseError("Generate support summary failed", error);

    const summary = generateCounselorSummary((data ?? []).map((row) => summaryEvent(row as SummaryEntryRow)));
    const { error: auditError } = await supabase.from("model_runs").insert({
      owner_user_id: ownerUserId,
      participant_id: participant.id,
      artifact_type: "counselor_summary",
      artifact_id: summary.summary_id,
      provider: "rules",
      model: "counselor-summary-v1",
      prompt_version: "counselor-summary-v1",
      schema_version: "counselor-summary-v1",
      pipeline_version: "counselor-summary-v1",
      temperature: 0,
      retrieval_config_json: { source: "entries.extraction_json", event_ids: summary.sections.flatMap((section) => section.evidence_event_ids) },
      input_provenance_json: { reflection_count: summary.reflection_count, date_range: summary.date_range },
      output_hash: await stableHash(JSON.stringify(summary)),
      status: "completed",
    });
    if (auditError) console.warn("[support-summary] audit insert skipped", auditError);
    return summary;
  }

  static async listOversightRequests(userId: string): Promise<OversightRequest[]> {
    const participant = await this.getParticipant(userId);

    const [rosterResult, consentResult] = await Promise.all([
      supabase
        .from("oversight_roster")
        .select("id, org_id, status, created_at, organizations(name)")
        .eq("participant_id", participant.id)
        .order("created_at", { ascending: false }),
      supabase
        .from("oversight_consents")
        .select("org_id, status, granted_at, revoked_at")
        .eq("participant_id", participant.id)
        .is("educator_user_id", null),
    ]);
    if (rosterResult.error) throwSupabaseError("Load oversight requests failed", rosterResult.error);
    if (consentResult.error) throwSupabaseError("Load oversight consents failed", consentResult.error);

    type RosterRow = { id: string; org_id: string; status: string; organizations?: { name: string } | { name: string }[] | null };
    type ConsentRow = { org_id: string; status: string; granted_at: string | null; revoked_at: string | null };
    const consentByOrg = new Map<string, ConsentRow>();
    for (const consent of (consentResult.data ?? []) as ConsentRow[]) {
      consentByOrg.set(consent.org_id, consent);
    }

    // One card per organization; any active roster link outranks revoked ones.
    const byOrg = new Map<string, OversightRequest>();
    for (const row of (rosterResult.data ?? []) as RosterRow[]) {
      const org = Array.isArray(row.organizations) ? row.organizations[0] : row.organizations;
      const consent = consentByOrg.get(row.org_id) ?? null;
      const existing = byOrg.get(row.org_id);
      const candidate: OversightRequest = {
        roster_id: row.id,
        org_id: row.org_id,
        org_name: org?.name ?? "Unknown organization",
        roster_status: row.status,
        consent_status: (consent?.status as OversightRequest["consent_status"]) ?? null,
        granted_at: consent?.granted_at ?? null,
        revoked_at: consent?.revoked_at ?? null,
      };
      if (!existing || (existing.roster_status !== "active" && row.status === "active")) {
        byOrg.set(row.org_id, candidate);
      }
    }
    return [...byOrg.values()];
  }

  static async grantOversightConsent(userId: string, orgId: string): Promise<void> {
    const ownerUserId = await this.requireOwnerId();
    const participant = await this.getParticipant(userId);
    const existing = await supabase
      .from("oversight_consents")
      .select("id")
      .eq("participant_id", participant.id)
      .eq("org_id", orgId)
      .is("educator_user_id", null)
      .maybeSingle();
    if (existing.error) throwSupabaseError("Load consent failed", existing.error);

    if (existing.data) {
      const { error } = await supabase
        .from("oversight_consents")
        .update({ status: "active" })
        .eq("id", existing.data.id);
      if (error) throwSupabaseError("Grant consent failed", error);
      return;
    }
    const { error } = await supabase.from("oversight_consents").insert({
      participant_id: participant.id,
      owner_user_id: ownerUserId,
      org_id: orgId,
    });
    if (error) throwSupabaseError("Grant consent failed", error);
  }

  static async revokeOversightConsent(userId: string, orgId: string): Promise<void> {
    const participant = await this.getParticipant(userId);
    const { error } = await supabase
      .from("oversight_consents")
      .update({ status: "revoked" })
      .eq("participant_id", participant.id)
      .eq("org_id", orgId)
      .is("educator_user_id", null);
    if (error) throwSupabaseError("Revoke consent failed", error);
  }

  // ------------------------------------------------------------------
  // Educator oversight reads (issues #29/#30/#31). All queries below run
  // through the educator RLS policies: only actively rostered AND
  // consented students are ever returned, and raw text is unreachable.
  // ------------------------------------------------------------------

  private static stateBand(score: number | null): EducatorStudentStatus["state_band"] {
    if (score === null || !Number.isFinite(score)) return "unknown";
    if (score >= 2) return "review";
    if (score >= 1.2) return "watch";
    return "settled";
  }

  static async getCohortRoster(): Promise<EducatorStudentStatus[]> {
    const rosterResult = await supabase.rpc("overseen_participants");
    if (rosterResult.error) throwSupabaseError("Load cohort roster failed", rosterResult.error);
    type RosterRow = { participant_id: string; org_id: string; owner_user_id: string; code: string; display_name: string | null };
    const roster = (rosterResult.data ?? []) as RosterRow[];
    if (!roster.length) return [];
    const ids = roster.map((row) => row.participant_id);

    const [insightsResult, safetyResult] = await Promise.all([
      supabase
        .from("insights")
        .select("participant_id, day, anomaly_score")
        .in("participant_id", ids)
        .order("day", { ascending: false })
        .limit(400),
      supabase
        .from("model_runs")
        .select("participant_id, retrieval_config_json, created_at")
        .eq("artifact_type", "safety_assessment")
        .in("participant_id", ids)
        .order("created_at", { ascending: false })
        .limit(400),
    ]);
    if (insightsResult.error) throwSupabaseError("Load cohort insights failed", insightsResult.error);
    if (safetyResult.error) throwSupabaseError("Load cohort safety failed", safetyResult.error);

    type InsightRowLite = { participant_id: string; day: string; anomaly_score: number | null };
    type SafetyRowLite = { participant_id: string; retrieval_config_json: Record<string, JsonValue> | null; created_at: string };
    const latestInsight = new Map<string, InsightRowLite>();
    for (const row of (insightsResult.data ?? []) as InsightRowLite[]) {
      if (!latestInsight.has(row.participant_id)) latestInsight.set(row.participant_id, row);
    }
    const latestSafety = new Map<string, SafetyRowLite>();
    for (const row of (safetyResult.data ?? []) as SafetyRowLite[]) {
      if (!latestSafety.has(row.participant_id)) latestSafety.set(row.participant_id, row);
    }

    return roster.map((row) => {
      const insight = latestInsight.get(row.participant_id);
      const safety = latestSafety.get(row.participant_id);
      const score = insight?.anomaly_score ?? null;
      return {
        participant_id: row.participant_id,
        org_id: row.org_id,
        owner_user_id: row.owner_user_id,
        code: row.code,
        display_name: row.display_name,
        last_active_day: insight?.day ?? null,
        latest_score: score,
        state_band: this.stateBand(score),
        safety_level: typeof safety?.retrieval_config_json?.risk_level === "string"
          ? String(safety.retrieval_config_json.risk_level)
          : null,
        safety_at: safety?.created_at ?? null,
      };
    });
  }

  static async getCohortAlerts(): Promise<CohortAlert[]> {
    const roster = await this.getCohortRoster();
    if (!roster.length) return [];

    const ackResult = await supabase
      .from("educator_access_log")
      .select("metadata")
      .eq("view_type", "alert_ack")
      .limit(500);
    if (ackResult.error) throwSupabaseError("Load alert acknowledgements failed", ackResult.error);
    const acked = new Set(
      ((ackResult.data ?? []) as Array<{ metadata: Record<string, JsonValue> | null }>)
        .map((row) => String(row.metadata?.alert_key ?? ""))
        .filter(Boolean),
    );

    const alerts: CohortAlert[] = [];
    const now = Date.now();
    for (const student of roster) {
      const base = {
        participant_id: student.participant_id,
        org_id: student.org_id,
        owner_user_id: student.owner_user_id,
        code: student.code,
      };
      if (student.safety_level === "crisis" || student.safety_level === "elevated") {
        const type = student.safety_level === "crisis" ? "safety_crisis" as const : "safety_elevated" as const;
        const key = `${type}:${student.participant_id}:${student.safety_at ?? "latest"}`;
        alerts.push({
          ...base,
          alert_key: key,
          type,
          severity: student.safety_level === "crisis" ? 3 : 2,
          occurred_at: student.safety_at ?? new Date().toISOString(),
          detail: student.safety_level === "crisis"
            ? "Crisis-level safety flag on the latest reflection."
            : "Elevated safety signal on the latest reflection.",
          policy_refs: [],
          acknowledged: acked.has(key),
        });
      }
      if (student.state_band === "review" && student.last_active_day) {
        const key = `anomaly_spike:${student.participant_id}:${student.last_active_day}`;
        alerts.push({
          ...base,
          alert_key: key,
          type: "anomaly_spike",
          severity: 2,
          occurred_at: student.last_active_day,
          detail: `Reflection signal ${student.latest_score?.toFixed(2) ?? "—"} is above the review threshold (2.0).`,
          policy_refs: [],
          acknowledged: acked.has(key),
        });
      }
      const lastActive = student.last_active_day ? new Date(student.last_active_day).getTime() : null;
      if (lastActive === null || now - lastActive > 7 * 24 * 60 * 60 * 1000) {
        const key = `inactivity:${student.participant_id}:${student.last_active_day ?? "never"}`;
        alerts.push({
          ...base,
          alert_key: key,
          type: "inactivity",
          severity: 1,
          occurred_at: student.last_active_day ?? new Date(0).toISOString(),
          detail: lastActive === null ? "No reflections recorded yet." : "No reflections in the last 7 days.",
          policy_refs: [],
          acknowledged: acked.has(key),
        });
      }
    }
    return alerts.sort((a, b) => b.severity - a.severity || a.code.localeCompare(b.code));
  }

  /** Append-only accountability record (issue #31). Never blocks the view. */
  static async recordEducatorAccess(
    student: Pick<EducatorStudentStatus, "participant_id" | "org_id" | "owner_user_id">,
    viewType: "roster" | "alerts" | "student_overview" | "alert_ack",
    metadata: Record<string, JsonValue> = {},
  ): Promise<void> {
    const educator = await this.requireOwnerId();
    const { error } = await supabase.from("educator_access_log").insert({
      educator_user_id: educator,
      org_id: student.org_id,
      participant_id: student.participant_id,
      owner_user_id: student.owner_user_id,
      view_type: viewType,
      metadata,
    });
    if (error) console.warn("[oversight] access log insert skipped", error);
  }

  static async acknowledgeAlert(alert: CohortAlert): Promise<void> {
    await this.recordEducatorAccess(alert, "alert_ack", { alert_key: alert.alert_key, alert_type: alert.type });
  }

  /** Batched accountability records for list views (one row per student shown). */
  static async recordCohortAccess(
    students: Array<Pick<EducatorStudentStatus, "participant_id" | "org_id" | "owner_user_id">>,
    viewType: "roster" | "alerts",
  ): Promise<void> {
    if (!students.length) return;
    const educator = await this.requireOwnerId();
    const { error } = await supabase.from("educator_access_log").insert(
      students.map((student) => ({
        educator_user_id: educator,
        org_id: student.org_id,
        participant_id: student.participant_id,
        owner_user_id: student.owner_user_id,
        view_type: viewType,
      })),
    );
    if (error) console.warn("[oversight] cohort access log insert skipped", error);
  }

  /** Minimized per-student view for educators (issue #36). */
  static async getStudentOverviewForEducator(participantId: string): Promise<{
    student: EducatorStudentStatus;
    signals: Array<{ day: string; score: number | null }>;
    themes: Array<{ label: string; count: number }>;
    safetyRuns: Array<{ level: string; occurred_at: string }>;
  } | null> {
    const roster = await this.getCohortRoster();
    const student = roster.find((row) => row.participant_id === participantId);
    if (!student) return null;

    const [insightsResult, safetyResult] = await Promise.all([
      supabase
        .from("insights")
        .select("day, anomaly_score, graph_summary_json")
        .eq("participant_id", participantId)
        .order("day", { ascending: false })
        .limit(30),
      supabase
        .from("model_runs")
        .select("retrieval_config_json, created_at")
        .eq("artifact_type", "safety_assessment")
        .eq("participant_id", participantId)
        .order("created_at", { ascending: false })
        .limit(10),
    ]);
    if (insightsResult.error) throwSupabaseError("Load student signals failed", insightsResult.error);
    if (safetyResult.error) throwSupabaseError("Load student safety failed", safetyResult.error);

    type InsightRowLite = { day: string; anomaly_score: number | null; graph_summary_json: Record<string, JsonValue> | null };
    const rows = (insightsResult.data ?? []) as InsightRowLite[];
    const themeCounts = new Map<string, number>();
    for (const row of rows) {
      const keyNodes = Array.isArray(row.graph_summary_json?.key_nodes) ? row.graph_summary_json.key_nodes : [];
      for (const node of keyNodes as Array<Record<string, JsonValue>>) {
        const label = typeof node?.label === "string" ? node.label : null;
        if (label) themeCounts.set(label, (themeCounts.get(label) ?? 0) + 1);
      }
    }
    const themes = [...themeCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([label, count]) => ({ label, count }));

    void this.recordEducatorAccess(student, "student_overview");

    return {
      student,
      signals: rows.map((row) => ({ day: row.day, score: row.anomaly_score })),
      themes,
      safetyRuns: ((safetyResult.data ?? []) as Array<{ retrieval_config_json: Record<string, JsonValue> | null; created_at: string }>)
        .map((row) => ({
          level: typeof row.retrieval_config_json?.risk_level === "string" ? String(row.retrieval_config_json.risk_level) : "unknown",
          occurred_at: row.created_at,
        }))
        .filter((run) => run.level !== "none" && run.level !== "low"),
    };
  }

  /** Student-facing view of who looked at their data (issue #31). */
  static async listEducatorAccess(userId: string, limit = 20): Promise<StudentAccessRecord[]> {
    const participant = await this.getParticipant(userId);
    const { data, error } = await supabase
      .from("educator_access_log")
      .select("id, view_type, occurred_at, organizations(name)")
      .eq("participant_id", participant.id)
      .order("occurred_at", { ascending: false })
      .limit(limit);
    if (error) throwSupabaseError("Load educator access log failed", error);
    type Row = { id: string; view_type: string; occurred_at: string; organizations?: { name: string } | { name: string }[] | null };
    return ((data ?? []) as Row[]).map((row) => {
      const org = Array.isArray(row.organizations) ? row.organizations[0] : row.organizations;
      return { id: row.id, view_type: row.view_type, occurred_at: row.occurred_at, org_name: org?.name ?? "Organization" };
    });
  }

  // ------------------------------------------------------------------
  // Student-controlled support-summary sharing (counselor handoff).
  // ------------------------------------------------------------------

  static async listOrgCounselors(orgId: string): Promise<OrgCounselor[]> {
    const { data, error } = await supabase.rpc("org_counselors", { target_org: orgId });
    if (error) throwSupabaseError("Load counselors failed", error);
    return (data ?? []) as OrgCounselor[];
  }

  static async shareSupportSummary(
    userId: string,
    summary: CounselorSupportSummary,
    orgId: string,
    counselorUserId?: string | null,
  ): Promise<void> {
    const ownerUserId = await this.requireOwnerId();
    const participant = await this.getParticipant(userId);
    const { error } = await supabase.from("shared_support_summaries").insert({
      participant_id: participant.id,
      owner_user_id: ownerUserId,
      org_id: orgId,
      counselor_user_id: counselorUserId ?? null,
      summary_id: summary.summary_id,
      summary_json: summary as unknown as Record<string, JsonValue>,
      evidence_event_ids: [...new Set(summary.sections.flatMap((section) => section.evidence_event_ids))],
      date_range_from: summary.date_range.from,
      date_range_to: summary.date_range.to,
      reflection_count: summary.reflection_count,
    });
    if (error) throwSupabaseError("Share summary failed", error);
  }

  static async listMySummaryShares(userId: string): Promise<SharedSupportSummary[]> {
    const participant = await this.getParticipant(userId);
    const { data, error } = await supabase
      .from("shared_support_summaries")
      .select("id, participant_id, org_id, counselor_user_id, summary_id, summary_json, evidence_event_ids, reflection_count, status, shared_at, revoked_at, organizations(name)")
      .eq("participant_id", participant.id)
      .order("shared_at", { ascending: false });
    if (error) throwSupabaseError("Load summary shares failed", error);
    type Row = SharedSupportSummary & { organizations?: { name: string } | { name: string }[] | null };
    return ((data ?? []) as Row[]).map((row) => {
      const org = Array.isArray(row.organizations) ? row.organizations[0] : row.organizations;
      return { ...row, org_name: org?.name ?? "Organization" };
    });
  }

  static async revokeSummaryShare(shareId: string): Promise<void> {
    const { error } = await supabase
      .from("shared_support_summaries")
      .update({ status: "revoked" })
      .eq("id", shareId);
    if (error) throwSupabaseError("Revoke summary share failed", error);
  }

  /** Counselor view: active shares for students passing all four gates. */
  static async counselorListSharedSummaries(): Promise<SharedSupportSummary[]> {
    const [sharesResult, roster] = await Promise.all([
      supabase
        .from("shared_support_summaries")
        .select("id, participant_id, org_id, counselor_user_id, summary_id, summary_json, evidence_event_ids, reflection_count, status, shared_at, revoked_at")
        .order("shared_at", { ascending: false }),
      this.getCohortRoster(),
    ]);
    if (sharesResult.error) throwSupabaseError("Load shared summaries failed", sharesResult.error);
    const codeByParticipant = new Map(roster.map((student) => [student.participant_id, student.code]));
    return ((sharesResult.data ?? []) as SharedSupportSummary[]).map((share) => ({
      ...share,
      student_code: codeByParticipant.get(share.participant_id) ?? share.participant_id,
    }));
  }

  static async getAuditTrails(userId: string, reflectionId?: string, limit = 200): Promise<ReflectionAuditTrail[]> {
    const ownerUserId = await this.requireOwnerId();
    const participant = await this.getParticipant(userId);
    let query = supabase
      .from("model_runs")
      .select(
        "id, artifact_type, artifact_id, provider, model, prompt_version, schema_version, pipeline_version, temperature, retrieval_config_json, input_provenance_json, output_hash, status, error_message, created_at",
      )
      .eq("owner_user_id", ownerUserId)
      .eq("participant_id", participant.id)
      .order("created_at", { ascending: false })
      .limit(Math.max(1, Math.min(limit, 500)));
    if (reflectionId) {
      query = query.eq("artifact_id", reflectionId);
    }
    const { data, error } = await query;
    if (error) throwSupabaseError("Load audit trails failed", error);
    return buildAuditTrails((data ?? []) as unknown as ModelRunRecord[]);
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
