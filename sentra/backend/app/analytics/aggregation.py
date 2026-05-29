import logging
from datetime import date
from typing import Any, Dict, List, Optional, Union

from ..schemas.analytics import DailyFeatureAggregation
from ..schemas.extraction import Extraction

logger = logging.getLogger(__name__)


def _safe_float(value: Any, default: float = 0.0) -> float:
    """Convert a value to float safely; return *default* if conversion fails."""
    if value is None:
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _normalize_node(node: Dict[str, Any]) -> Dict[str, Any]:
    """
    Normalise a raw node dict so that all numeric fields are safe floats and
    optional Event fields are coerced from None to sensible defaults.
    """
    normed = dict(node)
    normed["intensity"] = _safe_float(normed.get("intensity"), 0.5)
    normed["confidence"] = _safe_float(normed.get("confidence"), 1.0)
    # Event-specific optional fields
    normed["duration"] = _safe_float(normed.get("duration"), 0.0)
    return normed


def _normalize_relation(rel: Dict[str, Any]) -> Dict[str, Any]:
    """Normalise a raw relation dict so that all numeric fields are safe floats."""
    normed = dict(rel)
    normed["confidence"] = _safe_float(normed.get("confidence"), 1.0)
    return normed


def aggregate_daily_features(
    user_id: str,
    day: date,
    extractions: List[Extraction],
) -> DailyFeatureAggregation:
    """
    Combines all extracted structural nodes from multiple entries on a single
    day into a feature vector.

    All field accesses are null-safe: missing or non-numeric values fall back
    to 0 (or 0.5 for intensity) so a partial extraction never crashes this
    function.
    """
    logger.info(
        "[aggregation] start user=%s day=%s extractions=%d",
        user_id, day, len(extractions),
    )

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
        raw_nodes = ext.nodes_json or []
        raw_relations = ext.relations_json or []

        for raw_node in raw_nodes:
            try:
                node = _normalize_node(raw_node)
                cat = node.get("category") or node.get("class") or ""
                if cat == "State":
                    state_count += 1
                elif cat == "Trigger":
                    trigger_count += 1
                elif cat == "Protective":
                    protective_count += 1
                elif cat == "Behavior":
                    behavior_count += 1
                    if node.get("label") == "isolation":
                        isolation_score += node["intensity"]
                elif cat == "Event":
                    event_count += 1
                    total_duration += node["duration"]
                else:
                    logger.debug("[aggregation] unknown node category=%r; skipping", cat)
            except Exception:
                logger.exception("[aggregation] failed to process node=%r; skipping", raw_node)

        for raw_rel in raw_relations:
            try:
                rel = _normalize_relation(raw_rel)
                relation_count += 1
                rel_type = rel.get("type", "")
                if rel_type == "buffers":
                    protective_relation_count += 1
                if rel_type == "precedes":
                    event_transition_count += 1
            except Exception:
                logger.exception("[aggregation] failed to process relation=%r; skipping", raw_rel)

    total_risk_nodes = state_count + trigger_count + behavior_count
    protective_ratio = protective_count / max(1, total_risk_nodes)

    avg_duration = total_duration / max(1, event_count)
    event_transition_signal = event_transition_count / max(1, event_count)
    relation_density = relation_count / max(
        1, state_count + trigger_count + protective_count + behavior_count + event_count
    )
    protective_buffer_ratio = protective_relation_count / max(1, relation_count)

    feature_vector: Dict[str, float] = {
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

    logger.info("[aggregation] feature_vector=%s", feature_vector)

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
        feature_vector_json=feature_vector,
    )
