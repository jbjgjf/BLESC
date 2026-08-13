"""Deterministic relation-aware traversal (#96).

Written against the acceptance criteria rather than the implementation. The
issue names nine of them; each has at least one test here, and the ones that are
invariants rather than behaviours (`no result without attribution reaches an
educator surface`, `fixed parameters are never called learned attention`) are
tested as invariants — a test that fails when someone relaxes them later.

Two fixture sets:

- hand-built graphs for the relation algebra, so a test about `causes` vs
  `buffers` is not also a test of the assembler;
- the #95 Japanese and English series from
  `fixtures/participant_temporal_graph.json`, so the walk is exercised against
  real assembled output in both languages. The defect this line of work follows
  from (#107) was Japanese-only.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import date
from pathlib import Path
from typing import Any, Dict, Optional, Sequence

import pytest

from app.ontology.schema import RELATIONS, EvidenceStrength
from app.temporal import (
    CuratedProvenance,
    ObservationInterval,
    ParticipantTemporalGraph,
    PersonalObservation,
    SnapshotInput,
    SnapshotRef,
    TemporalEdge,
    TemporalNode,
    assemble_participant_graph,
)
from app.temporal.model import AssemblyReport, CategoryAssignment
from app.traversal import (
    RELATION_RULES,
    SCORE_WEIGHTS,
    SeedCandidate,
    SeedRule,
    TraversalDirection,
    TraversalMode,
    UnknownRelationType,
    filter_reportable,
    reportability_reasons,
    resolve_seeds,
    rule_for,
    rules_as_dict,
    score_path,
    traverse,
)

BACKEND = Path(__file__).resolve().parents[1]
FIXTURES = Path(__file__).resolve().parent / "fixtures" / "participant_temporal_graph.json"
JA = "ja-001"
EN = "en-001"

DAY = date(2026, 8, 1)


# ---- hand-built graph plumbing --------------------------------------------


def _ref(snapshot_id: str, day: date = DAY) -> SnapshotRef:
    return SnapshotRef(snapshot_id=snapshot_id, day=day, entry_id=f"entry-{snapshot_id}")


def _node(node_id: str, category: str = "State", day: date = DAY) -> TemporalNode:
    return TemporalNode(
        node_id=node_id,
        canonical_label=node_id,
        labels_seen=(node_id,),
        category_history=(CategoryAssignment(category=category, days=(day,)),),
        intervals=(ObservationInterval(observed_days=(day,), snapshot_ids=("s1",)),),
        personal_observations=(
            PersonalObservation(snapshot=_ref("s1", day), confidence=0.9, label_as_written=node_id),
        ),
    )


def _edge(
    source: str,
    target: str,
    relation_type: str,
    *,
    confidence: Optional[float] = 0.8,
    day: date = DAY,
    snapshot_id: str = "s1",
    curated: CuratedProvenance = CuratedProvenance(),
    with_observation: bool = True,
) -> TemporalEdge:
    observations = (
        (
            PersonalObservation(
                snapshot=_ref(snapshot_id, day),
                confidence=confidence if confidence is not None else 0.0,
                relation_type_as_written=relation_type,
            ),
        )
        if with_observation
        else ()
    )
    return TemporalEdge(
        source_id=source,
        target_id=target,
        relation_type=relation_type,
        intervals=(ObservationInterval(observed_days=(day,), snapshot_ids=(snapshot_id,)),),
        personal_observations=observations,
        curated_provenance=curated,
        confidence_by_day=((day, confidence),) if confidence is not None else (),
    )


def _graph(
    edges: Sequence[TemporalEdge],
    *,
    participant: str = "p1",
    identity_usable: bool = True,
    extra_nodes: Sequence[str] = (),
) -> ParticipantTemporalGraph:
    node_ids = sorted({e.source_id for e in edges} | {e.target_id for e in edges} | set(extra_nodes))
    return ParticipantTemporalGraph(
        participant_id=participant,
        contract_version="test",
        nodes={node_id: _node(node_id) for node_id in node_ids},
        edges={edge.edge_key: edge for edge in edges},
        events=(),
        report=AssemblyReport(
            snapshots_seen=1,
            snapshots_usable=1,
            legacy_identity_snapshots=() if identity_usable else ("s-legacy",),
        ),
    )


@pytest.fixture(scope="module")
def fixtures() -> Dict[str, Any]:
    return json.loads(FIXTURES.read_text(encoding="utf-8"))


def _assembled(fixtures: Dict[str, Any], participant: str) -> ParticipantTemporalGraph:
    spec = fixtures["participants"][participant]
    inputs = [
        SnapshotInput(
            snapshot_id=snapshot["snapshot_id"],
            day=date.fromisoformat(snapshot["day"]),
            nodes=snapshot["nodes"],
            relations=snapshot["relations"],
            entry_id=snapshot.get("entry_id"),
            extraction_provider=snapshot.get("extraction_provider", "unknown"),
            extraction_model=snapshot.get("extraction_model", "unknown"),
            extractor_version=snapshot.get("extractor_version"),
            temporal_diff=snapshot.get("temporal_diff"),
        )
        for snapshot in spec["snapshots"]
    ]
    return assemble_participant_graph(participant, inputs, aliases=spec.get("aliases"))


# ---- AC: the parameters are fixed, documented, and never called learned ----


def test_every_ontology_relation_has_exactly_one_rule():
    """AC: 'Each relation type has an explicit fixed parameter or rule.'

    Both directions. A relation without a rule would be silently untraversable;
    a rule without a relation would be a parameter for something the vocabulary
    does not contain.
    """
    assert set(RELATION_RULES) == set(RELATIONS)


def test_the_ordering_is_consistent_with_the_ontologys_evidence_strength():
    """A relation backed only by our own judgement never outranks a sourced one.

    The magnitudes are arbitrary; this ordering is the part that is argued, so it
    is the part pinned by a test. If a future rule needs to break it, the
    argument belongs here.
    """
    sourced = [
        name
        for name in RELATION_RULES
        if RELATIONS[name].evidence_strength is not EvidenceStrength.EXPERT_JUDGEMENT
    ]
    judgement = [
        name
        for name in RELATION_RULES
        if RELATIONS[name].evidence_strength is EvidenceStrength.EXPERT_JUDGEMENT
    ]
    assert sourced and judgement, "fixture assumption: the vocabulary has both kinds"
    assert max(RELATION_RULES[n].strength_rank for n in sourced) < min(
        RELATION_RULES[n].strength_rank for n in judgement
    )


def test_damping_is_monotone_in_strength_rank():
    ordered = sorted(RELATION_RULES.values(), key=lambda rule: rule.strength_rank)
    dampings = [rule.step_damping for rule in ordered]
    assert dampings == sorted(dampings, reverse=True)
    assert all(0.0 < value <= 1.0 for value in dampings)


def test_a_two_hop_causal_chain_outranks_a_one_hop_co_occurrence():
    """The magnitudes were chosen for this consequence, so it is asserted.

    The #87 chain family only discriminates if a real chain of the vocabulary's
    strongest relation beats a single instance of its weakest.
    """
    assert RELATION_RULES["causes"].step_damping ** 2 > RELATION_RULES["co_occurs"].step_damping


def test_the_rule_table_says_its_parameters_are_not_learned():
    """AC: 'The implementation never describes these fixed parameters as learned attention.'

    An invariant, not a behaviour: it fails if someone later drops the disclaimer
    from the serialisation that carries these numbers into stored results.
    """
    payload = json.dumps(rules_as_dict(), ensure_ascii=False)
    assert "engineering_choice" in payload
    assert "Nothing here is learned or fitted" in payload
    for rule in RELATION_RULES.values():
        assert rule.as_dict()["parameter_basis"] == "engineering_choice"
        assert rule.rationale.strip(), f"{rule.relation_type} has no recorded rationale"


def test_a_relation_outside_the_vocabulary_gets_no_invented_parameter():
    with pytest.raises(UnknownRelationType):
        rule_for("cures")


def test_rules_read_their_provenance_from_the_ontology_rather_than_restating_it():
    for name, rule in RELATION_RULES.items():
        assert rule.source_refs == tuple(RELATIONS[name].source_refs)
        assert rule.evidence_strength == RELATIONS[name].evidence_strength.value


# ---- AC: traversal respects direction and relation type -------------------


def test_downstream_follows_causes_and_refuses_the_reverse():
    """AC: reverse-direction rejection.

    `A --causes--> B`. Asking what A leads to reaches B. Asking what B leads to
    reaches nothing: returning A would assert that B causes A, which is the
    opposite of the only thing the edge says.
    """
    graph = _graph([_edge("A", "B", "causes")])

    forward = traverse(graph, ["A"], mode=TraversalMode.DOWNSTREAM)
    assert [node.node_id for node in forward.nodes] == ["B"]

    backward = traverse(graph, ["B"], mode=TraversalMode.DOWNSTREAM)
    assert backward.nodes == ()
    assert backward.report.paths_found == 0


def test_upstream_reaches_the_cause_and_records_that_it_read_against_the_arrow():
    graph = _graph([_edge("A", "B", "causes")])
    result = traverse(graph, ["B"], mode=TraversalMode.UPSTREAM)

    assert [node.node_id for node in result.nodes] == ["A"]
    step = result.nodes[0].paths[0].steps[0]
    assert step.walked_against_arrow is True
    assert step.edge_key == ("A", "B", "causes"), "the assertion is unchanged by reading direction"


def test_a_single_walk_never_mixes_directions():
    """A→B and C→B share a consequence; they are not connected.

    The failure this prevents: a walk that reverses mid-path emits A→B→C and a
    reader sees 'A leads to C'.
    """
    graph = _graph([_edge("A", "B", "causes"), _edge("C", "B", "causes")])

    downstream = traverse(graph, ["A"], mode=TraversalMode.DOWNSTREAM)
    assert [node.node_id for node in downstream.nodes] == ["B"]
    assert "C" not in {node.node_id for node in downstream.nodes}

    upstream = traverse(graph, ["A"], mode=TraversalMode.UPSTREAM)
    assert upstream.nodes == ()


def test_co_occurs_is_symmetric_because_its_scope_note_says_undirected():
    graph = _graph([_edge("A", "B", "co_occurs")])
    assert RELATION_RULES["co_occurs"].direction is TraversalDirection.SYMMETRIC

    assert [n.node_id for n in traverse(graph, ["A"], mode=TraversalMode.DOWNSTREAM).nodes] == ["B"]
    assert [n.node_id for n in traverse(graph, ["B"], mode=TraversalMode.DOWNSTREAM).nodes] == ["A"]


def test_buffers_and_causes_between_the_same_pair_stay_separate_paths():
    """The distinction the old undirected BFS could not make.

    `graph_index.traverse_graph` reports one hop from A to B whichever relation
    connects them. Here the two relations produce two paths with two influences
    and two scores, and the reader can tell them apart.
    """
    graph = _graph([_edge("A", "B", "causes"), _edge("A", "B", "buffers")])
    result = traverse(graph, ["A"], mode=TraversalMode.DOWNSTREAM)

    assert len(result.nodes) == 1
    paths = result.nodes[0].paths
    assert {path.relation_types[0] for path in paths} == {"causes", "buffers"}
    assert {path.influence_summary for path in paths} == {"raises", "lowers"}
    assert paths[0].score != paths[1].score


def test_an_unknown_relation_type_is_refused_and_named():
    """Not coerced to `co_occurs`. The validator's coercion happens at extraction
    time and is reported there; a coercion here would be a second, silent one."""
    graph = _graph([_edge("A", "B", "causes"), _edge("B", "C", "cures")])
    result = traverse(graph, ["A"], mode=TraversalMode.DOWNSTREAM)

    assert [node.node_id for node in result.nodes] == ["B"]
    assert result.report.skipped_edges
    edge_key, reason = result.report.skipped_edges[0]
    assert edge_key == ("B", "C", "cures")
    assert "not in the ontology vocabulary" in reason
    assert any("not traversable" in warning for warning in result.report.warnings)


# ---- AC: cycles, and the red herring --------------------------------------


def test_a_cycle_terminates_and_does_not_revisit_a_node():
    graph = _graph(
        [_edge("A", "B", "causes"), _edge("B", "C", "causes"), _edge("C", "A", "causes")]
    )
    result = traverse(graph, ["A"], mode=TraversalMode.DOWNSTREAM, max_hops=10)

    assert {node.node_id for node in result.nodes} == {"B", "C"}
    for path in result.paths:
        assert len(set(path.node_ids)) == len(path.node_ids), f"revisited a node: {path.node_ids}"


def test_a_self_loop_produces_no_path():
    graph = _graph([_edge("A", "A", "causes")])
    assert traverse(graph, ["A"], mode=TraversalMode.DOWNSTREAM).nodes == ()


def test_a_red_herring_path_is_returned_but_ranks_below_the_real_one():
    """AC: red-herring coverage.

    Both routes exist and both are reported — suppressing one would make the
    traversal an answer key. The ranking is what carries the judgement, and the
    weak route's score has to show why: a `co_occurs` chain is the vocabulary's
    weakest claim twice over.
    """
    graph = _graph(
        [
            _edge("seed", "real", "causes"),
            _edge("seed", "decoy", "co_occurs"),
            _edge("decoy", "far", "co_occurs"),
        ]
    )
    result = traverse(graph, ["seed"], mode=TraversalMode.DOWNSTREAM)

    by_id = {node.node_id: node for node in result.nodes}
    assert set(by_id) == {"real", "decoy", "far"}
    assert by_id["real"].best_score > by_id["decoy"].best_score > by_id["far"].best_score
    assert by_id["far"].paths[0].weakest_relation_type == "co_occurs"


def test_hop_limit_is_respected():
    graph = _graph(
        [_edge("A", "B", "causes"), _edge("B", "C", "causes"), _edge("C", "D", "causes")]
    )
    reached = {n.node_id for n in traverse(graph, ["A"], max_hops=2).nodes}
    assert reached == {"B", "C"}


# ---- AC: the evidence trace ------------------------------------------------


def test_a_result_carries_the_whole_trace_the_issue_lists():
    """AC: 'complete path, hop count, relation types, component scores, source
    snapshot ids, source refs, and evidence strength'. All eight, on one object."""
    curated = CuratedProvenance(
        source_refs=("nice_ng134",),
        subgraph_id="sleep",
        evidence_strength="association",
        match_rule="seed_pair",
    )
    graph = _graph([_edge("A", "B", "causes", curated=curated), _edge("B", "C", "buffers")])
    path = traverse(graph, ["A"], mode=TraversalMode.DOWNSTREAM).nodes[-1].paths[0]

    assert path.node_ids == ("A", "B", "C")
    assert path.hop_count == 2
    assert path.relation_types == ("causes", "buffers")
    assert set(path.components) == set(SCORE_WEIGHTS)
    assert path.source_snapshot_ids
    assert path.curated_source_refs == ("nice_ng134",)
    assert path.steps[0].evidence_strength == "association"
    assert path.steps[0].relation_source_refs == ("nice_ng134",)

    payload = path.as_dict()
    for key in ("node_ids", "hop_count", "relation_types", "score_breakdown", "source_snapshot_ids", "steps"):
        assert key in payload


