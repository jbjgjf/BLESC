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
  category: "State" | "Trigger" | "Protective" | "Behavior" | "Event";
  label: string;
  intensity: number;
  confidence: number;
  duration?: number;
}

export interface Extraction {
  id: number;
  entry_id: number;
  nodes_json: ExtractionNode[];
  relations_json: any[];
  temporal_summary: string;
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
}

export interface ExplanationPayload {
  id: number;
  user_id: string;
  day: string;
  rule_contributions: ExplanationContribution[];
  feature_zscores: Record<string, number>;
  top_features: string[];
  uncertainty_summary: string;
  evidence_summaries: string[];
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
  feature_vector_json: Record<string, any>;
}
