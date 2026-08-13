"""Issues #74, #75, #76 — provenance for the ontology.

The defect these close is not missing citations. It is that a sourced choice
and an invented one looked identical in the code.
"""

from pathlib import Path

import pytest

from app.ontology.provenance import COVERAGE_NOTE, MATCH_RULES, provenance_coverage
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
        # Some of these edges and nodes are carried by the other seed files as
        # well — one reading of NG134 or mhGAP appearing more than once, not
        # several independent supports. They must agree exactly, so a merge
        # that de-duplicates on (source, target, type) can drop a copy without
        # choosing between versions. If they ever diverge, that merge silently
        # picks a winner, and so does `provenance._label_index`, which is
        # first-writer-wins over sorted(glob) and resolves these labels to
        # whichever file sorts first.
        #
        # Runs over every other loaded subgraph rather than sleep.yaml alone:
        # `trusted_adult_contact -> depressed_mood` is in three files now, and
        # a pairwise check would have kept passing while missing the third.
        others = {k: v for k, v in load_seed_subgraphs().items() if k != "social_withdrawal"}
        assert others, "expected the other seed files alongside this one"

        here_nodes = withdrawal.nodes
        shared_nodes = 0
        for other in others.values():
            for node_id, node in here_nodes.items():
                twin = other.nodes.get(node_id)
                if twin is None:
                    continue
                shared_nodes += 1
                assert (node.category, node.label_ja, node.label_en) == (
                    twin.category, twin.label_ja, twin.label_en), node_id
                assert sorted(node.source_refs) == sorted(twin.source_refs), node_id
        assert shared_nodes, "expected the nodes this file shares with the others"

        here = {(e.source, e.target, e.type): e for e in withdrawal.edges}
        shared_edges = 0
        for other in others.values():
            for key, twin in {(e.source, e.target, e.type): e for e in other.edges}.items():
                if key not in here:
                    continue
                shared_edges += 1
                assert here[key].evidence_strength is twin.evidence_strength, key
                assert sorted(here[key].source_refs) == sorted(twin.source_refs), key
        assert shared_edges, "expected the edges this file shares with the others"

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

    def test_it_does_not_contradict_another_subgraph(self, withdrawal):
        # A reversed shared edge would give a merged graph a cycle no file's
        # curation argued for. Over every loaded subgraph, not sleep.yaml
        # alone, for the same reason as the shared-claim check above.
        here = {(e.source, e.target) for e in withdrawal.edges}
        for subgraph_id, other in load_seed_subgraphs().items():
            if subgraph_id == "social_withdrawal":
                continue
            reversed_pairs = here & {(e.target, e.source) for e in other.edges}
            assert not reversed_pairs, f"orientation conflict with {subgraph_id}: {reversed_pairs}"


