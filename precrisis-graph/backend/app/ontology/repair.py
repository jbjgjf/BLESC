import json
import re
from typing import Dict, Any, Optional

def repair_json_string(raw_output: str) -> Optional[Dict[str, Any]]:
    """
    Cleans up LLM output (removing markdown fences, etc.) and attempts to parse JSON.
    """
    # Remove triple backticks and markdown markers
    clean_text = re.sub(r'```(?:json)?', '', raw_output)
    clean_text = re.sub(r'```', '', clean_text)
    clean_text = clean_text.strip()
    
    try:
        data = json.loads(clean_text)
        return data
    except json.JSONDecodeError:
        # Try a more aggressive regex search for the first { and last }
        match = re.search(r'(\{.*\})', clean_text, re.DOTALL)
        if match:
            try:
                return json.loads(match.group(1))
            except json.JSONDecodeError:
                pass
    return None

def get_fallback_extraction() -> Dict[str, Any]:
    """
    Returns a safe, empty extraction structure.
    """
    return {
        "nodes": [],
        "relations": [],
        "temporal": {"recency": "unknown"},
        "graph_summary": {
            "node_count": 0,
            "relation_count": 0,
            "event_count": 0,
            "category_counts": {},
            "key_nodes": [],
            "key_relations": [],
            "summary": "empty graph",
        },
        "error_flag": True
    }
