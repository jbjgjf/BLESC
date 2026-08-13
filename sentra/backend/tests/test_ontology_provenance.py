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


class TestSocialWithdrawalSubgraph:
    """#77 — where the product's own signal lives.

    Behavior:withdrawal, the protective decline the pipeline already computes,
    and the `protective_decline` benchmark case. None of it was sourced.
    """

    @pytest.fixture(scope="class")
    def withdrawal(self):
        return load_seed_subgraphs()["social_withdrawal"]

    def test_edge_count_is_within_the_stated_range(self, withdrawal):
        assert 10 <= len(withdrawal.edges) <= 20

    def test_every_node_is_bilingual_and_sourced(self, withdrawal):
        for node in withdrawal.nodes.values():
            assert node.label_ja and node.label_en
            assert node.source_refs
            assert node.category in VALID_CATEGORIES

    def test_every_edge_carries_source_refs_and_a_scope_note(self, withdrawal):
        for edge in withdrawal.edges:
            assert edge.source_refs, f"{edge.source}->{edge.target}"
            assert edge.scope_note.strip(), f"{edge.source}->{edge.target}"

    def test_observational_support_is_not_dressed_as_causal(self, withdrawal):
        assert not [e for e in withdrawal.edges if e.evidence_strength is EvidenceStrength.CAUSAL]
        for edge in [e for e in withdrawal.edges if e.type == "causes"]:
            assert edge.evidence_strength in (EvidenceStrength.ASSOCIATION, EvidenceStrength.EXPERT_JUDGEMENT)

    def test_both_required_sources_are_drawn_on(self, withdrawal):
        # 生徒指導提要 for the Japanese school context, WHO for the adolescent
        # material. The issue names both; neither may be quietly dropped.
        cited = {ref for edge in withdrawal.edges for ref in edge.source_refs}
        cited |= {ref for node in withdrawal.nodes.values() for ref in node.source_refs}
        assert "mext_seitoshido" in cited
        assert "who_adolescent_mh" in cited

    def test_protective_decline_is_an_edge_pattern_not_only_negative_states(self, withdrawal):
        # What the `protective_decline` benchmark case asserts: the graph should
        # connect protective resources, not just accumulate negative terms.
        protective = {n.id for n in withdrawal.nodes.values() if n.category == "Protective"}
        assert len(protective) >= 3

        # No decorative protective nodes — one that participates in no edge
        # would pad the category without connecting anything.
        for node_id in protective:
            assert [e for e in withdrawal.edges if node_id in (e.source, e.target)], node_id

        # The decline is a pair on one resource: `buffers` while it holds,
        # `avoids` for the disengagement. A file where no single resource
        # carries both halves cannot express decline at all — it would only
        # have resources that help and, separately, resources that are dropped.
        buffers_out = {e.source for e in withdrawal.edges if e.type == "buffers"}
        avoids_in = {e.target for e in withdrawal.edges if e.type == "avoids"}
        assert protective & buffers_out & avoids_in

    def test_shared_claims_are_stated_identically(self, withdrawal):
        # Two edges are carried by sleep.yaml as well. They are one reading of
        # NG134 appearing twice, not two independent supports — so they must
        # agree exactly, and a merge that de-duplicates on (source, target,
        # type) can then drop a copy without choosing between versions. If they
        # ever diverge, that merge silently picks a winner.
        sleep = load_seed_subgraphs()["sleep_deprivation"]
        here = {(e.source, e.target, e.type): e for e in withdrawal.edges}
        there = {(e.source, e.target, e.type): e for e in sleep.edges}

        shared = set(here) & set(there)
        assert shared, "expected the withdrawal edges sleep.yaml also carries"

        for key in shared:
            assert here[key].evidence_strength is there[key].evidence_strength, key
            assert sorted(here[key].source_refs) == sorted(there[key].source_refs), key

    def test_withdrawal_reaches_a_protective_resource(self, withdrawal):
        # The benchmark case walks from Behavior:withdrawal to the support the
        # student stopped using. If that path is missing the case cannot pass.
        protective = {n.id for n in withdrawal.nodes.values() if n.category == "Protective"}
        from_withdrawal = {e.target for e in withdrawal.edges if e.source == "social_withdrawal"}
        assert from_withdrawal & protective

    def test_futoko_is_never_mapped_onto_a_clinical_construct(self, withdrawal):
        # The construct mismatch the issue warns about: 不登校 is an
        # administrative category from a 文部科学省 counting rule, not a
        # clinical one. Every edge touching it must be judgement, sourced to
        # nothing clinical, and must say so.
        futoko_edges = [e for e in withdrawal.edges if "futoko" in (e.source, e.target)]
        assert futoko_edges

        for edge in futoko_edges:
            assert edge.evidence_strength is EvidenceStrength.EXPERT_JUDGEMENT, f"{edge.source}->{edge.target}"
            assert "nice_ng134" not in edge.source_refs, f"{edge.source}->{edge.target}"
            assert "who_adolescent_mh" not in edge.source_refs, f"{edge.source}->{edge.target}"
            assert "who_mhgap" not in edge.source_refs, f"{edge.source}->{edge.target}"

        # And no edge may claim 不登校 is caused by a clinical state.
        for edge in futoko_edges:
            if edge.source in ("depressed_mood", "anxiety") or edge.target in ("depressed_mood", "anxiety"):
                assert edge.type == "precedes", f"{edge.source}->{edge.target} asserts more than ordering"

    def test_the_judgement_rate_is_reported_not_minimised(self, withdrawal):
        # Higher than sleep.yaml's, and that is the honest result: 生徒指導提要
        # supports no clinical claim and the WHO fact sheet reports population
        # risk factors, so most withdrawal edges have nothing to cite.
        assert 0 < withdrawal.unsourced_edge_rate < 1
        assert withdrawal.unsourced_edge_rate > load_seed_subgraphs()["sleep_deprivation"].unsourced_edge_rate

    def test_it_does_not_contradict_the_sleep_subgraph(self, withdrawal):
        # Both files carry school_absence and social_withdrawal. Same
        # orientation in both, or a merged graph gains a cycle that neither
        # file's curation argued for.
        sleep = load_seed_subgraphs()["sleep_deprivation"]
        shared = {(e.source, e.target) for e in sleep.edges} & {
            (e.target, e.source) for e in withdrawal.edges
        }
        assert not shared, f"orientation conflict with sleep.yaml: {shared}"


