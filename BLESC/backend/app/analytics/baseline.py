import numpy as np
from datetime import date, datetime
from typing import Dict, List, Tuple
from ..schemas.analytics import DailyFeatureAggregation, BaselineStats

# Conservative defaults derived from domain knowledge.
# Replace with data-driven values once real usage data accumulates.
POPULATION_BASELINE: Dict[str, Dict[str, float]] = {
    "state_count":             {"mean": 1.5,  "std": 1.2},
    "trigger_count":           {"mean": 1.2,  "std": 1.0},
    "protective_count":        {"mean": 1.8,  "std": 1.3},
    "behavior_count":          {"mean": 0.8,  "std": 0.7},
    "event_count":             {"mean": 1.0,  "std": 0.9},
    "event_avg_duration":      {"mean": 45.0, "std": 30.0},
    "event_transition_signal": {"mean": 0.5,  "std": 0.4},
    "protective_ratio":        {"mean": 0.45, "std": 0.25},
    "protective_buffer_ratio": {"mean": 0.30, "std": 0.20},
    "relation_density":        {"mean": 0.40, "std": 0.30},
    "isolation_signal":        {"mean": 0.20, "std": 0.25},
}

# Days until the blend fully shifts to the user's own baseline.
RAMP_UP_DAYS = 14


def estimate_baseline(user_id: str, aggregations: List[DailyFeatureAggregation]) -> BaselineStats:
    """Compute mean and std for each feature from the given aggregations."""
    features_list = [agg.feature_vector_json for agg in aggregations]
    all_keys = set(features_list[0].keys())

    stats: Dict[str, Dict[str, float]] = {}
    for key in all_keys:
        values = [f.get(key, 0.0) for f in features_list]
        stats[key] = {
            "mean": float(np.mean(values)),
            "std": max(float(np.std(values)), 0.01),  # prevent division-by-zero in z-scores
        }

    return BaselineStats(
        user_id=user_id,
        window_start=aggregations[0].day,
        window_end=aggregations[-1].day,
        stats_json=stats,
    )


def _blend(
    population: Dict[str, Dict[str, float]],
    user_stats: Dict[str, Dict[str, float]],
    ratio: float,
) -> Dict[str, Dict[str, float]]:
    """ratio=0.0 → population only, ratio=1.0 → user only."""
    result: Dict[str, Dict[str, float]] = {}
    for key in set(population) | set(user_stats):
        pop = population.get(key, {"mean": 0.0, "std": 1.0})
        usr = user_stats.get(key, pop)
        result[key] = {
            "mean": pop["mean"] * (1 - ratio) + usr["mean"] * ratio,
            # Clamp std > 0 to prevent silent division-by-zero in z-score
            "std": max(pop["std"] * (1 - ratio) + usr["std"] * ratio, 0.01),
        }
    return result


def get_effective_baseline(
    user_id: str,
    aggregations: List[DailyFeatureAggregation],
) -> Tuple[BaselineStats, str]:
    """
    Always returns a valid BaselineStats plus a type label.

    baseline_type:
      "population" — no user data yet; using domain defaults
      "blended"    — mixing population and user data during ramp-up
      "user"       — 14+ days of data; fully personal baseline
    """
    n = len(aggregations)
    today = datetime.utcnow().date()

    if n == 0:
        return (
            BaselineStats(
                user_id=user_id,
                window_start=today,
                window_end=today,
                stats_json=POPULATION_BASELINE,
            ),
            "population",
        )

    if n == 1:
        # One data point: borrow population std, use user mean
        vec = aggregations[0].feature_vector_json
        single_day_stats = {
            k: {"mean": float(vec.get(k, POPULATION_BASELINE.get(k, {}).get("mean", 0.0))),
                "std": POPULATION_BASELINE.get(k, {}).get("std", 1.0)}
            for k in POPULATION_BASELINE
        }
        ratio = 1.0 / RAMP_UP_DAYS
        blended = _blend(POPULATION_BASELINE, single_day_stats, ratio)
        day = aggregations[0].day
        return (
            BaselineStats(user_id=user_id, window_start=day, window_end=day, stats_json=blended),
            "blended",
        )

    user_bl = estimate_baseline(user_id, aggregations)
    ratio = min(1.0, n / RAMP_UP_DAYS)

    if ratio >= 1.0:
        return user_bl, "user"

    blended = _blend(POPULATION_BASELINE, user_bl.stats_json, ratio)
    return (
        BaselineStats(
            user_id=user_id,
            window_start=aggregations[0].day,
            window_end=aggregations[-1].day,
            stats_json=blended,
        ),
        "blended",
    )
