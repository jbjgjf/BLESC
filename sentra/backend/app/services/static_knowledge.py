from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from dotenv import load_dotenv
from openai import OpenAI


logger = logging.getLogger(__name__)

_ENV_DIR = Path(__file__).resolve().parents[2]
_SENTRA_ROOT = Path(__file__).resolve().parents[3]
load_dotenv(_ENV_DIR / ".env.local")
load_dotenv(_ENV_DIR / ".env")

DEFAULT_VECTOR_STORE_NAME = os.getenv("BLESC_VECTOR_STORE_NAME", "BLESC Static Knowledge")
VECTOR_STORE_ID_ENV = "BLESC_VECTOR_STORE_ID"
VECTOR_STORE_ID_FALLBACK_ENV = "OPENAI_VECTOR_STORE_ID"
STATIC_KNOWLEDGE_VERSION = "blesc-static-knowledge-v1"
DEFAULT_STATIC_DOCS_DIR = _SENTRA_ROOT / "docs"
DEFAULT_STATIC_KNOWLEDGE_FILES = [
    DEFAULT_STATIC_DOCS_DIR / "product_policy.md",
    DEFAULT_STATIC_DOCS_DIR / "safety_escalation_policy.md",
    DEFAULT_STATIC_DOCS_DIR / "vector_store_knowledge_plan.md",
]
ALLOWED_EXTENSIONS = {".md", ".txt", ".pdf", ".docx"}
SENSITIVE_PATH_MARKERS = {
    "chat",
    "entry",
    "entries",
    "export",
    "exports",
    "journal",
    "journals",
    "sentra.db",
    "sqlite",
    "test_exports",
    "uploads",
    "user",
    "users",
}


@dataclass(frozen=True)
class StaticKnowledgeConfig:
    vector_store_id: Optional[str]
    vector_store_name: str
    enabled: bool
    max_results: int
    allowed_source_dirs: List[Path]


def _env_flag(name: str, default: str = "true") -> bool:
    return os.getenv(name, default).strip().lower() in {"1", "true", "yes", "on"}


def static_knowledge_config() -> StaticKnowledgeConfig:
    configured_dirs = [
        Path(value).expanduser()
        for value in os.getenv("BLESC_STATIC_KNOWLEDGE_SOURCE_DIRS", str(DEFAULT_STATIC_DOCS_DIR)).split(":")
        if value.strip()
    ]
    return StaticKnowledgeConfig(
        vector_store_id=os.getenv(VECTOR_STORE_ID_ENV) or os.getenv(VECTOR_STORE_ID_FALLBACK_ENV),
        vector_store_name=os.getenv("BLESC_VECTOR_STORE_NAME", DEFAULT_VECTOR_STORE_NAME),
        enabled=_env_flag("BLESC_STATIC_KNOWLEDGE_ENABLED", "true"),
        max_results=max(1, min(int(os.getenv("BLESC_STATIC_KNOWLEDGE_MAX_RESULTS", "5")), 20)),
        allowed_source_dirs=[path.resolve() for path in configured_dirs],
    )


def _has_openai_key() -> bool:
    return bool(os.getenv("OPENAI_API_KEY")) and os.getenv("USE_MOCK_LLM", "").lower() != "true"


def _openai_client() -> OpenAI:
    return OpenAI(api_key=os.getenv("OPENAI_API_KEY"))


def _object_to_dict(value: Any) -> Dict[str, Any]:
    if hasattr(value, "model_dump"):
        return value.model_dump()
    if isinstance(value, dict):
        return value
    return dict(getattr(value, "__dict__", {}) or {})


def _is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def assert_static_knowledge_file(path: Path, config: Optional[StaticKnowledgeConfig] = None) -> Path:
    config = config or static_knowledge_config()
    resolved = path.expanduser().resolve()
    if not resolved.exists() or not resolved.is_file():
        raise FileNotFoundError(f"Static knowledge file not found: {resolved}")
    if resolved.suffix.lower() not in ALLOWED_EXTENSIONS:
        raise ValueError(f"Unsupported static knowledge file type: {resolved.suffix}")
    if not any(_is_relative_to(resolved, source_dir) for source_dir in config.allowed_source_dirs):
        allowed = ", ".join(str(path) for path in config.allowed_source_dirs)
        raise ValueError(f"Refusing to ingest outside static knowledge directories: {resolved}. Allowed: {allowed}")
    relative_parts: List[str] = []
    for source_dir in config.allowed_source_dirs:
        if _is_relative_to(resolved, source_dir):
            relative_parts = list(resolved.relative_to(source_dir).parts)
            break
    lower_parts = {part.lower() for part in relative_parts}
    if lower_parts.intersection(SENSITIVE_PATH_MARKERS):
        raise ValueError(f"Refusing to ingest a path that may contain user data: {resolved}")
    return resolved