def _recomputed(path) -> float:
    """The score, rebuilt from the published breakdown alone."""
    breakdown = path.as_dict()["score_breakdown"]
    return sum(
        value * breakdown["weights_applied"][name] for name, value in breakdown["components"].items()
    )


def test_the_score_breakdown_names_the_weights_it_actually_applied():
    graph = _graph([_edge("A", "B", "causes")])
    path = traverse(graph, ["A"]).nodes[0].paths[0]
    breakdown = path.as_dict()["score_breakdown"]

    assert breakdown["declared_weights"] == SCORE_WEIGHTS
    assert set(breakdown["weights_applied"]) == set(path.components)
    assert sum(breakdown["weights_applied"].values()) == pytest.approx(1.0, abs=1e-5)


def test_a_published_breakdown_reproduces_the_score_it_is_attached_to():
    """The property that makes a breakdown an explanation rather than decoration.

    A reader who multiplies the published components by the published weights
    must land on the published score. This is asserted over every path of an
    assembled fixture, including the ones with a component missing, because the
    renormalisation is exactly where a breakdown stops adding up.
    """
    fixtures = json.loads(FIXTURES.read_text(encoding="utf-8"))
    graph = _assembled(fixtures, JA)
    paths = traverse(graph, sorted(graph.nodes), mode=TraversalMode.DOWNSTREAM).paths

    assert paths, "fixture assumption: the Japanese series has traversable edges"
    for path in paths:
        assert _recomputed(path) == pytest.approx(path.score, abs=1e-5)


