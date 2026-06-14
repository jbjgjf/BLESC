from __future__ import annotations

import csv
import hashlib
import json
import math
import os
import re
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

from openai import OpenAI
from dotenv import load_dotenv
from sqlmodel import Session, func, select

from ..analytics.graph_features import build_temporal_graph_diff
from ..schemas.analytics import DailyFeatureAggregation
from ..schemas.entry import Entry
from ..schemas.extraction import Extraction
from ..schemas.research import (
    ChatMessage,
    ChatSession,
    ConsentRecord,
    EntryEmbedding,
    EntryField,
    EntrySession,
    EvalExample,
    ExportJob,
    GraphChangeEvent,
    GraphVersion,
    InteractionEvent,
    LongitudinalFeature,
    ModelRun,
    ResearchEntryLink,
    RetrievalEvent,
)
from ..schemas.structured import GraphSnapshot


_ENV_DIR = Path(__file__).resolve().parents[2]
load_dotenv(_ENV_DIR / ".env.local")
load_dotenv(_ENV_DIR / ".env")

PIPELINE_VERSION = "research-pipeline-v1"
EXTRACTION_SCHEMA_VERSION = "sentra-extraction-schema-v1"
EXTRACTION_PROMPT_VERSION = "sentra-ontology-extractor-v2"
DEFAULT_CONSENT_VERSION = "research-consent-v1"
DEFAULT_EMBEDDING_MODEL = os.getenv("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small")
DEFAULT_CHAT_MODEL = os.getenv("OPENAI_CHAT_MODEL") or os.getenv("LLM_MODEL_NAME", "gpt-4.1-mini")
CHAT_PROMPT_VERSION = "sentra-research-chat-v1"
CHAT_SCHEMA_VERSION = "sentra-chat-grounded-answer-v1"
GRAPH_RAG_VERSION = "sentra-graph-rag-v1"
SEMANTIC_RAG_VERSION = "sentra-semantic-rag-v2"
PERSONALIZATION_VERSION = "sentra-personalization-v1"
MIN_REVIEWED_EXAMPLES_FOR_PERSONALIZATION = int(os.getenv("SENTRA_MIN_PERSONALIZATION_EXAMPLES", "100"))
RAW_TEXT_EXPORT_KEYS = {
    "content",
    "content_redacted",
    "evidence_text",
    "raw_text",
    "text",
    "transcript",
}
IDENTIFIER_EXPORT_KEYS = {"user_id", "participant_code", "owner_user_id", "participant_id"}


def stable_hash(value: Any) -> str:
    if not isinstance(value, str):
        value = json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _has_openai_key() -> bool:
    return bool(os.getenv("OPENAI_API_KEY")) and os.getenv("USE_MOCK_LLM", "").lower() != "true"


def _openai_client() -> OpenAI:
    return OpenAI(api_key=os.getenv("OPENAI_API_KEY"))


def _parse_datetime(value: Any, fallback: Optional[datetime] = None) -> datetime:
    if isinstance(value, datetime):
        return value
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00")).replace(tzinfo=None)
        except ValueError:
            pass
    return fallback or datetime.utcnow()


def _word_count(text: str) -> int:
    return len([part for part in text.replace("\n", " ").split(" ") if part.strip()])