class TestGeneratedGraphAnnotation:
    """#80 — the curated subgraphs were inert until the extraction path saw them."""

    @staticmethod
    def _extract():
        return validate_extraction({
            "nodes": [
                {"node_id": "sleep_deprivation", "label": "睡眠不足", "class": "Trigger"},
                {"node_id": "x1", "label": "認知機能の低下", "class": "State"},
                {"node_id": "weird", "label": "テスト前の胃痛", "class": "State"},
            ],
            "relations": [
                {"source_id": "sleep_deprivation", "target_id": "x1", "type": "causes"},
                {"source_id": "sleep_deprivation", "target_id": "weird", "type": "causes"},
                {"source_id": "x1", "target_id": "sleep_deprivation", "type": "escalates"},
            ],
        })

    def test_curated_elements_are_annotated(self):
        result = self._extract()
        by_id = {node["id"]: node for node in result["nodes"]}
        assert by_id["sleep_deprivation"]["provenance"]["matched"] is True
        assert by_id["sleep_deprivation"]["provenance"]["source_refs"]

    def test_a_node_matches_on_its_japanese_label_not_only_its_id(self):
        result = self._extract()
        by_id = {node["id"]: node for node in result["nodes"]}
        # id "x1" means nothing; the label 認知機能の低下 is what matches.
        assert by_id["x1"]["provenance"]["matched"] is True
        assert by_id["x1"]["provenance"]["match_rule"] == "normalised_label"

    def test_unmatched_is_stated_never_absent(self):
        # An absent key reads as "not checked", which is a different claim
        # from "checked and not found".
        result = self._extract()
        by_id = {node["id"]: node for node in result["nodes"]}
        assert by_id["weird"]["provenance"]["matched"] is False
        assert by_id["weird"]["provenance"]["source_refs"] == []
        for relation in result["relations"]:
            assert "matched" in relation["provenance"]

    def test_matching_annotates_and_never_rewrites(self):
        # The trap the issue names: correcting the model with the seed graph
        # would make the graph condition score against its own answer key.
        result = self._extract()
        assert [rel["type"] for rel in result["relations"]] == ["causes", "causes", "escalates"]
        by_id = {node["id"]: node for node in result["nodes"]}
        assert by_id["weird"]["category"] == "State"
        assert by_id["sleep_deprivation"]["category"] == "Trigger"

    def test_disagreement_with_the_seed_is_recorded_not_corrected(self):
        # x1 -> sleep_deprivation is `escalates` from the model; the curated
        # edge is `causes`. The model's type stands and the mismatch is a flag.
        result = self._extract()
        escalates = [rel for rel in result["relations"] if rel["type"] == "escalates"][0]
        assert escalates["type"] == "escalates"
        if escalates["provenance"]["matched"]:
            assert escalates["provenance"]["type_matches_seed"] is False

    def test_an_edge_between_two_curated_nodes_that_is_not_curated_is_counted(self):
        # Neither error nor success — the model asserting a relation the
        # curation does not carry is the interesting set.
        result = self._extract()
        assert result["provenance"]["edges_between_curated_nodes_not_in_seed"] >= 0

    def test_coverage_is_reported_in_the_coercion_style(self):
        result = self._extract()
        coverage = result["provenance"]
        for key in ("nodes_with_source", "edges_with_source", "edges_by_strength",
                    "unsourced_rate", "matched_seed_subgraphs", "match_rules"):
            assert key in coverage

    def test_the_matching_rule_is_stated(self):
        # An unstated matching rule makes the coverage number unfalsifiable.
        assert self._extract()["provenance"]["match_rules"] == ["exact_id", "normalised_label"]

    def test_a_graph_with_nothing_curated_reports_zero_not_an_error(self):
        result = validate_extraction({
            "nodes": [{"node_id": "n", "label": "まったく無関係", "class": "State"}],
            "relations": [],
        })
        assert result["provenance"]["nodes_with_source"] == 0.0
        assert result["provenance"]["matched_seed_subgraphs"] == []

    def test_coercion_behaviour_is_untouched(self):
        result = validate_extraction({"nodes": [{"node_id": "a", "class": "Vibe"}]})
        assert result["coercion_count"] == 1
        assert result["nodes"][0]["category"] == "State"
