/**
 * Types and pure helpers for the world-model research screen (#151, #152).
 *
 * Everything here is contract-shaped: the names match C4 and C5 exactly, so a
 * schema change surfaces as a type error rather than as an undefined rendering
 * as blank. No copy lives in this file — the strings are in `i18n/ja.ts` and
 * the functions below return the *keys* that select them.
 *
 * Two rules the UI depends on and that are enforced here rather than in each
 * component:
 *
 * `formatMetric` never renders a null as a number. A metric with
 * `status !== "ok"` has no value, and showing 0 where the evaluator wrote
 * "unsupported" would turn an absent yardstick into a measured failure.
 *
 * `disabledCapabilities` is what the screen keys its controls off. A capability
 * reported false must not be operable, whatever the rest of the payload says.
 */

export type RunState = "idle" | "queued" | "running" | "succeeded" | "failed" | "unknown";

export const RUN_STATES: RunState[] = ["idle", "queued", "running", "succeeded", "failed", "unknown"];

export type MetricStatus = "ok" | "unsupported" | "not_enough_data" | "failed";

export interface Metric {
  name: string;
  target: string;
  value: number | null;
  unit: string;
  n_participants: number | null;
  n_predictions: number | null;
  uncertainty_method: string | null;
  interval: [number, number] | null;
  status: MetricStatus;
  model_id: string | null;
  reason_ja: string | null;
}

export interface LeakageCheck {
  name: string;
  passed: boolean;
  detail_ja: string;
  checked_items: number | null;
}

export interface MeasuredUsage {
  provider_calls: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
  elapsed_seconds: number | null;
  compute_environment: string;
}

export interface EvaluationReport {
  report_version: string;
  run_id: string;
  dataset_id: string;
  split_id: string;
  artifact_hashes: Record<string, string>;
  seed_list: number[];
  baselines: string[];
  metrics: Metric[];
  metrics_by_scenario: Record<string, Metric[]>;
  unsupported_metrics: Metric[];
  leakage_checks: LeakageCheck[];
  predictions_ref: string;
  limitations: string[];
  measured_usage: MeasuredUsage;
  reproducibility_command: string;
  status: string;
  generated_at: string | null;
}

export interface ExplanationNode {
  id: string;
  label: string;
  semantic_status: string;
  unit: string;
  value: number | null;
  uncertainty: number | null;
}

export interface CandidateEdge {
  source_ids: string[];
  target_id: string;
  lag_days: number;
  interaction_order: number;
  interaction_function: string;
  coefficient: number;
  uncertainty_method: string | null;
  uncertainty: number | null;
  model_id: string;
  evidence_scope: string;
  source_refs: string[];
}

export interface ExplanationBundle {
  schema_version: string;
  run_id: string;
  forecast_id: string;
  abstraction_id: string;
  node_schema_id: string;
  states: ExplanationNode[];
  candidate_edges: CandidateEdge[];
  residual_summary: Record<string, number | null>;
  fidelity_metrics: Record<string, number | null>;
  source_refs: string[];
  assumptions: string[];
  capability_flags: Record<string, boolean>;
  status: string;
}

export interface ForecastPreview {
  scenario: string;
  seed: number;
  participant_key: string;
  feature_names: string[];
  cutoff_at: string;
  history: { available_at: string; values: (number | null)[] }[];
  actual_after_cutoff: { available_at: string; values: (number | null)[] }[];
  forecast: {
    model_id: string;
    target_times: string[];
    target_names: string[];
    means: number[][];
    scales_or_samples: number[][] | null;
    distribution_method: string;
    capability_flags: Record<string, boolean>;
    status: string;
  };
  baseline_forecast: {
    model_id: string;
    target_times: string[];
    means: number[][];
  } | null;
}

export interface RunStatus {
  run_id: string;
  state: string;
  dataset_id: string;
  config_id: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  artifact_versions: Record<string, string>;
  error: string | null;
}

/** A row for the chart: one time point, one feature, three possible series. */
export interface SeriesPoint {
  at: string;
  observed: number | null;
  actual: number | null;
  forecast: number | null;
  baseline: number | null;
  lower: number | null;
  upper: number | null;
}

