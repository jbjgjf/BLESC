from typing import Dict, Any, List
from ..schemas.analytics import DailyFeatureAggregation, BaselineStats, AnomalyResult

def compute_zscores(feature_vector: Dict[str, Any], baseline_stats: Dict[str, Any]) -> Dict[str, float]:
    """
    Computes per-feature z-scores based on baseline means and stds.
    """
    z_scores = {}
    for key, stats in baseline_stats.items():
        val = feature_vector.get(key, 0.0)
        mean = stats.get("mean", 0.0)
        std = stats.get("std", 1.0)
        if std == 0:
            z_scores[key] = 0.0
        else:
            z_scores[key] = (val - mean) / std
            
    return z_scores

def calculate_anomaly_score(z_scores: Dict[str, float]) -> float:
    """
    Aggregates z-scores into a single baseline-deviation score.
    """
    # Specific weights for Phase 1
    weights = {
        "state_count": 0.2,
        "trigger_count": 0.1,
        "event_count": 0.1,
        "isolation_signal": 0.3,
        "behavior_count": 0.1,
        "protective_ratio": -0.3,  # negative because drop is anomaly
        "event_avg_duration": 0.1,
        "event_transition_signal": 0.1,
    }
    
    score = 0.0
    for key, weight in weights.items():
        z = z_scores.get(key, 0.0)
        score += z * weight
        
    return max(0.0, score)