def test_a_missing_confidence_is_dropped_and_named_rather_than_zeroed():
    """Absence is never a number.

    Zero would report an undocumented edge as a bad one; one would report it as
    perfect. The component leaves, the remaining weights renormalise, and the
    breakdown says which one left.
    """
    graph = _graph([_edge("A", "B", "causes", confidence=None)])
    path = traverse(graph, ["A"]).nodes[0].paths[0]

    assert "edge_confidence" not in path.components
    assert path.components_unavailable == ("edge_confidence",)
    assert sum(path.weights_applied.values()) == pytest.approx(1.0, abs=1e-5)
    assert _recomputed(path) == pytest.approx(path.score, abs=1e-5)
    assert 0.0 < path.score <= 1.0


def test_partial_confidence_along_a_chain_is_still_absence():
    """A min over the documented subset would report the path as confident as its
    best-documented edge, which is exactly backwards."""
    graph = _graph([_edge("A", "B", "causes", confidence=0.9), _edge("B", "C", "causes", confidence=None)])
    two_hop = [p for p in traverse(graph, ["A"]).paths if p.hop_count == 2][0]
    assert "edge_confidence" not in two_hop.components


def test_every_scalar_component_is_the_weakest_link():
    """One rule, stated once, checked here: a chain is as good as its worst edge."""
    strong = _edge("A", "B", "causes", confidence=0.9, day=date(2026, 8, 1), snapshot_id="s1")
    weak = _edge("B", "C", "causes", confidence=0.2, day=date(2026, 7, 1), snapshot_id="s2")
    graph = _graph([strong, weak])

    two_hop = [p for p in traverse(graph, ["A"], as_of=date(2026, 8, 1)).paths if p.hop_count == 2][0]
    one_hop = [p for p in traverse(graph, ["A"], as_of=date(2026, 8, 1)).paths if p.hop_count == 1][0]

    assert two_hop.components["edge_confidence"] == 0.2
    assert two_hop.components["recency"] < one_hop.components["recency"]