export function toRunState(raw: string | null | undefined): RunState {
  if (!raw) return "idle";
  return (RUN_STATES as string[]).includes(raw) && raw !== "idle" ? (raw as RunState) : "unknown";
}

/** `null` means "there is no number", and the caller must render it as such. */
export function metricValue(metric: Metric): number | null {
  return metric.status === "ok" ? metric.value : null;
}

export function metricInterval(metric: Metric): [number, number] | null {
  return metric.status === "ok" ? metric.interval : null;
}

export function formatNumber(value: number | null, digits = 4): string | null {
  if (value === null || Number.isNaN(value)) return null;
  return value.toFixed(digits);
}

/** Capabilities reported false. The screen must not offer these as controls. */
export function disabledCapabilities(flags: Record<string, boolean> | undefined): string[] {
  if (!flags) return [];
  return Object.entries(flags)
    .filter(([, enabled]) => !enabled)
    .map(([name]) => name)
    .sort();
}

export function enabledCapabilities(flags: Record<string, boolean> | undefined): string[] {
  if (!flags) return [];
  return Object.entries(flags)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name)
    .sort();
}

/**
 * The chart rows for one feature of one participant.
 *
 * Observed history, post-cutoff actuals and the forecast are separate fields on
 * purpose: drawing them as one line would join a measurement to a prediction and
 * make the cutoff invisible, which is the one thing a reader of this chart has
 * to be able to see.
 */
export function seriesForFeature(preview: ForecastPreview, featureIndex: number): SeriesPoint[] {
  const rows: SeriesPoint[] = [];

  for (const point of preview.history) {
    rows.push({
      at: point.available_at,
      observed: point.values[featureIndex] ?? null,
      actual: null,
      forecast: null,
      baseline: null,
      lower: null,
      upper: null,
    });
  }

  const byTime = new Map<string, SeriesPoint>();
  for (const point of preview.actual_after_cutoff) {
    const row: SeriesPoint = {
      at: point.available_at,
      observed: null,
      actual: point.values[featureIndex] ?? null,
      forecast: null,
      baseline: null,
      lower: null,
      upper: null,
    };
    byTime.set(point.available_at, row);
    rows.push(row);
  }

  preview.forecast.target_times.forEach((at, horizon) => {
    const mean = preview.forecast.means[horizon]?.[featureIndex] ?? null;
    const scale = preview.forecast.scales_or_samples?.[horizon]?.[featureIndex] ?? null;
    const baseline = preview.baseline_forecast?.means[horizon]?.[featureIndex] ?? null;
    const existing = byTime.get(at);
    const row = existing ?? {
      at,
      observed: null,
      actual: null,
      forecast: null,
      baseline: null,
      lower: null,
      upper: null,
    };
    row.forecast = mean;
    row.baseline = baseline;
    if (mean !== null && scale !== null) {
      row.lower = mean - 1.6449 * scale;
      row.upper = mean + 1.6449 * scale;
    }
    if (!existing) {
      byTime.set(at, row);
      rows.push(row);
    }
  });

  return rows.sort((left, right) => left.at.localeCompare(right.at));
}

/** Edges sorted so the strongest candidates read first, ties broken stably. */
export function sortedEdges(edges: CandidateEdge[]): CandidateEdge[] {
  return [...edges].sort((left, right) => {
    const byFrequency = (right.uncertainty ?? 0) - (left.uncertainty ?? 0);
    if (byFrequency !== 0) return byFrequency;
    const byMagnitude = Math.abs(right.coefficient) - Math.abs(left.coefficient);
    if (byMagnitude !== 0) return byMagnitude;
    return `${left.source_ids.join()}->${left.target_id}`.localeCompare(
      `${right.source_ids.join()}->${right.target_id}`,
    );
  });
}

export function failedChecks(report: EvaluationReport | null): LeakageCheck[] {
  if (!report) return [];
  return report.leakage_checks.filter((check) => !check.passed);
}
