import logging
from typing import Any, Dict, List

from ..analytics.graph_features import build_graph_summary
# Same contents as the sets that used to be declared here; schema.py adds the
# provenance and scope notes that a bare set could not carry. Behaviour is
# unchanged — this is an import, not a vocabulary change.
from .schema import VALID_CATEGORIES, VALID_RELATIONS

logger = logging.getLogger(__name__)

DEFAULT_CATEGORY = "State"
DEFAULT_RELATION = "co_occurs"


def _record_coercion(
    coercions: List[Dict[str, Any]],
    *,
    element_id: str,
    field: str,
    original: Any,
    replacement: str,
    reason: str,
) -> None:
    """Note a value the model produced that the schema would not accept.

    These used to be replaced silently, so the share of a graph that was
    extracted rather than defaulted could not be known: every unrecognised
    category became a State and every unrecognised relation became co_occurs,
    indistinguishable from the model genuinely choosing them.

    'missing' and 'invalid' are kept apart because they call for different
    fixes — a field the model omits is a prompt or schema problem, a value it
    invents is a vocabulary problem.
    """
    coercions.append(
        {
            "element_id": element_id,
            "field": field,
            "original": original,
            "replacement": replacement,
            "reason": reason,
        }
    )
    logger.warning(
        "ontology coercion: %s.%s %r -> %r (%s)",
        element_id,
        field,
        original,
        replacement,
        reason,
    )


def validate_extraction(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Validates a raw extraction dictionary.
    Returns a cleaned version.
    """
    nodes = data.get("nodes", [])
    relations = data.get("relations", [])

    clean_nodes = []
    seen_ids = set()
    coercions: List[Dict[str, Any]] = []

    for node in nodes:
        node_id = str(node.get("node_id", node.get("id", "")))
        if not node_id or node_id in seen_ids:
            continue

        raw_category = node.get("class", node.get("category"))
        category = raw_category
        if raw_category is None:
            category = DEFAULT_CATEGORY
            _record_coercion(
                coercions,
                element_id=node_id,
                field="category",
                original=None,
                replacement=DEFAULT_CATEGORY,
                reason="missing",
            )
        elif raw_category not in VALID_CATEGORIES:
            category = DEFAULT_CATEGORY
            _record_coercion(
                coercions,
                element_id=node_id,
                field="category",
                original=raw_category,
                replacement=DEFAULT_CATEGORY,
                reason="invalid",
            )

        clean_node = {
            "id": node_id,
            "category": category,
            "label": node.get("label", node.get("node_id", "Unknown")),
            "intensity": float(node.get("intensity", 0.5)),
            "confidence": float(node.get("confidence", 1.0)),
            "evidence_text": node.get("evidence_text", ""),
            "rationale_tag": node.get("rationale_tag", ""),
        }

        # Add event-specific fields if category is Event
        if category == "Event":
            clean_node["start_time"] = node.get("start_time")
            clean_node["end_time"] = node.get("end_time")
            clean_node["duration"] = node.get("duration")

        clean_nodes.append(clean_node)
        seen_ids.add(node_id)

    clean_relations = []
    for rel in relations:
        source_id = str(rel.get("source_node_id", rel.get("source_id", "")))
        target_id = str(rel.get("target_node_id", rel.get("target_id", "")))
        raw_type = rel.get("type")
        rel_type = raw_type

        if source_id in seen_ids and target_id in seen_ids:
            edge_id = f"{source_id}->{target_id}"
            if raw_type is None:
                rel_type = DEFAULT_RELATION
                _record_coercion(
                    coercions,
                    element_id=edge_id,
                    field="type",
                    original=None,
                    replacement=DEFAULT_RELATION,
                    reason="missing",
                )
            elif raw_type not in VALID_RELATIONS:
                rel_type = DEFAULT_RELATION
                _record_coercion(
                    coercions,
                    element_id=edge_id,
                    field="type",
                    original=raw_type,
                    replacement=DEFAULT_RELATION,
                    reason="invalid",
                )

            clean_relations.append(
                {
                    "source_id": source_id,
                    "target_id": target_id,
                    "type": rel_type,
                    "confidence": float(rel.get("confidence", 1.0)),
                    "evidence_text": rel.get("evidence_text", ""),
                    "rationale_tag": rel.get("rationale_tag", ""),
                }
            )

    graph_summary = build_graph_summary(clean_nodes, clean_relations)

    # Denominator is what survived validation, so the rate answers "what share
    # of this graph is the model's own choice rather than a default?" — the
    # question a rising number should trigger prompt work over.
    element_count = len(clean_nodes) + len(clean_relations)

    return {
        "nodes": clean_nodes,
        "relations": clean_relations,
        "temporal_summary": data.get("temporal", {}).get("recency", "unknown")
        if isinstance(data.get("temporal", {}), dict)
        else "unknown",
        "graph_summary": graph_summary,
        "temporal": data.get("temporal", {}),
        "uncertainty": data.get("uncertainty", {}),
        "safety_flags": data.get("safety_flags", []),
        "coercion_count": len(coercions),
        "coerced_fields": coercions,
        "coercion_rate": round(len(coercions) / element_count, 6) if element_count else 0.0,
    }
