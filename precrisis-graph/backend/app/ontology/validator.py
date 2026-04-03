from typing import List, Dict, Any, Optional

from ..analytics.graph_features import build_graph_summary

VALID_CATEGORIES = {"State", "Trigger", "Protective", "Behavior", "Event"}
VALID_RELATIONS = {"causes", "escalates", "buffers", "avoids", "co_occurs", "precedes"}

def validate_extraction(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Validates a raw extraction dictionary.
    Returns a cleaned version.
    """
    nodes = data.get("nodes", [])
    relations = data.get("relations", [])
    
    clean_nodes = []
    seen_ids = set()
    
    for node in nodes:
        node_id = str(node.get("node_id", node.get("id", "")))
        if not node_id or node_id in seen_ids:
            continue
            
        category = node.get("class", node.get("category", "State"))
        if category not in VALID_CATEGORIES:
            category = "State"  # Default fallback
            
        clean_node = {
            "id": node_id,
            "category": category,
            "label": node.get("label", node.get("node_id", "Unknown")),
            "intensity": float(node.get("intensity", 0.5)),
            "confidence": float(node.get("confidence", 1.0)),
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
        rel_type = rel.get("type", "co_occurs")
        
        if source_id in seen_ids and target_id in seen_ids:
            if rel_type not in VALID_RELATIONS:
                rel_type = "co_occurs"
                
            clean_relations.append({
                "source_id": source_id,
                "target_id": target_id,
                "type": rel_type,
                "confidence": float(rel.get("confidence", 1.0))
            })
            
    graph_summary = build_graph_summary(clean_nodes, clean_relations)

    return {
        "nodes": clean_nodes,
        "relations": clean_relations,
        "temporal_summary": data.get("temporal", {}).get("recency", "unknown")
        if isinstance(data.get("temporal", {}), dict)
        else "unknown",
        "graph_summary": graph_summary,
        "temporal": data.get("temporal", {}),
    }