class TestAcademicPressureSubgraph:
    """#78 — the trigger the case set uses most, and the chain the temporal
    benchmark cases (#87, #88) are built on.

    The order these assertions defend: the chain is curated here and the cases
    are written against it. Cases written first would assert whatever the graph
    happened to contain, and the graph condition would be scoring its own
    answer key.
    """

    @pytest.fixture(scope="class")
    def pressure(self):
        return load_seed_subgraphs()["academic_pressure"]

    def test_edge_count_is_within_the_stated_range(self, pressure):
        assert 10 <= len(pressure.edges) <= 20

    def test_every_node_is_bilingual_and_sourced(self, pressure):
        for node in pressure.nodes.values():
            assert node.label_ja and node.label_en
            assert node.source_refs
            assert node.category in VALID_CATEGORIES

    def test_every_edge_carries_source_refs_and_a_scope_note(self, pressure):
        for edge in pressure.edges:
            assert edge.source_refs, f"{edge.source}->{edge.target}"
            assert edge.scope_note.strip(), f"{edge.source}->{edge.target}"

    def test_observational_support_is_not_dressed_as_causal(self, pressure):
        assert not [e for e in pressure.edges if e.evidence_strength is EvidenceStrength.CAUSAL]
        for edge in [e for e in pressure.edges if e.type == "causes"]:
            assert edge.evidence_strength in (EvidenceStrength.ASSOCIATION, EvidenceStrength.EXPERT_JUDGEMENT)

    def test_no_node_sits_in_the_file_without_an_edge(self, pressure):
        # A node kept alive by nothing is padding, and pads the category counts
        # a reader uses to judge the file.
        for node_id in pressure.nodes:
            assert [e for e in pressure.edges if node_id in (e.source, e.target)], node_id

    # -- the chain the benchmark is built on ---------------------------------

    def test_the_declared_chain_is_a_real_multi_hop_path(self, pressure):
        # The loader enforces this too; asserted here because it is the
        # acceptance criterion, not an implementation detail.
        chain = pressure.benchmark_chain
        assert len(chain) >= 4, "at least three hops, or a single day could contain the answer"
        pairs = {(e.source, e.target) for e in pressure.edges}
        for step in zip(chain, chain[1:]):
            assert step in pairs, step

    def test_the_chain_runs_from_the_trigger_to_an_affective_state(self, pressure):
        # What makes the case winnable by traversal and not by wording: the
        # query is about exams and the answer is about not enjoying anything.
        chain = pressure.benchmark_chain
        assert chain[0] == "exam_pressure"
        assert pressure.nodes[chain[0]].category == "Trigger"
        assert chain[-1] == "anhedonia"
        assert pressure.nodes[chain[-1]].category == "State"

    def test_the_chain_is_traversable_by_the_benchmarks_own_retrieval(self, pressure):
        # The acceptance criterion the file exists for, checked against the
        # real scorer rather than by eye. One day per chain step; every one of
        # them must be reachable from the query anchor within the depth the
        # sweep actually runs to, or the cases built on this chain score zero
        # under the condition they exist to test.
        from app.services.benchmark_retrieval import _adjacency, hop_distances, parse_motifs, traversal_score
        from app.services.hf_research_benchmark import TRAVERSAL_DEPTHS

        motifs = pressure.chain_motifs
        assert len(motifs) == len(pressure.benchmark_chain) - 1
        for motif in motifs:
            assert parse_motifs([motif]), f"motif does not parse in the benchmark's notation: {motif}"

        days = [[motif] for motif in motifs]
        distance = hop_distances(_adjacency(days), ["exam pressure"], max(TRAVERSAL_DEPTHS))
        for day in days:
            score, hops = traversal_score(day, distance)
            assert score > 0.0, f"unreachable within depth {max(TRAVERSAL_DEPTHS)}: {day}"
            assert hops <= max(TRAVERSAL_DEPTHS)

    def test_traversal_recovers_the_chain_where_wording_cannot(self, pressure):
        # The hypothesis in miniature. Decoys reuse the query's vocabulary and
        # the chain days share none of it, so `keyword` must be misled and
        # `graph_pattern` must not. If this fails, a case built on this chain
        # cannot separate the conditions whatever else is true of it.
        from app.services.benchmark_retrieval import _adjacency, char_ngrams, hop_distances, score_candidate, tokens

        query = "The pressure before a deadline is doing it again."
        chain_days = [(f"c{i}", "Slept badly, then could not take any of it in.", [motif])
                      for i, motif in enumerate(pressure.chain_motifs)]
        decoy_days = [(f"d{i}", "Wrote about pressure and the deadline again today.",
                       ["State:pressure -> co_occurs -> State:deadline"]) for i in range(20)]
        candidates = chain_days + decoy_days
        distance = hop_distances(_adjacency([motifs for _, _, motifs in candidates]), ["exam pressure"], 3)

        def top(method):
            ranked = sorted(
                candidates,
                key=lambda candidate: -score_candidate(
                    method, tokens(query), char_ngrams(query),
                    candidate[1], candidate[2], distance, "normal", False,
                )["score"],
            )
            return {candidate[0] for candidate in ranked[: len(chain_days)]}

        chain_ids = {candidate[0] for candidate in chain_days}
        assert top("graph_pattern") == chain_ids
        assert not (top("keyword") & chain_ids)

    def test_the_recurrence_loop_the_case_set_is_named_for_is_present(self, pressure):
        # `deadline_pressure_returns` is about a pattern coming BACK. The graph
        # is cyclic on purpose and a test says so, because a later reviewer
        # removing "the cycle" would remove the recurrence with it.
        pairs = {(e.source, e.target) for e in pressure.edges}
        assert ("academic_difficulty", "exam_pressure") in pairs
        assert ("exam_pressure", "sleep_deprivation") in pairs

    def test_the_sleep_onset_route_is_not_a_clinical_claim(self, pressure):
        # 不眠症 is a diagnosis. The issue's sketch said "insomnia"; what is
        # encoded is what a student reports, and it is judgement throughout.
        assert "insomnia" not in pressure.nodes
        assert "sleep_onset_difficulty" in pressure.nodes
        for edge in [e for e in pressure.edges if "sleep_onset_difficulty" in (e.source, e.target)]:
            assert edge.evidence_strength is EvidenceStrength.EXPERT_JUDGEMENT, f"{edge.source}->{edge.target}"
            assert edge.source_refs == ["expert_judgement"], f"{edge.source}->{edge.target}"

    # -- what the file shares with the others --------------------------------

    def test_the_judgement_rate_is_reported_not_minimised(self, pressure):
        # Highest of the seed files, and that is the honest result: this
        # registry holds no source for 受験, 塾 or 提出期限, and 生徒指導提要 is
        # explicit that it supports no clinical claim.
        assert 0 < pressure.unsourced_edge_rate < 1
        assert pressure.unsourced_edge_rate > load_seed_subgraphs()["sleep_deprivation"].unsourced_edge_rate

    def test_shared_nodes_and_edges_are_stated_identically(self, pressure):
        # Sharper here than for social_withdrawal.yaml: `provenance._label_index`
        # is first-writer-wins over sorted(glob), and academic_pressure.yaml
        # sorts first, so every label these files share now resolves to THIS
        # file. Which file wins is only harmless while they agree exactly.
        others = {key: value for key, value in load_seed_subgraphs().items() if key != "academic_pressure"}
        assert others, "expected at least sleep.yaml alongside this file"

        shared_nodes = 0
        for other in others.values():
            for node_id, node in pressure.nodes.items():
                twin = other.nodes.get(node_id)
                if twin is None:
                    continue
                shared_nodes += 1
                assert (node.category, node.label_ja, node.label_en) == (
                    twin.category, twin.label_ja, twin.label_en), node_id
                assert sorted(node.source_refs) == sorted(twin.source_refs), node_id
        assert shared_nodes, "expected the sleep nodes this file's chain runs through"

        here = {(e.source, e.target, e.type): e for e in pressure.edges}
        shared_edges = 0
        for other in others.values():
            for key, twin in {(e.source, e.target, e.type): e for e in other.edges}.items():
                if key not in here:
                    continue
                shared_edges += 1
                assert here[key].evidence_strength is twin.evidence_strength, key
                assert sorted(here[key].source_refs) == sorted(twin.source_refs), key
        assert shared_edges, "expected the sleep edges this file's chain runs through"

    def test_it_does_not_contradict_another_subgraph(self, pressure):
        # A reversed shared edge would give a merged graph a cycle no file's
        # curation argued for. Runs over every loaded subgraph so it also
        # covers social_withdrawal.yaml once that lands.
        here = {(e.source, e.target) for e in pressure.edges}
        for subgraph_id, other in load_seed_subgraphs().items():
            if subgraph_id == "academic_pressure":
                continue
            reversed_pairs = here & {(e.target, e.source) for e in other.edges}
            assert not reversed_pairs, f"orientation conflict with {subgraph_id}: {reversed_pairs}"

    # -- the loader guarantee the cases rest on ------------------------------

    def test_loader_rejects_a_chain_step_that_is_not_an_edge(self, tmp_path):
        # Without this the declared chain is a comment: it could name a path
        # the curation does not carry, and the cases built on it would look
        # grounded while resting on nothing.
        bad = tmp_path / "bad.yaml"
        bad.write_text(
            "subgraph_id: bad\nbenchmark_chain: [a, b, c]\nnodes:\n"
            "  - {id: a, category: State, label_ja: あ, label_en: a, source_refs: [expert_judgement]}\n"
            "  - {id: b, category: State, label_ja: い, label_en: b, source_refs: [expert_judgement]}\n"
            "  - {id: c, category: State, label_ja: う, label_en: c, source_refs: [expert_judgement]}\n"
            "edges:\n"
            "  - {source: a, target: b, type: causes, evidence_strength: expert_judgement,"
            " source_refs: [expert_judgement], scope_note: note}\n",
            encoding="utf-8",
        )
        from app.ontology import seed_graph

        with pytest.raises(seed_graph.SeedGraphError) as caught:
            seed_graph._load_file(bad)
        assert "b -> c" in str(caught.value)

    def test_loader_rejects_a_chain_too_short_to_be_multi_hop(self, tmp_path):
        bad = tmp_path / "bad.yaml"
        bad.write_text(
            "subgraph_id: bad\nbenchmark_chain: [a, b]\nnodes:\n"
            "  - {id: a, category: State, label_ja: あ, label_en: a, source_refs: [expert_judgement]}\n"
            "  - {id: b, category: State, label_ja: い, label_en: b, source_refs: [expert_judgement]}\n"
            "edges:\n"
            "  - {source: a, target: b, type: causes, evidence_strength: expert_judgement,"
            " source_refs: [expert_judgement], scope_note: note}\n",
            encoding="utf-8",
        )
        from app.ontology import seed_graph

        with pytest.raises(seed_graph.SeedGraphError):
            seed_graph._load_file(bad)

    def test_a_file_declaring_no_chain_is_unaffected(self):
        assert load_seed_subgraphs()["sleep_deprivation"].benchmark_chain == ()
        assert load_seed_subgraphs()["sleep_deprivation"].chain_motifs == []


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


