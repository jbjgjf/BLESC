from __future__ import annotations

from datetime import date, datetime
from typing import Optional

from sqlmodel import Session, select, func

from ..analytics.aggregation import aggregate_daily_features
from ..analytics.baseline import estimate_baseline
from ..analytics.explanation_gen import RuleEngine, generate_explanation
from ..analytics.graph_features import build_graph_summary
from ..analytics.hybrid_inference import combine_hybrid_score, score_baseline_deviation, score_temporal_shift
from ..analytics.scoring import compute_zscores
from ..schemas.analytics import AnomalyResult, BaselineStats, DailyFeatureAggregation
from ..schemas.entry import Entry
from ..schemas.extraction import Extraction
from ..schemas.structured import GraphSnapshot, HybridExplanation


class InferenceOrchestrator:
    def __init__(self, session: Session):
        self.session = session

    def _load_current_graph_snapshot(self, user_id: str, day: date) -> Optional[GraphSnapshot]:
        query = (
            select(GraphSnapshot)
            .where(GraphSnapshot.user_id == user_id, GraphSnapshot.day == day)
            .order_by(GraphSnapshot.created_at.desc())
            .limit(1)
        )
        return self.session.exec(query).first()

    def process_day(self, user_id: str, day: date) -> Optional[AnomalyResult]:
        """
        Orchestrates the hybrid structural-change pipeline for a user on a given day.
        """
        query = select(Extraction).join(Entry).where(Entry.user_id == user_id, func.date(Entry.created_at) == day)
        extractions = self.session.exec(query).all()
        if not extractions:
            return None

        aggregation = aggregate_daily_features(user_id, day, list(extractions))
        self.session.add(aggregation)
        self.session.commit()
        self.session.refresh(aggregation)

        historical_query = select(DailyFeatureAggregation).where(
            DailyFeatureAggregation.user_id == user_id,
            DailyFeatureAggregation.day < day,
        ).order_by(DailyFeatureAggregation.day.desc()).limit(7)
        history = self.session.exec(historical_query).all()

        baseline = None
        if len(history) >= 2:
            baseline = estimate_baseline(user_id, list(history))
            self.session.add(baseline)
            self.session.commit()

        z_scores = compute_zscores(aggregation.feature_vector_json, baseline.stats_json if baseline else {})
        baseline_deviation = {
            "feature_zscores": z_scores,
            "baseline_available": baseline is not None,
            "top_features": [name for name, _ in sorted(z_scores.items(), key=lambda item: abs(item[1]), reverse=True)[:4]],
            "score": round(score_baseline_deviation(z_scores), 3),
        }

        graph_snapshot = self._load_current_graph_snapshot(user_id, day)
        if graph_snapshot:
            graph_summary = graph_snapshot.graph_summary_json
            graph_diff = graph_snapshot.temporal_diff_json
        else:
            graph_summary = build_graph_summary([], [])
            graph_diff = {
                "added_nodes": [],
                "removed_nodes": [],
                "added_relations": [],
                "removed_relations": [],
                "changed_relations": [],
                "relation_shift_summary": "No graph snapshot available",
                "protective_decline": {"drop_in_protective_nodes": 0, "current_protective_nodes": 0, "previous_protective_nodes": 0},
                "uncertainty": {"level": "high", "reasons": ["Graph snapshot missing"], "missing_signals": ["local graph"]},
            }

        rule_context = graph_diff
        rule_hits = RuleEngine().check_rules(
            aggregation.feature_vector_json,
            z_scores,
            graph_summary,
            graph_diff,
        )
        score_breakdown = combine_hybrid_score(
            rule_hits,
            baseline_deviation["score"],
            score_temporal_shift(rule_context),
        )

        explanation = generate_explanation(
            user_id=user_id,
            day=datetime.combine(day, datetime.min.time()),
            feature_vector=aggregation.feature_vector_json,
            z_scores=z_scores,
            graph_summary=graph_summary,
            graph_diff=graph_diff,
            baseline_deviation=baseline_deviation,
            score_breakdown=score_breakdown,
        )
        self.session.add(explanation)
        self.session.commit()
        self.session.refresh(explanation)

        result = AnomalyResult(
            user_id=user_id,
            day=day,
            anomaly_score=score_breakdown["final_score"],
            z_scores_json={
                **z_scores,
                "baseline_deviation_score": baseline_deviation["score"],
                "temporal_shift_score": score_breakdown["temporal_shift_score"],
            },
            explanation_id=explanation.id,
        )
        self.session.add(result)
        self.session.commit()
        self.session.refresh(result)

        return result
