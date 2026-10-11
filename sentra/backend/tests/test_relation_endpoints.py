"""The shared relation-endpoint resolver (#304).

The writer test covers the row that was broken. These cover the contract the
other readers now rely on: either spelling resolves, nothing is guessed, and
the local change key in `research_pipeline` agrees with the Supabase one about
which relation it is looking at.
"""

from app.ontology.relation_endpoints import (
    UNRESOLVED_ENDPOINT,
    relation_source_id,
    relation_source_or_unresolved,
    relation_target_id,
    relation_target_or_unresolved,
)
from app.services import research_pipeline


def test_both_spellings_resolve_to_the_same_endpoints():
    extractor_shape = {"source_node_id": "exam", "target_node_id": "sleep", "type": "causes"}
    validated_shape = {"source_id": "exam", "target_id": "sleep", "type": "causes"}

    for relation in (extractor_shape, validated_shape):
        assert relation_source_id(relation) == "exam"
        assert relation_target_id(relation) == "sleep"


def test_a_missing_endpoint_is_empty_not_guessed():
    for relation in ({}, {"source_node_id": None, "source_id": ""}):
        assert relation_source_id(relation) == ""
        assert relation_target_id(relation) == ""
        assert relation_source_or_unresolved(relation) == UNRESOLVED_ENDPOINT
        assert relation_target_or_unresolved(relation) == UNRESOLVED_ENDPOINT


def test_the_marker_cannot_split_a_change_key():
    """Both change keys use `:` or `|` as separators; the marker holds neither."""
    assert ":" not in UNRESOLVED_ENDPOINT
    assert "|" not in UNRESOLVED_ENDPOINT
    assert UNRESOLVED_ENDPOINT != "None"


def test_the_local_change_key_uses_the_shared_resolver():
    extractor_shape = {"source_node_id": "exam", "target_node_id": "sleep", "type": "causes"}
    validated_shape = {"source_id": "exam", "target_id": "sleep", "type": "causes"}

    assert research_pipeline._entity_key(extractor_shape, "relation") == "exam|sleep|causes"
    assert research_pipeline._entity_key(validated_shape, "relation") == "exam|sleep|causes"
    assert research_pipeline._entity_key({"type": "causes"}, "relation") == (
        f"{UNRESOLVED_ENDPOINT}|{UNRESOLVED_ENDPOINT}|causes"
    )
