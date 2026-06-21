"""
Normalized graph index for Graph RAG.

Today's Graph RAG scans up to 250 full `GraphSnapshot` rows per query and scores
them with Python-side token overlap over JSONB blobs (see
`research_pipeline.search_similar_graph_patterns`). Nodes/relations have no
persistent identity across days, so there is no real semantic search, no
traversal, and no recency/confidence/recurrence weighting.

This module maintains `graph_nodes`/`graph_edges` as a deduplicated, embedded,
traversable index *derived from* the existing `graph_versions` JSONB source of
truth — `graph_snapshots`/`graph_versions` are untouched; this is additive.

`upsert_graph_index` is the only function here that touches the DB session. The
rest (key derivation, traversal, ranking) are pure functions over plain dicts so
they stay unit-testable and dependency-free, following the same convention as
pattern_mining.py and memory_objects.py.
"""

from __future__ import annotations

import math
import os
import re
from datetime import date, datetime
from typing import Any, Callable, Dict, List, Optional, Sequence, Set, Tuple

from sqlmodel import Session, select

from ..schemas.research import GraphEdge, GraphNode

GRAPH_INDEX_VERSION = "graph-index-v1"

DEFAULT_TRAVERSAL_DEPTH = 2
DEFAULT_MAX_TRAVERSAL_NODES = 30
DEFAULT_RECENCY_HALF_LIFE_DAYS = 30.0
DEFAULT_RECURRENCE_CAP = 8

DEFAULT_WEIGHTS = {
    "semantic": float(os.getenv("SENTRA_GRAPH_RAG_WEIGHT_SEMANTIC", "0.35")),
    "distance": float(os.getenv("SENTRA_GRAPH_RAG_WEIGHT_DISTANCE", "0.15")),
    "confidence": float(os.getenv("SENTRA_GRAPH_RAG_WEIGHT_CONFIDENCE", "0.15")),
    "recency": float(os.getenv("SENTRA_GRAPH_RAG_WEIGHT_RECENCY", "0.15")),
    "recurrence": float(os.getenv("SENTRA_GRAPH_RAG_WEIGHT_RECURRENCE", "0.10")),
    "memory_importance": float(os.getenv("SENTRA_GRAPH_RAG_WEIGHT_MEMORY", "0.10")),
}