def test_damping_compounds_along_the_chain_rather_than_taking_a_minimum():
    """The one component that is not a weakest link, and why: relation weakness
    accumulates with length instead of being bounded by the worst hop."""
    graph = _graph([_edge("A", "B", "causes"), _edge("B", "C", "causes")])
    paths = {p.hop_count: p for p in traverse(graph, ["A"]).paths}

    assert paths[1].components["relation_path"] == pytest.approx(0.90)
    assert paths[2].components["relation_path"] == pytest.approx(0.81)


def test_influence_is_summarised_not_multiplied():
    """A buffer of a cause is not 'therefore lowers'. That is a causal inference
    and this layer does not make one — mixed stays mixed."""
    graph = _graph([_edge("A", "B", "causes"), _edge("B", "C", "buffers")])
    two_hop = [p for p in traverse(graph, ["A"]).paths if p.hop_count == 2][0]
    assert two_hop.influence_summary == "mixed"

    ordering_only = _graph([_edge("A", "B", "precedes")])
    assert traverse(ordering_only, ["A"]).paths[0].influence_summary == "none"


def test_curated_knowledge_guides_the_walk_but_never_rewrites_the_personal_edge():
    """AC: 'Curated knowledge can guide traversal but cannot rewrite an extracted
    personal edge.'

    The extractor produced `causes`; the curated subgraph types the same pair as
    `co_occurs`. The walk crosses the edge the participant's data produced, at
    `causes`'s parameter. The disagreement is carried on the step as a finding —
    which is #101's business to adjudicate, not this layer's.
    """
    disagreeing = CuratedProvenance(
        source_refs=("who_adolescent_mh",),
        subgraph_id="sleep",
        seed_relation_type="co_occurs",
        type_matches_seed=False,
    )
    graph = _graph([_edge("A", "B", "causes", curated=disagreeing)])
    step = traverse(graph, ["A"]).nodes[0].paths[0].steps[0]

    assert step.relation_type == "causes"
    assert step.step_damping == RELATION_RULES["causes"].step_damping
    assert step.curated_relation_type == "co_occurs"
    assert step.curation_disagrees is True