class TestProvenanceCoverage:
    """#79 — the number the research claim rests on, reportable on its own.

    'What share of an LLM-generated psychological graph can be tied to a
    published source?' Measured, documented, and gated on nothing.
    """

    GRAPH = {
        "nodes": [
            {"id": "sleep_deprivation", "label": "睡眠不足", "category": "Trigger"},
            {"id": "x1", "label": "認知機能の低下", "category": "State"},
            {"id": "weird", "label": "テスト前の胃痛", "category": "State"},
        ],
        "relations": [
            {"source_id": "sleep_deprivation", "target_id": "x1", "type": "causes"},
            {"source_id": "sleep_deprivation", "target_id": "weird", "type": "causes"},
        ],
    }

    def test_it_reports_every_field_the_issue_names(self):
        coverage = provenance_coverage(self.GRAPH)
        for key in (
            "nodes_with_source",
            "edges_with_source",
            "edges_by_strength",
            "unsourced_rate",
            "matched_seed_subgraphs",
        ):
            assert key in coverage

    def test_measuring_a_graph_does_not_annotate_it(self):
        # The distinction from annotate(): a caller asking for the number should
        # not find its graph silently carrying provenance keys afterwards. The
        # benchmark passes graphs it then reports verbatim.
        graph = {"nodes": [dict(node) for node in self.GRAPH["nodes"]], "relations": []}
        provenance_coverage(graph)
        assert all("provenance" not in node for node in graph["nodes"])

    def test_it_agrees_with_the_extraction_path(self):
        # Two callers, one definition. If these ever disagree, the coverage
        # reported by CI is not the coverage the product computes.
        from_validator = validate_extraction({
            "nodes": [
                {"node_id": node["id"], "label": node["label"], "class": node["category"]}
                for node in self.GRAPH["nodes"]
            ],
            "relations": list(self.GRAPH["relations"]),
        })["provenance"]
        assert provenance_coverage(self.GRAPH) == from_validator

    def test_every_evidence_strength_is_a_key_even_at_zero(self):
        # An absent key reads as "not measured". "No causal edges in this graph"
        # is a finding, and it is also what lets these be summed across cases.
        by_strength = provenance_coverage(self.GRAPH)["edges_by_strength"]
        assert set(by_strength) == {strength.value for strength in EvidenceStrength}
        assert by_strength["causal"] == 0

    def test_counts_are_carried_so_a_set_of_these_can_be_pooled(self):
        # Averaging per-case rates weights a 3-element graph like a 40-element
        # one. Pooling needs the denominators, so they are reported.
        coverage = provenance_coverage(self.GRAPH)
        assert coverage["node_count"] == 3
        assert coverage["edge_count"] == 2
        assert coverage["matched_node_count"] == round(
            coverage["nodes_with_source"] * coverage["node_count"]
        )

    def test_the_matching_rule_is_stated_with_the_number(self):
        # An unstated matching rule makes the coverage number unfalsifiable.
        assert provenance_coverage(self.GRAPH)["match_rules"] == ["exact_id", "normalised_label"]

    def test_the_caveat_travels_with_the_number(self):
        # Coverage is not accuracy, and "62% sourced" reads as a quality claim
        # when quoted alone. The note is in the payload so it survives quoting.
        assert "not accuracy" in COVERAGE_NOTE
        assert "still be wrong about a student" in COVERAGE_NOTE

    def test_an_empty_graph_reports_zero_rather_than_dividing_by_zero(self):
        coverage = provenance_coverage({"nodes": [], "relations": []})
        assert coverage["nodes_with_source"] == 0.0
        assert coverage["unsourced_rate"] == 0.0
        assert coverage["matched_seed_subgraphs"] == []

    def test_edges_is_accepted_as_an_alias_for_relations(self):
        as_edges = provenance_coverage({"nodes": self.GRAPH["nodes"], "edges": self.GRAPH["relations"]})
        assert as_edges == provenance_coverage(self.GRAPH)

    def test_nothing_is_gated_on_coverage(self):
        # The constraint the issue is explicit about: measure first, thresholds
        # only once there is a distribution. A comparison against a coverage
        # figure appearing in the validator would be that gate arriving early.
        import inspect

        from app.ontology import provenance, validator

        for module in (provenance, validator):
            body = inspect.getsource(module)
            for forbidden in ("MIN_COVERAGE", "COVERAGE_THRESHOLD", "raise" + " CoverageError"):
                assert forbidden not in body, module.__name__