def get_or_create_blesc_vector_store(create_if_missing: bool = True) -> Dict[str, Any]:
    config = static_knowledge_config()
    if not config.enabled:
        return {"status": "disabled", "vector_store_id": config.vector_store_id}
    if not _has_openai_key():
        return {"status": "pending_no_openai_key", "vector_store_id": config.vector_store_id}

    client = _openai_client()
    if config.vector_store_id:
        vector_store = client.vector_stores.retrieve(config.vector_store_id)
        return {
            "status": "connected",
            "vector_store_id": vector_store.id,
            "name": getattr(vector_store, "name", config.vector_store_name),
        }
    if not create_if_missing:
        return {"status": "missing_vector_store_id", "vector_store_id": None}

    vector_store = client.vector_stores.create(
        name=config.vector_store_name,
        metadata={
            "owner": "blesc",
            "knowledge_version": STATIC_KNOWLEDGE_VERSION,
            "data_boundary": "static_curated_only",
            "user_data_allowed": "false",
        },
    )
    logger.info("[static_knowledge] source=vector_store action=create vector_store_id=%s", vector_store.id)
    return {"status": "created", "vector_store_id": vector_store.id, "name": getattr(vector_store, "name", config.vector_store_name)}


def default_static_knowledge_files() -> List[Path]:
    return [path for path in DEFAULT_STATIC_KNOWLEDGE_FILES if path.exists()]


def ingest_static_knowledge_files(paths: Iterable[Path], create_if_missing: bool = True) -> Dict[str, Any]:
    config = static_knowledge_config()
    validated_paths = [assert_static_knowledge_file(Path(path), config) for path in paths]
    if not validated_paths:
        return {"status": "no_files", "vector_store_id": config.vector_store_id, "files": []}

    vector_store = get_or_create_blesc_vector_store(create_if_missing=create_if_missing)
    vector_store_id = vector_store.get("vector_store_id")
    if vector_store.get("status") in {"disabled", "pending_no_openai_key", "missing_vector_store_id"}:
        return {**vector_store, "files": [{"path": str(path), "status": "not_uploaded"} for path in validated_paths]}
    if not vector_store_id:
        raise RuntimeError("OpenAI vector store ID was not available after create/connect.")

    client = _openai_client()
    uploaded: List[Dict[str, Any]] = []
    for path in validated_paths:
        with path.open("rb") as handle:
            file_obj = client.files.create(file=handle, purpose="assistants")
        vector_file = client.vector_stores.files.create_and_poll(
            vector_store_id=vector_store_id,
            file_id=file_obj.id,
            attributes={
                "source_path": str(path.relative_to(_SENTRA_ROOT)),
                "knowledge_version": STATIC_KNOWLEDGE_VERSION,
                "data_boundary": "static_curated_only",
                "user_data_allowed": False,
            },
            poll_interval_ms=1000,
        )
        uploaded.append(
            {
                "path": str(path),
                "file_id": file_obj.id,
                "vector_store_file_id": getattr(vector_file, "id", None),
                "status": getattr(vector_file, "status", "unknown"),
            }
        )
    logger.info(
        "[static_knowledge] source=vector_store action=ingest vector_store_id=%s file_count=%s",
        vector_store_id,
        len(uploaded),
    )
    return {"status": "uploaded", "vector_store_id": vector_store_id, "files": uploaded}


def _result_content_text(result: Dict[str, Any]) -> str:
    chunks: List[str] = []
    for item in result.get("content") or []:
        if isinstance(item, dict):
            text = item.get("text") or item.get("value")
            if text:
                chunks.append(str(text))
        elif isinstance(item, str):
            chunks.append(item)
    return "\n".join(chunks).strip()


def search_static_knowledge(query: str, limit: Optional[int] = None) -> Dict[str, Any]:
    config = static_knowledge_config()
    bounded_limit = max(1, min(limit or config.max_results, 20))
    if not config.enabled:
        logger.info("[static_knowledge] source=vector_store action=search status=disabled")
        return {"source": "openai_vector_store", "status": "disabled", "matches": []}
    if not config.vector_store_id:
        logger.info("[static_knowledge] source=vector_store action=search status=missing_vector_store_id")
        return {"source": "openai_vector_store", "status": "missing_vector_store_id", "matches": []}
    if not _has_openai_key():
        logger.info("[static_knowledge] source=vector_store action=search status=pending_no_openai_key")
        return {"source": "openai_vector_store", "status": "pending_no_openai_key", "matches": []}

    try:
        results = _openai_client().vector_stores.search(
            config.vector_store_id,
            query=query,
            max_num_results=bounded_limit,
            rewrite_query=True,
        )
    except Exception as exc:
        logger.exception("[static_knowledge] source=vector_store action=search status=failed")
        return {"source": "openai_vector_store", "status": "failed", "error": str(exc), "matches": []}

    matches: List[Dict[str, Any]] = []
    for result in list(getattr(results, "data", []) or []):
        payload = _object_to_dict(result)
        matches.append(
            {
                "file_id": payload.get("file_id"),
                "filename": payload.get("filename"),
                "score": payload.get("score"),
                "attributes": payload.get("attributes") or {},
                "content": _result_content_text(payload)[:2000],
                "retrieval_source": "openai_vector_store",
            }
        )
    logger.info(
        "[static_knowledge] source=vector_store action=search status=completed vector_store_id=%s result_count=%s",
        config.vector_store_id,
        len(matches),
    )
    return {
        "source": "openai_vector_store",
        "status": "completed",
        "vector_store_id": config.vector_store_id,
        "matches": matches,
    }
