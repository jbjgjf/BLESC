"""Issues #74, #75, #76 — provenance for the ontology.

The defect these close is not missing citations. It is that a sourced choice
and an invented one looked identical in the code.
"""

import pytest

from app.ontology.schema import CATEGORIES, RELATIONS, VALID_CATEGORIES, VALID_RELATIONS, EvidenceStrength
from app.ontology.seed_graph import load_seed_subgraphs
from app.ontology.sources import SOURCES, SourceKind, UnknownSource, resolve
from app.ontology.validator import validate_extraction


class TestSourceRegistry:
    """#74"""

    def test_expert_judgement_is_a_first_class_kind(self):
        # The point of the registry: an uncited choice is recorded as uncited,
        # not left blank and therefore invisible.
        assert SOURCES["expert_judgement"].kind is SourceKind.EXPERT_JUDGEMENT
        assert SOURCES["expert_judgement"].is_published is False

    def test_seeded_with_the_material_available_without_new_access(self):
        for source_id in ("who_adolescent_mh", "who_mhgap", "nice_ng134", "mhlw_kokoro", "mext_seitoshido"):
            assert source_id in SOURCES

    def test_every_source_states_what_it_does_not_support(self):
        # A fact sheet reporting an association is not a source for a causal
        # claim, and the scope_note is where that lives.
        for source in SOURCES.values():
            assert source.scope_note.strip()
            assert "not" in source.scope_note.lower() or "NOT" in source.scope_note

    def test_retrieval_date_is_recorded(self):
        for source in SOURCES.values():
            assert source.retrieved_on.year >= 2026

    def test_unknown_id_raises_with_a_usable_message(self):
        with pytest.raises(UnknownSource) as caught:
            resolve("nice_ng999")
        assert "expert_judgement" in str(caught.value)

    def test_registry_has_no_ontology_imports(self):
        # It is shared with the probe vocabularies, so it must stay free of
        # ontology-specific imports.
        import inspect

        from app.ontology import sources

        body = inspect.getsource(sources)
        assert "from .schema" not in body
        assert "validator" not in body


class TestSchemaProvenance:
    """#75"""

    def test_all_eleven_terms_carry_provenance(self):
        assert len(CATEGORIES) == 5
        assert len(RELATIONS) == 6
        for term in list(CATEGORIES.values()) + list(RELATIONS.values()):
            assert term.source_refs, term.name
            assert term.scope_note.strip(), term.name

    def test_every_source_ref_resolves(self):
        for term in list(CATEGORIES.values()) + list(RELATIONS.values()):
            for source_id in term.source_refs:
                resolve(source_id)

    def test_evidence_strength_is_separate_from_relation_type(self):
        # The whole point: an edge can be typed `causes` while recording that
        # its support is observational.
        assert RELATIONS["causes"].evidence_strength is EvidenceStrength.ASSOCIATION

    def test_causal_strength_is_not_claimed_anywhere_yet(self):
        # Nothing in the available guideline material supports a causal claim,
        # so no term should assert one.
        assert not [t for t in RELATIONS.values() if t.evidence_strength is EvidenceStrength.CAUSAL]

    def test_unsourced_terms_are_marked_rather_than_blank(self):
        judged = [t.name for t in list(CATEGORIES.values()) + list(RELATIONS.values()) if t.is_expert_judgement]
        assert "Event" in judged  # not a psychological category at all
        assert "co_occurs" in judged

    def test_a_term_cannot_be_created_without_provenance(self):
        from app.ontology.schema import OntologyTerm

        with pytest.raises(ValueError):
            OntologyTerm(name="X", scope_note="note", source_refs=[])
        with pytest.raises(ValueError):
            OntologyTerm(name="X", scope_note="  ", source_refs=["expert_judgement"])

    def test_vocabulary_is_unchanged(self):
        # This issue adds provenance to what exists; widening or narrowing the
        # sets is a separate change with its own argument.
        assert VALID_CATEGORIES == {"State", "Trigger", "Protective", "Behavior", "Event"}
        assert VALID_RELATIONS == {"causes", "escalates", "buffers", "avoids", "co_occurs", "precedes"}

    def test_validator_behaviour_is_unchanged(self):
        result = validate_extraction({
            "nodes": [{"node_id": "a", "class": "Vibe"}],
            "relations": [],
        })
        assert result["nodes"][0]["category"] == "State"
        assert result["coercion_count"] == 1


