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

export interface EmotionalStateExtraction {
  reflection_id: string;
  locale: string;
  primary_emotions: Array<{
    label: string;
    intensity: number;
    confidence: "low" | "medium" | "high" | string;
    evidence_ref: Record<string, JsonValue>;
  }>;
  intensity: number;
  trigger_candidates: Array<Record<string, JsonValue>>;
  cognitive_themes: Array<Record<string, JsonValue>>;
  body_behavior_signals: Array<Record<string, JsonValue>>;
  protective_factors: Array<Record<string, JsonValue>>;
  support_needs: Array<Record<string, JsonValue>>;
  uncertainty_notes: string[];
  evidence_spans: Array<Record<string, JsonValue>>;
  safety_classification: {
    level: "normal" | "elevated" | "crisis" | string;
    flags: string[];
    action: string;
  };
  prompt_version: string;
  model: string;
  status: string;
}

export interface ReflectionCard {
  id: string;
  type: "emotion_mirror" | "possible_trigger_pattern" | "support_need" | "small_next_step" | "reflection_question" | "safety_suppression" | string;
  title: string;
  body: string;
  evidence_refs: Array<Record<string, JsonValue>>;
  confidence: "low" | "medium" | "high" | string;
  status: "active" | "suppressed" | string;
  prompt_version: string;
  policy_refs?: string[];
}

export interface SafetyAssessment {
  risk_level: "none" | "low" | "elevated" | "crisis";
  confidence: number;
  escalation_required: boolean;
  reasons: string[];
  safe_response: string;
  policy_refs: string[];
}

export interface CounselorSummarySection {
  key: "recent_themes" | "recurring_triggers" | "intensity_trend" | "support_needs" | "protective_factors" | "suggested_discussion_points";
  title: string;
  items: string[];
  evidence_event_ids: string[];
}

export interface CounselorSupportSummary {
  summary_id: string;
  date_range: { from: string | null; to: string | null };
  reflection_count: number;
  sections: CounselorSummarySection[];
  safety_flags: Array<{ level: string; reasons: string[]; timestamp: string; event_id: string }>;
  limitations: string;
  generated_at: string;
}

export interface OversightRequest {
  roster_id: string;
  org_id: string;
  org_name: string;
  roster_status: "pending" | "active" | "revoked" | string;
  consent_status: "active" | "revoked" | null;
  granted_at: string | null;
  revoked_at: string | null;
}

export interface EducatorStudentStatus {
  participant_id: string;
  org_id: string;
  owner_user_id: string;
  code: string;
  display_name: string | null;
  last_active_day: string | null;
  latest_score: number | null;
  state_band: "settled" | "watch" | "review" | "unknown";
  safety_level: string | null;
  safety_at: string | null;
}

export interface CohortAlert {
  alert_key: string;
  type: "safety_crisis" | "safety_elevated" | "anomaly_spike" | "inactivity";
  severity: 1 | 2 | 3;
  participant_id: string;
  org_id: string;
  owner_user_id: string;
  code: string;
  occurred_at: string;
  detail: string;
  policy_refs: string[];
  acknowledged: boolean;
}

export interface StudentAccessRecord {
  id: string;
  view_type: string;
  occurred_at: string;
  org_name: string;
}

export interface SharedSupportSummary {
  id: string;
  participant_id: string;
  org_id: string;
  org_name?: string;
  student_code?: string;
  counselor_user_id: string | null;
  summary_id: string;
  summary_json: CounselorSupportSummary;
  evidence_event_ids: string[];
  reflection_count: number;
  status: "active" | "revoked" | string;
  shared_at: string;
  revoked_at: string | null;
}

export interface OrgCounselor {
  counselor_user_id: string;
  display_label: string;
}

export interface AiAuditSafetyDecision {
  risk_level: string;
  escalation_required: boolean;
  reasons: string[];
  policy_refs: string[];
}

export interface AiAuditEvent {
  id: string;
  stage: "extraction" | "safety_assessment" | "counselor_summary" | string;
  label: string;
  status: "completed" | "failed" | "suppressed" | string;
  occurred_at: string;
  provider: string;
  model: string;
  prompt_version: string;
  schema_version?: string;
  pipeline_version?: string;
  temperature?: number;
  safety_decision?: AiAuditSafetyDecision | null;
  evidence_refs: string[];
  output_hash?: string | null;
  error_message?: string | null;
}

export interface ReflectionAuditTrail {
  correlation_id: string;
  reflection_id: string | null;
  first_event_at: string;
  last_event_at: string;
  event_count: number;
  has_safety_flag: boolean;
  has_failure: boolean;
  events: AiAuditEvent[];
}

export interface Extraction {
  id: RecordId;
  entry_id: RecordId;
  nodes_json: ExtractionNode[];
  relations_json: ExtractionRelation[];
  temporal_summary: string;
  emotional_state_json?: EmotionalStateExtraction;
  reflection_cards_json?: ReflectionCard[];
  safety_flags_json?: string[];
  safety_assessment_json?: SafetyAssessment;
  prompt_version?: string;
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

export interface ConversationMemoryObject {
  memory_id: RecordId;
  source_message_ids: Array<string | number>;
  topic: string;
  summary: string;
  emotional_tone: {
    negative: number;
    protective: number;
    valence: number;
    dominant: "negative" | "protective" | "neutral" | string;
  };
  importance_score: number;
  effective_importance: number;
  score_breakdown: Record<string, JsonValue>;
  recurrence_score: number;
  recurrence_count: number;
  confidence_score: number;
  extraction_mode: "llm_assisted" | "deterministic_fallback" | string;
  embedding_model: string;
  embedding_status: "generated" | "pending_no_openai_key" | "generation_failed" | "empty_content" | string;
  created_at?: string;
  updated_at?: string;
  last_reinforced_at?: string;
  merged_into_id?: RecordId | null;
  merge_reason?: string | null;
  superseded_by_id?: RecordId | null;
  contradiction_status: "none" | "flagged" | "superseded" | string;
  contradiction_detail?: Record<string, JsonValue>;
  pipeline_version: string;
}

export interface ConversationRecallSummary {
  id?: RecordId;
  status: "completed" | "not_enough_history" | string;
  window_turn_count: number;
  required_turn_count: number;
  message_start?: string | null;
  message_end?: string | null;
  summary_json: {
    summary?: string;
    top_topics?: Array<{ topic: string; count: number }>;
    recurring_topics?: Array<{ topic: string; count: number }>;
    tone_trends?: Record<string, JsonValue>;
    open_loops?: string[];
    non_diagnostic?: boolean;
    [key: string]: JsonValue | undefined;
  };
  source_message_hashes?: string[];
  memory_object_ids?: Array<string | number>;
  memory_objects?: ConversationMemoryObject[];
  pipeline_version: string;
  created_at?: string;
}

export interface ChatResponse {
  chat_session_id: RecordId;
  message_id: RecordId;
  answer: string;
  evidence_refs: Record<string, JsonValue>;
  retrieval_context: Record<string, JsonValue>;
  conversation_recall_30?: ConversationRecallSummary;
  model_run_id?: RecordId;
  status: string;
  error_message?: string | null;
  mirrored?: boolean;
}

export interface AudioTranscriptionResponse {
  text: string;
  provider: string;
  model: string;
  status: string;
}