def test_curation_guides_the_score_through_support_not_through_retyping():
    """The one channel curated evidence has: it raises `curated_support`. It does
    not change which edge exists, its direction, or its type."""
    backed = CuratedProvenance(source_refs=("nice_ng134",), subgraph_id="sleep")
    with_curation = _graph([_edge("A", "B", "causes", curated=backed)])
    without = _graph([_edge("A", "B", "causes")])

    curated_path = traverse(with_curation, ["A"]).nodes[0].paths[0]
    bare_path = traverse(without, ["A"]).nodes[0].paths[0]

    assert curated_path.components["curated_support"] == 1.0
    assert bare_path.components["curated_support"] == 0.0
    assert curated_path.score > bare_path.score
    assert curated_path.relation_types == bare_path.relation_types


def test_a_path_reports_the_days_it_spans():
    """The #87 finding is that an answer can exist in no single day."""
    graph = _graph(
        [
            _edge("A", "B", "causes", day=date(2026, 7, 1), snapshot_id="s1"),
            _edge("B", "C", "causes", day=date(2026, 7, 20), snapshot_id="s2"),
        ]
    )
    two_hop = [p for p in traverse(graph, ["A"], as_of=date(2026, 7, 20)).paths if p.hop_count == 2][0]
    assert two_hop.spans_days == 20
    assert set(two_hop.source_snapshot_ids) == {"s1", "s2"}


# ---- AC: the educator-facing invariant ------------------------------------


def test_a_path_without_attribution_is_withheld_from_an_educator_surface():
    """AC: 'a result without attributable observations and score breakdown is not
    returned to an educator-facing consumer.'"""
    graph = _graph([_edge("A", "B", "causes", with_observation=False)])
    result = traverse(graph, ["A"])

    assert result.nodes, "the walk still finds it — the filter is what withholds it"
    allowed, withheld = filter_reportable(result)
    assert allowed == ()
    assert withheld
    assert any("no source snapshot" in reason for reason in withheld[0].reasons)


def test_unusable_cross_day_identity_withholds_everything():
    """A participant with a pre-#107 snapshot has array-position node ids, so
    `node_1` on two days are unrelated. Every temporal path over them is void."""
    graph = _graph([_edge("A", "B", "causes")], identity_usable=False)
    result = traverse(graph, ["A"])

    assert result.report.identity_is_usable is False
    assert any("identity_is_usable is false" in warning for warning in result.report.warnings)

    allowed, withheld = filter_reportable(result)
    assert allowed == ()
    assert all(
        any("cross-day identity is unusable" in reason for reason in item.reasons) for item in withheld
    )