class TestSleepSubgraph:
    """#76 — the chain the landing page already claims."""

    @pytest.fixture(scope="class")
    def sleep(self):
        return load_seed_subgraphs()["sleep_deprivation"]

    def test_the_landing_pages_chain_is_encoded(self, sleep):
        # 睡眠不足 → 認知機能の低下 → 抑うつ傾向, which existed nowhere.
        pairs = {(edge.source, edge.target) for edge in sleep.edges}
        assert ("sleep_deprivation", "cognitive_impairment") in pairs
        assert ("cognitive_impairment", "depressed_mood") in pairs

    def test_edge_count_is_within_the_stated_range(self, sleep):
        assert 10 <= len(sleep.edges) <= 20

    def test_every_node_is_bilingual_and_sourced(self, sleep):
        for node in sleep.nodes.values():
            assert node.label_ja and node.label_en
            assert node.source_refs
            assert node.category in VALID_CATEGORIES

    def test_every_edge_carries_a_scope_note(self, sleep):
        for edge in sleep.edges:
            assert edge.scope_note.strip(), f"{edge.source}->{edge.target}"

    def test_observational_support_is_not_dressed_as_causal(self, sleep):
        # The rule the file is curated under: where the source reports an
        # association, evidence_strength says association even when the
        # relation type is `causes`.
        assert not [e for e in sleep.edges if e.evidence_strength is EvidenceStrength.CAUSAL]
        causes_edges = [e for e in sleep.edges if e.type == "causes"]
        assert causes_edges
        for edge in causes_edges:
            assert edge.evidence_strength in (EvidenceStrength.ASSOCIATION, EvidenceStrength.EXPERT_JUDGEMENT)

    def test_the_reverse_direction_is_encoded_too(self, sleep):
        # Sleep and mood are bidirectional in the literature; a one-way graph
        # would misrepresent it.
        pairs = {(edge.source, edge.target) for edge in sleep.edges}
        assert ("sleep_deprivation", "depressed_mood") in pairs
        assert ("depressed_mood", "sleep_deprivation") in pairs

    def test_unsourced_edges_are_visible_not_hidden(self, sleep):
        assert 0 < sleep.unsourced_edge_rate < 1, "a subgraph with no judgement edges is suspicious"

    def test_loader_rejects_an_unknown_source_id(self, tmp_path):
        bad = tmp_path / "bad.yaml"
        bad.write_text(
            "subgraph_id: bad\nnodes:\n"
            "  - {id: n, category: State, label_ja: あ, label_en: a, source_refs: [nice_ng999]}\n"
            "edges: []\n",
            encoding="utf-8",
        )
        from app.ontology import seed_graph

        with pytest.raises(UnknownSource):
            seed_graph._load_file(bad)

    def test_loader_rejects_an_edge_with_no_scope_note(self, tmp_path):
        bad = tmp_path / "bad.yaml"
        bad.write_text(
            "subgraph_id: bad\nnodes:\n"
            "  - {id: a, category: State, label_ja: あ, label_en: a, source_refs: [expert_judgement]}\n"
            "  - {id: b, category: State, label_ja: い, label_en: b, source_refs: [expert_judgement]}\n"
            "edges:\n"
            "  - {source: a, target: b, type: causes, evidence_strength: association,"
            " source_refs: [expert_judgement], scope_note: ''}\n",
            encoding="utf-8",
        )
        from app.ontology import seed_graph

        with pytest.raises(seed_graph.SeedGraphError):
            seed_graph._load_file(bad)
