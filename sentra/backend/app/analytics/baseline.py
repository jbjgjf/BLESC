import numpy as np
from typing import Dict, List, Optional, Tuple
from ..schemas.analytics import DailyFeatureAggregation, BaselineStats

# Days of the user's own history required before a baseline is usable.
RAMP_UP_DAYS = 14


def baseline_provenance(baseline_type: str, observed_days: int) -> Dict[str, object]:
    """How far a reading can be trusted, in a form a UI can render directly.

    Returned alongside every score so a reading taken before the user has their
    own history cannot be shown as if it were a settled one. `is_provisional`
    is the flag to gate on; `days_remaining` is what to put in "learning this
    student's baseline (N days left)".
    """
    remaining = max(0, RAMP_UP_DAYS - observed_days)
    return {
        "baseline_type": baseline_type,
        "observed_days": observed_days,
        "ramp_up_days": RAMP_UP_DAYS,
        "days_remaining": remaining,
        "is_provisional": baseline_type != "user",
    }


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


def get_effective_baseline(
    user_id: str,
    aggregations: List[DailyFeatureAggregation],
) -> Tuple[Optional[BaselineStats], str]:
    """
    Returns the user's own baseline, or None when there is not enough history.

    baseline_type:
      "none" — fewer than RAMP_UP_DAYS of the user's own data; no baseline, so
               no z-score may be computed
      "user" — RAMP_UP_DAYS+ of data; fully personal baseline
    """
    if len(aggregations) < RAMP_UP_DAYS:
        return None, "none"

    return estimate_baseline(user_id, aggregations), "user"