def test_withheld_paths_are_returned_with_reasons_not_dropped():
    """A consumer that cannot see what was withheld reports what it got as complete."""
    graph = _graph(
        [_edge("A", "B", "causes"), _edge("A", "C", "causes", with_observation=False)]
    )
    result = traverse(graph, ["A"])
    allowed, withheld = filter_reportable(result)

    assert [node.node_id for node in allowed] == ["B"]
    assert len(withheld) == 1
    assert withheld[0].path.target_node_id == "C"
    assert withheld[0].reasons


def test_a_node_keeps_only_its_reportable_paths_and_rescores_on_them():
    """A node reachable both attributably and not must not keep the unattributable
    route's score just because one route survived."""
    graph = _graph(
        [
            _edge("A", "B", "co_occurs"),
            _edge("A", "X", "causes", with_observation=False),
            _edge("X", "B", "causes", with_observation=False),
        ]
    )
    result = traverse(graph, ["A"])
    allowed, _ = filter_reportable(result)

    node = {n.node_id: n for n in allowed}["B"]
    assert all(path.is_fully_attributed for path in node.paths)
    assert node.best_score == max(path.score for path in node.paths)


def test_reportability_reasons_is_empty_for_a_good_path():
    graph = _graph([_edge("A", "B", "causes")])
    path = traverse(graph, ["A"]).nodes[0].paths[0]
    assert reportability_reasons(path, identity_is_usable=True) == ()


# ---- AC: seeds, and the two identity schemes ------------------------------


def test_a_seed_that_does_not_map_is_reported_not_dropped():
    graph = _graph([_edge("A", "B", "causes")])
    resolution = resolve_seeds(graph, [SeedCandidate("q1", "A"), SeedCandidate("q2", "nowhere")])

    assert resolution.resolved_node_ids == ("A",)
    assert resolution.coverage == 0.5
    assert resolution.unresolved[0].rule is SeedRule.UNMATCHED


def test_an_ambiguous_seed_is_refused_rather_than_picked():
    """#95 declined to merge these two nodes. Choosing one here would undo that."""
    graph = _assembled(json.loads(FIXTURES.read_text(encoding="utf-8")), JA)
    resolution = resolve_seeds(graph, [SeedCandidate("q", "先生の言葉")])

    mapping = resolution.mappings[0]
    assert mapping.rule is SeedRule.AMBIGUOUS
    assert mapping.temporal_node_id is None
    assert len(mapping.collided_with) > 1
    assert resolution.ambiguous == (mapping,)


def test_an_empty_seed_set_says_so_rather_than_returning_a_quiet_nothing():
    graph = _graph([_edge("A", "B", "causes")])
    result = traverse(graph, [])
    assert result.nodes == ()
    assert any("no seeds were given" in warning for warning in result.report.warnings)


def test_seed_candidates_can_be_built_from_graph_node_mappings():
    from app.traversal import candidates_from_graph_nodes

    candidates = candidates_from_graph_nodes([{"id": 7, "label": "A", "category": "State"}])
    assert candidates[0].source_id == "7"
    assert candidates[0].label == "A"


# ---- AC: caps are reported -------------------------------------------------


def test_a_cap_reports_what_it_removed():
    """No silent truncation: a result that dropped forty paths is not the same
    result as one that dropped two, and `truncated: true` says they are."""
    graph = _graph(
        [_edge("A", "B", relation) for relation in ("causes", "buffers", "avoids", "escalates")]
    )
    result = traverse(graph, ["A"], max_paths_per_target=2)

    assert result.report.paths_found == 4
    assert result.report.paths_dropped_by_cap == 2
    assert result.report.was_truncated is True
    assert any("caps removed" in warning for warning in result.report.warnings)


# ---- determinism, and the assembled fixtures ------------------------------


def test_identical_input_produces_an_identical_result():
    graph = _graph(
        [
            _edge("A", "B", "causes"),
            _edge("A", "B", "buffers"),
            _edge("B", "C", "co_occurs"),
            _edge("A", "C", "precedes"),
        ]
    )
    first = json.dumps(traverse(graph, ["A"], as_of=DAY).as_dict(), sort_keys=True, ensure_ascii=False)
    second = json.dumps(traverse(graph, ["A"], as_of=DAY).as_dict(), sort_keys=True, ensure_ascii=False)
    assert first == second


