"""Guards on how the #88 cases are BUILT, as opposed to how they score.

Everything here would still matter if every retrieval number changed tomorrow.
The theme is the same one running through #86 and #87: a benchmark fails
quietly, by containing a cue nobody meant to put there, and the cue is always
easier to assert against than to notice.
"""

from collections import Counter

import pytest

from app.services.benchmark_cases import (
    BENCHMARK_CASES,
    DRAFTS,
    CaseDesignError,
    motif_for,
)
from app.services.benchmark_cases._build import _curated_edges, _curated_terms
from app.services.benchmark_cases._splits import EDGE_POOLS, SPLITS
from app.services.benchmark_retrieval import parse_motifs
from app.models.safety import SafetyAssessmentInput
from app.services.safety import assess_safety


# ---- the cases cannot assert what the ontology does not hold ---------------


def test_a_motif_can_only_be_rendered_for_a_curated_edge():
    with pytest.raises(CaseDesignError, match="no curated edge"):
        motif_for("sleep_deprivation", "peer_friendship")


def test_an_unknown_node_is_rejected_rather_than_rendered():
    with pytest.raises(CaseDesignError, match="not a node"):
        motif_for("self_harm", "depressed_mood")


def test_every_target_motif_is_an_edge_a_seed_file_declares():
    """The property the whole `_build` module exists for. If a case could assert
    a relation the curation does not hold, the benchmark would be scoring its
    own answer key."""
    curated = {
        f"{_curated_terms()[source]} -> {relation} -> {_curated_terms()[target]}"
        for (source, target), relation in _curated_edges().items()
    }
    for case in BENCHMARK_CASES:
        expected = set(case.expected_evidence_ids)
        for day in case.evidence:
            if day.evidence_id in expected:
                for motif in day.graph_motifs:
                    assert motif in curated, f"{case.case_id}/{day.evidence_id}: {motif}"


def test_decoys_assert_no_curated_relation():
    """Decoy motifs are noise in the candidate set, not claims about the world.

    One that happened to spell a curated edge would be a target wearing a
    decoy's id, and every metric would count it as a miss.
    """
    curated_pairs = set(_curated_edges())
    terms = {term: node_id for node_id, term in _curated_terms().items()}
    for case in BENCHMARK_CASES:
        expected = set(case.expected_evidence_ids)
        for day in case.evidence:
            if day.evidence_id in expected or not day.evidence_id.startswith("d"):
                continue
            for triple in parse_motifs(day.graph_motifs):
                pair = (terms.get(triple.subject), terms.get(triple.object))
                assert pair not in curated_pairs, f"{case.case_id}/{day.evidence_id}"


# ---- the graph layer carries no language ----------------------------------


def test_a_matched_pair_has_an_identical_graph():
    """The confound #88 introduced and then removed.

    Decoy motifs used to name the decoy WORD, so the graph differed by language
    and the deterministic tie-break sorted the two scripts differently — `ja`
    scored 1.000 where `en` scored 0.469 on the same case. The product's graph
    is canonical concept ids, which carry no language, and the fixtures have to
    be the same.
    """
    by_pair: dict[str, dict[str, list]] = {}
    for case in BENCHMARK_CASES:
        by_pair.setdefault(case.pair_id, {})[case.lang] = [
            sorted(day.graph_motifs) for day in case.evidence
        ]
    for pair_id, langs in by_pair.items():
        assert langs["en"] == langs["ja"], f"{pair_id} has a language-dependent graph"


def test_a_matched_pair_shares_its_query_anchors_and_candidate_count():
    by_pair: dict[str, dict[str, tuple]] = {}
    for case in BENCHMARK_CASES:
        by_pair.setdefault(case.pair_id, {})[case.lang] = (
            tuple(case.query_anchors),
            len(case.evidence),
            tuple(case.expected_evidence_ids),
        )
    for pair_id, langs in by_pair.items():
        assert langs["en"] == langs["ja"], pair_id


def test_the_two_languages_share_no_text():
    """A pair whose Japanese half contained an English sentence would let a
    method match across the pair rather than within the case."""
    by_pair: dict[str, dict[str, set]] = {}
    for case in BENCHMARK_CASES:
        by_pair.setdefault(case.pair_id, {})[case.lang] = {day.text for day in case.evidence}
    for pair_id, langs in by_pair.items():
        assert not (langs["en"] & langs["ja"]), pair_id


# ---- the split partition ---------------------------------------------------


def test_the_edge_pools_are_disjoint():
    seen: Counter = Counter()
    for pool in EDGE_POOLS.values():
        seen.update(pool)
    shared = [edge for edge, count in seen.items() if count > 1]
    assert not shared, f"an edge in two pools cannot keep its cases in one split: {shared}"


def test_every_draft_declares_a_split_that_owns_its_target_edges():
    for draft in DRAFTS:
        assert draft.split in SPLITS, f"{draft.slug}: {draft.split!r}"
        for step in draft.answer:
            assert step.edge in EDGE_POOLS[draft.split], f"{draft.slug}: {step.edge}"


def test_no_leakage_group_spans_a_split():
    """The guarantee the partition buys, checked against the grouping derived
    from case content rather than against the partition that produced it."""
    from app.services.benchmark_labelling import leakage_groups

    split_of = {case.case_id: case.split for case in BENCHMARK_CASES}
    for group in leakage_groups():
        spans = {split_of[case_id] for case_id in group}
        assert len(spans) == 1, f"{sorted(group)[:4]} spans {sorted(spans)}"


# ---- the severity family agrees with the product's own detector ------------


def _risk_level(text: str) -> str:
    return assess_safety(SafetyAssessmentInput(reflection_id="benchmark", content=text)).risk_level


def test_low_frequency_cases_agree_with_the_safety_detector():
    """A fixture whose declared safety level its own product disagrees with is
    a broken fixture, not a hard case."""
    cases = [case for case in BENCHMARK_CASES if case.family == "low_frequency_high_severity"]
    assert cases

    for case in cases:
        expected = set(case.expected_evidence_ids)
        levels = {
            _risk_level(day.text)
            for day in case.evidence
            if day.evidence_id in expected and day.safety_label != "normal"
        }
        assert case.expected_safety in levels, (
            f"{case.case_id} declares {case.expected_safety!r} but assess_safety "
            f"returns {sorted(levels)} for its labelled targets"
        )


def test_wrong_days_carry_the_crisis_label_too():
    """The defect that retired `crisis_escalation`.

    `benchmark_retrieval` adds +0.45 when a case expects crisis and a day is
    labelled crisis. If only the targets were labelled, the flag WAS the answer
    key and the case measured a method's ability to read the fixture.
    """
    for case in BENCHMARK_CASES:
        if case.expected_safety != "crisis":
            continue
        expected = set(case.expected_evidence_ids)
        decoys_labelled = [
            day
            for day in case.evidence
            if day.evidence_id not in expected and day.safety_label == "crisis"
        ]
        assert decoys_labelled, f"{case.case_id}: the crisis flag is the answer key"
