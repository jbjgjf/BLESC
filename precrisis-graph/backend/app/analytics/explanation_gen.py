from typing import List, Dict, Any
from ..schemas.explanation import ExplanationPayload
from datetime import datetime

class RuleEngine:
    """
    Deterministic rules for scenario detection based on ontology-driven signals.
    """
    def check_rules(self, feature_vector: Dict[str, Any], z_scores: Dict[str, float]) -> List[Dict[str, Any]]:
        contributions = []
        
        # Rule 1: Isolation Spike
        if z_scores.get("isolation_signal", 0.0) > 2.0:
            contributions.append({
                "rule": "isolation_spike",
                "evidence": f"Isolation signal is {z_scores['isolation_signal']:.1f} standard deviations above baseline.",
                "weight": 0.4
            })
            
        # Rule 2: Protective Decline
        if feature_vector.get("protective_ratio", 1.0) < 0.2:
             contributions.append({
                "rule": "protective_decline",
                "evidence": "Protective behaviors have dropped significantly below baseline.",
                "weight": 0.3
            })
             
        # Rule 3: Sleep & Rumination State
        if z_scores.get("state_count", 0.0) > 1.5:
            contributions.append({
                "rule": "state_inflation",
                "evidence": "Distressing personal states (sleep/rumination) are elevated.",
                "weight": 0.2
            })
            
        return contributions

def generate_explanation(user_id: str, day: datetime, feature_vector: Dict[str, Any], z_scores: Dict[str, float]) -> ExplanationPayload:
    """
    Generates a structured ExplanationPayload using the rule engine.
    """
    engine = RuleEngine()
    contributions = engine.check_rules(feature_vector, z_scores)
    
    # Sort top features by z-score magnitude
    sorted_features = sorted(z_scores.items(), key=lambda x: abs(x[1]), reverse=True)
    top_features = [f[0] for f in sorted_features[:3]]
    
    evidence_summaries = [c["evidence"] for c in contributions]
    
    return ExplanationPayload(
        user_id=user_id,
        day=day,
        rule_contributions=contributions,
        feature_zscores=z_scores,
        top_features=top_features,
        uncertainty_summary="Confidence based on deterministic z-scores and ontology rules.",
        evidence_summaries=evidence_summaries
    )
