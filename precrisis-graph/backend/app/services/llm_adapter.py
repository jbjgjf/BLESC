import logging
import os
from typing import Any, Dict, Optional

import httpx
from openai import OpenAI
from dotenv import load_dotenv

load_dotenv()

from ..ontology.repair import get_fallback_extraction, repair_json_string
from ..ontology.validator import validate_extraction

logger = logging.getLogger(__name__)


def _is_vercel() -> bool:
    """Vercel (and other serverless) environments set VERCEL=1 at runtime."""
    return bool(os.getenv("VERCEL") or os.getenv("VERCEL_ENV"))


def _check_ollama_running() -> bool:
    """Return True only when Ollama is reachable locally."""
    host = os.getenv("OLLAMA_HOST", "http://localhost:11434")
    try:
        r = httpx.get(f"{host}/api/tags", timeout=2.0)
        return r.status_code == 200
    except Exception:
        return False


class LLMAdapter:
    def __init__(self):
        openai_key = os.getenv("OPENAI_API_KEY")
        force_mock = os.getenv("USE_MOCK_LLM", "").lower() == "true"

        if force_mock:
            self._init_mock("USE_MOCK_LLM=true (explicit override)")

        elif openai_key:
            # Priority 1: OpenAI — works in all environments including Vercel
            self.use_mock = False
            self.api_key = openai_key
            self.openai_url = os.getenv("LLM_OPENAI_BASE_URL", "https://api.openai.com/v1")
            self.model_name = os.getenv("LLM_MODEL_NAME", "gpt-4o-mini")
            self.use_json_format = True
            logger.info("[llm] mode=openai model=%s", self.model_name)

        elif not _is_vercel() and _check_ollama_running():
            # Priority 2: Ollama local — only when NOT on Vercel
            host = os.getenv("OLLAMA_HOST", "http://localhost:11434")
            self.use_mock = False
            self.api_key = "ollama"
            self.openai_url = f"{host}/v1"
            self.model_name = os.getenv("OLLAMA_MODEL", "qwen2.5:14b")
            self.use_json_format = False  # rely on prompt + repair_json_string
            logger.info("[llm] mode=ollama model=%s", self.model_name)

        else:
            reason = (
                "Vercel environment — set OPENAI_API_KEY for real extraction"
                if _is_vercel()
                else "no OPENAI_API_KEY and Ollama not running — run: ollama serve"
            )
            self._init_mock(reason)

        self.client = OpenAI(base_url=self.openai_url, api_key=self.api_key)

    def _init_mock(self, reason: str) -> None:
        self.use_mock = True
        self.api_key = "dummy"
        self.openai_url = "http://localhost:11434/v1"
        self.model_name = "dummy"
        self.use_json_format = False
        logger.warning("[llm] mode=mock reason=%s", reason)

    def extract_structure(self, text: str) -> Dict[str, Any]:
        """Always returns a valid dict — never raises."""
        try:
            result = self._mock_extract(text) if self.use_mock else self._real_extract(text)
            if not isinstance(result, dict):
                logger.warning("[llm] extraction returned non-dict type=%s; using fallback", type(result))
                return get_fallback_extraction()
            return result
        except Exception:
            logger.exception("[llm] extract_structure raised; using fallback")
            return get_fallback_extraction()

    def _real_extract(self, text: str) -> Dict[str, Any]:
        kwargs: Dict[str, Any] = {
            "model": self.model_name,
            "messages": [
                {"role": "system", "content": "You are a specialized ontology extractor for research journaling."},
                {"role": "user", "content": self._get_prompt(text)},
            ],
            "temperature": 0.1,
        }
        if self.use_json_format:
            kwargs["response_format"] = {"type": "json_object"}

        try:
            response = self.client.chat.completions.create(**kwargs)
            raw_content = response.choices[0].message.content
            parsed = repair_json_string(raw_content)
            return validate_extraction(parsed) if parsed else get_fallback_extraction()
        except Exception:
            logger.exception("[llm] real extraction failed; using fallback")
            return get_fallback_extraction()

    def _mock_extract(self, text: str) -> Dict[str, Any]:
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

        if not nodes:
            nodes.append({"node_id": "self_1", "category": "Protective", "label": "Self / Baseline", "intensity": 0.5})

        return {
            "nodes": nodes,
            "relations": relations,
            "temporal": {"recency": "recent", "event_density": 1 if any(n.get("category") == "Event" for n in nodes) else 0},
        }

    def _get_prompt(self, text: str) -> str:
        return f"""Extract a structured representation of the following journal entry using the specified ontology categories.

Ontology Categories:
- State: Sleep issues, rumination, etc.
- Trigger: Deadlines, conflicts, etc.
- Protective: Routine, support, etc.
- Behavior: Isolation, meals, etc.
- Event: Discrete occurrences (meeting, exercise, shift) with optional start/end/duration.

Relations: causes, escalates, buffers, avoids, co_occurs, precedes.

Input text:
"{text}"

Return ONLY valid JSON in this exact format:
{{
  "nodes": [
    {{ "node_id": "string", "category": "State|Trigger|Protective|Behavior|Event", "label": "string", "intensity": 0.0, "confidence": 0.0 }}
  ],
  "relations": [
    {{ "source_node_id": "string", "target_node_id": "string", "type": "causes|escalates|buffers|avoids|co_occurs|precedes", "confidence": 0.0 }}
  ],
  "temporal": {{ "recency": "recent|ongoing|past|future|unknown", "event_density": 0, "sequence_shift": 0.0 }}
}}"""


llm_adapter = LLMAdapter()
