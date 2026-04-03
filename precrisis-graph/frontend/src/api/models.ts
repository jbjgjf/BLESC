export interface Entry {
  id: number;
  user_id: string;
  raw_text?: string;
  is_masked: boolean;
  created_at: string;
  expires_at?: string;
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
  id: number;
  entry_id: number;
  nodes_json: ExtractionNode[];
  relations_json: ExtractionRelation[];
  temporal_summary: string;
  created_at: string;
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
  changed_relations: Array<Record<string, any>>;
  relation_shift_summary: string;
  protective_decline: Record<string, any>;
  uncertainty: Record<string, any>;
}

export interface GraphSnapshot {
  id: number;
  entry_id: number;
  user_id: string;
  day: string;
  nodes_json: ExtractionNode[];
  relations_json: ExtractionRelation[];
  graph_summary_json: GraphLayerSummary;
  temporal_diff_json: TemporalGraphDiff;
  created_at: string;
}

export interface AnomalyResult {
  id: number;
  user_id: string;
  day: string;
  anomaly_score: number;
  z_scores_json: Record<string, number>;
  explanation_id?: number;
}

export interface ExplanationContribution {
  rule: string;
  evidence: string;
  weight: number;
  signal?: Record<string, any>;
}

export interface ExplanationPayload {
  id: number;
  user_id: string;
  day: string;
  triggered_rules_json: ExplanationContribution[];
  baseline_deviation_json: Record<string, any>;
  changed_relations_json: Array<Record<string, any>>;
  protective_decline_json: Record<string, any>;
  uncertainty_json: Record<string, any>;
  evidence_summaries: string[];
  graph_summary_json: GraphLayerSummary;
  score_breakdown_json: Record<string, any>;
  key_relations: ExtractionRelation[];
  created_at: string;
}

export interface EntrySubmissionResponse {
  entry: Entry;
  extraction: Extraction;
  graph_snapshot: GraphSnapshot;
  anomaly_result?: AnomalyResult | null;
  explanation?: ExplanationPayload | null;
}

export interface GraphSnapshotResponse extends GraphSnapshot {}

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
  feature_vector_json: Record<string, any>;
}