def test_determinism_survives_a_different_hash_seed(tmp_path):
    """Set and dict iteration order is hash-randomised per process.

    An in-process comparison cannot catch one leaking into the output, because
    both walks share a seed. The same check #95 applies to assembly, applied to
    traversal: the walk builds an adjacency map, groups paths by target and
    resolves seeds through two label indexes, and this is what holds all of them
    to sorting first.
    """
    script = tmp_path / "walk_once.py"
    script.write_text(
        "\n".join(
            [
                "import json, sys",
                f"sys.path.insert(0, {str(BACKEND)!r})",
                "from datetime import date",
                "from app.temporal import SnapshotInput, assemble_participant_graph",
                "from app.traversal import TraversalMode, traverse",
                f"data = json.loads(open({str(FIXTURES)!r}, encoding='utf-8').read())",
                "out = {}",
                f"for pid in ({JA!r}, {EN!r}):",
                "    spec = data['participants'][pid]",
                "    snapshots = [SnapshotInput(",
                "        snapshot_id=s['snapshot_id'], day=date.fromisoformat(s['day']),",
                "        nodes=s['nodes'], relations=s['relations'], entry_id=s.get('entry_id'),",
                "        temporal_diff=s.get('temporal_diff'),",
                "    ) for s in spec['snapshots']]",
                "    graph = assemble_participant_graph(pid, snapshots, aliases=spec.get('aliases'))",
                "    for mode in (TraversalMode.DOWNSTREAM, TraversalMode.UPSTREAM):",
                "        result = traverse(graph, sorted(graph.nodes), mode=mode, as_of=date(2026, 8, 10))",
                "        out[pid + ':' + mode.value] = result.as_dict()",
                "sys.stdout.write(json.dumps(out, sort_keys=True, ensure_ascii=False, default=str))",
            ]
        ),
        encoding="utf-8",
    )

    def run(seed: str) -> str:
        environment = {**os.environ, "PYTHONHASHSEED": seed, "PYTHONDONTWRITEBYTECODE": "1"}
        result = subprocess.run(
            [sys.executable, str(script)], capture_output=True, text=True, env=environment, check=True
        )
        return result.stdout

    assert run("0") == run("12345") == run("987654")


def test_as_of_defaults_to_the_graphs_last_day_not_the_wall_clock():
    """A fixture scored in December must score the way it did in August, or every
    recency component drifts with the calendar and no result is reproducible."""
    graph = _graph([_edge("A", "B", "causes", day=date(2026, 8, 1))])
    assert traverse(graph, ["A"]).nodes[0].best_score == traverse(
        graph, ["A"], as_of=date(2026, 8, 1)
    ).nodes[0].best_score


@pytest.mark.parametrize("participant", [JA, EN])
def test_the_assembled_series_traverse_in_both_languages(fixtures, participant):
    """#107 was a Japanese-only defect. An English-only suite could not catch the
    next one either."""
    graph = _assembled(fixtures, participant)
    seed = sorted(graph.nodes)[0]
    result = traverse(graph, [seed], mode=TraversalMode.DOWNSTREAM)

    assert result.report.identity_is_usable is True
    assert result.report.seeds_resolved == (seed,)
    for path in result.paths:
        assert path.source_snapshot_ids, "every path over assembled data is attributable"
        assert path.relation_types


def test_the_japanese_and_english_series_produce_the_same_shape(fixtures):
    """Structurally identical fixtures must traverse identically once ids are set
    aside — a language-shaped difference in the walk is a defect, not data."""
    shapes = {}
    for participant in (JA, EN):
        graph = _assembled(fixtures, participant)
        result = traverse(graph, sorted(graph.nodes), mode=TraversalMode.DOWNSTREAM)
        shapes[participant] = sorted(
            (path.hop_count, path.relation_types, path.influence_summary) for path in result.paths
        )
    assert shapes[JA] == shapes[EN]


def test_the_serialised_result_carries_the_rules_and_the_disclaimer(fixtures):
    """A stored result has to be auditable without checking out the revision that
    produced it, and has to keep saying it is not learned."""
    graph = _assembled(fixtures, JA)
    payload = traverse(graph, sorted(graph.nodes)[:1]).as_dict()

    assert payload["traversal_version"]
    assert payload["relation_rules_version"]
    assert payload["relation_rules"]["rules"]
    assert "Not attention, not trained, not fitted" in payload["not_learned"]


# ---- the baseline stays a baseline ----------------------------------------


def test_the_undirected_bfs_baseline_is_untouched_and_still_undirected():
    """AC: 'Current undirected BFS and keyword retrieval remain comparison
    baselines.' Deleting it would delete the comparison, so this test fails if
    someone later 'fixes' it into directedness."""
    from app.analytics.graph_index import traverse_graph

    edges = [{"source_node_id": 1, "target_node_id": 2}]
    assert traverse_graph([2], edges) == {2: 0, 1: 1}, "the baseline walks backwards, by design"


def test_score_path_on_no_steps_invents_nothing():
    score, components, weights, unavailable = score_path([], DAY)
    assert score == 0.0
    assert components == {}
    assert set(unavailable) == set(SCORE_WEIGHTS)


