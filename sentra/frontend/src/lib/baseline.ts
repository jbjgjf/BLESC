/**
 * Baseline, z-scores and rule hits for the production write path.
 *
 * ## Why this file exists
 *
 * The FastAPI backend has computed all of this since the beginning
 * (`app/analytics/{aggregation,baseline,scoring,hybrid_inference,explanation_gen}.py`).
 * It writes to SQLite. Production does not use it: `NEXT_PUBLIC_API_URL` is
 * unset on Vercel, so submissions go to the Next route handler, and every write
 * lands in Supabase. The backend therefore receives no rows, its
 * `daily_feature_aggregations` table stays empty in production, and the 14-day
 * ramp it gates on can never complete.
 *
 * What production shipped instead, in `app/api/entries/route.ts`:
 *
 *     anomalyScore = 1 + triggers * 0.8 - protective * 0.25 + relations * 0.05
 *
 * No history, no baseline, no z-score — an arithmetic function of one
 * submission, written into `insights.anomaly_score` and rendered as "Hybrid
 * Reflection Signal". The route handler was honest about it in the adjacent
 * column (`baseline_deviation_json: { baseline_available: false }`); nothing
 * read that.
 *
 * This is a deliberate port of the backend implementation, not a
 * reinterpretation — the same relationship `temporalDiff.ts` has to
 * `graph_features.py`, and for the same reason. Two implementations of one
 * contract is the condition that produced #106; both sides are pinned to
 * `sentra/shared/baseline_conformance.json` so a divergence fails a build
 * instead of reaching a student.
 *
 * ## What this does NOT do
 *
 * It does not invent a baseline for a student who does not have one yet. The
 * population baseline was deleted in #91 after an external review found its
 * eleven constants had never been measured; `docs/baseline_reestimation.md`
 * records the trade and the sample floors any replacement would have to meet.
 * Below `RAMP_UP_DAYS` this module returns no baseline, exactly as the backend
 * does, and the caller writes an explicit `not_enough_data` state.
 */

import type { ExtractedNode, ExtractedRelation } from "./extraction";
import type { TemporalDiff } from "./temporalDiff";

/**
 * Days of the student's own history required before a baseline is usable.
 * `RAMP_UP_DAYS` in `app/analytics/baseline.py`.
 */
export const RAMP_UP_DAYS = 14;

/**
 * The backend floors `MIN_REFLECTION_BASELINE_DAYS` at `RAMP_UP_DAYS` so the
 * environment can raise the requirement but never lower it. There is no
 * environment override on this path at all — a client-side env var deciding how
 * much history a mental-health reading rests on is not a knob worth having.
 */
export const MIN_BASELINE_DAYS = RAMP_UP_DAYS;

/**
 * Floor on every standard deviation, keeping z-scores finite when a feature did
 * not move across the window. `max(np.std(values), 0.01)` in `estimate_baseline`.
 */
export const MIN_STD = 0.01;

/**
 * Whether the computed score is written to `insights.anomaly_score`.
 *
 * Off, mirroring `PERSIST_ANOMALY_SCORE` in `inference_orchestrator.py`.
 * Retention of a risk classification attached to an identifiable minor is the
 * open compliance question (docs/educator_display_policy.md, decided
 * 2026-08-06). The backend stopped writing it that day. The production path
 * never did, because it never ran this code — it went on writing its own score
 * on every submission for the two months since. That is the gap this closes.
 */
export const PERSIST_ANOMALY_SCORE = false;

export type FeatureVector = Record<string, number>;
export type FeatureStats = Record<string, { mean: number; std: number }>;

export type BaselineProvenance = {
  baseline_type: string;
  observed_days: number;
  ramp_up_days: number;
  days_remaining: number;
  is_provisional: boolean;
};

export type DayGraph = {
  nodes: ExtractedNode[];
  relations: ExtractedRelation[];
};

