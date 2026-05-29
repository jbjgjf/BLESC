from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List


@dataclass
class RuleHit:
    rule: str
    evidence: str
    weight: float
    signal: Dict[str, Any]


def score_rule_hits(rule_hits: List[RuleHit]) -> float:
    return sum(hit.weight for hit in rule_hits)


def score_baseline_deviation(z_scores: Dict[str, float]) -> float:
    weights = {
        "state_count": 0.18,
        "trigger_count": 0.12,
        "behavior_count": 0.12,
        "event_count": 0.08,
        "event_avg_duration": 0.08,
        "protective_ratio": -0.28,
        "isolation_signal": 0.22,
        "event_transition_signal": 0.12,
    }

    total = 0.0
    for key, weight in weights.items():
        total += float(z_scores.get(key, 0.0)) * weight
    return max(0.0, total)


def score_temporal_shift(graph_diff: Dict[str, Any]) -> float:
    relation_shift = len(graph_diff.get("added_relations", [])) + len(graph_diff.get("removed_relations", []))
    node_shift = len(graph_diff.get("added_nodes", [])) + len(graph_diff.get("removed_nodes", []))
    changed_relations = len(graph_diff.get("changed_relations", []))
    return min(3.0, relation_shift * 0.3 + node_shift * 0.25 + changed_relations * 0.35)


def build_uncertainty(level: str, reasons: List[str], missing_signals: List[str]) -> Dict[str, Any]:
    return {
        "level": level,
        "reasons": reasons,
        "missing_signals": missing_signals,
    }


def combine_hybrid_score(rule_hits: List[RuleHit], deviation_score: float, temporal_shift_score: float) -> Dict[str, float]:
    rule_score = score_rule_hits(rule_hits)
    final_score = min(10.0, rule_score * 2.0 + deviation_score * 1.15 + temporal_shift_score * 0.85)
    return {
        "rule_score": round(rule_score, 3),
        "deviation_score": round(deviation_score, 3),
        "temporal_shift_score": round(temporal_shift_score, 3),
        "final_score": round(final_score, 3),
    }

