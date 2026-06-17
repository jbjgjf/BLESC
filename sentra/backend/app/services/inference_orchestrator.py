from __future__ import annotations

import logging
import os
from datetime import date, datetime
from typing import Optional

from sqlmodel import Session, func, select

from ..analytics.aggregation import aggregate_daily_features
from ..analytics.baseline import get_effective_baseline
from ..analytics.explanation_gen import RuleEngine, generate_explanation
from ..analytics.graph_features import build_graph_summary
from ..analytics.hybrid_inference import combine_hybrid_score, score_baseline_deviation, score_temporal_shift
from ..analytics.scoring import compute_zscores
from ..schemas.analytics import AnomalyResult, BaselineStats, DailyFeatureAggregation
from ..schemas.entry import Entry
from ..schemas.extraction import Extraction
from ..schemas.structured import GraphSnapshot, HybridExplanation

logger = logging.getLogger(__name__)

_EMPTY_GRAPH_DIFF = {
    "added_nodes": [],
    "removed_nodes": [],
    "added_relations": [],
    "removed_relations": [],
    "changed_relations": [],
    "relation_shift_summary": "No graph snapshot available",
    "protective_decline": {
        "drop_in_protective_nodes": 0,
        "current_protective_nodes": 0,
        "previous_protective_nodes": 0,
    },
    "uncertainty": {
        "level": "high",
        "reasons": ["Graph snapshot missing"],
        "missing_signals": ["local graph"],
    },
}