function safeFloat(value: unknown, fallback: number): number {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

/**
 * The eleven-feature daily vector, summed across every graph recorded on that
 * day. `aggregate_daily_features` takes a day's extractions; this takes a day's
 * snapshots, which carry the same nodes and relations.
 *
 * `isolation_signal` accumulates intensity only for a Behavior node whose label
 * is exactly "isolation". That is a faithful port of the backend, and it is
 * brittle in the same way: a model that writes "social isolation", or anything
 * in Japanese, scores zero. Changing the match would change the contract on
 * both sides at once and is deliberately not done here.
 */
export function aggregateDailyFeatures(graphs: DayGraph[]): FeatureVector {
  let stateCount = 0;
  let triggerCount = 0;
  let protectiveCount = 0;
  let behaviorCount = 0;
  let eventCount = 0;
  let totalDuration = 0;
  let eventTransitionCount = 0;
  let relationCount = 0;
  let protectiveRelationCount = 0;
  let isolationScore = 0;

  for (const graph of graphs) {
    for (const rawNode of graph?.nodes ?? []) {
      const node = rawNode as ExtractedNode & { class?: string; duration?: number };
      const category = node?.category ?? node?.class ?? "";
      const intensity = safeFloat(node?.intensity, 0.5);
      if (category === "State") stateCount += 1;
      else if (category === "Trigger") triggerCount += 1;
      else if (category === "Protective") protectiveCount += 1;
      else if (category === "Behavior") {
        behaviorCount += 1;
        if (node?.label === "isolation") isolationScore += intensity;
      } else if (category === "Event") {
        eventCount += 1;
        totalDuration += safeFloat(node?.duration, 0);
      }
    }

    for (const rawRelation of graph?.relations ?? []) {
      relationCount += 1;
      const type = String(rawRelation?.type ?? "");
      if (type === "buffers") protectiveRelationCount += 1;
      if (type === "precedes") eventTransitionCount += 1;
    }
  }

  const totalRiskNodes = stateCount + triggerCount + behaviorCount;
  const totalNodes = stateCount + triggerCount + protectiveCount + behaviorCount + eventCount;

  return {
    state_count: stateCount,
    trigger_count: triggerCount,
    protective_count: protectiveCount,
    behavior_count: behaviorCount,
    event_count: eventCount,
    event_avg_duration: totalDuration / Math.max(1, eventCount),
    event_transition_signal: eventTransitionCount / Math.max(1, eventCount),
    protective_ratio: protectiveCount / Math.max(1, totalRiskNodes),
    protective_buffer_ratio: protectiveRelationCount / Math.max(1, relationCount),
    relation_density: relationCount / Math.max(1, totalNodes),
    isolation_signal: isolationScore,
  };
}

/** Population standard deviation, matching `np.std` (ddof=0). */
function populationStd(values: number[], mean: number): number {
  if (values.length === 0) return 0;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * Mean and standard deviation per feature across the window.
 *
 * Keys come from the FIRST vector only, as in the backend
 * (`all_keys = set(features_list[0].keys())`). A feature absent from day one is
 * absent from the baseline even if later days carry it — preserved because it
 * decides which z-scores exist, and diverging would put the two stores back out
 * of agreement.
 */
export function estimateBaseline(vectors: FeatureVector[]): FeatureStats {
  const stats: FeatureStats = {};
  if (vectors.length === 0) return stats;

  for (const key of Object.keys(vectors[0])) {
    const values = vectors.map((vector) => safeFloat(vector?.[key], 0));
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    stats[key] = { mean, std: Math.max(populationStd(values, mean), MIN_STD) };
  }
  return stats;
}

/**
 * The student's own baseline, or nothing.
 *
 * `< RAMP_UP_DAYS` of their own history → `null` and `"none"`. There is no
 * population fallback to stand in for the missing days, by decision (#91).
 */
export function getEffectiveBaseline(
  vectors: FeatureVector[],
): { stats: FeatureStats | null; baselineType: "user" | "none" } {
  if (vectors.length < RAMP_UP_DAYS) return { stats: null, baselineType: "none" };
  return { stats: estimateBaseline(vectors), baselineType: "user" };
}

/**
 * How far a reading can be trusted, in a form the UI can render directly.
 * `is_provisional` is the flag to gate a comparison on; `days_remaining` is what
 * goes in 「基準値の学習中（残り N 日）」.
 */
export function baselineProvenance(baselineType: string, observedDays: number): BaselineProvenance {
  return {
    baseline_type: baselineType,
    observed_days: observedDays,
    ramp_up_days: RAMP_UP_DAYS,
    days_remaining: Math.max(0, RAMP_UP_DAYS - observedDays),
    is_provisional: baselineType !== "user",
  };
}

export function computeZScores(vector: FeatureVector, stats: FeatureStats): Record<string, number> {
  const zScores: Record<string, number> = {};
  for (const [key, stat] of Object.entries(stats)) {
    const value = safeFloat(vector?.[key], 0);
    const mean = safeFloat(stat?.mean, 0);
    const std = safeFloat(stat?.std, 1);
    zScores[key] = std === 0 ? 0 : (value - mean) / std;
  }
  return zScores;
}

/**
 * Weights from `hybrid_inference.score_baseline_deviation`. They are an
 * engineering choice and have never been validated against an outcome — see
 * M-02 in the external review. Clamped at zero, so movement toward the
 * protective side cannot produce a negative signal.
 */
export const DEVIATION_WEIGHTS: Record<string, number> = {
  state_count: 0.18,
  trigger_count: 0.12,
  behavior_count: 0.12,
  event_count: 0.08,
  event_avg_duration: 0.08,
  protective_ratio: -0.28,
  isolation_signal: 0.22,
  event_transition_signal: 0.12,
};

export function scoreBaselineDeviation(zScores: Record<string, number>): number {
  let total = 0;
  for (const [key, weight] of Object.entries(DEVIATION_WEIGHTS)) {
    total += safeFloat(zScores?.[key], 0) * weight;
  }
  return Math.max(0, total);
}

export function scoreTemporalShift(diff: Partial<TemporalDiff>): number {
  const relationShift = (diff?.added_relations?.length ?? 0) + (diff?.removed_relations?.length ?? 0);
  const nodeShift = (diff?.added_nodes?.length ?? 0) + (diff?.removed_nodes?.length ?? 0);
  const changedRelations = diff?.changed_relations?.length ?? 0;
  return Math.min(3, relationShift * 0.3 + nodeShift * 0.25 + changedRelations * 0.35);
}

export type RuleHit = {
  rule: string;
  evidence: string;
  weight: number;
  signal: Record<string, number | string>;
};

export type ProtectiveDecline = {
  drop_in_protective_nodes: number;
  current_protective_nodes: number;
  previous_protective_nodes: number;
};

/**
 * `summarize_temporal_diff`'s protective block. Only the drop is used by the
 * rule engine; the other two travel with it so a reader can see what the drop
 * was measured between.
 */
export function protectiveDecline(current: DayGraph, previous: DayGraph, hadPrevious: boolean): ProtectiveDecline {
  const countProtective = (graph: DayGraph) =>
    (graph?.nodes ?? []).filter((node) => node?.category === "Protective").length;
  const currentCount = countProtective(current);
  const previousCount = hadPrevious ? countProtective(previous) : 0;
  return {
    drop_in_protective_nodes: hadPrevious ? Math.max(0, previousCount - currentCount) : 0,
    current_protective_nodes: currentCount,
    previous_protective_nodes: previousCount,
  };
}

/** `RuleEngine.check_rules`. Deterministic, and every hit carries its evidence. */
export function checkRules(
  featureVector: FeatureVector,
  zScores: Record<string, number>,
  graphSummary: { event_count?: number },
  diff: Partial<TemporalDiff>,
  decline: ProtectiveDecline,
): RuleHit[] {
  const hits: RuleHit[] = [];

  if (safeFloat(zScores?.isolation_signal, 0) > 1.8 || safeFloat(featureVector?.isolation_signal, 0) > 0.8) {
    hits.push({
      rule: "isolation_spike",
      evidence:
        "Isolation signal rose relative to the baseline and the structural graph is centered on fewer supportive links.",
      weight: 0.45,
      signal: { feature: "isolation_signal", z: safeFloat(zScores?.isolation_signal, 0) },
    });
  }

  const protectiveRatio = safeFloat(featureVector?.protective_ratio, 1);
  const protectiveDrop = safeFloat(decline?.drop_in_protective_nodes, 0);
  if (protectiveRatio < 0.2 || protectiveDrop > 0) {
    hits.push({
      rule: "protective_decline",
      evidence:
        "Protective structure weakened: the daily graph has fewer protective nodes or lower protective ratio than the baseline.",
      weight: 0.4,
      signal: { protective_ratio: protectiveRatio, protective_drop: protectiveDrop },
    });
  }

  if (safeFloat(zScores?.state_count, 0) > 1.25 || safeFloat(zScores?.trigger_count, 0) > 1.25) {
    hits.push({
      rule: "state_trigger_inflation",
      evidence: "Distressing states or triggers expanded beyond the baseline pattern.",
      weight: 0.25,
      signal: {
        state_count_z: safeFloat(zScores?.state_count, 0),
        trigger_count_z: safeFloat(zScores?.trigger_count, 0),
      },
    });
  }

  if ((graphSummary?.event_count ?? 0) > 0 && safeFloat(zScores?.event_transition_signal, 0) > 1.2) {
    hits.push({
      rule: "event_sequence_shift",
      evidence: "Event nodes are present, but their temporal sequencing differs from the baseline graph.",
      weight: 0.3,
      signal: {
        event_count: graphSummary?.event_count ?? 0,
        event_transition_signal_z: safeFloat(zScores?.event_transition_signal, 0),
      },
    });
  }

  const changedCount = diff?.changed_relations?.length ?? 0;
  if (changedCount > 0) {
    hits.push({
      rule: "relation_reweighting",
      evidence: "Several key relations changed confidence or direction relative to the prior local graph.",
      weight: Math.min(0.35, 0.08 * changedCount),
      signal: { changed_relations: changedCount },
    });
  }

  return hits;
}

export type ScoreBreakdown = {
  rule_score: number;
  deviation_score: number;
  temporal_shift_score: number;
  final_score: number;
};

/** Python's `round(x, 3)` is banker's rounding; the difference from JS shows up
 * only on an exact half at the fourth decimal, so the shared contract compares
 * these with a tolerance rather than for equality. */
function round3(value: number): number {
  return Number(value.toFixed(3));
}

export function combineHybridScore(
  ruleHits: RuleHit[],
  deviationScore: number,
  temporalShiftScore: number,
): ScoreBreakdown {
  const ruleScore = ruleHits.reduce((sum, hit) => sum + hit.weight, 0);
  return {
    rule_score: round3(ruleScore),
    deviation_score: round3(deviationScore),
    temporal_shift_score: round3(temporalShiftScore),
    final_score: round3(Math.min(10, ruleScore * 2 + deviationScore * 1.15 + temporalShiftScore * 0.85)),
  };
}

/**
 * Features that could not vary across the window, and so carry no information
 * however large their weight.
 *
 * `event_avg_duration` is the standing case: it is weighted 0.08, and on this
 * path it is always zero, because the production extraction schema
 * (`app/api/entries/route.ts`) never asks the model for a node `duration`. The
 * backend's schema does. Rather than let a permanently-zero feature sit in a
 * stored z-score map looking measured, the caller records this list alongside
 * it — the same failure #85 was about.
 */
export function degenerateFeatures(vectors: FeatureVector[]): string[] {
  if (vectors.length === 0) return [];
  return Object.keys(vectors[0]).filter((key) => {
    const values = vectors.map((vector) => safeFloat(vector?.[key], 0));
    return values.every((value) => value === values[0]);
  });
}

export type BaselineOutcome =
  | {
      status: "ok";
      baselineType: "user";
      provenance: BaselineProvenance;
      featureVector: FeatureVector;
      zScores: Record<string, number>;
      deviationScore: number;
      degenerate: string[];
      observedDays: number;
    }
  | {
      status: "not_enough_data";
      baselineType: "none";
      provenance: BaselineProvenance;
      featureVector: FeatureVector;
      observedDays: number;
      requiredDays: number;
    };

/**
 * The whole gate in one call: today's graphs, the prior days' graphs, and
 * either a real deviation or an explicit refusal to produce one.
 *
 * `history` is one entry per distinct prior day, most recent first or last — the
 * order does not matter to a mean and a standard deviation.
 */
export function evaluateBaseline(today: DayGraph[], history: DayGraph[][]): BaselineOutcome {
  const featureVector = aggregateDailyFeatures(today);
  const historyVectors = history.map((day) => aggregateDailyFeatures(day));
  const observedDays = historyVectors.length;

  if (observedDays < MIN_BASELINE_DAYS) {
    return {
      status: "not_enough_data",
      baselineType: "none",
      provenance: baselineProvenance("none", observedDays),
      featureVector,
      observedDays,
      requiredDays: MIN_BASELINE_DAYS,
    };
  }

  const { stats, baselineType } = getEffectiveBaseline(historyVectors);
  if (!stats || baselineType !== "user") {
    return {
      status: "not_enough_data",
      baselineType: "none",
      provenance: baselineProvenance("none", observedDays),
      featureVector,
      observedDays,
      requiredDays: MIN_BASELINE_DAYS,
    };
  }

  const zScores = computeZScores(featureVector, stats);
  return {
    status: "ok",
    baselineType: "user",
    provenance: baselineProvenance("user", observedDays),
    featureVector,
    zScores,
    deviationScore: round3(scoreBaselineDeviation(zScores)),
    degenerate: degenerateFeatures(historyVectors),
    observedDays,
  };
}

/**
 * Pull the provenance back out of a stored `baseline_deviation_json`.
 *
 * Rows written before this landed have no `baseline_provenance` key, so they
 * return null and the caller shows the ramp-up state — the correct reading for
 * them, since none of them rested on a baseline either.
 */
export function readBaselineProvenance(deviation: unknown): BaselineProvenance | null {
  const provenance = (deviation as { baseline_provenance?: unknown } | null)?.baseline_provenance;
  if (!provenance || typeof provenance !== "object") return null;
  const candidate = provenance as Partial<BaselineProvenance>;
  if (typeof candidate.is_provisional !== "boolean") return null;
  return {
    baseline_type: String(candidate.baseline_type ?? "none"),
    observed_days: Number(candidate.observed_days ?? 0),
    ramp_up_days: Number(candidate.ramp_up_days ?? RAMP_UP_DAYS),
    days_remaining: Number(candidate.days_remaining ?? RAMP_UP_DAYS),
    is_provisional: candidate.is_provisional,
  };
}

/**
 * What to show a student in place of a score during the ramp.
 *
 * Says what is missing and when it arrives. "No data" would be wrong — they
 * have written entries and those entries were analysed; what does not exist yet
 * is fourteen days to compare today against.
 */
export function rampUpMessage(provenance: BaselineProvenance | null): string {
  const remaining = provenance?.days_remaining ?? RAMP_UP_DAYS;
  const observed = provenance?.observed_days ?? 0;
  return (
    `Still learning your baseline — ${remaining} more day(s) of entries needed. ` +
    `A signal compares today against your own previous ${RAMP_UP_DAYS} days, and ${observed} are recorded so far. ` +
    `Your entries are being analysed in the meantime; there is simply nothing yet to compare them against.`
  );
}

/** The four features whose |z| is largest, as `top_features` in the backend. */
export function topFeatures(zScores: Record<string, number>): string[] {
  return Object.entries(zScores)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, 4)
    .map(([name]) => name);
}