class TestBenchmarkProvenanceCoverage:
    """#79 — coverage for every benchmark case, reported and printed by CI."""

    @pytest.fixture(scope="class")
    def report(self):
        from app.services.hf_research_benchmark import run_hf_research_benchmark

        return run_hf_research_benchmark()["provenance_coverage"]

    def test_every_case_is_covered(self, report):
        from app.services.hf_research_benchmark import SYNTHETIC_BENCHMARK_CASES

        assert set(report["cases"]) == {case.case_id for case in SYNTHETIC_BENCHMARK_CASES}

    def test_a_case_graph_reaches_the_curated_subgraphs(self, report):
        # The load-bearing dependency between two files: benchmark motifs write
        # concepts as "exam pressure" and the curation as "exam_pressure", and
        # they meet only because provenance._normalise strips both. If this
        # fails, every coverage number silently becomes 0.
        assert any(case["matched_seed_subgraphs"] for case in report["cases"].values())
        assert report["overall"]["nodes_with_source"] > 0

    def test_the_aggregate_is_pooled_not_averaged(self, report):
        cases = report["cases"].values()
        expected = sum(case["matched_node_count"] for case in cases) / sum(
            case["node_count"] for case in cases
        )
        assert report["overall"]["nodes_with_source"] == round(expected, 6)

    def test_it_is_reported_per_language(self, report):
        from app.services.hf_research_benchmark import SYNTHETIC_BENCHMARK_CASES

        assert set(report["by_language"]) == {case.lang for case in SYNTHETIC_BENCHMARK_CASES}

    def test_an_uninformative_language_split_says_so(self, report):
        # The ja/en numbers are currently identical, and reporting that without
        # the reason would let "no gap" be read as a finding about Japanese
        # coverage when nothing about Japanese was measured: everything that
        # matches comes from chain motifs written in English notation for both.
        validity = report["by_language_validity"]
        rates = {lang: coverage["nodes_with_source"] for lang, coverage in report["by_language"].items()}
        if len(set(rates.values())) == 1:
            assert validity["per_language_comparison_valid"] is False
            assert "not informative" in validity["note"]

    def test_coverage_is_not_a_per_condition_result(self, report):
        # Same structural reason safety moved out of `summary` in #85: coverage
        # is a property of the case's graph and cannot vary with the retrieval
        # condition, so a per-condition column would print one number five times
        # and have it read as five measurements.
        from app.services.benchmark_retrieval import METHODS
        from app.services.hf_research_benchmark import run_hf_research_benchmark

        summary = run_hf_research_benchmark()["summary"]
        for method in METHODS:
            assert not [key for key in summary[method] if "provenance" in key or "source" in key]

    def test_the_caveat_is_in_the_block(self, report):
        assert "not accuracy" in report["note"]
        assert report["match_rules"] == list(MATCH_RULES)

    def test_the_ci_report_runs_and_does_not_fail_the_build(self, capsys):
        # It prints coverage per run so a regression is visible; it must not
        # gate, because there is no distribution to set a threshold against yet.
        import runpy
        import sys

        argv = sys.argv
        sys.argv = ["report_provenance_coverage.py"]
        try:
            with pytest.raises(SystemExit) as caught:
                runpy.run_path(
                    str(Path(__file__).resolve().parents[1] / "scripts" / "report_provenance_coverage.py"),
                    run_name="__main__",
                )
        finally:
            sys.argv = argv

        assert caught.value.code == 0
        printed = capsys.readouterr().out
        assert "Provenance coverage" in printed
        assert "not accuracy" in printed