MIN_REFLECTION_BASELINE_DAYS = int(os.getenv("MIN_REFLECTION_BASELINE_DAYS", "3"))


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

    def _persist_not_enough_data_explanation(
        self,
        user_id: str,
        day: date,
        aggregation: DailyFeatureAggregation,
        baseline_day_count: int,
        required_days: int,
    ) -> HybridExplanation:
        graph_snapshot = self._load_current_graph_snapshot(user_id, day)
        graph_summary = graph_snapshot.graph_summary_json if graph_snapshot else build_graph_summary([], [])
        explanation = HybridExplanation(
            user_id=user_id,
            day=datetime.combine(day, datetime.min.time()),
            triggered_rules_json=[],
            baseline_deviation_json={
                "status": "not_enough_data",
                "baseline_available": False,
                "baseline_day_count": baseline_day_count,
                "required_baseline_days": required_days,
                "feature_zscores": {},
                "top_features": [],
                "score": None,
                "latest_feature_vector": aggregation.feature_vector_json,
            },
            changed_relations_json=[],
            protective_decline_json={},
            uncertainty_json={
                "level": "high",
                "status": "not_enough_data",
                "reasons": [
                    f"Reflection Signal needs at least {required_days} prior day(s) of user data.",
                    f"Only {baseline_day_count} prior day(s) are available.",
                ],
                "missing_signals": ["personal baseline"],
            },
            evidence_summaries=[
                "Not enough personal history is available to calculate a Reflection Signal yet."
            ],
            graph_summary_json=graph_summary,
            score_breakdown_json={
                "status": "not_enough_data",
                "rule_score": 0.0,
                "deviation_score": 0.0,
                "temporal_shift_score": 0.0,
                "final_score": None,
            },
            key_relations=graph_summary.get("key_relations", []),
        )
        self.session.add(explanation)
        self.session.commit()
        self.session.refresh(explanation)
        logger.info(
            "[orchestrator] reflection_signal status=not_enough_data user=%s day=%s baseline_days=%s required=%s",
            user_id,
            day,
            baseline_day_count,
            required_days,
        )
        return explanation

    def process_day(self, user_id: str, day: date) -> Optional[AnomalyResult]:
        """
        Orchestrates the hybrid structural-change pipeline for a user on a given day.

        Any sub-step that fails is logged and the pipeline continues with safe
        defaults; the method returns None only if there are zero extractions for
        that day (which is a legitimate empty state, not an error).
        """
        logger.info("[orchestrator] process_day user=%s day=%s", user_id, day)

        # ── 1. Load extractions ──────────────────────────────────────────────
        query = select(Extraction).join(Entry).where(
            Entry.user_id == user_id,
            func.date(Entry.created_at) == day,
        )
        extractions = self.session.exec(query).all()
        if not extractions:
            logger.info("[orchestrator] no extractions found for user=%s day=%s", user_id, day)
            return None

        # ── 2. Aggregate features ────────────────────────────────────────────
        try:
            aggregation = aggregate_daily_features(user_id, day, list(extractions))
            self.session.add(aggregation)
            self.session.commit()
            self.session.refresh(aggregation)
            logger.info("[orchestrator] aggregation saved id=%s", aggregation.id)
        except Exception:
            logger.exception("[orchestrator] aggregation failed; using zero feature vector")
            aggregation = DailyFeatureAggregation(
                user_id=user_id,
                day=day,
                state_count=0,
                trigger_count=0,
                protective_count=0,
                behavior_count=0,
                event_count=0,
                event_avg_duration=0.0,
                protective_ratio=1.0,
                isolation_signal=0.0,
                feature_vector_json={
                    "state_count": 0, "trigger_count": 0, "protective_count": 0,
                    "behavior_count": 0, "event_count": 0, "event_avg_duration": 0.0,
                    "event_transition_signal": 0.0, "protective_ratio": 1.0,
                    "protective_buffer_ratio": 0.0, "relation_density": 0.0,
                    "isolation_signal": 0.0,
                },
            )

        # ── 3. Require a real personal history before showing a signal ──────
        try:
            historical_query = (
                select(DailyFeatureAggregation)
                .where(
                    DailyFeatureAggregation.user_id == user_id,
                    DailyFeatureAggregation.day < day,
                )
                .order_by(DailyFeatureAggregation.day.desc())
                .limit(max(MIN_REFLECTION_BASELINE_DAYS, 14))
            )
            history = self.session.exec(historical_query).all()
        except Exception:
            logger.exception("[orchestrator] historical aggregation load failed; treating as insufficient data")
            history = []

        if len(history) < MIN_REFLECTION_BASELINE_DAYS:
            self._persist_not_enough_data_explanation(
                user_id=user_id,
                day=day,
                aggregation=aggregation,
                baseline_day_count=len(history),
                required_days=MIN_REFLECTION_BASELINE_DAYS,
            )
            return None

        # ── 3. Baseline estimation ───────────────────────────────────────────
        baseline = None
        baseline_type = "population"
        try:
            baseline, baseline_type = get_effective_baseline(user_id, list(history))
            self.session.add(baseline)
            self.session.commit()
            logger.info(
                "[orchestrator] reflection_signal baseline type=%s baseline_days=%s stats_keys=%s",
                baseline_type,
                len(history),
                list(baseline.stats_json.keys()),
            )
        except Exception:
            logger.exception("[orchestrator] baseline estimation failed; continuing without baseline")

        # ── 4. Z-scores and deviation ────────────────────────────────────────
        try:
            z_scores = compute_zscores(
                aggregation.feature_vector_json,
                baseline.stats_json if baseline else {},
            )
        except Exception:
            logger.exception("[orchestrator] z-score computation failed; using empty z-scores")
            z_scores = {}

        baseline_deviation = {
            "feature_zscores": z_scores,
            "baseline_available": baseline is not None,
            "baseline_type": baseline_type,  # "population" | "blended" | "user"
            "top_features": [
                name
                for name, _ in sorted(z_scores.items(), key=lambda kv: abs(kv[1]), reverse=True)[:4]
            ],
            "score": round(score_baseline_deviation(z_scores), 3),
        }
        logger.info("[orchestrator] reflection_signal baseline_deviation score=%.3f", baseline_deviation["score"])

        # ── 5. Graph snapshot ────────────────────────────────────────────────
        try:
            graph_snapshot = self._load_current_graph_snapshot(user_id, day)
            if graph_snapshot:
                graph_summary = graph_snapshot.graph_summary_json
                graph_diff = graph_snapshot.temporal_diff_json or _EMPTY_GRAPH_DIFF
            else:
                graph_summary = build_graph_summary([], [])
                graph_diff = _EMPTY_GRAPH_DIFF
        except Exception:
            logger.exception("[orchestrator] graph snapshot load failed; using empty diff")
            graph_snapshot = None
            graph_summary = build_graph_summary([], [])
            graph_diff = _EMPTY_GRAPH_DIFF

        # ── 6. Rule engine ───────────────────────────────────────────────────
        try:
            rule_hits = RuleEngine().check_rules(
                aggregation.feature_vector_json,
                z_scores,
                graph_summary,
                graph_diff,
            )
            score_breakdown = combine_hybrid_score(
                rule_hits,
                baseline_deviation["score"],
                score_temporal_shift(graph_diff),
            )
            logger.info("[orchestrator] score_breakdown=%s", score_breakdown)
        except Exception:
            logger.exception("[orchestrator] rule engine / scoring failed; using zero scores")
            rule_hits = []
            score_breakdown = {
                "rule_score": 0.0,
                "deviation_score": baseline_deviation["score"],
                "temporal_shift_score": 0.0,
                "final_score": baseline_deviation["score"],
            }

        # ── 7. Explanation ───────────────────────────────────────────────────
        try:
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
            logger.info("[orchestrator] explanation saved id=%s", explanation.id)
        except Exception:
            logger.exception("[orchestrator] explanation generation failed; using placeholder")
            explanation = HybridExplanation(
                user_id=user_id,
                day=datetime.combine(day, datetime.min.time()),
                triggered_rules_json=[],
                baseline_deviation_json=baseline_deviation,
                changed_relations_json=[],
                protective_decline_json={},
                uncertainty_json={"level": "high", "reasons": ["Explanation generation failed"], "missing_signals": []},
                evidence_summaries=[],
                graph_summary_json=graph_summary,
                score_breakdown_json=score_breakdown,
                key_relations=[],
            )
            try:
                self.session.add(explanation)
                self.session.commit()
                self.session.refresh(explanation)
            except Exception:
                logger.exception("[orchestrator] could not persist fallback explanation")

        # ── 8. Anomaly result ────────────────────────────────────────────────
        try:
            result = AnomalyResult(
                user_id=user_id,
                day=day,
                anomaly_score=score_breakdown["final_score"],
                z_scores_json={
                    **z_scores,
                    "baseline_deviation_score": baseline_deviation["score"],
                    "temporal_shift_score": score_breakdown.get("temporal_shift_score", 0.0),
                },
                explanation_id=explanation.id if explanation.id else None,
            )
            self.session.add(result)
            self.session.commit()
            self.session.refresh(result)
            logger.info("[orchestrator] reflection_signal saved id=%s score=%.3f", result.id, result.anomaly_score)
            return result
        except Exception:
            logger.exception("[orchestrator] failed to persist anomaly result; returning None")
            return None
