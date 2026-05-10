import numpy as np
from datetime import date
from typing import List, Dict, Any
from ..schemas.analytics import DailyFeatureAggregation, BaselineStats

def estimate_baseline(user_id: str, aggregations: List[DailyFeatureAggregation]) -> BaselineStats:
    """
    Computes mean and std for each feature in the aggregation set.
    """
    if not aggregations:
        return None
        
    features_list = [agg.feature_vector_json for agg in aggregations]
    all_keys = set(features_list[0].keys())
    
    stats = {}
    for key in all_keys:
        values = [f.get(key, 0.0) for f in features_list]
        stats[key] = {
            "mean": float(np.mean(values)),
            "std": float(np.std(values))
        }
        
    # Window start and end dates
    window_start = aggregations[0].day
    window_end = aggregations[-1].day
    
    return BaselineStats(
        user_id=user_id,
        window_start=window_start,
        window_end=window_end,
        stats_json=stats
    )