# ---- the benchmark condition ----------------------------------------------
#
# `relation_aware` ranks identically to `graph_pattern` on all six current cases,
# and `test_benchmark_separation.py` exempts the pair by name. An exemption has
# to be earned: these tests show the condition separating from its baseline
# whenever the data can tell them apart, so the collapse is attributable to the
# case set rather than to the implementation. What #88 needs to add is written
# down in the two cases below.


def _reach(motifs: Sequence[Sequence[str]], anchors: Sequence[str], depth: int = 3):
    from app.services.benchmark_retrieval import build_relation_graph, relation_aware_reach

    return relation_aware_reach(build_relation_graph(motifs), anchors, depth)


def _hops(motifs: Sequence[Sequence[str]], anchors: Sequence[str], depth: int = 3):
    from app.services.benchmark_retrieval import build_concept_graph, hop_distances

    return hop_distances(build_concept_graph(motifs), anchors, depth)


def test_the_case_set_separates_directed_from_undirected():
    """The inverse of what this test asserted before #88.

    It used to assert that NO case discriminated, and carried the instruction
    that adding one should turn it red and take the `relation_aware` exemption
    in `test_benchmark_separation.py` with it. #88 added them, so it now asserts
    the property it was waiting for: at least one case where undirected
    traversal reaches something directed traversal does not.

    Kept as a floor rather than a count. The exact number moves whenever a case
    is added; what must not come back is zero, because at zero the ablation is
    reporting two arms that are one.
    """
    from app.services.benchmark_cases import BENCHMARK_CASES

    discriminating = [
        case.case_id
        for case in BENCHMARK_CASES
        if set(_reach([e.graph_motifs for e in case.evidence], case.query_anchors))
        != set(_hops([e.graph_motifs for e in case.evidence], case.query_anchors))
    ]
    assert discriminating, (
        "no case separates directed from undirected traversal. The relation_aware "
        "exemption in test_benchmark_separation.py has to go back if this is true"
    )


def test_a_distractor_reachable_only_against_an_arrow_separates_the_conditions():
    """The first case family #88 should add.

    `distraction -> causes -> anchor`. Undirected traversal reaches it in one
    hop and ranks it top. Directed traversal does not reach it at all, because
    nothing the anchor leads to includes it.
    """
    motifs = [
        ("State:anchor -> causes -> State:real",),
        ("Trigger:distraction -> causes -> State:anchor",),
    ]
    undirected = _hops(motifs, ["anchor"])
    directed = _reach(motifs, ["anchor"])

    assert "distraction" in undirected
    assert "distraction" not in directed
    assert "real" in directed


def test_two_routes_of_equal_length_separate_on_relation_type():
    """The second family #88 should add.

    Both targets sit one hop from the anchor, so hop-count traversal scores them
    identically and the tiebreak decides. Relation-aware traversal ranks the
    `causes` route above the `co_occurs` one, which is the distinction the whole
    stage exists to make.
    """
    motifs = [
        ("State:anchor -> causes -> State:strong",),
        ("State:anchor -> co_occurs -> State:weak",),
    ]
    undirected = _hops(motifs, ["anchor"])
    directed = _reach(motifs, ["anchor"])

    assert undirected["strong"] == undirected["weak"] == 1
    assert directed["strong"].damping > directed["weak"].damping


def test_the_benchmark_declares_which_conditions_are_fixed_rules():
    """AC: 'Benchmark output reports fixed-rule traversal separately from learned
    methods.' Structural, so a reader skimming the summary cannot miss it."""
    from app.services.benchmark_retrieval import METHOD_FAMILIES, METHODS

    assert set(METHOD_FAMILIES) == set(METHODS), "every condition declares a family"
    assert METHOD_FAMILIES["relation_aware"] == "fixed_rule_traversal"
    assert METHOD_FAMILIES["graph_pattern"] == "untyped_traversal", (
        "the undirected baseline must not be relabelled as the thing it is a baseline for"
    )


def test_the_benchmark_condition_refuses_an_unknown_relation_too():
    """Same refusal as the walker, so the two cannot disagree about the vocabulary.

    A `cures` edge is not given the weakest parameter and quietly walked; it is
    dropped, and the target it led to is simply not reached.
    """
    reach = _reach([("State:anchor -> cures -> State:target",)], ["anchor"])
    assert "target" not in reach


def test_the_benchmark_condition_and_the_walker_share_one_parameter_table():
    """Two implementations of the same rule would drift, and the benchmark would
    stop measuring the traversal the product runs."""
    from app.services import benchmark_retrieval

    motifs = [("State:a -> causes -> State:b",), ("State:b -> causes -> State:c",)]
    reach = benchmark_retrieval.relation_aware_reach(
        benchmark_retrieval.build_relation_graph(motifs), ["a"], 3
    )
    assert reach["c"].damping == pytest.approx(RELATION_RULES["causes"].step_damping ** 2)
