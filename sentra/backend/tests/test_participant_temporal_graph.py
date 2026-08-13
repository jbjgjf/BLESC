"""The participant temporal graph contract (#95).

The properties under test are the ones the issue names as acceptance criteria,
and each test is written against the property rather than the implementation:
identity across days, provenance that survives back to the entry, curated and
personal evidence kept in separate fields, deletions and contradictions as
append-only events, past days reconstructable, and the same input producing the
same bytes.

Fixtures are two structurally identical seven-day series, one Japanese and one
English (`fixtures/participant_temporal_graph.json`). The parity test compares
the two assembled event streams after mapping node ids, because the defect this
work followed on from (#107) was a Japanese-only failure that an English-only
suite could not have caught.
"""

from __future__ import annotations

import dataclasses
import json
import os
import random
import subprocess
import sys
from datetime import date
from pathlib import Path
from typing import Any, Dict, List

import pytest

from app.temporal import (
    CONTRACT_VERSION,
    NOT_IMPLEMENTED_HERE,
    UNCURATED,
    ContradictionKind,
    CuratedProvenance,
    EventKind,
    IdentityRule,
    ParticipantTemporalGraph,
    PersonalObservation,
    SnapshotInput,
    assemble_participant_graph,
    edge_key_from_subject,
    edge_subject,
    normalise_label,
    snapshot_inputs,
)

BACKEND = Path(__file__).resolve().parents[1]
FIXTURES = Path(__file__).resolve().parent / "fixtures" / "participant_temporal_graph.json"
SHARED_DIFF_CONTRACT = BACKEND.parent / "shared" / "temporal_diff_conformance.json"

JA = "ja-001"
EN = "en-001"


# ---- fixture plumbing -----------------------------------------------------


@pytest.fixture(scope="module")
def fixtures() -> Dict[str, Any]:
    assert FIXTURES.exists(), f"fixtures missing at {FIXTURES}"
    return json.loads(FIXTURES.read_text(encoding="utf-8"))


def _inputs(fixtures: Dict[str, Any], participant: str) -> List[SnapshotInput]:
    return [
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
        for snapshot in fixtures["participants"][participant]["snapshots"]
    ]


def _graph(fixtures: Dict[str, Any], participant: str, **kwargs: Any) -> ParticipantTemporalGraph:
    return assemble_participant_graph(
        participant,
        _inputs(fixtures, participant),
        aliases=fixtures["participants"][participant].get("aliases"),
        **kwargs,
    )


@pytest.fixture(scope="module")
def ja_graph(fixtures) -> ParticipantTemporalGraph:
    return _graph(fixtures, JA)


@pytest.fixture(scope="module")
def en_graph(fixtures) -> ParticipantTemporalGraph:
    return _graph(fixtures, EN)


def _kinds(graph: ParticipantTemporalGraph, subject: str) -> List[str]:
    return [event.kind.value for event in graph.events_for(subject)]


# ---- the contract itself --------------------------------------------------


def test_the_contract_is_a_data_model_and_says_so():
    """#95 is explicit that this issue introduces no learning.

    The disclaimer lives in the exported constant rather than only in a
    docstring so that anything serialising the graph carries it, and so that
    deleting it fails a test rather than passing silently.
    """
    joined = " ".join(NOT_IMPLEMENTED_HERE).lower()
    for absent in ("tgn", "tgat", "hawkes", "attention", "prediction"):
        assert absent in joined, f"{absent} should be named as out of scope"


def test_documentation_exists_and_disclaims_learning():
    doc = BACKEND.parent / "docs" / "participant_temporal_graph.md"
    assert doc.exists(), f"documentation missing at {doc}"
    text = doc.read_text(encoding="utf-8").lower()
    for required in ("tgn", "tgat", "hawkes", "data model", "not"):
        assert required in text
    assert "risk band" in text or "clinical prediction" in text


def test_graph_shape_has_everything_the_issue_names(ja_graph):
    assert ja_graph.contract_version == CONTRACT_VERSION
    payload = ja_graph.as_dict()
    assert payload["not_implemented_here"] == list(NOT_IMPLEMENTED_HERE)

    node = ja_graph.nodes["眠れない"]
    assert node.intervals, "nodes carry observation intervals"
    assert node.source_snapshot_ids, "nodes carry the snapshot ids that produced them"
    assert node.category_history

    edge = ja_graph.edges[("テスト前のプレッシャー", "眠れない", "causes")]
    assert edge.as_dict()["directed"] is True
    assert edge.relation_type == "causes"
    assert edge.intervals and edge.source_snapshot_ids
    assert edge.confidence_by_day


def test_edges_are_directed_and_typed_independently(ja_graph):
    """Two relation types between one pair are two edges, not one.

    Relation type is part of edge identity in the shared diff contract; if it
    were not part of it here, a retyping would silently overwrite the earlier
    claim.
    """
    pair_edges = [key for key in ja_graph.edges if key[:2] == ("テスト前のプレッシャー", "眠れない")]
    assert sorted(key[2] for key in pair_edges) == ["buffers", "causes", "co_occurs"]
    assert ("眠れない", "テスト前のプレッシャー", "causes") not in ja_graph.edges


# ---- determinism ----------------------------------------------------------


def test_identical_inputs_produce_identical_graphs(fixtures):
    """The AC: identical inputs, identical graphs. Compared as bytes."""
    snapshots = _inputs(fixtures, JA)
    aliases = fixtures["participants"][JA]["aliases"]

    shuffled = list(snapshots)
    random.Random(20260813).shuffle(shuffled)

    first = assemble_participant_graph(JA, snapshots, aliases=aliases).as_json()
    second = assemble_participant_graph(JA, list(reversed(snapshots)), aliases=aliases).as_json()
    third = assemble_participant_graph(JA, shuffled, aliases=aliases).as_json()

    assert first == second == third
    assert first.encode("utf-8") == second.encode("utf-8")


