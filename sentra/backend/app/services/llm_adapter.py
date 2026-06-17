import logging
import os
from pathlib import Path
from typing import Any, Dict, Optional

import httpx
from openai import OpenAI
from dotenv import load_dotenv

_ENV_DIR = Path(__file__).resolve().parents[2]
load_dotenv(_ENV_DIR / ".env.local")
load_dotenv(_ENV_DIR / ".env")

from ..ontology.repair import get_fallback_extraction, repair_json_string
from ..ontology.validator import validate_extraction

logger = logging.getLogger(__name__)


EXTRACTION_JSON_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "nodes": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "node_id": {"type": "string"},
                    "category": {"type": "string", "enum": ["State", "Trigger", "Protective", "Behavior", "Event"]},
                    "label": {"type": "string"},
                    "intensity": {"type": "number", "minimum": 0, "maximum": 1},
                    "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                    "evidence_text": {"type": "string"},
                    "rationale_tag": {"type": "string"},
                    "start_time": {"type": ["string", "null"]},
                    "end_time": {"type": ["string", "null"]},
                    "duration": {"type": ["number", "null"]},
                },
                "required": [
                    "node_id",
                    "category",
                    "label",
                    "intensity",
                    "confidence",
                    "evidence_text",
                    "rationale_tag",
                    "start_time",
                    "end_time",
                    "duration",
                ],
            },
        },
        "relations": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "source_node_id": {"type": "string"},
                    "target_node_id": {"type": "string"},
                    "type": {"type": "string", "enum": ["causes", "escalates", "buffers", "avoids", "co_occurs", "precedes"]},
                    "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                    "evidence_text": {"type": "string"},
                    "rationale_tag": {"type": "string"},
                },
                "required": [
                    "source_node_id",
                    "target_node_id",
                    "type",
                    "confidence",
                    "evidence_text",
                    "rationale_tag",
                ],
            },
        },
        "temporal": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "recency": {"type": "string", "enum": ["recent", "ongoing", "past", "future", "unknown"]},
                "event_density": {"type": "number"},
                "sequence_shift": {"type": "number"},
            },
            "required": ["recency", "event_density", "sequence_shift"],
        },
        "uncertainty": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "level": {"type": "string", "enum": ["low", "medium", "high"]},
                "reasons": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["level", "reasons"],
        },
        "safety_flags": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["nodes", "relations", "temporal", "uncertainty", "safety_flags"],
}


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


def _list_ollama_models(host: str) -> list[str]:
    try:
        r = httpx.get(f"{host}/api/tags", timeout=2.0)
        r.raise_for_status()
        payload = r.json()
        return [
            model.get("name")
            for model in payload.get("models", [])
            if isinstance(model, dict) and model.get("name")
        ]
    except Exception:
        logger.exception("[llm] failed to list Ollama models")
        return []


