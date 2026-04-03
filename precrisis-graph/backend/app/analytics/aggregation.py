from datetime import date
from typing import List, Dict, Any
from ..schemas.extraction import Extraction
from ..schemas.analytics import DailyFeatureAggregation

def aggregate_daily_features(user_id: str, day: date, extractions: List[Extraction]) -> DailyFeatureAggregation:
    """
    Combines all extracted structural nodes from multiple entries on a single day into a feature vector.
    """
    state_count = 0
    trigger_count = 0
    protective_count = 0
    behavior_count = 0
    event_count = 0
    total_duration = 0.0
    event_transition_count = 0
    relation_count = 0
    protective_relation_count = 0
    
    isolation_score = 0.0
    
    for ext in extractions:
        for node in ext.nodes_json:
            cat = node.get("category")
            if cat == "State":
                state_count += 1
            elif cat == "Trigger":
                trigger_count += 1
            elif cat == "Protective":
                protective_count += 1
            elif cat == "Behavior":
                behavior_count += 1
                if node.get("label") == "isolation":
                    isolation_score += node.get("intensity", 1.0)
            elif cat == "Event":
                event_count += 1
                total_duration += float(node.get("duration", 0.0))
        for relation in ext.relations_json:
            relation_count += 1
            if relation.get("type") == "buffers":
                protective_relation_count += 1
            if relation.get("type") == "precedes":
                event_transition_count += 1

    total_risk_nodes = state_count + trigger_count + behavior_count
    protective_ratio = protective_count / max(1, total_risk_nodes)
    
    avg_duration = total_duration / max(1, event_count)
    event_transition_signal = event_transition_count / max(1, event_count)
    relation_density = relation_count / max(1, state_count + trigger_count + protective_count + behavior_count + event_count)
    protective_buffer_ratio = protective_relation_count / max(1, relation_count)
    
    feature_vector = {
        "state_count": state_count,
        "trigger_count": trigger_count,
        "protective_count": protective_count,
        "behavior_count": behavior_count,
        "event_count": event_count,
        "event_avg_duration": avg_duration,
        "event_transition_signal": event_transition_signal,
        "protective_ratio": protective_ratio,
        "protective_buffer_ratio": protective_buffer_ratio,
        "relation_density": relation_density,
        "isolation_signal": isolation_score,
    }
    
    return DailyFeatureAggregation(
        user_id=user_id,
        day=day,
        state_count=state_count,
        trigger_count=trigger_count,
        protective_count=protective_count,
        behavior_count=behavior_count,
        event_count=event_count,
        event_avg_duration=avg_duration,
        protective_ratio=protective_ratio,
        isolation_signal=isolation_score,
        feature_vector_json=feature_vector
    )
