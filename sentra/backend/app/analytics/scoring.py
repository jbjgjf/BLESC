from typing import Dict, Any

# The live baseline-deviation weights are in
# hybrid_inference.score_baseline_deviation. A second, divergent copy used to
# sit here inside calculate_anomaly_score — unreferenced since the orchestrator
# moved to hybrid_inference, but close enough to the live table to be read or
# edited by mistake (state_count 0.20 vs 0.18, isolation_signal 0.30 vs 0.22).
# This module is now compute_zscores only, so the codebase holds exactly one
# weight table.


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
