from __future__ import annotations

from collections import Counter
from datetime import date
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple


def _node_key(node: Dict[str, Any]) -> str:
    return str(node.get("id") or node.get("node_id") or node.get("source_id") or "")


def _relation_key(relation: Dict[str, Any]) -> Tuple[str, str, str]:
    return (
        str(relation.get("source_id") or relation.get("source_node_id") or ""),
        str(relation.get("target_id") or relation.get("target_node_id") or ""),
        str(relation.get("type") or "co_occurs"),
    )


def build_graph_summary(nodes: List[Dict[str, Any]], relations: List[Dict[str, Any]]) -> Dict[str, Any]:
    category_counts = Counter(node.get("category", "State") for node in nodes)
    event_nodes = [node for node in nodes if node.get("category") == "Event"]
    key_nodes = sorted(nodes, key=lambda node: (float(node.get("confidence", 1.0)), float(node.get("intensity", 0.5))), reverse=True)[:6]
    key_relations = sorted(relations, key=lambda rel: float(rel.get("confidence", 1.0)), reverse=True)[:6]

    summary_bits = [f"{len(nodes)} nodes", f"{len(relations)} relations"]
    if event_nodes:
        summary_bits.append(f"{len(event_nodes)} events")
    if category_counts.get("Protective", 0):
        summary_bits.append(f"{category_counts['Protective']} protective nodes")

    return {
        "node_count": len(nodes),
        "relation_count": len(relations),
        "event_count": len(event_nodes),
        "category_counts": dict(category_counts),
        "key_nodes": key_nodes,
        "key_relations": key_relations,
        "summary": ", ".join(summary_bits) if summary_bits else "empty graph",
    }


def build_temporal_graph_diff(
    current_nodes: List[Dict[str, Any]],
    current_relations: List[Dict[str, Any]],
    previous_nodes: Optional[List[Dict[str, Any]]] = None,
    previous_relations: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    previous_nodes = previous_nodes or []
    previous_relations = previous_relations or []

    current_node_map = {_node_key(node): node for node in current_nodes if _node_key(node)}
    previous_node_map = {_node_key(node): node for node in previous_nodes if _node_key(node)}

    current_relation_map = {_relation_key(rel): rel for rel in current_relations}
    previous_relation_map = {_relation_key(rel): rel for rel in previous_relations}

    added_nodes = [node for node_id, node in current_node_map.items() if node_id not in previous_node_map]
    removed_nodes = [node for node_id, node in previous_node_map.items() if node_id not in current_node_map]

    added_relations = [rel for key, rel in current_relation_map.items() if key not in previous_relation_map]
    removed_relations = [rel for key, rel in previous_relation_map.items() if key not in current_relation_map]

    changed_relations = []
    shared_relation_keys = set(current_relation_map.keys()).intersection(previous_relation_map.keys())
    for key in shared_relation_keys:
        current_rel = current_relation_map[key]
        previous_rel = previous_relation_map[key]
        current_conf = float(current_rel.get("confidence", 1.0))
        previous_conf = float(previous_rel.get("confidence", 1.0))
        if abs(current_conf - previous_conf) >= 0.15:
            changed_relations.append(
                {
                    "source_id": key[0],
                    "target_id": key[1],
                    "type": key[2],
                    "previous_confidence": previous_conf,
                    "current_confidence": current_conf,
                    "confidence_delta": current_conf - previous_conf,
                }
            )

    return {
        "added_nodes": added_nodes,
        "removed_nodes": removed_nodes,
        "added_relations": added_relations,
        "removed_relations": removed_relations,
        "changed_relations": changed_relations,
    }


def summarize_temporal_diff(diff: Dict[str, Any], current_summary: Dict[str, Any], previous_summary: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    previous_summary = previous_summary or {}
    protective_drop = 0.0
    if previous_summary:
        protective_drop = max(
            0.0,
            float(previous_summary.get("category_counts", {}).get("Protective", 0))
            - float(current_summary.get("category_counts", {}).get("Protective", 0)),
        )

    relation_shift_summary = (
        f"{len(diff['added_nodes'])} nodes added, {len(diff['removed_nodes'])} removed, "
        f"{len(diff['added_relations'])} relations added, {len(diff['removed_relations'])} removed"
    )

    return {
        **diff,
        "relation_shift_summary": relation_shift_summary,
        "protective_decline": {
            "drop_in_protective_nodes": protective_drop,
            "current_protective_nodes": current_summary.get("category_counts", {}).get("Protective", 0),
            "previous_protective_nodes": previous_summary.get("category_counts", {}).get("Protective", 0),
        },
        "uncertainty": {
            "level": "low" if current_summary.get("node_count", 0) >= 4 else "medium",
            "reasons": [
                "Sparse graph coverage" if current_summary.get("node_count", 0) < 4 else "Graph coverage is adequate",
                "No prior graph to compare" if not previous_summary else "Compared with prior structural snapshot",
            ],
        },
    }