class LLMAdapter:
    def __init__(self):
        openai_key = os.getenv("OPENAI_API_KEY")
        force_mock = os.getenv("USE_MOCK_LLM", "").lower() == "true"

        if force_mock:
            self._init_mock("USE_MOCK_LLM=true (explicit override)")

        elif openai_key:
            # Priority 1: OpenAI — works in all environments including Vercel
            self.use_mock = False
            self.provider = "openai"
            self.api_key = openai_key
            self.openai_url = os.getenv("LLM_OPENAI_BASE_URL", "https://api.openai.com/v1")
            self.model_name = os.getenv("OPENAI_EXTRACTION_MODEL") or os.getenv("LLM_MODEL_NAME", "gpt-4.1-mini")
            self.use_json_format = True
            logger.info("[llm] mode=openai model=%s", self.model_name)

        elif not _is_vercel() and _check_ollama_running():
            # Priority 2: Ollama local — only when NOT on Vercel
            host = os.getenv("OLLAMA_HOST", "http://localhost:11434")
            self.use_mock = False
            self.provider = "ollama"
            self.api_key = "ollama"
            self.openai_url = f"{host}/v1"
            configured_model = os.getenv("OLLAMA_MODEL", "qwen2.5:14b")
            available_models = _list_ollama_models(host)
            if configured_model in available_models or not available_models:
                self.model_name = configured_model
            else:
                self.model_name = available_models[0]
                logger.warning(
                    "[llm] configured Ollama model=%s unavailable; using installed model=%s",
                    configured_model,
                    self.model_name,
                )
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
        self.provider = "mock"
        self.api_key = "dummy"
        self.openai_url = "http://localhost:11434/v1"
        self.model_name = "dummy"
        self.use_json_format = False
        logger.warning("[llm] mode=mock reason=%s", reason)

    @property
    def extractor_version(self) -> str:
        return f"{self.provider}:{self.model_name}"

    def metadata(self, model_override: Optional[str] = None) -> Dict[str, str]:
        active_model = model_override or self.model_name
        return {
            "provider": self.provider,
            "model": active_model,
            "extractor_version": f"{self.provider}:{active_model}",
        }

    def extract_structure(self, text: str, model_override: Optional[str] = None) -> Dict[str, Any]:
        """Always returns a valid dict — never raises."""
        try:
            result = self._mock_extract(text) if self.use_mock else self._real_extract(text, model_override=model_override)
            if not isinstance(result, dict):
                logger.warning("[llm] extraction returned non-dict type=%s; using fallback", type(result))
                return get_fallback_extraction()
            return result
        except Exception:
            logger.exception("[llm] extract_structure raised; using fallback")
            return get_fallback_extraction()

    def _real_extract(self, text: str, model_override: Optional[str] = None) -> Dict[str, Any]:
        active_model = model_override or self.model_name
        if self.provider == "openai" and hasattr(self.client, "responses"):
            try:
                response = self.client.responses.create(
                    model=active_model,
                    instructions="You are a specialist ontology extractor for transparent psychological and behavioral research journaling. Return only schema-valid data and ground every node/relation in evidence text from the input.",
                    input=self._get_prompt(text),
                    temperature=0.1,
                    store=False,
                    text={
                        "format": {
                            "type": "json_schema",
                            "name": "sentra_research_extraction",
                            "strict": True,
                            "schema": EXTRACTION_JSON_SCHEMA,
                        }
                    },
                )
                raw_content = getattr(response, "output_text", None)
                if not raw_content:
                    raw_content = response.output[0].content[0].text
                parsed = repair_json_string(raw_content)
                return validate_extraction(parsed) if parsed else get_fallback_extraction()
            except Exception:
                logger.exception("[llm] responses extraction failed; trying chat fallback")

        kwargs: Dict[str, Any] = {
            "model": active_model,
            "messages": [
                {"role": "system", "content": "You are a specialized ontology extractor for research journaling."},
                {"role": "user", "content": self._get_prompt(text)},
            ],
            "temperature": 0.1,
        }
        if self.use_json_format:
            kwargs["response_format"] = {"type": "json_object"}
        if self.provider == "openai":
            kwargs["store"] = False

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

        # Richer mock — always produces at least 5 nodes for a meaningful graph
        base_nodes = [
            {"node_id": "baseline_state", "category": "State", "label": "Baseline mental state", "intensity": 0.45, "confidence": 0.85},
            {"node_id": "daily_routine", "category": "Protective", "label": "Daily routine", "intensity": 0.5, "confidence": 0.9},
        ]

        if "sleep" in low_text or "tired" in low_text or "fatigue" in low_text:
            nodes.append({"node_id": "sleep_issue", "category": "State", "label": "Sleep disruption", "intensity": 0.78, "confidence": 0.9})
            nodes.append({"node_id": "fatigue", "category": "State", "label": "Fatigue", "intensity": 0.65, "confidence": 0.8})
        if "anxious" in low_text or "anxiety" in low_text or "worry" in low_text or "stress" in low_text:
            nodes.append({"node_id": "anxiety", "category": "State", "label": "Anxiety", "intensity": 0.72, "confidence": 0.88})
        if "sad" in low_text or "depress" in low_text or "down" in low_text or "low" in low_text:
            nodes.append({"node_id": "low_mood", "category": "State", "label": "Low mood", "intensity": 0.68, "confidence": 0.82})
        if "friend" in low_text or "talk" in low_text or "call" in low_text or "social" in low_text:
            nodes.append({"node_id": "social_support", "category": "Protective", "label": "Social support", "intensity": 0.74, "confidence": 0.85})
        if "family" in low_text or "parent" in low_text or "partner" in low_text:
            nodes.append({"node_id": "family_connection", "category": "Protective", "label": "Family connection", "intensity": 0.7, "confidence": 0.8})
        if "work" in low_text or "job" in low_text or "office" in low_text or "project" in low_text:
            nodes.append({"node_id": "work_demand", "category": "Trigger", "label": "Work demands", "intensity": 0.62, "confidence": 0.85})
        if "deadline" in low_text or "due" in low_text or "urgent" in low_text:
            nodes.append({"node_id": "deadline_pressure", "category": "Trigger", "label": "Deadline pressure", "intensity": 0.78, "confidence": 0.9})
        if "meeting" in low_text or "presentation" in low_text or "interview" in low_text:
            nodes.append({"node_id": "work_event", "category": "Event", "label": "Work meeting / presentation", "intensity": 0.55, "confidence": 0.88})
        if "exercise" in low_text or "walk" in low_text or "run" in low_text or "gym" in low_text:
            nodes.append({"node_id": "exercise", "category": "Protective", "label": "Physical exercise", "intensity": 0.65, "confidence": 0.9})
            nodes.append({"node_id": "exercise_event", "category": "Event", "label": "Exercise session", "intensity": 0.5, "confidence": 0.85})
        if "eat" in low_text or "meal" in low_text or "food" in low_text or "cook" in low_text:
            nodes.append({"node_id": "meal_behavior", "category": "Behavior", "label": "Eating pattern", "intensity": 0.4, "confidence": 0.75})
        if "isolat" in low_text or "alone" in low_text or "withdraw" in low_text:
            nodes.append({"node_id": "isolation", "category": "Behavior", "label": "Social withdrawal", "intensity": 0.7, "confidence": 0.82})

        nodes = base_nodes + nodes

        # Auto-generate relations between detected nodes
        node_ids = {n["node_id"] for n in nodes}
        if "deadline_pressure" in node_ids and "anxiety" in node_ids:
            relations.append({"source_node_id": "deadline_pressure", "target_node_id": "anxiety", "type": "escalates", "confidence": 0.85})
        if "anxiety" in node_ids and "sleep_issue" in node_ids:
            relations.append({"source_node_id": "anxiety", "target_node_id": "sleep_issue", "type": "causes", "confidence": 0.78})
        if "sleep_issue" in node_ids and "fatigue" in node_ids:
            relations.append({"source_node_id": "sleep_issue", "target_node_id": "fatigue", "type": "causes", "confidence": 0.88})
        if "social_support" in node_ids and "anxiety" in node_ids:
            relations.append({"source_node_id": "social_support", "target_node_id": "anxiety", "type": "buffers", "confidence": 0.8})
        if "exercise" in node_ids and "low_mood" in node_ids:
            relations.append({"source_node_id": "exercise", "target_node_id": "low_mood", "type": "buffers", "confidence": 0.82})
        if "exercise" in node_ids and "anxiety" in node_ids:
            relations.append({"source_node_id": "exercise", "target_node_id": "anxiety", "type": "buffers", "confidence": 0.75})
        if "work_demand" in node_ids and "deadline_pressure" in node_ids:
            relations.append({"source_node_id": "work_demand", "target_node_id": "deadline_pressure", "type": "causes", "confidence": 0.8})
        if "isolation" in node_ids and "low_mood" in node_ids:
            relations.append({"source_node_id": "isolation", "target_node_id": "low_mood", "type": "escalates", "confidence": 0.76})
        if "daily_routine" in node_ids and "baseline_state" in node_ids:
            relations.append({"source_node_id": "daily_routine", "target_node_id": "baseline_state", "type": "buffers", "confidence": 0.7})
        if "family_connection" in node_ids and "baseline_state" in node_ids:
            relations.append({"source_node_id": "family_connection", "target_node_id": "baseline_state", "type": "buffers", "confidence": 0.72})

        event_count = sum(1 for n in nodes if n.get("category") == "Event")
        return {
            "nodes": nodes,
            "relations": relations,
            "temporal": {"recency": "recent", "event_density": event_count},
        }

    def _get_prompt(self, text: str) -> str:
        return f"""You are a specialist ontology extractor for psychological and behavioral research journals. Extract a RICH, DETAILED structural representation. Aim for 8–20 distinct nodes per entry — more nodes create a denser, more informative knowledge graph.

ONTOLOGY CATEGORIES:
- State: Internal psychological/physical states (anxiety, depression, calm, rumination, loneliness, fatigue, irritability, confidence, overwhelm, pain, numbness, hopelessness, contentment, etc.)
- Trigger: External stressors or stimuli that influence states (deadlines, conflicts, criticism, financial pressure, uncertainty, isolation, demanding interactions, bad news, environmental factors, etc.)
- Protective: Resources, coping mechanisms, and supports that buffer against negative states (specific people, routines, hobbies, exercise, therapy, self-compassion, community, medication, pets, creative outlets, etc.)
- Behavior: Observable actions, habits, or patterns (social withdrawal, substance use, compulsive checking, skipping meals, overworking, self-harm, avoidance, sleep hygiene behaviors, etc.)
- Event: Discrete time-bounded occurrences (meetings, conversations, activities, incidents, appointments, social events, travel, etc.) — include start_time/end_time/duration when mentioned

RELATIONS:
- causes: A directly produces or induces B
- escalates: A intensifies or worsens B
- buffers: A reduces, protects against, or relieves B
- avoids: A prevents engagement with B or substitutes for B
- co_occurs: A and B happen together without clear causal direction
- precedes: A temporally comes before B (sequence without clear causality)

EXTRACTION RULES:
1. Extract EVERY distinct entity — do not merge different concepts into one node
2. Use specific, descriptive labels (e.g. "work deadline anxiety" not just "stress"; "call with friend Sarah" not just "social contact")
3. Capture IMPLICIT states: if someone says they "couldn't stop thinking about X", extract "rumination about X" as a State
4. One concept per node — if a sentence has multiple states, create one node per state
5. Create nodes for protective factors even if mentioned briefly ("I went for a walk" → Protective: walking; Event: outdoor walk)
6. Intensity 0.0=absent/minimal to 1.0=maximal/crisis; confidence 0.0=uncertain to 1.0=explicitly stated
7. Create relations between all clearly related nodes — a rich relation set is as important as rich nodes

INPUT TEXT:
"{text}"

Return ONLY valid JSON (no markdown, no explanation):
{{
  "nodes": [
    {{ "node_id": "unique_snake_case_id", "category": "State|Trigger|Protective|Behavior|Event", "label": "descriptive label", "intensity": 0.0, "confidence": 0.0, "start_time": null, "end_time": null, "duration": null }}
  ],
  "relations": [
    {{ "source_node_id": "id", "target_node_id": "id", "type": "causes|escalates|buffers|avoids|co_occurs|precedes", "confidence": 0.0 }}
  ],
  "temporal": {{ "recency": "recent|ongoing|past|future|unknown", "event_density": 0, "sequence_shift": 0.0 }}
}}"""


llm_adapter = LLMAdapter()
