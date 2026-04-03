import logging
import os
from typing import Any, Dict, Optional

import httpx
from openai import OpenAI

from ..ontology.repair import get_fallback_extraction, repair_json_string
from ..ontology.validator import validate_extraction

logger = logging.getLogger(__name__)


class LLMAdapter:
    def __init__(self, use_mock: bool = False):
        self.use_mock = use_mock
        self.openai_url = os.getenv("LLM_OPENAI_BASE_URL", "http://localhost:11434/v1")
        self.api_key = os.getenv("LLM_API_KEY", "ollama")
        self.model_name = os.getenv("LLM_MODEL_NAME", "qwen2.5:7b-instruct-q4_K_M")

        self.client = OpenAI(base_url=self.openai_url, api_key=self.api_key)

    def extract_structure(self, text: str) -> Dict[str, Any]:
        """
        Main entry point for extraction.
        Always returns a valid dict — never raises.
        """
        try:
            if self.use_mock:
                result = self._mock_extract(text)
            else:
                result = self._real_extract(text)
            # Guard: validate the return value is actually a dict
            if not isinstance(result, dict):
                logger.warning("[llm_adapter] extraction returned non-dict type=%s; using fallback", type(result))
                return get_fallback_extraction()
            return result
        except Exception:
            logger.exception("[llm_adapter] extract_structure raised; using fallback")
            return get_fallback_extraction()

    def _real_extract(self, text: str) -> Dict[str, Any]:
        prompt = self._get_prompt(text)
        try:
            response = self.client.chat.completions.create(
                model=self.model_name,
                messages=[
                    {"role": "system", "content": "You are a specialized ontology extractor for research journaling."},
                    {"role": "user", "content": prompt}
                ],
                temperature=0.1,
                response_format={"type": "json_object"}
            )
            raw_content = response.choices[0].message.content
            parsed = repair_json_string(raw_content)
            if parsed:
                return validate_extraction(parsed)
            else:
                return get_fallback_extraction()
        except Exception:
            logger.exception("[llm_adapter] Qwen inference failed; using fallback extraction")
            return get_fallback_extraction()

    def _mock_extract(self, text: str) -> Dict[str, Any]:
        """
        Mock extraction for testing when LLM is unavailable.
        """
        # Simple keyword-based mock
        nodes = []
        relations = []
        low_text = text.lower()
        if "sleep" in low_text:
            nodes.append({"node_id": "sleep_1", "category": "State", "label": "sleep_issue", "intensity": 0.8})
        if "friend" in low_text:
            nodes.append({"node_id": "friend_1", "category": "Protective", "label": "support_person", "intensity": 0.7})
        if "meeting" in low_text:
            nodes.append({"node_id": "meeting_1", "category": "Event", "label": "evaluation_event", "intensity": 0.5})
        if "deadline" in low_text and nodes:
            nodes.append({"node_id": "deadline_1", "category": "Trigger", "label": "deadline", "intensity": 0.6})
            relations.append({"source_node_id": "deadline_1", "target_node_id": "sleep_1", "type": "escalates", "confidence": 0.7})
            
        return {
            "nodes": nodes,
            "relations": relations,
            "temporal": {"recency": "recent", "event_density": 1 if any(n.get("category") == "Event" for n in nodes) else 0},
        }

    def _get_prompt(self, text: str) -> str:
        return f"""
        Extract a structured representation of the following journal entry using the specified ontology categories.
        
        Ontology Categories:
        - State: Sleep issues, rumination, etc.
        - Trigger: Deadlines, conflicts, etc.
        - Protective: Routine, support, etc.
        - Behavior: Isolation, meals, etc.
        - Event: Discrete occurrences (meeting, exercise, shift) with optional start/end/duration.
        
        Structural expectations:
        - Treat abstract structural features as the primary output.
        - Include Event nodes when a discrete occurrence is present.
        - Capture relations that change support, escalation, avoidance, or temporal order.
        - Return a local graph summary with a compact node and relation inventory.
        
        Relations:
        - causes, escalates, buffers, avoids, co_occurs, precedes.
        
        Input text:
        "{text}"
        
        Format as JSON:
        {{
          "nodes": [
            {{ "node_id": "string", "category": "State|Trigger|Protective|Behavior|Event", "label": "string", "intensity": 0.0-1.0, "confidence": 0.0-1.0, "start_time": "ISO-8601", "end_time": "ISO-8601", "duration": float_minutes }}
          ],
          "relations": [
            {{ "source_node_id": "string", "target_node_id": "string", "type": "causes|escalates|buffers|avoids|co_occurs|precedes", "confidence": 0.0-1.0 }}
          ],
          "temporal": {{ "recency": "recent|ongoing|past|future|unknown", "event_density": 0, "sequence_shift": 0.0 }}
        }}
        """

llm_adapter = LLMAdapter(use_mock=os.getenv("USE_MOCK_LLM", "true") == "true")