def test_determinism_survives_a_different_hash_seed(tmp_path):
    """Set iteration order is hash-randomised per process.

    An in-process comparison cannot catch a set leaking into the output, because
    both assemblies share one seed. This runs the assembly twice in separate
    interpreters with different `PYTHONHASHSEED` values and compares the bytes —
    the retyping and contradiction passes both walk sets of edge keys, and this
    is what holds them to sorting first.
    """
    script = tmp_path / "assemble_once.py"
    script.write_text(
        "\n".join(
            [
                "import json, sys",
                f"sys.path.insert(0, {str(BACKEND)!r})",
                "from datetime import date",
                "from app.temporal import SnapshotInput, assemble_participant_graph",
                f"data = json.loads(open({str(FIXTURES)!r}, encoding='utf-8').read())",
                f"participant = data['participants'][{JA!r}]",
                "snapshots = [SnapshotInput(",
                "    snapshot_id=s['snapshot_id'], day=date.fromisoformat(s['day']),",
                "    nodes=s['nodes'], relations=s['relations'], entry_id=s.get('entry_id'),",
                "    temporal_diff=s.get('temporal_diff'),",
                ") for s in participant['snapshots']]",
                f"graph = assemble_participant_graph({JA!r}, snapshots, aliases=participant['aliases'])",
                "sys.stdout.write(graph.as_json())",
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


# ---- node identity --------------------------------------------------------


def test_exact_id_carries_a_node_across_days(ja_graph):
    node = ja_graph.nodes["眠れない"]
    assert IdentityRule.EXACT_ID in node.identity_rules
    assert node.total_observations == 7
    assert node.identity_rule is IdentityRule.DECLARED_ALIAS, (
        "six of seven days matched on the id, but day 7 needed the alias table — "
        "the node is only as trustworthy as its loosest match"
    )


def test_a_declared_alias_continues_the_node_rather_than_starting_one(fixtures, ja_graph, en_graph):
    """Day 7 writes the concept under a different id. Only the curator's alias
    table links them, and without it the assembler must NOT link them."""
    assert "不眠" not in ja_graph.nodes
    assert date(2026, 8, 7) in ja_graph.nodes["眠れない"].intervals[-1].observed_days
    assert IdentityRule.DECLARED_ALIAS in ja_graph.nodes["眠れない"].identity_rules
    assert "insomnia" not in en_graph.nodes

    without_alias = assemble_participant_graph(JA, _inputs(fixtures, JA))
    assert "不眠" in without_alias.nodes, "an inferred alias would be a guess; there must be none"
    assert date(2026, 8, 7) not in without_alias.nodes["眠れない"].intervals[-1].observed_days


def test_two_ids_one_label_in_the_same_day_are_not_merged(ja_graph, en_graph):
    """The AC: ambiguous matches are not silently merged.

    Both ids survive, each is marked ambiguous, and an event records the
    decision and its reason.
    """
    for graph, kept, other in (
        (ja_graph, "先生の言葉_2", "先生の言葉"),
        (en_graph, "words_from_teacher", "teacher_words"),
    ):
        assert kept in graph.nodes and other in graph.nodes
        assert graph.nodes[kept].ambiguous_with == (other,)
        assert graph.nodes[kept].identity_rule is IdentityRule.AMBIGUOUS

        ambiguous = graph.events_of_kind(EventKind.IDENTITY_AMBIGUOUS)
        assert [event.subject for event in ambiguous] == [kept]
        assert ambiguous[0].detail["candidates"] == [other]
        assert "same day" in ambiguous[0].detail["reason"]
        assert "kept separate" in ambiguous[0].detail["resolution"]

    assert ja_graph.report.ambiguous_identities == 1
    assert en_graph.report.ambiguous_identities == 1


def test_a_normalised_label_match_is_recorded_as_the_weaker_rung():
    """A node held together by a label match must not report as an exact-id node."""
    snapshots = [
        SnapshotInput("s1", date(2026, 8, 1), [{"id": "ｽﾄﾚｽ", "label": "ｽﾄﾚｽ", "category": "State"}], []),
        SnapshotInput("s2", date(2026, 8, 2), [{"id": "stress-2", "label": "ストレス", "category": "State"}], []),
    ]
    graph = assemble_participant_graph("p", snapshots)

    assert normalise_label("ｽﾄﾚｽ") == normalise_label("ストレス")
    assert list(graph.nodes) == ["ｽﾄﾚｽ"]
    node = graph.nodes["ｽﾄﾚｽ"]
    assert node.identity_rules == (IdentityRule.NORMALISED_LABEL,)
    assert node.identity_rule is IdentityRule.NORMALISED_LABEL
    assert node.labels_seen == ("ｽﾄﾚｽ", "ストレス")


def test_a_node_seen_once_claims_no_cross_day_identity():
    graph = assemble_participant_graph(
        "p", [SnapshotInput("s1", date(2026, 8, 1), [{"id": "a", "label": "A"}], [])]
    )
    assert graph.nodes["a"].identity_rules == (IdentityRule.NO_MATCH,)


def test_positional_node_ids_void_every_temporal_claim():
    """Pre-#107 rows used array positions as ids. `node_1` on two days is not
    the same observation, and the report has to say so rather than assemble a
    confident-looking graph over nothing."""
    snapshots = [
        SnapshotInput("s1", date(2026, 8, 1), [{"id": "node_1", "label": "眠れない"}], []),
        SnapshotInput("s2", date(2026, 8, 2), [{"id": "node_1", "label": "部活を休んだ"}], []),
    ]
    graph = assemble_participant_graph("p", snapshots)

    assert graph.report.identity_is_usable is False
    assert graph.report.legacy_identity_snapshots == ("s1", "s2")
    assert any("positional node ids" in warning for warning in graph.report.warnings)
    unavailable = graph.events_of_kind(EventKind.IDENTITY_UNAVAILABLE)
    assert len(unavailable) == 1 and unavailable[0].detail["snapshot_ids"] == ["s1", "s2"]


# ---- recurrence, disappearance, reappearance ------------------------------


def test_a_gap_produces_two_intervals_not_one_span(ja_graph, en_graph):
    """The AC's recurrence case. 部活を休んだ appears on day 2, is absent for
    three days, and returns on day 6."""
    for graph, node_id in ((ja_graph, "部活を休んだ"), (en_graph, "skipped_club")):
        node = graph.nodes[node_id]
        assert node.recurrence_count == 2
        assert [interval.observed_days for interval in node.intervals] == [
            (date(2026, 8, 2),),
            (date(2026, 8, 6),),
        ]
        assert node.first_day == date(2026, 8, 2)
        assert node.last_day == date(2026, 8, 6)
        assert node.total_observations == 2
        assert graph.recurring_nodes(2) == [node] or node in graph.recurring_nodes(2)


def test_an_interval_never_claims_a_span_its_observations_do_not_cover(ja_graph):
    interval = ja_graph.nodes["テスト前のプレッシャー"].intervals[-1]
    assert interval.observation_count <= interval.span_days
    assert interval.is_dense is (interval.observation_count == interval.span_days)
    assert len(interval.snapshot_ids) == interval.observation_count


def test_disappearance_and_reappearance_are_events(ja_graph, en_graph):
    for graph, node_id in ((ja_graph, "テスト前のプレッシャー"), (en_graph, "exam_pressure")):
        kinds = _kinds(graph, node_id)
        assert kinds.count(EventKind.NODE_OBSERVED.value) == 1, "observed once, then reappeared"
        assert EventKind.NODE_ABSENT.value in kinds
        assert EventKind.NODE_REAPPEARED.value in kinds

        absent = [e for e in graph.events_for(node_id) if e.kind is EventKind.NODE_ABSENT]
        assert absent[0].day == date(2026, 8, 2)
        assert absent[0].detail["last_observed"] == "2026-08-01"

        reappeared = [e for e in graph.events_for(node_id) if e.kind is EventKind.NODE_REAPPEARED]
        assert reappeared[0].day == date(2026, 8, 3)
        assert reappeared[0].detail["last_seen_before"] == "2026-08-01"


def test_edge_disappearance_and_reappearance_are_events(ja_graph):
    subject = edge_subject("テスト前のプレッシャー", "眠れない", "causes")
    kinds = _kinds(ja_graph, subject)
    assert kinds.count(EventKind.EDGE_OBSERVED.value) == 1
    assert EventKind.EDGE_ABSENT.value in kinds
    assert EventKind.EDGE_REAPPEARED.value in kinds


def test_a_missing_entry_day_is_not_a_disappearance():
    """`max_gap_days` counts skipped entries, not calendar days.

    Students do not write daily. Treating a quiet weekend as remission is the
    error this parameter exists to make explicit rather than accidental.
    """
    snapshots = [
        SnapshotInput("s1", date(2026, 8, 1), [{"id": "a", "label": "A"}], []),
        SnapshotInput("s2", date(2026, 8, 5), [{"id": "a", "label": "A"}], []),
    ]
    graph = assemble_participant_graph("p", snapshots)
    node = graph.nodes["a"]
    assert node.recurrence_count == 1, "consecutive entries continue one interval"
    assert node.intervals[0].span_days == 5
    assert node.intervals[0].is_dense is False, "four calendar days, two observations"


def test_max_gap_days_controls_when_a_skipped_entry_splits_an_interval():
    snapshots = [
        SnapshotInput("s1", date(2026, 8, 1), [{"id": "a", "label": "A"}], []),
        SnapshotInput("s2", date(2026, 8, 2), [{"id": "b", "label": "B"}], []),
        SnapshotInput("s3", date(2026, 8, 3), [{"id": "a", "label": "A"}], []),
    ]
    strict = assemble_participant_graph("p", snapshots)
    lenient = assemble_participant_graph("p", snapshots, max_gap_days=1)

    assert strict.nodes["a"].recurrence_count == 2
    assert lenient.nodes["a"].recurrence_count == 1


# ---- changed relations ----------------------------------------------------


def test_a_confidence_shift_past_the_threshold_is_an_event(ja_graph, en_graph):
    for graph, source, target in (
        (ja_graph, "テスト前のプレッシャー", "眠れない"),
        (en_graph, "exam_pressure", "cannot_sleep"),
    ):
        subject = edge_subject(source, target, "causes")
        shifts = [e for e in graph.events_for(subject) if e.kind is EventKind.EDGE_CONFIDENCE_SHIFTED]
        assert len(shifts) == 1
        assert shifts[0].day == date(2026, 8, 4)
        assert shifts[0].detail["previous_confidence"] == 0.9
        assert shifts[0].detail["current_confidence"] == 0.7
        assert shifts[0].detail["delta"] == pytest.approx(-0.2)


def test_confidence_is_kept_per_day_rather_than_averaged(ja_graph):
    edge = ja_graph.edges[("テスト前のプレッシャー", "眠れない", "causes")]
    assert edge.confidence_by_day == (
        (date(2026, 8, 1), 0.5),
        (date(2026, 8, 3), 0.9),
        (date(2026, 8, 4), 0.7),
        (date(2026, 8, 6), 0.6),
    )
    assert edge.latest_confidence == 0.6


def test_a_retyped_relation_is_recorded_as_a_retyping(ja_graph):
    """The shared diff contract reports a retype as an add plus a remove and
    says #95 owns telling that apart from two unrelated edges."""
    retyped = ja_graph.events_of_kind(EventKind.EDGE_RETYPED)
    on_day_5 = [event for event in retyped if event.day == date(2026, 8, 5)]
    assert len(on_day_5) == 1
    assert on_day_5[0].subject == edge_subject("テスト前のプレッシャー", "眠れない", "co_occurs")
    assert on_day_5[0].detail["previous_relation_types"] == ["causes"]
    assert on_day_5[0].detail["current_relation_type"] == "co_occurs"

    # The add and the remove are still emitted alongside it.
    assert any(
        event.kind is EventKind.EDGE_ABSENT and event.day == date(2026, 8, 5)
        for event in ja_graph.events_for(edge_subject("テスト前のプレッシャー", "眠れない", "causes"))
    )


# ---- contradictions -------------------------------------------------------


def test_a_same_day_polarity_conflict_is_a_contradiction(ja_graph, en_graph):
    for graph, source, target in (
        (ja_graph, "テスト前のプレッシャー", "眠れない"),
        (en_graph, "exam_pressure", "cannot_sleep"),
    ):
        same_day = [
            event
            for event in graph.events_of_kind(EventKind.CONTRADICTION)
            if event.detail["scope"] == "same_day"
        ]
        assert len(same_day) == 1
        detail = same_day[0].detail
        assert detail["kind"] == ContradictionKind.OPPOSITE_POLARITY.value
        assert detail["source_id"] == source and detail["target_id"] == target
        assert detail["raising_relation_types"] == ["causes"]
        assert detail["lowering_relation_types"] == ["buffers"]
        assert "does not adjudicate" in detail["resolution"]


def test_a_polarity_flip_across_days_is_a_contradiction(ja_graph):
    across = [
        event
        for event in ja_graph.events_of_kind(EventKind.CONTRADICTION)
        if event.detail["scope"] == "across_days"
    ]
    assert len(across) == 1
    detail = across[0].detail
    assert (detail["source_id"], detail["target_id"]) == ("眠れない", "部活を休んだ")
    assert detail["previous_day"] == "2026-08-02", "compared against the last time it was asserted"
    assert detail["previous_relation_types"] == ["causes"]
    assert detail["current_relation_types"] == ["buffers"]


def test_a_contradiction_keeps_both_edges(ja_graph):
    """Nothing is adjudicated. Both claims stay in the graph with their own
    provenance, because the assembler has no basis for choosing."""
    assert ("テスト前のプレッシャー", "眠れない", "causes") in ja_graph.edges
    assert ("テスト前のプレッシャー", "眠れない", "buffers") in ja_graph.edges
    assert ja_graph.report.contradictions == 2


def test_mutual_causation_on_one_day_is_a_contradiction():
    snapshots = [
        SnapshotInput(
            "s1",
            date(2026, 8, 1),
            [{"id": "a", "label": "A"}, {"id": "b", "label": "B"}],
            [
                {"source_id": "a", "target_id": "b", "type": "causes", "confidence": 0.8},
                {"source_id": "b", "target_id": "a", "type": "escalates", "confidence": 0.7},
            ],
        )
    ]
    graph = assemble_participant_graph("p", snapshots)
    contradictions = graph.events_of_kind(EventKind.CONTRADICTION)
    assert len(contradictions) == 1
    assert contradictions[0].detail["kind"] == ContradictionKind.MUTUAL_CAUSATION.value
    assert graph.edges[("a", "b", "causes")] and graph.edges[("b", "a", "escalates")]


def test_a_weak_relation_type_contradicts_nothing():
    """`co_occurs` and `precedes` assert no direction of influence.

    Treating them as contradicting a causal claim would manufacture conflict out
    of the vocabulary's own hedge.
    """
    snapshots = [
        SnapshotInput(
            "s1",
            date(2026, 8, 1),
            [{"id": "a", "label": "A"}, {"id": "b", "label": "B"}],
            [
                {"source_id": "a", "target_id": "b", "type": "causes"},
                {"source_id": "a", "target_id": "b", "type": "co_occurs"},
                {"source_id": "a", "target_id": "b", "type": "precedes"},
            ],
        )
    ]
    assert assemble_participant_graph("p", snapshots).report.contradictions == 0


# ---- categories -----------------------------------------------------------


def test_a_category_change_is_appended_not_applied(ja_graph, en_graph):
    for graph, node_id in ((ja_graph, "眠れない"), (en_graph, "cannot_sleep")):
        node = graph.nodes[node_id]
        assert node.has_category_conflict
        assert [assignment.category for assignment in node.category_history] == [
            "State",
            "Behavior",
            "State",
        ]
        assert node.category_history[0].days == (
            date(2026, 8, 1),
            date(2026, 8, 2),
            date(2026, 8, 3),
            date(2026, 8, 4),
            date(2026, 8, 5),
        )
        assert node.category == "State", "the property summarises the history, it does not replace it"

        reassignments = [e for e in graph.events_for(node_id) if e.kind is EventKind.CATEGORY_REASSIGNED]
        assert [(e.day, e.detail["previous_category"], e.detail["current_category"]) for e in reassignments] == [
            (date(2026, 8, 6), "State", "Behavior"),
            (date(2026, 8, 7), "Behavior", "State"),
        ]
        assert graph.report.category_conflicts == 1


# ---- provenance -----------------------------------------------------------


def test_personal_and_curated_provenance_share_no_field():
    """The AC: the two stay in separate fields.

    Enforced structurally rather than by convention — the two dataclasses have
    no field name in common, so no dict merge or `**` splat can move a curated
    citation into the record of what a participant wrote, or the reverse.
    """
    personal = {field.name for field in dataclasses.fields(PersonalObservation)}
    curated = {field.name for field in dataclasses.fields(CuratedProvenance)}

    assert personal & curated == set()
    assert "snapshot" in personal and "snapshot" not in curated
    assert "source_refs" in curated and "source_refs" not in personal
    assert not any("source" in name for name in personal)
    assert not any(name in ("day", "entry_id", "snapshot_id") for name in curated)


def test_curated_and_personal_provenance_are_populated_independently(ja_graph):
    node = ja_graph.nodes["眠れない"]
    assert node.curated_provenance.source_refs == ("nice_ng134",)
    assert node.curated_provenance.subgraph_id == "sleep_disruption"
    assert node.curated_provenance.match_rule == "normalised_label"
    assert len(node.personal_observations) == 7
    assert all(observation.snapshot.snapshot_id for observation in node.personal_observations)

    unmatched = ja_graph.nodes["テスト前のプレッシャー"]
    assert unmatched.curated_provenance is UNCURATED
    assert unmatched.curated_source_refs == ()
    assert unmatched.personal_observations, "no curation does not mean no observation"


def test_edge_evidence_strength_comes_from_curation_only(ja_graph):
    curated_edge = ja_graph.edges[("テスト前のプレッシャー", "眠れない", "causes")]
    assert curated_edge.evidence_strength == "association"
    assert curated_edge.curated_source_refs == ("nice_ng134",)
    assert curated_edge.curated_provenance.seed_relation_type == "causes"
    assert curated_edge.curated_provenance.type_matches_seed is True

    uncurated_edge = ja_graph.edges[("眠れない", "部活を休んだ", "causes")]
    assert uncurated_edge.evidence_strength is None
    assert uncurated_edge.curated_source_refs == ()


def test_a_curator_supplied_table_lands_only_in_the_curated_field(fixtures):
    graph = _graph(
        fixtures,
        JA,
        curated_node_sources={"部活を休んだ": ["who_adolescent_mh"]},
        curated_edge_sources={("眠れない", "部活を休んだ", "causes"): ["who_adolescent_mh"]},
    )
    node = graph.nodes["部活を休んだ"]
    assert node.curated_source_refs == ("who_adolescent_mh",)
    assert node.curated_provenance.match_rule == "curator_declared"
    assert graph.edges[("眠れない", "部活を休んだ", "causes")].curated_source_refs == ("who_adolescent_mh",)

    for observation in node.personal_observations:
        assert not hasattr(observation, "source_refs")
        assert observation.snapshot.entry_id


def test_every_node_and_edge_traces_back_to_a_snapshot_and_an_entry(ja_graph):
    """The AC: every temporal node/edge traces back to the snapshot and the user
    observation that produced it."""
    for node in ja_graph.nodes.values():
        chain = ja_graph.provenance_chain(node.node_id)
        assert chain, f"{node.node_id} has no provenance chain"
        for link in chain:
            assert link["snapshot_id"] and link["entry_id"] and link["day"]
            assert link["extraction_provider"] == "openai"
            assert link["extraction_model"] == "gpt-4o-mini"
            assert link["extractor_version"] == "extraction-v3"

    for key in ja_graph.edges:
        assert ja_graph.provenance_chain(edge_subject(*key))

    node = ja_graph.nodes["眠れない"]
    assert set(node.source_snapshot_ids) == {f"s-ja-{index}" for index in range(1, 8)}
    for interval in node.intervals:
        assert len(interval.snapshot_ids) == interval.observation_count


def test_the_label_as_written_survives_a_later_relabelling(ja_graph):
    """A participant's words are not rewritten by a later day's extraction."""
    day_seven = [
        observation
        for observation in ja_graph.nodes["眠れない"].personal_observations
        if observation.snapshot.day == date(2026, 8, 7)
    ]
    assert [observation.label_as_written for observation in day_seven] == ["不眠"]
    assert ja_graph.nodes["眠れない"].canonical_label == "眠れない"
    assert "不眠" in ja_graph.nodes["眠れない"].labels_seen


def test_an_event_carries_the_label_written_on_its_own_day():
    """A relabelling must not reach backwards.

    The node accumulates every surface form it has been written as; an event on
    a given day has to carry that day's, or the log rewrites what the
    participant said. `at(day)` reads the labels off the log, so getting this
    wrong makes every reconstructed past day show today's wording.
    """
    snapshots = [
        SnapshotInput("s1", date(2026, 8, 1), [{"id": "x", "label": "つらい"}], []),
        SnapshotInput("s2", date(2026, 8, 2), [{"id": "other", "label": "別"}], []),
        SnapshotInput("s3", date(2026, 8, 3), [{"id": "x", "label": "しんどい"}], []),
        SnapshotInput("s4", date(2026, 8, 4), [{"id": "other", "label": "別"}], []),
        SnapshotInput("s5", date(2026, 8, 5), [{"id": "x", "label": "つらい"}], []),
    ]
    graph = assemble_participant_graph("p", snapshots)

    labels = {
        event.day: event.detail["label"]
        for event in graph.events_for("x")
        if event.kind in (EventKind.NODE_OBSERVED, EventKind.NODE_REAPPEARED)
    }
    assert labels == {
        date(2026, 8, 1): "つらい",
        date(2026, 8, 3): "しんどい",
        date(2026, 8, 5): "つらい",
    }
    assert graph.at(date(2026, 8, 3)).labels["x"] == "しんどい"
    assert graph.at(date(2026, 8, 5)).labels["x"] == "つらい"
    assert graph.nodes["x"].labels_seen == ("つらい", "しんどい")


def test_the_days_last_entry_supplies_the_days_event():
    """A participant who writes twice has revised their own account by evening."""
    snapshots = [
        SnapshotInput("morning", date(2026, 8, 1), [{"id": "x", "label": "A", "category": "State"}], []),
        SnapshotInput("night", date(2026, 8, 1), [{"id": "x", "label": "B", "category": "Behavior"}], []),
    ]
    graph = assemble_participant_graph("p", snapshots)

    observed = graph.events_of_kind(EventKind.NODE_OBSERVED)
    assert len(observed) == 1
    assert observed[0].detail["label"] == "B"
    assert observed[0].detail["category"] == "Behavior"
    assert observed[0].snapshot.snapshot_id == "night"
    assert [o.label_as_written for o in graph.nodes["x"].personal_observations] == ["A", "B"]


# ---- time travel and the append-only log ----------------------------------


def test_a_past_day_can_be_reconstructed(ja_graph):
    day_two = ja_graph.at(date(2026, 8, 2))
    assert day_two.present_node_ids == ("眠れない", "部活を休んだ")
    assert day_two.absent_node_ids == ("テスト前のプレッシャー",)
    assert day_two.categories["眠れない"] == "State"
    assert ("眠れない", "部活を休んだ", "causes") in day_two.present_edge_keys

    day_six = ja_graph.at(date(2026, 8, 6))
    assert day_six.categories["眠れない"] == "Behavior", "the category as it stood then"
    assert "部活を休んだ" in day_six.present_node_ids

    day_seven = ja_graph.at(date(2026, 8, 7))
    assert day_seven.present_node_ids == ("眠れない",)
    assert set(day_seven.absent_node_ids) == {
        "テスト前のプレッシャー",
        "先生の言葉",
        "先生の言葉_2",
        "部活を休んだ",
    }
    assert day_seven.present_edge_keys == ()
    assert "先生の言葉" in ja_graph.nodes, "absent on day 7, still in the graph with its history"


def test_a_slice_and_a_day_of_observations_answer_different_questions(ja_graph):
    """A quiet day is not an empty graph. The two projections must not be
    confused, because "the student stopped writing" and "the student got better"
    are different findings."""
    quiet = date(2026, 8, 8)
    assert ja_graph.nodes_present_on(quiet) == []
    assert ja_graph.at(quiet).present_node_ids == ("眠れない",)


def test_a_longer_window_never_rewrites_the_days_it_shares(fixtures):
    """The AC: history is never overwritten.

    Assembling four days and then seven must produce identical events for the
    four they share — a representation that mutated in place could not promise
    that.
    """
    aliases = fixtures["participants"][JA]["aliases"]
    everything = _inputs(fixtures, JA)
    short = assemble_participant_graph(JA, everything[:4], aliases=aliases)
    long = assemble_participant_graph(JA, everything, aliases=aliases)

    cutoff = date(2026, 8, 4)
    shared = [event.as_dict() for event in long.events if event.day <= cutoff]
    assert [event.as_dict() for event in short.events] == shared


def test_the_event_log_is_the_authority_for_every_change(ja_graph):
    """Nothing changes state without an event naming it."""
    kinds = {event.kind for event in ja_graph.events}
    assert {
        EventKind.NODE_OBSERVED,
        EventKind.NODE_ABSENT,
        EventKind.NODE_REAPPEARED,
        EventKind.EDGE_OBSERVED,
        EventKind.EDGE_ABSENT,
        EventKind.EDGE_REAPPEARED,
        EventKind.EDGE_RETYPED,
        EventKind.EDGE_CONFIDENCE_SHIFTED,
        EventKind.CATEGORY_REASSIGNED,
        EventKind.IDENTITY_AMBIGUOUS,
        EventKind.CONTRADICTION,
    } <= kinds

    days = [event.day for event in ja_graph.events]
    assert days == sorted(days), "the log is ordered and append-only"


# ---- the stored temporal_diff_json ----------------------------------------


def test_the_stored_diff_is_cross_checked_not_consumed(ja_graph):
    """The AC asks the assembler to consume snapshots plus `temporal_diff_json`.

    The stored diff is unreliable by row (#106/#107), so it is compared against
    a recomputation rather than trusted, and every row's verdict is reported.
    """
    by_snapshot = {check.snapshot_id: check for check in ja_graph.report.diff_cross_checks}
    assert len(by_snapshot) == 7

    assert by_snapshot["s-ja-1"].status == "agreed"
    assert by_snapshot["s-ja-2"].status == "agreed"
    assert by_snapshot["s-ja-7"].status == "agreed"

    assert by_snapshot["s-ja-3"].status == "not_comparable"
    assert "stateless route handler" in by_snapshot["s-ja-3"].reason
    assert by_snapshot["s-ja-6"].status == "not_comparable"
    assert "positional node ids" in by_snapshot["s-ja-6"].reason

    assert by_snapshot["s-ja-5"].status == "absent"

    disagreed = by_snapshot["s-ja-4"]
    assert disagreed.status == "disagreed"
    # The row claims both nodes and the relation are new and that nothing
    # changed. All three were present the day before, and the relation's
    # confidence moved 0.9 -> 0.7.
    assert set(disagreed.disagreements) == {"added_nodes", "added_relations", "changed_relations"}
    assert ja_graph.report.diff_disagreements == (disagreed,)
    assert any("disagree" in warning for warning in ja_graph.report.warnings)


def test_a_wrong_stored_diff_cannot_change_the_graph(fixtures):
    """The reason the stored diff is not consumed: a row claiming everything is
    new, every day — the #106 placeholder — must not make recurrence vanish."""
    snapshots = _inputs(fixtures, JA)
    aliases = fixtures["participants"][JA]["aliases"]
    truthful = assemble_participant_graph(JA, snapshots, aliases=aliases)

    poisoned = [
        dataclasses.replace(
            snapshot,
            temporal_diff={
                "diff_basis": "previous_snapshot",
                "added_nodes": list(snapshot.nodes),
                "removed_nodes": [],
                "added_relations": list(snapshot.relations),
                "removed_relations": [],
                "changed_relations": [],
            },
        )
        for snapshot in snapshots
    ]
    corrupted = assemble_participant_graph(JA, poisoned, aliases=aliases)

    assert corrupted.nodes.keys() == truthful.nodes.keys()
    assert corrupted.edges.keys() == truthful.edges.keys()
    assert [event.as_dict() for event in corrupted.events] == [
        event.as_dict() for event in truthful.events
    ]
    assert corrupted.nodes["部活を休んだ"].recurrence_count == 2
    assert len(corrupted.report.diff_disagreements) >= 4


def test_a_diff_claiming_to_be_the_first_snapshot_mid_history_disagrees(fixtures):
    snapshots = _inputs(fixtures, JA)
    relabelled = [
        dataclasses.replace(
            snapshot,
            temporal_diff={**(snapshot.temporal_diff or {}), "diff_basis": "first_snapshot_for_participant"},
        )
        if snapshot.snapshot_id == "s-ja-2"
        else snapshot
        for snapshot in snapshots
    ]
    graph = assemble_participant_graph(JA, relabelled, aliases=fixtures["participants"][JA]["aliases"])
    check = next(c for c in graph.report.diff_cross_checks if c.snapshot_id == "s-ja-2")
    assert check.status == "disagreed"
    assert check.disagreements == ("claimed_first_snapshot_but_earlier_day_exists",)


def test_the_recomputed_diff_matches_the_shared_contract():
    """#95's change detection and the #106 diff contract are the same semantics.

    Each shared fixture case is replayed as a two-day series so a divergence
    between this assembler and the contract fails here rather than surfacing as
    two components disagreeing in the database.
    """
    contract = json.loads(SHARED_DIFF_CONTRACT.read_text(encoding="utf-8"))
    monday, tuesday = date(2026, 8, 3), date(2026, 8, 4)

    for case in contract["cases"]:
        if not case["had_previous"]:
            continue
        graph = assemble_participant_graph(
            "p",
            [
                SnapshotInput("s1", monday, *_with_endpoints(case["previous"])),
                SnapshotInput("s2", tuesday, *_with_endpoints(case["current"])),
            ],
        )
        expected = case["expected"]
        name = case["name"]

        observed = {
            event.subject
            for event in graph.events
            if event.day == tuesday and event.kind is EventKind.NODE_OBSERVED
        }
        assert observed == set(expected["added_node_ids"]), name

        absent = {
            event.subject
            for event in graph.events
            if event.day == tuesday and event.kind is EventKind.NODE_ABSENT
        }
        assert absent == set(expected["removed_node_ids"]), name

        added_edges = {
            event.subject
            for event in graph.events
            if event.day == tuesday and event.kind is EventKind.EDGE_OBSERVED
        }
        assert added_edges == {_contract_key(key) for key in expected["added_relation_keys"]}, name

        shifted = {
            event.subject
            for event in graph.events
            if event.day == tuesday and event.kind is EventKind.EDGE_CONFIDENCE_SHIFTED
        }
        assert shifted == {_contract_key(key) for key in expected["changed_relation_keys"]}, name

        if name == "relation_retyped_is_an_add_and_a_remove":
            assert graph.events_of_kind(EventKind.EDGE_RETYPED), name


def _contract_key(key: str) -> str:
    source, target, relation_type = key.split("|")
    return edge_subject(source, target, relation_type)


def _with_endpoints(snapshot: Dict[str, Any]):
    """The contract's cases, with endpoint nodes supplied.

    Several shared cases carry a relation whose source is not in the same
    snapshot's node list, because `build_temporal_graph_diff` compares arrays and
    never looks at endpoints. The temporal graph does: a relation pointing at a
    node the day did not observe is exactly the pre-#107 Japanese defect, so it
    is counted as dangling and not assembled
    (`test_a_relation_with_a_missing_endpoint_is_counted_not_dropped`). Adding a
    stub node keeps the case about change detection, which is what it is for,
    instead of about the endpoint rule, which is tested separately.
    """
    nodes = list(snapshot["nodes"])
    known = {str(node.get("id", "")) for node in nodes}
    for relation in snapshot["relations"]:
        for endpoint in (relation.get("source_id"), relation.get("target_id")):
            endpoint = str(endpoint or "")
            if endpoint and endpoint not in known:
                nodes.append({"id": endpoint, "label": endpoint, "category": "State", "confidence": 1.0})
                known.add(endpoint)
    return nodes, list(snapshot["relations"])


# ---- language parity ------------------------------------------------------


def test_japanese_and_english_series_assemble_identically(fixtures, ja_graph, en_graph):
    """The AC: Japanese and English fixtures cover the same phenomena.

    Asserted as equality of the whole assembled history rather than as two
    parallel checklists — a Japanese-only defect would have to survive a
    byte-level comparison against the English run to get through, and the
    extraction defect that motivated this work was exactly Japanese-only.
    """
    node_map = fixtures["parity"]["node_map"]
    assert set(node_map) <= set(ja_graph.nodes) | {"不眠"}

    translated = [_translate(event.as_dict(), node_map) for event in ja_graph.events]
    english = [_language_neutral(event.as_dict()) for event in en_graph.events]

    assert sorted(map(json.dumps, translated), key=str) == sorted(map(json.dumps, english), key=str)

    assert {node_map[node_id] for node_id in ja_graph.nodes} == set(en_graph.nodes)
    assert {
        (node_map[key[0]], node_map[key[1]], key[2]) for key in ja_graph.edges
    } == set(en_graph.edges)
    for attribute in ("contradictions", "category_conflicts", "ambiguous_identities", "dangling_relations"):
        assert getattr(ja_graph.report, attribute) == getattr(en_graph.report, attribute), attribute


_ID_FIELDS = ("source_id", "target_id", "subject")
_ID_LIST_FIELDS = ("candidates",)
#: Dropped before comparison: the participant's own words and the row ids
#: differ by construction between the two series, and neither is structure.
_LANGUAGE_BOUND = ("label", "reason")


def _translate(payload: Dict[str, Any], node_map: Dict[str, str]) -> Dict[str, Any]:
    def convert(node_id: str) -> str:
        return node_map.get(node_id, node_id)

    def convert_subject(subject: str) -> str:
        source, target, relation_type = edge_key_from_subject(subject)
        if not relation_type:
            return convert(subject)
        return edge_subject(convert(source), convert(target), relation_type)

    result = _language_neutral(payload)
    result["subject"] = convert_subject(str(result["subject"]))
    detail = result["detail"]
    for field_name in _ID_FIELDS:
        if field_name in detail:
            detail[field_name] = convert(str(detail[field_name]))
    for field_name in _ID_LIST_FIELDS:
        if field_name in detail:
            detail[field_name] = [convert(str(value)) for value in detail[field_name]]
    return result


def _language_neutral(payload: Dict[str, Any]) -> Dict[str, Any]:
    result = {key: value for key, value in payload.items() if key != "snapshot"}
    result["detail"] = {
        key: value for key, value in payload["detail"].items() if key not in _LANGUAGE_BOUND
    }
    if "snapshot_ids" in result["detail"]:
        result["detail"].pop("snapshot_ids")
    return result


# ---- adapters and edges of the input space --------------------------------


class _Row:
    """A stand-in for the `GraphSnapshot` SQLModel row, attribute for attribute."""

    def __init__(self, **fields: Any) -> None:
        for key, value in fields.items():
            setattr(self, key, value)


def test_rows_and_mappings_reach_the_assembler_through_one_door():
    rows = [
        _Row(
            id=11,
            day=date(2026, 8, 1),
            entry_id=5,
            nodes_json=[{"id": "a", "label": "A"}],
            relations_json=[],
            temporal_diff_json={"diff_basis": "first_snapshot_for_participant"},
            extraction_provider="openai",
            extraction_model="gpt-4o-mini",
        ),
        {
            "id": "12",
            "day": "2026-08-02T09:30:00+09:00",
            "entry_id": "6",
            "nodes_json": [{"id": "a", "label": "A"}],
            "relations_json": [],
            "extraction_provider": "openai",
            "extraction_model": "gpt-4o-mini",
        },
        _Row(id=13, day=None, nodes_json=[], relations_json=[]),
    ]
    adapted = snapshot_inputs(rows)

    assert [snapshot.snapshot_id for snapshot in adapted] == ["11", "12"], "an undatable row is dropped"
    assert adapted[1].day == date(2026, 8, 2)
    assert adapted[0].entry_id == "5"
    assert adapted[0].diff_basis == "first_snapshot_for_participant"

    graph = assemble_participant_graph("p", adapted)
    assert graph.nodes["a"].total_observations == 2


def test_two_entries_on_one_day_are_one_day(fixtures):
    """A participant who writes twice on Tuesday has one Tuesday.

    Both snapshots keep their own provenance; only the absence arithmetic is
    done per day, so a concept in the morning entry and not the evening one is
    not a disappearance.
    """
    snapshots = [
        SnapshotInput("s1", date(2026, 8, 1), [{"id": "a", "label": "A"}], []),
        SnapshotInput("s2", date(2026, 8, 1), [{"id": "b", "label": "B"}], []),
        SnapshotInput("s3", date(2026, 8, 2), [{"id": "a", "label": "A"}, {"id": "b", "label": "B"}], []),
    ]
    graph = assemble_participant_graph("p", snapshots)

    assert graph.report.days_covered == (date(2026, 8, 1), date(2026, 8, 2))
    assert graph.events_of_kind(EventKind.NODE_ABSENT) == []
    assert graph.nodes["a"].recurrence_count == 1
    assert graph.nodes["a"].intervals[0].snapshot_ids == ("s1", "s3")


def test_a_relation_with_a_missing_endpoint_is_counted_not_dropped():
    """The pre-#107 Japanese defect produced exactly this shape."""
    snapshots = [
        SnapshotInput(
            "s1",
            date(2026, 8, 1),
            [{"id": "a", "label": "A"}],
            [{"source_id": "a", "target_id": "ghost", "type": "causes"}],
        )
    ]
    graph = assemble_participant_graph("p", snapshots)

    assert graph.edges == {}
    assert graph.report.dangling_relations == 1
    assert any("absent from the same day" in warning for warning in graph.report.warnings)


def test_a_snapshot_with_no_identifiable_node_is_reported_as_a_hole():
    snapshots = [
        SnapshotInput("s1", date(2026, 8, 1), [{"id": "", "label": "  "}], []),
        SnapshotInput("s2", date(2026, 8, 2), [{"id": "a", "label": "A"}], []),
    ]
    graph = assemble_participant_graph("p", snapshots)

    assert graph.report.snapshots_seen == 2
    assert graph.report.snapshots_usable == 1
    assert any("contributed no identifiable node" in warning for warning in graph.report.warnings)


def test_no_snapshots_produces_an_empty_graph_not_an_error():
    graph = assemble_participant_graph("p", [])
    assert graph.nodes == {} and graph.edges == {} and graph.events == ()
    assert graph.report.snapshots_seen == 0
    assert graph.report.days_covered == ()
    assert graph.at(date(2026, 8, 1)).present_node_ids == ()
    assert json.loads(graph.as_json())["contract_version"] == CONTRACT_VERSION


def test_traversal_helpers_respect_direction(ja_graph):
    outgoing = ja_graph.outgoing("テスト前のプレッシャー")
    assert {edge.target_id for edge in outgoing} == {"眠れない"}
    assert ja_graph.incoming("テスト前のプレッシャー") == []
    assert {edge.relation_type for edge in ja_graph.outgoing("テスト前のプレッシャー", ["causes"])} == {"causes"}
