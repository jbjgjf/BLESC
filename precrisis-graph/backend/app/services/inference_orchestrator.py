from datetime import date, datetime, timedelta
from typing import List, Optional
from sqlmodel import Session, select, func
from ..schemas.entry import Entry
from ..schemas.extraction import Extraction
from ..schemas.analytics import DailyFeatureAggregation, BaselineStats, AnomalyResult
from ..schemas.explanation import ExplanationPayload
from ..analytics.aggregation import aggregate_daily_features
from ..analytics.baseline import estimate_baseline
from ..analytics.scoring import compute_zscores, calculate_anomaly_score
from ..analytics.explanation_gen import generate_explanation

class InferenceOrchestrator:
    def __init__(self, session: Session):
        self.session = session

    def process_day(self, user_id: str, day: date) -> AnomalyResult:
        """
        Orchestrates the entire analytics pipeline for a user on a given day.
        1. Aggregates all extractions for the day.
        2. Estimates/fetches the baseline (e.g., previous 7-14 days).
        3. Computes z-scores and anomaly score.
        4. Generates a structured explanation.
        """
        # 1. Fetch data for this day
        # Query entries for this user on this day
        # For simplicity in Phase 1, we match only by exact date
        # (Practical implementation would need a range)
        query = select(Extraction).join(Entry).where(
            Entry.user_id == user_id,
            func.date(Entry.created_at) == day
        )
        extractions = self.session.exec(query).all()
        
        if not extractions:
            return None
            
        # 2. Daily feature aggregation
        aggregation = aggregate_daily_features(user_id, day, list(extractions))
        self.session.add(aggregation)
        self.session.commit()
        self.session.refresh(aggregation)
        
        # 3. Baseline estimation (previous 7 aggregations)
        historical_query = select(DailyFeatureAggregation).where(
            DailyFeatureAggregation.user_id == user_id,
            DailyFeatureAggregation.day < day
        ).order_by(DailyFeatureAggregation.day.desc()).limit(7)
        history = self.session.exec(historical_query).all()
        
        if len(history) < 2:  # Need at least 2 days for baseline
            return AnomalyResult(user_id=user_id, day=day, anomaly_score=0.0, z_scores_json={})
            
        baseline = estimate_baseline(user_id, list(history))
        self.session.add(baseline)
        self.session.commit()
        
        # 4. Generate scores
        z_scores = compute_zscores(aggregation.feature_vector_json, baseline.stats_json)
        anomaly_score = calculate_anomaly_score(z_scores)
        
        # 5. Generate Explanation
        explanation = generate_explanation(user_id, datetime.combine(day, datetime.min.time()), aggregation.feature_vector_json, z_scores)
        self.session.add(explanation)
        self.session.commit()
        self.session.refresh(explanation)
        
        # 6. Save result
        result = AnomalyResult(
            user_id=user_id,
            day=day,
            anomaly_score=anomaly_score,
            z_scores_json=z_scores,
            explanation_id=explanation.id
        )
        self.session.add(result)
        self.session.commit()
        self.session.refresh(result)
        
        return result
