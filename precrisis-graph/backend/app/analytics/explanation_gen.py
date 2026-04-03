from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List

from .hybrid_inference import RuleHit, build_uncertainty
from ..schemas.structured import HybridExplanation


class RuleEngine:
    """
    Deterministic rules for structural-change detection.
    """

    def check_rules(
        self,
        feature_vector: Dict[str, Any],
        z_scores: Dict[str, float],
        graph_summary: Dict[str, Any],
        graph_diff: Dict[str, Any],
    ) -> List[RuleHit]:
        contributions: List[RuleHit] = []

        if z_scores.get("isolation_signal", 0.0) > 1.8 or feature_vector.get("isolation_signal", 0.0) > 0.8:
            contributions.append(
                RuleHit(
                    rule="isolation_spike",
                    evidence="Isolation signal rose relative to the baseline and the structural graph is centered on fewer supportive links.",
                    weight=0.45,
                    signal={"feature": "isolation_signal", "z": z_scores.get("isolation_signal", 0.0)},
                )
            )

        protective_ratio = float(feature_vector.get("protective_ratio", 1.0))
        protective_drop = float(graph_diff.get("protective_decline", {}).get("drop_in_protective_nodes", 0.0))
        if protective_ratio < 0.2 or protective_drop > 0:
            contributions.append(
                RuleHit(
                    rule="protective_decline",
                    evidence="Protective structure weakened: the daily graph has fewer protective nodes or lower protective ratio than the baseline.",
                    weight=0.4,
                    signal={
                        "protective_ratio": protective_ratio,
                        "protective_drop": protective_drop,
                    },
                )
            )

        if z_scores.get("state_count", 0.0) > 1.25 or z_scores.get("trigger_count", 0.0) > 1.25:
            contributions.append(
                RuleHit(
                    rule="state_trigger_inflation",
                    evidence="Distressing states or triggers expanded beyond the baseline pattern.",
                    weight=0.25,
                    signal={
                        "state_count_z": z_scores.get("state_count", 0.0),
                        "trigger_count_z": z_scores.get("trigger_count", 0.0),
                    },
                )
            )

        if graph_summary.get("event_count", 0) > 0 and z_scores.get("event_transition_signal", 0.0) > 1.2:
            contributions.append(
                RuleHit(
                    rule="event_sequence_shift",
                    evidence="Event nodes are present, but their temporal sequencing differs from the baseline graph.",
                    weight=0.3,
                    signal={
                        "event_count": graph_summary.get("event_count", 0),
                        "event_transition_signal_z": z_scores.get("event_transition_signal", 0.0),
                    },
                )
            )

        if len(graph_diff.get("changed_relations", [])) > 0:
            contributions.append(
                RuleHit(
                    rule="relation_reweighting",
                    evidence="Several key relations changed confidence or direction relative to the prior local graph.",
                    weight=min(0.35, 0.08 * len(graph_diff.get("changed_relations", []))),
                    signal={"changed_relations": len(graph_diff.get("changed_relations", []))},
                )
            )

        return contributions


def generate_explanation(
    user_id: str,
    day: datetime,
    feature_vector: Dict[str, Any],
    z_scores: Dict[str, float],
    graph_summary: Dict[str, Any],
    graph_diff: Dict[str, Any],
    baseline_deviation: Dict[str, Any],
    score_breakdown: Dict[str, Any],
) -> HybridExplanation:
    engine = RuleEngine()
    contributions = engine.check_rules(feature_vector, z_scores, graph_summary, graph_diff)

    changed_relations = graph_diff.get("changed_relations", [])
    protective_decline = graph_diff.get("protective_decline", {})
    uncertainty = graph_diff.get("uncertainty", {})
    if not uncertainty.get("reasons"):
        uncertainty = build_uncertainty(
            "medium",
            ["No temporal comparison data available" if not graph_diff.get("removed_nodes") and not graph_diff.get("added_nodes") else "Temporal graph comparison available"],
            ["Prior graph context"],
        )

    evidence_summaries = [hit.evidence for hit in contributions]

    return HybridExplanation(
        user_id=user_id,
        day=day,
        triggered_rules_json=[
            {
                "rule": hit.rule,
                "evidence": hit.evidence,
                "weight": hit.weight,
                "signal": hit.signal,
            }
            for hit in contributions
        ],
        baseline_deviation_json=baseline_deviation,
        changed_relations_json=changed_relations,
        protective_decline_json=protective_decline,
        uncertainty_json=uncertainty,
        evidence_summaries=evidence_summaries,
        graph_summary_json=graph_summary,
        score_breakdown_json=score_breakdown,
    )