def _normalize_text(value: Any) -> str:
    text = str(value or "").lower()
    text = re.sub(r"[^a-z0-9_\-\sぁ-んァ-ン一-龥]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def _tokenize(value: Any) -> Set[str]:
    normalized = _normalize_text(value)
    return {
        part
        for part in normalized.replace("_", " ").replace("-", " ").split()
        if len(part) >= 3 or re.search(r"[ぁ-んァ-ン一-龥]", part)
    }


def _node_id(node: Dict[str, Any]) -> str:
    return str(node.get("node_id") or node.get("id") or node.get("label") or "")


def _node_label(node: Dict[str, Any]) -> str:
    return str(node.get("label") or _node_id(node))


def _node_category(node: Dict[str, Any]) -> str:
    return str(node.get("category") or "Unknown")


def _relation_source_id(relation: Dict[str, Any]) -> str:
    return str(relation.get("source_node_id") or relation.get("source_id") or "")


def _relation_target_id(relation: Dict[str, Any]) -> str:
    return str(relation.get("target_node_id") or relation.get("target_id") or "")


def _node_brief(node: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": _node_id(node),
        "category": _node_category(node),
        "label": _node_label(node),
        "intensity": node.get("intensity"),
        "confidence": node.get("confidence"),
    }


def _relation_brief(relation: Dict[str, Any], nodes_by_id: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
    source = nodes_by_id.get(_relation_source_id(relation), {})
    target = nodes_by_id.get(_relation_target_id(relation), {})
    return {
        "source": _node_label(source) if source else _relation_source_id(relation),
        "source_category": _node_category(source) if source else None,
        "target": _node_label(target) if target else _relation_target_id(relation),
        "target_category": _node_category(target) if target else None,
        "type": relation.get("type") or "co_occurs",
        "confidence": relation.get("confidence"),
    }


def _relation_signature(relation: Dict[str, Any], nodes_by_id: Dict[str, Dict[str, Any]]) -> str:
    source = nodes_by_id.get(_relation_source_id(relation), {})
    target = nodes_by_id.get(_relation_target_id(relation), {})
    source_label = _normalize_text(_node_label(source) if source else _relation_source_id(relation))
    target_label = _normalize_text(_node_label(target) if target else _relation_target_id(relation))
    source_category = _normalize_text(_node_category(source) if source else "")
    target_category = _normalize_text(_node_category(target) if target else "")
    relation_type = _normalize_text(relation.get("type") or "co_occurs")
    return f"{source_category}:{source_label}->{relation_type}->{target_category}:{target_label}"


def _graph_signature(nodes: List[Dict[str, Any]], relations: List[Dict[str, Any]]) -> Dict[str, Set[str]]:
    nodes_by_id = {_node_id(node): node for node in nodes}
    node_terms: Set[str] = set()
    category_terms: Set[str] = set()
    relation_terms: Set[str] = set()
    relation_patterns: Set[str] = set()

    for node in nodes:
        category = _normalize_text(_node_category(node))
        label = _normalize_text(_node_label(node))
        if category:
            category_terms.add(category)
        node_terms.update(_tokenize(label))
        node_terms.add(f"{category}:{label}")

    for relation in relations:
        relation_type = _normalize_text(relation.get("type") or "co_occurs")
        if relation_type:
            relation_terms.add(relation_type)
        signature = _relation_signature(relation, nodes_by_id)
        relation_patterns.add(signature)
        relation_terms.update(_tokenize(signature))

    return {
        "node_terms": node_terms,
        "category_terms": category_terms,
        "relation_terms": relation_terms,
        "relation_patterns": relation_patterns,
        "all_terms": node_terms | category_terms | relation_terms | relation_patterns,
    }


def _search_terms_for_embedding(content_kind: str, content: str) -> List[str]:
    if content_kind not in {"extracted_nodes", "extracted_relations"}:
        return []
    try:
        parsed = json.loads(content)
    except json.JSONDecodeError:
        return sorted(_tokenize(content))[:80]
    terms: Set[str] = set()
    if isinstance(parsed, list):
        for item in parsed:
            if not isinstance(item, dict):
                continue
            for key in ("category", "label", "type", "rationale_tag"):
                terms.update(_tokenize(item.get(key)))
    return sorted(terms)[:120]


def _latest_graph_for_entry(session: Session, entry_id: Optional[int]) -> Optional[GraphSnapshot]:
    if entry_id is None:
        return None
    return session.exec(
        select(GraphSnapshot)
        .where(GraphSnapshot.entry_id == entry_id)
        .order_by(GraphSnapshot.created_at.desc())
        .limit(1)
    ).first()


def _latest_extraction_for_entry(session: Session, entry_id: Optional[int]) -> Optional[Extraction]:
    if entry_id is None:
        return None
    return session.exec(
        select(Extraction)
        .where(Extraction.entry_id == entry_id)
        .order_by(Extraction.created_at.desc())
        .limit(1)
    ).first()


def _consent_snapshot(consent: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    consent = consent or {}
    return {
        "app_use": bool(consent.get("app_use", True)),
        "research_analysis": bool(consent.get("research_analysis", True)),
        "anonymized_export": bool(consent.get("anonymized_export", False)),
        "future_fine_tuning": bool(consent.get("future_fine_tuning", False)),
        "consent_version": str(consent.get("consent_version", DEFAULT_CONSENT_VERSION)),
    }


def record_consent(
    session: Session,
    user_id: str,
    participant_code: str,
    consent: Optional[Dict[str, Any]],
) -> ConsentRecord:
    snapshot = _consent_snapshot(consent)
    record = ConsentRecord(
        user_id=user_id,
        participant_code=participant_code,
        app_use=snapshot["app_use"],
        research_analysis=snapshot["research_analysis"],
        anonymized_export=snapshot["anonymized_export"],
        future_fine_tuning=snapshot["future_fine_tuning"],
        consent_version=snapshot["consent_version"],
    )
    session.add(record)
    session.commit()
    session.refresh(record)
    return record


def record_entry_session(
    session: Session,
    user_id: str,
    participant_code: str,
    telemetry: Dict[str, Any],
    field_texts: Dict[str, str],
    consent: Optional[Dict[str, Any]],
) -> EntrySession:
    client_session_id = str(telemetry.get("session_id") or f"server-{stable_hash(field_texts)[:16]}")
    existing = session.exec(
        select(EntrySession)
        .where(
            EntrySession.client_session_id == client_session_id,
            EntrySession.user_id == user_id,
            EntrySession.participant_code == participant_code,
        )
        .limit(1)
    ).first()
    if existing:
        return existing

    started_at = _parse_datetime(telemetry.get("started_at"))
    submitted_at = _parse_datetime(telemetry.get("submitted_at"), datetime.utcnow())
    aggregate_metrics = telemetry.get("aggregate_metrics") if isinstance(telemetry.get("aggregate_metrics"), dict) else {}

    entry_session = EntrySession(
        client_session_id=client_session_id,
        user_id=user_id,
        participant_code=participant_code,
        status="submitted",
        started_at=started_at,
        submitted_at=submitted_at,
        client_timezone=telemetry.get("client_timezone"),
        user_agent=telemetry.get("user_agent"),
        consent_snapshot_json=_consent_snapshot(consent),
        aggregate_metrics_json=aggregate_metrics,
    )
    session.add(entry_session)
    session.commit()
    session.refresh(entry_session)

    field_metrics = telemetry.get("field_metrics") if isinstance(telemetry.get("field_metrics"), dict) else {}
    for field_name, final_text in field_texts.items():
        metrics = field_metrics.get(field_name, {}) if isinstance(field_metrics.get(field_name), dict) else {}
        field = EntryField(
            entry_session_id=entry_session.id,
            field_name=field_name,
            final_text_hash=stable_hash(final_text),
            char_count=len(final_text),
            word_count=_word_count(final_text),
            started_at=_parse_datetime(metrics.get("first_input_at")) if metrics.get("first_input_at") else None,
            completed_at=_parse_datetime(metrics.get("last_input_at")) if metrics.get("last_input_at") else None,
            metrics_json=metrics,
        )
        session.add(field)

    raw_events = telemetry.get("events") if isinstance(telemetry.get("events"), list) else []
    for raw in raw_events[:5000]:
        if not isinstance(raw, dict):
            continue
        event = InteractionEvent(
            entry_session_id=entry_session.id,
            field_name=str(raw.get("field_name") or raw.get("field") or "unknown"),
            event_type=str(raw.get("event_type") or raw.get("type") or "unknown"),
            occurred_at=_parse_datetime(raw.get("occurred_at"), started_at),
            relative_ms=int(raw.get("relative_ms") or 0),
            value_length=raw.get("value_length") if isinstance(raw.get("value_length"), int) else None,
            selection_start=raw.get("selection_start") if isinstance(raw.get("selection_start"), int) else None,
            selection_end=raw.get("selection_end") if isinstance(raw.get("selection_end"), int) else None,
            metadata_json=raw.get("metadata") if isinstance(raw.get("metadata"), dict) else {},
        )
        session.add(event)

    session.commit()
    return entry_session


def link_entry_to_session(
    session: Session,
    entry: Entry,
    entry_session: Optional[EntrySession],
    field_name: str,
    source_text: str,
) -> None:
    if not entry_session or not entry_session.id or not entry.id:
        return
    session.add(
        ResearchEntryLink(
            entry_id=entry.id,
            entry_session_id=entry_session.id,
            field_name=field_name,
            source_hash=stable_hash(source_text),
        )
    )
    session.commit()


def record_model_run(
    session: Session,
    user_id: str,
    participant_code: str,
    artifact_type: str,
    artifact_id: Optional[Any],
    provider: str,
    model: str,
    output: Any,
    *,
    prompt_version: str = EXTRACTION_PROMPT_VERSION,
    schema_version: str = EXTRACTION_SCHEMA_VERSION,
    temperature: float = 0.1,
    retrieval_config: Optional[Dict[str, Any]] = None,
    input_provenance: Optional[Dict[str, Any]] = None,
    status: str = "completed",
    error_message: Optional[str] = None,
) -> ModelRun:
    model_run = ModelRun(
        user_id=user_id,
        participant_code=participant_code,
        artifact_type=artifact_type,
        artifact_id=str(artifact_id) if artifact_id is not None else None,
        provider=provider,
        model=model,
        prompt_version=prompt_version,
        schema_version=schema_version,
        pipeline_version=PIPELINE_VERSION,
        temperature=temperature,
        retrieval_config_json=retrieval_config or {},
        input_provenance_json=input_provenance or {},
        output_hash=stable_hash(output) if output is not None else None,
        status=status,
        error_message=error_message,
    )
    session.add(model_run)
    session.commit()
    session.refresh(model_run)
    return model_run


def _entity_key(entity: Dict[str, Any], entity_type: str) -> str:
    if entity_type == "relation":
        return "|".join(
            [
                str(entity.get("source_id") or entity.get("source_node_id") or ""),
                str(entity.get("target_id") or entity.get("target_node_id") or ""),
                str(entity.get("type") or "co_occurs"),
            ]
        )
    return str(entity.get("id") or entity.get("node_id") or entity.get("label") or "")


def _trajectory_tags(entity: Dict[str, Any]) -> List[str]:
    text = f"{entity.get('category', '')} {entity.get('label', '')} {entity.get('type', '')}".lower()
    tags: List[str] = []
    if any(term in text for term in ["self", "identity", "confidence", "worth", "belief"]):
        tags.append("self_perception")
    if any(term in text for term in ["anxiety", "stress", "sad", "mood", "anger", "calm"]):
        tags.append("emotion")
    if any(term in text for term in ["belief", "thought", "rumination", "expectation"]):
        tags.append("belief")
    return tags


def record_graph_version(
    session: Session,
    user_id: str,
    participant_code: str,
    entry: Entry,
    graph_snapshot: Optional[GraphSnapshot],
) -> Optional[GraphVersion]:
    if not graph_snapshot:
        return None
    previous = session.exec(
        select(GraphVersion)
        .where(GraphVersion.user_id == user_id, GraphVersion.participant_code == participant_code)
        .order_by(GraphVersion.version_index.desc())
        .limit(1)
    ).first()
    version_index = (previous.version_index + 1) if previous else 1
    graph_version = GraphVersion(
        user_id=user_id,
        participant_code=participant_code,
        entry_id=entry.id,
        graph_snapshot_id=graph_snapshot.id,
        version_index=version_index,
        nodes_json=graph_snapshot.nodes_json or [],
        relations_json=graph_snapshot.relations_json or [],
        summary_json=graph_snapshot.graph_summary_json or {},
    )
    session.add(graph_version)
    session.commit()
    session.refresh(graph_version)

    previous_nodes = previous.nodes_json if previous else []
    previous_relations = previous.relations_json if previous else []
    diff = build_temporal_graph_diff(
        graph_version.nodes_json,
        graph_version.relations_json,
        previous_nodes,
        previous_relations,
    )
    for key, entity_type, change_type in [
        ("added_nodes", "node", "added"),
        ("removed_nodes", "node", "removed"),
        ("added_relations", "relation", "added"),
        ("removed_relations", "relation", "removed"),
    ]:
        for entity in diff.get(key, []):
            event = GraphChangeEvent(
                user_id=user_id,
                participant_code=participant_code,
                graph_version_id=graph_version.id,
                change_type=change_type,
                entity_type=entity_type,
                entity_key=_entity_key(entity, entity_type),
                previous_json=entity if change_type == "removed" else None,
                current_json=entity if change_type == "added" else None,
                semantic_drift_score=0.0,
                trajectory_tags=_trajectory_tags(entity),
            )
            session.add(event)

    for changed in diff.get("changed_relations", []):
        event = GraphChangeEvent(
            user_id=user_id,
            participant_code=participant_code,
            graph_version_id=graph_version.id,
            change_type="confidence_changed",
            entity_type="relation",
            entity_key=_entity_key(changed, "relation"),
            previous_json={"confidence": changed.get("previous_confidence")},
            current_json={"confidence": changed.get("current_confidence")},
            semantic_drift_score=abs(float(changed.get("confidence_delta") or 0.0)),
            trajectory_tags=_trajectory_tags(changed),
        )
        session.add(event)
    session.commit()
    return graph_version


def _generate_embedding(content: str, model: str = DEFAULT_EMBEDDING_MODEL) -> tuple[List[float], str]:
    if not content.strip():
        return [], "empty_content"
    if not _has_openai_key():
        return [], "pending_no_openai_key"
    response = _openai_client().embeddings.create(model=model, input=content)
    return list(response.data[0].embedding), "generated"


def record_entry_embeddings(
    session: Session,
    user_id: str,
    participant_code: str,
    entry: Entry,
    contents: Dict[str, str],
    extraction: Optional[Extraction] = None,
) -> List[Dict[str, Any]]:
    artifacts: List[Dict[str, Any]] = []
    payloads: Dict[str, str] = {k: v for k, v in contents.items() if v.strip()}
    if extraction:
        payloads["extracted_nodes"] = json.dumps(extraction.nodes_json or [], ensure_ascii=False, sort_keys=True)
        payloads["extracted_relations"] = json.dumps(extraction.relations_json or [], ensure_ascii=False, sort_keys=True)
    for content_kind, content in payloads.items():
        try:
            vector, status = _generate_embedding(content)
        except Exception as exc:
            vector = []
            status = "generation_failed"
            error_message = str(exc)
        else:
            error_message = None
        row = EntryEmbedding(
                entry_id=entry.id,
                user_id=user_id,
                participant_code=participant_code,
                content_kind=content_kind,
                embedding_model=DEFAULT_EMBEDDING_MODEL,
                vector_json=vector,
                content_hash=stable_hash(content),
                metadata_json={
                    "status": status,
                    "char_count": len(content),
                    "search_terms": _search_terms_for_embedding(content_kind, content),
                    "pipeline_version": PIPELINE_VERSION,
                    "error": error_message,
                },
            )
        session.add(row)
        session.flush()
        artifacts.append(
            {
                "local_id": row.id,
                "entry_id": entry.id,
                "content_kind": content_kind,
                "embedding_model": DEFAULT_EMBEDDING_MODEL,
                "vector_json": vector,
                "content_hash": row.content_hash,
                "metadata_json": row.metadata_json,
            }
        )
        record_model_run(
            session,
            user_id=user_id,
            participant_code=participant_code,
            artifact_type="embedding",
            artifact_id=f"{entry.id}:{content_kind}",
            provider="openai" if status == "generated" else "local",
            model=DEFAULT_EMBEDDING_MODEL,
            output={"content_hash": stable_hash(content), "vector_dimensions": len(vector), "status": status},
            prompt_version="embedding-v1",
            schema_version="embedding-vector-v1",
            temperature=0.0,
            input_provenance={"entry_id": entry.id, "content_kind": content_kind},
            status="completed" if status in {"generated", "pending_no_openai_key", "empty_content"} else "failed",
            error_message=error_message,
        )
    session.commit()
    return artifacts


def record_eval_candidate(
    session: Session,
    user_id: str,
    participant_code: str,
    entry: Entry,
    journal_text: str,
    recall_text: str,
    cleaned_extraction: Dict[str, Any],
    consent: Optional[Dict[str, Any]],
) -> EvalExample:
    example = EvalExample(
        user_id=user_id,
        participant_code=participant_code,
        source_entry_id=entry.id,
        task_type="structured_extraction",
        input_json={
            "journal_text_hash": stable_hash(journal_text),
            "recall_text_hash": stable_hash(recall_text),
            "combined_entry_hash": stable_hash(f"{journal_text}\n\n{recall_text}"),
            "field_names": ["journal_entry", "first_recall_30"],
            "observation_type": entry.observation_type,
        },
        expected_output_json={
            "nodes": cleaned_extraction.get("nodes", []),
            "relations": cleaned_extraction.get("relations", []),
            "temporal": cleaned_extraction.get("temporal", {}),
            "uncertainty": cleaned_extraction.get("uncertainty", {}),
            "safety_flags": cleaned_extraction.get("safety_flags", []),
        },
        consent_snapshot_json=_consent_snapshot(consent),
        review_status="unreviewed",
    )
    session.add(example)
    session.commit()
    session.refresh(example)
    return example


def _cosine_similarity(left: List[float], right: List[float]) -> float:
    if not left or not right or len(left) != len(right):
        return 0.0
    dot = sum(a * b for a, b in zip(left, right))
    left_norm = math.sqrt(sum(a * a for a in left))
    right_norm = math.sqrt(sum(b * b for b in right))
    if left_norm == 0 or right_norm == 0:
        return 0.0
    return dot / (left_norm * right_norm)


def _entry_semantic_context(session: Session, row: EntryEmbedding, score: float) -> Dict[str, Any]:
    graph_snapshot = _latest_graph_for_entry(session, row.entry_id)
    extraction = _latest_extraction_for_entry(session, row.entry_id)
    nodes = graph_snapshot.nodes_json if graph_snapshot else (extraction.nodes_json if extraction else [])
    relations = graph_snapshot.relations_json if graph_snapshot else (extraction.relations_json if extraction else [])
    nodes_by_id = {_node_id(node): node for node in nodes}
    key_nodes = [_node_brief(node) for node in nodes[:8]]
    key_relations = [_relation_brief(relation, nodes_by_id) for relation in relations[:8]]
    entry = session.get(Entry, row.entry_id) if row.entry_id is not None else None
    return {
        "entry_embedding_id": row.id,
        "entry_id": row.entry_id,
        "day": graph_snapshot.day.isoformat() if graph_snapshot else (entry.created_at.date().isoformat() if entry else None),
        "content_kind": row.content_kind,
        "score": round(score, 6),
        "content_hash": row.content_hash,
        "embedding_model": row.embedding_model,
        "summary": (graph_snapshot.graph_summary_json or {}).get("summary") if graph_snapshot else None,
        "key_nodes": key_nodes,
        "key_relations": key_relations,
        "temporal_diff": graph_snapshot.temporal_diff_json if graph_snapshot else {},
        "metadata": {
            "status": (row.metadata_json or {}).get("status"),
            "search_terms": (row.metadata_json or {}).get("search_terms", []),
        },
    }


def search_similar_embeddings(
    session: Session,
    user_id: str,
    participant_code: str,
    query: str,
    limit: int = 5,
) -> List[Dict[str, Any]]:
    query_hash = stable_hash(query)
    try:
        query_vector, status = _generate_embedding(query)
    except Exception as exc:
        query_vector = []
        status = "query_embedding_failed"
        error_message = str(exc)
    else:
        error_message = None

    rows = session.exec(
        select(EntryEmbedding)
        .where(EntryEmbedding.user_id == user_id, EntryEmbedding.participant_code == participant_code)
        .order_by(EntryEmbedding.created_at.desc())
        .limit(250)
    ).all()
    scored_rows: List[Tuple[EntryEmbedding, float]] = []
    if query_vector:
        for row in rows:
            score = _cosine_similarity(query_vector, row.vector_json or [])
            if score > 0:
                scored_rows.append((row, score))
    else:
        query_terms = _tokenize(query)
        for row in rows:
            metadata = row.metadata_json or {}
            text_terms = set(str(term).lower() for term in metadata.get("search_terms", []))
            overlap = len(query_terms.intersection(text_terms))
            if overlap:
                scored_rows.append((row, float(overlap)))
    scored_rows = sorted(scored_rows, key=lambda item: item[1], reverse=True)[:limit]
    scored = [_entry_semantic_context(session, row, score) for row, score in scored_rows]
    session.add(
        RetrievalEvent(
            user_id=user_id,
            participant_code=participant_code,
            query_hash=query_hash,
            retrieval_config_json={
                "limit": limit,
                "embedding_model": DEFAULT_EMBEDDING_MODEL,
                "retrieval_mode": "semantic_vector",
                "retrieval_version": SEMANTIC_RAG_VERSION,
                "query_status": status,
                "error": error_message,
                "pipeline_version": PIPELINE_VERSION,
            },
            result_refs_json=scored,
        )
    )
    session.commit()
    return scored


def _seed_graph_signatures(
    session: Session,
    semantic_evidence: List[Dict[str, Any]],
) -> Set[str]:
    seed_patterns: Set[str] = set()
    for evidence in semantic_evidence:
        graph_snapshot = _latest_graph_for_entry(session, evidence.get("entry_id"))
        if not graph_snapshot:
            continue
        signature = _graph_signature(graph_snapshot.nodes_json or [], graph_snapshot.relations_json or [])
        seed_patterns.update(signature["relation_patterns"])
    return seed_patterns


def _score_graph_snapshot(
    graph_snapshot: GraphSnapshot,
    query_terms: Set[str],
    seed_patterns: Set[str],
) -> Tuple[float, List[str], Dict[str, Set[str]]]:
    nodes = graph_snapshot.nodes_json or []
    relations = graph_snapshot.relations_json or []
    signature = _graph_signature(nodes, relations)
    term_overlap = query_terms.intersection(signature["all_terms"])
    pattern_overlap = seed_patterns.intersection(signature["relation_patterns"])
    score = float(len(term_overlap)) + (2.5 * len(pattern_overlap))
    reasons: List[str] = []
    if term_overlap:
        reasons.append(f"query_terms:{','.join(sorted(term_overlap)[:6])}")
    if pattern_overlap:
        reasons.append(f"relation_patterns:{len(pattern_overlap)}")
    if not reasons and relations:
        relation_types = sorted(signature["relation_terms"].intersection({"causes", "escalates", "buffers", "avoids", "co_occurs", "precedes"}))
        if relation_types and query_terms.intersection({"pattern", "patterns", "構造", "関係", "前回", "いつ"}):
            score += 0.5
            reasons.append(f"available_relation_types:{','.join(relation_types[:4])}")
    return score, reasons, signature


def search_similar_graph_patterns(
    session: Session,
    user_id: str,
    participant_code: str,
    query: str,
    limit: int = 5,
    semantic_evidence: Optional[List[Dict[str, Any]]] = None,
) -> List[Dict[str, Any]]:
    query_terms = _tokenize(query)
    seed_patterns = _seed_graph_signatures(session, semantic_evidence or [])
    snapshots = session.exec(
        select(GraphSnapshot)
        .where(GraphSnapshot.user_id == user_id)
        .order_by(GraphSnapshot.day.desc(), GraphSnapshot.created_at.desc())
        .limit(250)
    ).all()
    scored: List[Tuple[GraphSnapshot, float, List[str]]] = []
    for snapshot in snapshots:
        score, reasons, _signature = _score_graph_snapshot(snapshot, query_terms, seed_patterns)
        if score > 0:
            scored.append((snapshot, score, reasons))

    scored = sorted(scored, key=lambda item: (item[1], item[0].day), reverse=True)[:limit]
    results: List[Dict[str, Any]] = []
    for snapshot, score, reasons in scored:
        nodes = snapshot.nodes_json or []
        relations = snapshot.relations_json or []
        nodes_by_id = {_node_id(node): node for node in nodes}
        results.append(
            {
                "graph_snapshot_id": snapshot.id,
                "entry_id": snapshot.entry_id,
                "day": snapshot.day.isoformat(),
                "score": round(score, 6),
                "match_reasons": reasons,
                "summary": (snapshot.graph_summary_json or {}).get("summary"),
                "key_nodes": [_node_brief(node) for node in nodes[:10]],
                "key_relations": [_relation_brief(relation, nodes_by_id) for relation in relations[:10]],
                "temporal_diff": snapshot.temporal_diff_json or {},
                "retrieval_mode": "graph_pattern",
            }
        )

    session.add(
        RetrievalEvent(
            user_id=user_id,
            participant_code=participant_code,
            query_hash=stable_hash(query),
            retrieval_config_json={
                "limit": limit,
                "retrieval_mode": "graph_pattern",
                "retrieval_version": GRAPH_RAG_VERSION,
                "seed_relation_patterns": len(seed_patterns),
                "pipeline_version": PIPELINE_VERSION,
            },
            result_refs_json=results,
        )
    )
    session.commit()
    return results


def get_personalization_profile(
    session: Session,
    user_id: str,
    participant_code: str,
) -> Dict[str, Any]:
    examples = session.exec(
        select(EvalExample).where(
            EvalExample.user_id == user_id,
            EvalExample.participant_code == participant_code,
        )
    ).all()
    status_counts: Dict[str, int] = {}
    latest_consent = session.exec(
        select(ConsentRecord)
        .where(ConsentRecord.user_id == user_id, ConsentRecord.participant_code == participant_code)
        .order_by(ConsentRecord.created_at.desc())
        .limit(1)
    ).first()
    for example in examples:
        status_counts[example.review_status] = status_counts.get(example.review_status, 0) + 1

    model_map: Dict[str, Any] = {}
    try:
        model_map = json.loads(os.getenv("SENTRA_PERSONAL_EXTRACTION_MODEL_MAP", "{}") or "{}")
    except json.JSONDecodeError:
        model_map = {}

    latest_fine_tune = session.exec(
        select(ModelRun)
        .where(
            ModelRun.user_id == user_id,
            ModelRun.participant_code == participant_code,
            ModelRun.artifact_type == "fine_tuning_job",
        )
        .order_by(ModelRun.created_at.desc())
        .limit(1)
    ).first()
    configured_model = (
        model_map.get(participant_code)
        or model_map.get(user_id)
        or os.getenv("SENTRA_PERSONAL_EXTRACTION_MODEL")
    )
    reviewed_count = status_counts.get("reviewed", 0)
    consent_allows = bool(latest_consent.future_fine_tuning) if latest_consent else False
    return {
        "personalization_version": PERSONALIZATION_VERSION,
        "reviewed_examples": reviewed_count,
        "minimum_reviewed_examples": MIN_REVIEWED_EXAMPLES_FOR_PERSONALIZATION,
        "status_counts": status_counts,
        "consent_allows_future_fine_tuning": consent_allows,
        "ready_for_personal_adapter": consent_allows and reviewed_count >= MIN_REVIEWED_EXAMPLES_FOR_PERSONALIZATION,
        "adapter_model": configured_model,
        "latest_fine_tuning_run_id": latest_fine_tune.id if latest_fine_tune else None,
    }


def build_research_retrieval_context(
    session: Session,
    user_id: str,
    participant_code: str,
    message: str,
    limit: int = 5,
) -> Dict[str, Any]:
    bounded_limit = max(1, min(limit, 12))
    semantic_evidence = search_similar_embeddings(
        session=session,
        user_id=user_id,
        participant_code=participant_code,
        query=message,
        limit=bounded_limit,
    )
    graph_evidence = search_similar_graph_patterns(
        session=session,
        user_id=user_id,
        participant_code=participant_code,
        query=message,
        limit=bounded_limit,
        semantic_evidence=semantic_evidence,
    )
    return {
        "retrieval_version": {
            "semantic": SEMANTIC_RAG_VERSION,
            "graph": GRAPH_RAG_VERSION,
        },
        "semantic_matches": semantic_evidence,
        "graph_pattern_matches": graph_evidence,
        "personalization": get_personalization_profile(session, user_id, participant_code),
    }


def generate_research_chat_response(
    session: Session,
    user_id: str,
    participant_code: str,
    message: str,
    limit: int = 5,
) -> Dict[str, Any]:
    retrieval_context = build_research_retrieval_context(session, user_id, participant_code, message, limit=limit)
    evidence = {
        "semantic_matches": retrieval_context["semantic_matches"],
        "graph_pattern_matches": retrieval_context["graph_pattern_matches"],
    }
    consent_snapshot = _consent_snapshot(None)
    chat_session = ChatSession(
        user_id=user_id,
        participant_code=participant_code,
        consent_snapshot_json=consent_snapshot,
    )
    session.add(chat_session)
    session.commit()
    session.refresh(chat_session)

    session.add(
        ChatMessage(
            chat_session_id=chat_session.id,
            role="user",
            content_hash=stable_hash(message),
            content_redacted=message[:500],
            evidence_refs_json=[],
        )
    )

    instructions = (
        "You are Sentra's student-facing research assistant. Answer in simple, supportive language. "
        "Ground the response only in retrieved semantic and graph-pattern evidence. "
        "When graph-pattern evidence repeats an earlier Trigger, State, Protective, Behavior, or Event relation, "
        "you may mention that pattern with the evidence date. Explicitly mark uncertainty. "
        "Do not diagnose or make clinical claims. Suggest reflection questions, not medical advice."
    )
    evidence_context = json.dumps(retrieval_context, ensure_ascii=False, sort_keys=True, default=str)
    fallback_answer = (
        "I can reflect on patterns from your recorded entries, but I will stay cautious. "
        "The current evidence is limited, so treat this as a prompt for reflection rather than a conclusion."
    )
    provider = "local"
    model = "deterministic-fallback"
    answer = fallback_answer
    status = "completed"
    error_message = None

    if _has_openai_key():
        provider = "openai"
        model = DEFAULT_CHAT_MODEL
        try:
            response = _openai_client().responses.create(
                model=model,
                instructions=instructions,
                input=(
                    "Retrieved evidence refs:\n"
                    f"{evidence_context}\n\n"
                    "Student message:\n"
                    f"{message}"
                ),
                store=False,
                text={"verbosity": "medium"},
            )
            answer = getattr(response, "output_text", None) or response.output[0].content[0].text
        except Exception as exc:
            status = "failed"
            error_message = str(exc)
            answer = fallback_answer

    model_run = record_model_run(
        session,
        user_id=user_id,
        participant_code=participant_code,
        artifact_type="chat_message",
        artifact_id=chat_session.id,
        provider=provider,
        model=model,
        output={"answer": answer, "evidence_refs": evidence},
        prompt_version=CHAT_PROMPT_VERSION,
        schema_version=CHAT_SCHEMA_VERSION,
        temperature=0.2,
        retrieval_config={"limit": limit, "embedding_model": DEFAULT_EMBEDDING_MODEL},
        input_provenance={
            "chat_session_id": chat_session.id,
            "message_hash": stable_hash(message),
            "semantic_match_count": len(retrieval_context["semantic_matches"]),
            "graph_pattern_match_count": len(retrieval_context["graph_pattern_matches"]),
            "personalization": retrieval_context["personalization"],
        },
        status=status,
        error_message=error_message,
    )
    assistant_message = ChatMessage(
        chat_session_id=chat_session.id,
        role="assistant",
        content_hash=stable_hash(answer),
        content_redacted=answer[:1000],
        evidence_refs_json=[evidence],
        model_run_id=model_run.id,
    )
    session.add(assistant_message)
    session.commit()
    session.refresh(assistant_message)
    return {
        "chat_session_id": chat_session.id,
        "message_id": assistant_message.id,
        "answer": answer,
        "evidence_refs": evidence,
        "retrieval_context": retrieval_context,
        "model_run_id": model_run.id,
        "status": status,
        "error_message": error_message,
    }


def recompute_longitudinal_features(
    session: Session,
    user_id: str,
    participant_code: str,
    anchor_day: date,
    windows: Iterable[int] = (7, 30),
) -> List[LongitudinalFeature]:
    created: List[LongitudinalFeature] = []
    for window_days in windows:
        window_start = anchor_day - timedelta(days=window_days - 1)
        aggs = session.exec(
            select(DailyFeatureAggregation)
            .where(
                DailyFeatureAggregation.user_id == user_id,
                DailyFeatureAggregation.day >= window_start,
                DailyFeatureAggregation.day <= anchor_day,
            )
            .order_by(DailyFeatureAggregation.day.asc())
        ).all()
        vectors = [agg.feature_vector_json or {} for agg in aggs]
        feature_names = sorted({key for vector in vectors for key in vector.keys()})
        feature_json: Dict[str, Any] = {
            "n_days_observed": len(aggs),
            "window_days": window_days,
            "trend": {},
            "mean": {},
            "consistency": {},
            "change_rate": {},
            "volatility": {},
            "recurrence": {},
        }
        for name in feature_names:
            values = [float(vector.get(name) or 0.0) for vector in vectors]
            if not values:
                continue
            mean = sum(values) / len(values)
            deltas = [b - a for a, b in zip(values, values[1:])]
            abs_deltas = [abs(delta) for delta in deltas]
            variance = sum((value - mean) ** 2 for value in values) / max(1, len(values))
            feature_json["mean"][name] = round(mean, 4)
            feature_json["trend"][name] = round((values[-1] - values[0]) / max(1, len(values) - 1), 4)
            feature_json["consistency"][name] = round(1.0 / (1.0 + variance), 4)
            feature_json["change_rate"][name] = round(sum(abs_deltas) / max(1, len(abs_deltas)), 4)
            feature_json["volatility"][name] = round(variance ** 0.5, 4)
            feature_json["recurrence"][name] = sum(1 for value in values if value > 0)
        row = LongitudinalFeature(
            user_id=user_id,
            participant_code=participant_code,
            window_days=window_days,
            window_start=window_start,
            window_end=anchor_day,
            feature_json=feature_json,
        )
        session.add(row)
        created.append(row)
    session.commit()
    return created


def _safe_export_value(value: Any) -> Any:
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    return value


def _export_subject_id(user_id: str, participant_code: str) -> str:
    salt = os.getenv("SENTRA_EXPORT_SALT", "sentra-default-export-salt")
    return f"subject_{stable_hash(f'{salt}:{user_id}:{participant_code}')[:24]}"


def _scrub_research_payload(value: Any) -> Any:
    if isinstance(value, list):
        return [_scrub_research_payload(item) for item in value]
    if isinstance(value, dict):
        scrubbed: Dict[str, Any] = {}
        for key, item in value.items():
            normalized_key = str(key).lower()
            if normalized_key in IDENTIFIER_EXPORT_KEYS:
                continue
            if normalized_key in RAW_TEXT_EXPORT_KEYS and isinstance(item, str):
                scrubbed[f"{key}_hash"] = stable_hash(item)
                scrubbed[f"{key}_char_count"] = len(item)
                continue
            scrubbed[key] = _scrub_research_payload(item)
        return scrubbed
    return value


def _deidentify_export_row(table_name: str, row: Dict[str, Any], subject_id: str) -> Dict[str, Any]:
    deidentified: Dict[str, Any] = {"subject_id": subject_id, "source_table": table_name}
    for key, value in row.items():
        if key in {"user_id", "participant_code"}:
            continue
        if key == "client_session_id" and isinstance(value, str):
            deidentified["client_session_hash"] = stable_hash(value)
            continue
        if key == "content_redacted" and isinstance(value, str):
            deidentified["content_redacted_hash"] = stable_hash(value)
            deidentified["content_redacted_char_count"] = len(value)
            continue
        if key.endswith("_json"):
            deidentified[key] = _safe_export_value(_scrub_research_payload(value))
            continue
        deidentified[key] = _safe_export_value(value)
    return deidentified


def _rows_for_export(session: Session, user_id: str, participant_code: str) -> Dict[str, List[Dict[str, Any]]]:
    tables = {
        "consent_records": session.exec(
            select(ConsentRecord).where(ConsentRecord.user_id == user_id, ConsentRecord.participant_code == participant_code)
        ).all(),
        "entry_sessions": session.exec(
            select(EntrySession).where(EntrySession.user_id == user_id, EntrySession.participant_code == participant_code)
        ).all(),
        "entry_fields": session.exec(
            select(EntryField).join(EntrySession).where(
                EntrySession.user_id == user_id,
                EntrySession.participant_code == participant_code,
            )
        ).all(),
        "interaction_events": session.exec(
            select(InteractionEvent).join(EntrySession).where(
                EntrySession.user_id == user_id,
                EntrySession.participant_code == participant_code,
            )
        ).all(),
        "model_runs": session.exec(
            select(ModelRun).where(ModelRun.user_id == user_id, ModelRun.participant_code == participant_code)
        ).all(),
        "graph_versions": session.exec(
            select(GraphVersion).where(GraphVersion.user_id == user_id, GraphVersion.participant_code == participant_code)
        ).all(),
        "graph_change_events": session.exec(
            select(GraphChangeEvent).where(
                GraphChangeEvent.user_id == user_id,
                GraphChangeEvent.participant_code == participant_code,
            )
        ).all(),
        "longitudinal_features": session.exec(
            select(LongitudinalFeature).where(LongitudinalFeature.user_id == user_id, LongitudinalFeature.participant_code == participant_code)
        ).all(),
        "entry_embeddings": session.exec(
            select(EntryEmbedding).where(EntryEmbedding.user_id == user_id, EntryEmbedding.participant_code == participant_code)
        ).all(),
        "retrieval_events": session.exec(
            select(RetrievalEvent).where(RetrievalEvent.user_id == user_id, RetrievalEvent.participant_code == participant_code)
        ).all(),
        "chat_sessions": session.exec(
            select(ChatSession).where(ChatSession.user_id == user_id, ChatSession.participant_code == participant_code)
        ).all(),
        "chat_messages": session.exec(
            select(ChatMessage)
            .join(ChatSession)
            .where(ChatSession.user_id == user_id, ChatSession.participant_code == participant_code)
        ).all(),
        "eval_examples": session.exec(
            select(EvalExample).where(EvalExample.user_id == user_id, EvalExample.participant_code == participant_code)
        ).all(),
    }
    subject_id = _export_subject_id(user_id, participant_code)
    exported: Dict[str, List[Dict[str, Any]]] = {}
    for name, rows in tables.items():
        exported[name] = [
            _deidentify_export_row(
                name,
                {key: value for key, value in row.model_dump().items()},
                subject_id,
            )
            for row in rows
        ]
    return exported


def reconstruct_entry_replay(
    session: Session,
    user_id: str,
    participant_code: str,
    entry_session_id: int,
) -> Optional[Dict[str, Any]]:
    entry_session = session.get(EntrySession, entry_session_id)
    if (
        not entry_session
        or entry_session.user_id != user_id
        or entry_session.participant_code != participant_code
    ):
        return None

    fields = session.exec(
        select(EntryField)
        .where(EntryField.entry_session_id == entry_session_id)
        .order_by(EntryField.field_name.asc())
    ).all()
    events = session.exec(
        select(InteractionEvent)
        .where(InteractionEvent.entry_session_id == entry_session_id)
        .order_by(InteractionEvent.relative_ms.asc(), InteractionEvent.id.asc())
    ).all()
    replay_events: List[Dict[str, Any]] = []
    previous_by_field: Dict[str, int] = {}
    for event in events:
        previous_length = previous_by_field.get(event.field_name, 0)
        current_length = event.value_length if event.value_length is not None else previous_length
        replay_events.append(
            {
                "field_name": event.field_name,
                "event_type": event.event_type,
                "relative_ms": event.relative_ms,
                "occurred_at": event.occurred_at.isoformat(),
                "value_length": event.value_length,
                "delta_length": current_length - previous_length,
                "selection_start": event.selection_start,
                "selection_end": event.selection_end,
                "metadata": event.metadata_json,
            }
        )
        if event.value_length is not None:
            previous_by_field[event.field_name] = event.value_length

    return {
        "entry_session_id": entry_session.id,
        "client_session_hash": stable_hash(entry_session.client_session_id),
        "subject_id": _export_subject_id(user_id, participant_code),
        "started_at": entry_session.started_at.isoformat(),
        "submitted_at": entry_session.submitted_at.isoformat() if entry_session.submitted_at else None,
        "aggregate_metrics": entry_session.aggregate_metrics_json,
        "fields": [
            {
                "field_name": field.field_name,
                "final_text_hash": field.final_text_hash,
                "char_count": field.char_count,
                "word_count": field.word_count,
                "metrics": field.metrics_json,
            }
            for field in fields
        ],
        "events": replay_events,
    }


def create_research_export(
    session: Session,
    user_id: str,
    participant_code: str,
    export_format: str,
) -> ExportJob:
    latest_consent = session.exec(
        select(ConsentRecord)
        .where(ConsentRecord.user_id == user_id, ConsentRecord.participant_code == participant_code)
        .order_by(ConsentRecord.created_at.desc())
        .limit(1)
    ).first()
    consent_filter = {
        "requires_research_analysis": True,
        "requires_anonymized_export": export_format in {"csv", "jsonl", "parquet"},
        "consent_record_id": latest_consent.id if latest_consent else None,
    }
    job = ExportJob(
        user_id=user_id,
        participant_code=participant_code,
        export_format=export_format,
        status="running",
        consent_filter_json=consent_filter,
    )
    session.add(job)
    session.commit()
    session.refresh(job)

    if not latest_consent or not latest_consent.research_analysis or not latest_consent.anonymized_export:
        job.status = "blocked"
        job.error_message = "Consent scope does not allow anonymized research export."
        session.add(job)
        session.commit()
        session.refresh(job)
        return job

    rows = _rows_for_export(session, user_id, participant_code)
    export_root = Path(os.getenv("SENTRA_EXPORT_DIR", "./exports")).resolve()
    export_root.mkdir(parents=True, exist_ok=True)
    base_name = f"sentra_export_{participant_code}_{job.id}"
    try:
        if export_format == "jsonl":
            output_path = export_root / f"{base_name}.jsonl"
            with output_path.open("w", encoding="utf-8") as fh:
                for table_name, table_rows in rows.items():
                    for row in table_rows:
                        fh.write(json.dumps({"table": table_name, "row": row}, ensure_ascii=False, sort_keys=True) + "\n")
        elif export_format == "csv":
            output_path = export_root / base_name
            output_path.mkdir(parents=True, exist_ok=True)
            for table_name, table_rows in rows.items():
                csv_path = output_path / f"{table_name}.csv"
                keys = sorted({key for row in table_rows for key in row.keys()})
                with csv_path.open("w", encoding="utf-8", newline="") as fh:
                    writer = csv.DictWriter(fh, fieldnames=keys)
                    writer.writeheader()
                    writer.writerows(table_rows)
        elif export_format == "parquet":
            import pandas as pd

            output_path = export_root / base_name
            output_path.mkdir(parents=True, exist_ok=True)
            for table_name, table_rows in rows.items():
                pd.DataFrame(table_rows).to_parquet(output_path / f"{table_name}.parquet", index=False)
        else:
            raise ValueError("export_format must be csv, jsonl, or parquet")

        job.status = "completed"
        job.output_path = str(output_path)
        job.completed_at = datetime.utcnow()
        job.manifest_json = {
            "tables": {table_name: len(table_rows) for table_name, table_rows in rows.items()},
            "format": export_format,
            "pipeline_version": PIPELINE_VERSION,
        }
    except Exception as exc:
        job.status = "failed"
        job.error_message = str(exc)
    session.add(job)
    session.commit()
    session.refresh(job)
    return job


def create_fine_tuning_dataset_export(
    session: Session,
    user_id: str,
    participant_code: str,
) -> ExportJob:
    latest_consent = session.exec(
        select(ConsentRecord)
        .where(ConsentRecord.user_id == user_id, ConsentRecord.participant_code == participant_code)
        .order_by(ConsentRecord.created_at.desc())
        .limit(1)
    ).first()
    job = ExportJob(
        user_id=user_id,
        participant_code=participant_code,
        export_format="fine_tuning_jsonl",
        status="running",
        consent_filter_json={
            "requires_future_fine_tuning": True,
            "consent_record_id": latest_consent.id if latest_consent else None,
        },
    )
    session.add(job)
    session.commit()
    session.refresh(job)

    if not latest_consent or not latest_consent.future_fine_tuning:
        job.status = "blocked"
        job.error_message = "Consent scope does not allow future fine-tuning dataset inclusion."
        session.add(job)
        session.commit()
        session.refresh(job)
        return job

    examples = session.exec(
        select(EvalExample).where(
            EvalExample.user_id == user_id,
            EvalExample.participant_code == participant_code,
            EvalExample.review_status == "reviewed",
        )
    ).all()
    export_root = Path(os.getenv("SENTRA_EXPORT_DIR", "./exports")).resolve()
    export_root.mkdir(parents=True, exist_ok=True)
    output_path = export_root / f"sentra_fine_tuning_{participant_code}_{job.id}.jsonl"
    with output_path.open("w", encoding="utf-8") as fh:
        for example in examples:
            fh.write(
                json.dumps(
                    {
                        "messages": [
                            {
                                "role": "system",
                                "content": "You are Sentra's transparent research extraction model. Return schema-valid, evidence-grounded output.",
                            },
                            {"role": "user", "content": json.dumps(example.input_json, ensure_ascii=False, sort_keys=True)},
                            {"role": "assistant", "content": json.dumps(example.expected_output_json, ensure_ascii=False, sort_keys=True)},
                        ],
                        "metadata": {
                            "task_type": example.task_type,
                            "source_entry_id": example.source_entry_id,
                            "pipeline_version": PIPELINE_VERSION,
                        },
                    },
                    ensure_ascii=False,
                    sort_keys=True,
                )
                + "\n"
            )

    job.status = "completed"
    job.output_path = str(output_path)
    job.completed_at = datetime.utcnow()
    job.manifest_json = {"example_count": len(examples), "format": "fine_tuning_jsonl"}
    session.add(job)
    session.commit()
    session.refresh(job)
    return job


def update_eval_example_review_status(
    session: Session,
    user_id: str,
    participant_code: str,
    eval_example_id: int,
    review_status: str,
) -> Optional[EvalExample]:
    if review_status not in {"unreviewed", "reviewed", "rejected"}:
        raise ValueError("review_status must be unreviewed, reviewed, or rejected")
    example = session.get(EvalExample, eval_example_id)
    if not example or example.user_id != user_id or example.participant_code != participant_code:
        return None
    example.review_status = review_status
    session.add(example)
    session.commit()
    session.refresh(example)
    return example


def summarize_eval_readiness(
    session: Session,
    user_id: str,
    participant_code: str,
) -> Dict[str, Any]:
    examples = session.exec(
        select(EvalExample).where(
            EvalExample.user_id == user_id,
            EvalExample.participant_code == participant_code,
        )
    ).all()
    total_nodes = 0
    nodes_with_evidence = 0
    total_relations = 0
    relations_with_evidence = 0
    status_counts: Dict[str, int] = {}
    for example in examples:
        status_counts[example.review_status] = status_counts.get(example.review_status, 0) + 1
        expected = example.expected_output_json or {}
        nodes = expected.get("nodes", []) if isinstance(expected.get("nodes"), list) else []
        relations = expected.get("relations", []) if isinstance(expected.get("relations"), list) else []
        total_nodes += len(nodes)
        total_relations += len(relations)
        nodes_with_evidence += sum(1 for node in nodes if isinstance(node, dict) and node.get("evidence_text"))
        relations_with_evidence += sum(1 for rel in relations if isinstance(rel, dict) and rel.get("evidence_text"))
    summary = {
        "example_count": len(examples),
        "review_status_counts": status_counts,
        "node_evidence_coverage": round(nodes_with_evidence / max(1, total_nodes), 4),
        "relation_evidence_coverage": round(relations_with_evidence / max(1, total_relations), 4),
        "reviewed_examples_ready_for_fine_tuning": status_counts.get("reviewed", 0),
        "pipeline_version": PIPELINE_VERSION,
    }
    record_model_run(
        session,
        user_id=user_id,
        participant_code=participant_code,
        artifact_type="eval_summary",
        artifact_id=f"{user_id}:{participant_code}",
        provider="local",
        model="deterministic-eval-summary",
        output=summary,
        prompt_version="eval-summary-v1",
        schema_version="eval-summary-v1",
        temperature=0.0,
        input_provenance={"example_count": len(examples)},
    )
    return summary


def create_openai_fine_tuning_job(
    session: Session,
    user_id: str,
    participant_code: str,
    export_job_id: int,
    model: Optional[str] = None,
) -> Dict[str, Any]:
    export_job = session.get(ExportJob, export_job_id)
    if not export_job or export_job.user_id != user_id or export_job.participant_code != participant_code:
        return {"status": "blocked", "error_message": "Fine-tuning export job not found for participant."}
    if export_job.status != "completed" or export_job.export_format != "fine_tuning_jsonl" or not export_job.output_path:
        return {"status": "blocked", "error_message": "Fine-tuning dataset export is not completed."}
    if not _has_openai_key():
        return {"status": "blocked", "error_message": "OPENAI_API_KEY is not configured in the backend environment."}

    fine_tune_model = model or os.getenv("OPENAI_FINE_TUNE_MODEL", DEFAULT_CHAT_MODEL)
    status = "submitted"
    error_message = None
    job_payload: Dict[str, Any]
    try:
        client = _openai_client()
        with Path(export_job.output_path).open("rb") as fh:
            uploaded = client.files.create(file=fh, purpose="fine-tune")
        remote_job = client.fine_tuning.jobs.create(
            training_file=uploaded.id,
            model=fine_tune_model,
        )
        job_payload = {
            "openai_file_id": uploaded.id,
            "openai_fine_tuning_job_id": remote_job.id,
            "model": fine_tune_model,
            "status": getattr(remote_job, "status", "submitted"),
        }
    except Exception as exc:
        status = "failed"
        error_message = str(exc)
        job_payload = {"model": fine_tune_model, "error": error_message}

    model_run = record_model_run(
        session,
        user_id=user_id,
        participant_code=participant_code,
        artifact_type="fine_tuning_job",
        artifact_id=export_job_id,
        provider="openai",
        model=fine_tune_model,
        output=job_payload,
        prompt_version="fine-tuning-dataset-v1",
        schema_version="fine-tuning-jsonl-v1",
        temperature=0.0,
        input_provenance={"export_job_id": export_job_id, "output_path_hash": stable_hash(export_job.output_path)},
        status=status,
        error_message=error_message,
    )
    return {**job_payload, "status": status, "model_run_id": model_run.id, "error_message": error_message}
