export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type RecordId = string | number;

export interface Entry {
  id: RecordId;
  user_id: string;
  raw_text?: string;
  is_masked: boolean;
  created_at: string;
  expires_at?: string;
  observation_type?: string;
}

export interface ExtractionNode {
  id: string;
  category: "State" | "Trigger" | "Protective" | "Behavior" | "Event" | string;
  label: string;
  intensity: number;
  confidence: number;
  start_time?: string;
  end_time?: string;
  duration?: number;
}

export interface ExtractionRelation {
  source_id: string;
  target_id: string;
  type: "causes" | "escalates" | "buffers" | "avoids" | "co_occurs" | "precedes" | string;
  confidence: number;
}

export interface Extraction {
  id: RecordId;
  entry_id: RecordId;
  nodes_json: ExtractionNode[];
  relations_json: ExtractionRelation[];
  temporal_summary: string;
  created_at: string;
}

export interface ExtractionResponse extends Extraction {
  extractor_version: string;
  extraction_provider: string;
  extraction_model: string;
}

export interface GraphLayerSummary {
  node_count: number;
  relation_count: number;
  event_count: number;
  key_nodes: ExtractionNode[];
  key_relations: ExtractionRelation[];
  summary: string;
}

export interface TemporalGraphDiff {
  added_nodes: ExtractionNode[];
  removed_nodes: ExtractionNode[];
  added_relations: ExtractionRelation[];
  removed_relations: ExtractionRelation[];
  changed_relations: Array<Record<string, JsonValue>>;
  relation_shift_summary: string;
  protective_decline: Record<string, JsonValue>;
  uncertainty: Record<string, JsonValue>;
}

export interface GraphSnapshot {
  id: RecordId;
  entry_id: RecordId;
  user_id: string;
  day: string;
  nodes_json: ExtractionNode[];
  relations_json: ExtractionRelation[];
  graph_summary_json: GraphLayerSummary;
  temporal_diff_json: TemporalGraphDiff;
  extraction_provider?: string;
  extraction_model?: string;
  created_at: string;
}

export interface AnomalyResult {
  id: RecordId;
  user_id: string;
  day: string;
  anomaly_score: number;
  z_scores_json: Record<string, number>;
  explanation_id?: RecordId;
}

export interface ExplanationContribution {
  rule: string;
  evidence: string;
  weight: number;
  signal?: Record<string, JsonValue>;
}

export interface ExplanationPayload {
  id: RecordId;
  user_id: string;
  day: string;
  triggered_rules_json: ExplanationContribution[];
  baseline_deviation_json: Record<string, JsonValue>;
  changed_relations_json: Array<Record<string, JsonValue>>;
  protective_decline_json: Record<string, JsonValue>;
  uncertainty_json: Record<string, JsonValue>;
  evidence_summaries: string[];
  graph_summary_json: GraphLayerSummary;
  score_breakdown_json: Record<string, JsonValue>;
  key_relations: ExtractionRelation[];
  created_at: string;
}

export interface EntrySubmissionResponse {
  entry: Entry;
  extraction: ExtractionResponse;
  graph_snapshot: GraphSnapshot;
  anomaly_result?: AnomalyResult | null;
  explanation?: ExplanationPayload | null;
  research_artifacts?: {
    embedding_artifacts?: Array<{
      local_id?: number;
      entry_id?: RecordId;
      content_kind: string;
      embedding_model: string;
      vector_json?: number[];
      content_hash: string;
      metadata_json?: Record<string, JsonValue>;
    }>;
    writing_feature_artifacts?: Array<{
      local_id?: number;
      entry_id?: RecordId;
      entry_session_id?: number;
      field_name: string;
      pipeline_version: string;
      feature_json: Record<string, JsonValue>;
    }>;
    cognitive_probe_artifact?: {
      local_id?: number;
      entry_id?: RecordId;
      entry_session_id?: number | null;
      probe_name: string;
      journal_text_hash: string;
      recall_text_hash: string;
      pipeline_version: string;
      feature_json: Record<string, JsonValue>;
    } | null;
    pipeline_version?: string;
  };
}

export type GraphSnapshotResponse = GraphSnapshot;

export interface ConsentSnapshot {
  app_use: boolean;
  research_analysis: boolean;
  anonymized_export: boolean;
  future_fine_tuning: boolean;
  consent_version: string;
}

export interface InteractionEventPayload {
  field_name: string;
  event_type: string;
  occurred_at: string;
  relative_ms: number;
  value_length?: number;
  selection_start?: number;
  selection_end?: number;
  metadata?: Record<string, JsonValue>;
}

export interface FieldTelemetryPayload {
  first_input_at?: string;
  last_input_at?: string;
  focus_count: number;
  blur_count: number;
  input_count: number;
  deletion_count: number;
  paste_count: number;
  revision_count: number;
  pause_count: number;
  max_pause_ms: number;
  active_typing_ms: number;
}

export interface EntryTelemetryPayload {
  session_id: string;
  started_at: string;
  submitted_at: string;
  client_timezone?: string;
  user_agent?: string;
  events: InteractionEventPayload[];
  field_metrics: Record<string, FieldTelemetryPayload>;
  aggregate_metrics: Record<string, JsonValue>;
}

export interface DailyFeatureAggregation {
  id: number;
  user_id: string;
  day: string;
  state_count: number;
  trigger_count: number;
  protective_count: number;
  behavior_count: number;
  event_count: number;
  event_avg_duration: number;
  protective_ratio: number;
  isolation_signal: number;
  feature_vector_json: Record<string, JsonValue>;
}
