"""Unit tests for the dependency-free graph_nodes/graph_edges ranking helpers."""

from app.analytics.graph_index import (
    DEFAULT_WEIGHTS,
    graph_distance_score,
    hybrid_rank,
    node_key,
    recency_score,
    recurrence_score,
    relation_signature_text,
    traverse_graph,
)


def test_node_key_normalizes_category_and_label_for_stable_identity():
    assert node_key("Trigger", "Deadline Pressure") == node_key("trigger", "deadline   pressure")
    assert node_key("Trigger", "deadline") != node_key("State", "deadline")


def test_relation_signature_text_is_human_readable_and_directional():
    forward = relation_signature_text("Trigger", "deadline", "escalates", "State", "anxiety")
    backward = relation_signature_text("State", "anxiety", "escalates", "Trigger", "deadline")
    assert forward != backward
    assert "deadline" in forward and "anxiety" in forward and "escalates" in forward


def test_traverse_graph_bfs_hop_distances():
    # 1 -> 2 -> 3 -> 4, seeded from {1}
    edges = [
        {"source_node_id": 1, "target_node_id": 2},
        {"source_node_id": 2, "target_node_id": 3},
        {"source_node_id": 3, "target_node_id": 4},
    ]
    distances = traverse_graph([1], edges, depth=2, max_nodes=30)
    assert distances == {1: 0, 2: 1, 3: 2}
    assert 4 not in distances  # beyond depth 2


def test_traverse_graph_respects_max_nodes_cap():
    edges = [{"source_node_id": 0, "target_node_id": i} for i in range(1, 10)]
    distances = traverse_graph([0], edges, depth=1, max_nodes=3)
    assert len(distances) == 3
    assert 0 in distances  # the seed is always kept (distance 0)


def test_traverse_graph_no_seeds_returns_empty():
    assert traverse_graph([], [{"source_node_id": 1, "target_node_id": 2}]) == {}


def test_graph_distance_score_decreases_with_hops():
    assert graph_distance_score(0) == 1.0
    assert graph_distance_score(1) == 0.5
    assert round(graph_distance_score(2), 4) == 0.3333


def test_recency_score_at_half_life_is_half():
    assert recency_score(0, half_life_days=30) == 1.0
    assert abs(recency_score(30, half_life_days=30) - 0.5) < 1e-9
    assert recency_score(-5, half_life_days=30) == 1.0  # negative clamped to "now"


def test_recurrence_score_zero_at_zero_occurrences_and_saturates_below_one():
    assert recurrence_score(0) == 0.0
    low = recurrence_score(1, cap=8)
    high = recurrence_score(8, cap=8)
    assert 0.0 < low < high <= 1.0


def test_hybrid_rank_combines_all_six_components_and_weights_sum_to_one():
    assert abs(sum(DEFAULT_WEIGHTS.values()) - 1.0) < 1e-9

    score, breakdown = hybrid_rank(
        semantic_similarity=0.8,
        hop_distance=0,
        confidence=0.9,
        days_since_last_seen=0,
        occurrence_count=5,
        linked_memory_importance=0.6,
    )
    expected_components = {
        "semantic_similarity",
        "graph_distance_score",
        "confidence",
        "recency_score",
        "recurrence_score",
        "linked_memory_importance",
    }
    assert set(breakdown["components"].keys()) == expected_components
    assert 0.0 < score <= 1.0

    # A far-away, low-confidence, stale, never-recurring node should rank lower.
    weak_score, _ = hybrid_rank(
        semantic_similarity=0.1,
        hop_distance=2,
        confidence=0.2,
        days_since_last_seen=90,
        occurrence_count=0,
        linked_memory_importance=0.0,
    )
    assert weak_score < score