# ── key derivation ──────────────────────────────────────────────────────────────
def _normalize(value: Any) -> str:
    text = str(value or "").lower()
    text = re.sub(r"[^a-z0-9_\-\sぁ-んァ-ン一-龥]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def node_key(category: str, label: str) -> str:
    return f"{_normalize(category)}:{_normalize(label)}"


def relation_signature_text(
    source_category: str,
    source_label: str,
    relation_type: str,
    target_category: str,
    target_label: str,
) -> str:
    return f"{source_category}:{source_label} -{relation_type}-> {target_category}:{target_label}"


# ── upsert (touches the DB) ───────────────────────────────────────────────────
def upsert_graph_index(
    session: Session,
    user_id: str,
    participant_code: str,
    nodes: Sequence[Dict[str, Any]],
    relations: Sequence[Dict[str, Any]],
    day: date,
    embed_fn: Optional[Callable[[str], Tuple[List[float], str, str]]] = None,
) -> Dict[str, Any]:
    """
    Upsert graph_nodes/graph_edges from one entry's extracted nodes/relations.

    Idempotent: re-processing the same entry never duplicates rows. A repeated
    node_key bumps `occurrence_count`, refreshes `confidence`/`intensity`, and
    extends `last_seen_day`; a repeated (source, target, type) edge does the same
    plus rolls `mean_confidence` forward.

    `embed_fn(text) -> (vector, model, status)` is injected by the caller so this
    module has no direct OpenAI dependency; pass None to skip embeddings entirely
    (rows are stored with `embedding_status="pending_no_openai_key"`).
    """
    node_ids_by_raw_id: Dict[str, int] = {}
    touched_node_ids: List[int] = []

    for raw_node in nodes:
        category = str(raw_node.get("category") or "Unknown")
        label = str(raw_node.get("label") or raw_node.get("id") or raw_node.get("node_id") or "")
        if not label:
            continue
        key = node_key(category, label)
        existing = session.exec(
            select(GraphNode).where(
                GraphNode.user_id == user_id,
                GraphNode.participant_code == participant_code,
                GraphNode.node_key == key,
            )
        ).first()
        confidence = float(raw_node.get("confidence", 1.0))
        intensity = float(raw_node.get("intensity", 0.5))
        if existing:
            existing.label = label
            existing.confidence = confidence
            existing.intensity = intensity
            existing.occurrence_count += 1
            existing.last_seen_day = day
            existing.updated_at = datetime.utcnow()
            session.add(existing)
            node_row = existing
        else:
            vector, model, status = [], "not_generated", "pending_no_openai_key"
            if embed_fn:
                vector, model, status = embed_fn(f"{category}: {label}")
            node_row = GraphNode(
                user_id=user_id,
                participant_code=participant_code,
                node_key=key,
                category=category,
                label=label,
                vector_json=vector,
                embedding_model=model,
                embedding_status=status,
                confidence=confidence,
                intensity=intensity,
                occurrence_count=1,
                first_seen_day=day,
                last_seen_day=day,
            )
            session.add(node_row)
        session.flush()
        raw_id = str(raw_node.get("id") or raw_node.get("node_id") or label)
        node_ids_by_raw_id[raw_id] = node_row.id
        touched_node_ids.append(node_row.id)

    touched_edge_ids: List[int] = []
    for raw_relation in relations:
        source_raw = str(raw_relation.get("source_id") or raw_relation.get("source_node_id") or "")
        target_raw = str(raw_relation.get("target_id") or raw_relation.get("target_node_id") or "")
        source_node_id = node_ids_by_raw_id.get(source_raw)
        target_node_id = node_ids_by_raw_id.get(target_raw)
        if not source_node_id or not target_node_id:
            continue
        relation_type = str(raw_relation.get("type") or "co_occurs")
        existing_edge = session.exec(
            select(GraphEdge).where(
                GraphEdge.user_id == user_id,
                GraphEdge.participant_code == participant_code,
                GraphEdge.source_node_id == source_node_id,
                GraphEdge.target_node_id == target_node_id,
                GraphEdge.relation_type == relation_type,
            )
        ).first()
        confidence = float(raw_relation.get("confidence", 1.0))
        if existing_edge:
            existing_edge.confidence = confidence
            existing_edge.confidence_count += 1
            existing_edge.mean_confidence = (
                (existing_edge.mean_confidence * (existing_edge.confidence_count - 1) + confidence)
                / existing_edge.confidence_count
            )
            existing_edge.occurrence_count += 1
            existing_edge.last_seen_day = day
            existing_edge.updated_at = datetime.utcnow()
            session.add(existing_edge)
            edge_row = existing_edge
        else:
            source_node = session.get(GraphNode, source_node_id)
            target_node = session.get(GraphNode, target_node_id)
            signature = relation_signature_text(
                source_node.category if source_node else "Unknown",
                source_node.label if source_node else source_raw,
                relation_type,
                target_node.category if target_node else "Unknown",
                target_node.label if target_node else target_raw,
            )
            vector, model, status = [], "not_generated", "pending_no_openai_key"
            if embed_fn:
                vector, model, status = embed_fn(signature)
            edge_row = GraphEdge(
                user_id=user_id,
                participant_code=participant_code,
                source_node_id=source_node_id,
                target_node_id=target_node_id,
                relation_type=relation_type,
                vector_json=vector,
                embedding_model=model,
                embedding_status=status,
                confidence=confidence,
                mean_confidence=confidence,
                confidence_count=1,
                occurrence_count=1,
                first_seen_day=day,
                last_seen_day=day,
            )
            session.add(edge_row)
        session.flush()
        touched_edge_ids.append(edge_row.id)

    session.commit()
    return {"node_ids": touched_node_ids, "edge_ids": touched_edge_ids}


# ── traversal (pure) ──────────────────────────────────────────────────────────
def traverse_graph(
    seed_node_ids: Sequence[int],
    edges: Sequence[Dict[str, Any]],
    depth: int = DEFAULT_TRAVERSAL_DEPTH,
    max_nodes: int = DEFAULT_MAX_TRAVERSAL_NODES,
) -> Dict[int, int]:
    """
    Bounded BFS from `seed_node_ids` over an edge list (treated as undirected for
    hop-distance purposes). `edges` is a sequence of dicts with at least
    `source_node_id`/`target_node_id` keys. Returns `{node_id: hop_distance}`,
    with every seed at distance 0.
    """
    adjacency: Dict[int, Set[int]] = {}
    for edge in edges:
        source_id = edge.get("source_node_id")
        target_id = edge.get("target_node_id")
        if source_id is None or target_id is None:
            continue
        adjacency.setdefault(source_id, set()).add(target_id)
        adjacency.setdefault(target_id, set()).add(source_id)

    distances: Dict[int, int] = {node_id: 0 for node_id in seed_node_ids}
    frontier: Set[int] = set(seed_node_ids)
    for hop in range(1, depth + 1):
        next_frontier: Set[int] = set()
        for node_id in frontier:
            for neighbor in adjacency.get(node_id, set()):
                if neighbor not in distances:
                    distances[neighbor] = hop
                    next_frontier.add(neighbor)
        frontier = next_frontier
        if not frontier or len(distances) >= max_nodes:
            break

    if len(distances) > max_nodes:
        ordered = sorted(distances.items(), key=lambda item: item[1])[:max_nodes]
        distances = dict(ordered)
    return distances


# ── ranking components (pure) ──────────────────────────────────────────────────
def graph_distance_score(hop_distance: int) -> float:
    if hop_distance <= 0:
        return 1.0
    return 1.0 / (1 + hop_distance)


def recency_score(days_since_last_seen: float, half_life_days: float = DEFAULT_RECENCY_HALF_LIFE_DAYS) -> float:
    if half_life_days <= 0:
        return 1.0
    days_since_last_seen = max(0.0, days_since_last_seen)
    return 0.5 ** (days_since_last_seen / half_life_days)


def recurrence_score(occurrence_count: int, cap: int = DEFAULT_RECURRENCE_CAP) -> float:
    if occurrence_count <= 0:
        return 0.0
    return min(1.0, math.log(1 + occurrence_count) / math.log(1 + cap))


def hybrid_rank(
    semantic_similarity: float,
    hop_distance: int,
    confidence: float,
    days_since_last_seen: float,
    occurrence_count: int,
    linked_memory_importance: float = 0.0,
    weights: Optional[Dict[str, float]] = None,
) -> Tuple[float, Dict[str, Any]]:
    """
    Combines semantic similarity, graph distance, edge/node confidence, recency,
    recurrence, and any linked conversation-memory importance into one score.
    Every component (and the weights used) is returned so the result is always
    inspectable — no opaque blended number.
    """
    weights = weights or DEFAULT_WEIGHTS
    components = {
        "semantic_similarity": round(max(0.0, min(1.0, semantic_similarity)), 4),
        "graph_distance_score": round(graph_distance_score(hop_distance), 4),
        "confidence": round(max(0.0, min(1.0, confidence)), 4),
        "recency_score": round(recency_score(days_since_last_seen), 4),
        "recurrence_score": round(recurrence_score(occurrence_count), 4),
        "linked_memory_importance": round(max(0.0, min(1.0, linked_memory_importance)), 4),
    }
    weight_key_by_component = {
        "semantic_similarity": "semantic",
        "graph_distance_score": "distance",
        "confidence": "confidence",
        "recency_score": "recency",
        "recurrence_score": "recurrence",
        "linked_memory_importance": "memory_importance",
    }
    score = sum(
        components[component_key] * weights[weight_key]
        for component_key, weight_key in weight_key_by_component.items()
    )
    breakdown = {"components": components, "weights": dict(weights)}
    return round(score, 6), breakdown
