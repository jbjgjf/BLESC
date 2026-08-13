"""Guards on the #88 labelling scaffolding.

These test the protocol, not the labels — the labels do not exist yet. What can
be checked now is that the protocol cannot quietly produce a benchmark that
grades itself.
"""

import pytest

from app.services.benchmark_cases import BENCHMARK_CASES
from app.services.benchmark_labelling import (
    RaterLabels,
    assign_splits,
    cohens_kappa,
    labelling_status,
    labelling_task,
    leakage_groups,
)


def test_rater_never_sees_the_answer_key():
    for case in BENCHMARK_CASES:
        task = labelling_task(case)
        serialised = repr(task)
        assert "expected_evidence_ids" not in task
        assert "research_note" not in task
        assert "family" not in task
        assert "required_hops" not in task
        # The note text itself names the targets in prose ("only traversal of
        # the curated chain"), so absence of the key alone is not enough.
        assert case.research_note not in serialised


def test_candidate_order_is_not_the_authoring_order():
    """c1..c3 first in every list is a cue, and #86 showed it is one a method
    will happily exploit. A rater is no different."""
    moved = 0
    for case in BENCHMARK_CASES:
        shown = [candidate["evidence_id"] for candidate in labelling_task(case)["candidates"]]
        if shown != [day.evidence_id for day in case.evidence]:
            moved += 1
    assert moved == len(BENCHMARK_CASES)


def test_candidate_order_is_stable_across_calls():
    """Two raters must see the same order, or disagreement about position is
    recorded as disagreement about the cases."""
    for case in BENCHMARK_CASES:
        first = [candidate["evidence_id"] for candidate in labelling_task(case)["candidates"]]
        second = [candidate["evidence_id"] for candidate in labelling_task(case)["candidates"]]
        assert first == second


def test_matched_language_pairs_share_a_leakage_group():
    groups = leakage_groups()
    for pair in (("sleep_chain_en", "sleep_chain_ja"), ("vocab_disjoint_en", "vocab_disjoint_ja")):
        assert any(set(pair) <= set(group) for group in groups), f"{pair} would be split across sets"


def test_red_herring_groups_with_the_case_whose_targets_it_contains():
    """chain_red_herring_en carries c1..c3 verbatim as distractors. Training on
    it and testing on sleep_chain_en would be testing on seen text."""
    groups = leakage_groups()
    assert any({"chain_red_herring_en", "sleep_chain_en"} <= set(group) for group in groups)


def test_decoy_sharing_does_not_collapse_every_case_into_one_group():
    """Decoys are generated from a shared word list and are identical across
    cases. Linking on them would make the guard vacuous by grouping everything."""
    assert len(leakage_groups()) > 1


def test_split_shortage_is_reported_rather_than_silently_filled():
    result = assign_splits()
    assert result.warnings, "an unfillable split must surface, not resolve to an empty list quietly"
    assert any("validation" in warning for warning in result.warnings)


def test_no_case_appears_in_two_splits():
    result = assign_splits()
    seen = [case_id for split in ("train", "validation", "test") for case_id in result.cases_in(split)]
    assert len(seen) == len(set(seen))


def test_kappa_reports_undefined_rather_than_zero_when_chance_agreement_saturates():
    """Both raters selecting nothing is 100% observed agreement and ~100%
    chance agreement. Returning 0.0 would read as 'the raters disagreed'."""
    empty = {case.case_id: set() for case in BENCHMARK_CASES}
    result = cohens_kappa(RaterLabels("a", empty), RaterLabels("b", dict(empty)))
    assert result.kappa is None
    assert result.is_defined is False
    assert result.observed_agreement == 1.0
    assert not result.meets_threshold


def test_kappa_ignores_cases_only_one_rater_labelled():
    """Treating an unlabelled case as 'selected nothing' manufactures agreement
    out of work that was never done."""
    full = {case.case_id: set(case.expected_evidence_ids) for case in BENCHMARK_CASES}
    partial = {BENCHMARK_CASES[0].case_id: set(BENCHMARK_CASES[0].expected_evidence_ids)}
    result = cohens_kappa(RaterLabels("a", full), RaterLabels("b", partial))
    assert result.judgements == len(BENCHMARK_CASES[0].evidence)


def test_no_agreement_computed_when_raters_share_no_case():
    result = cohens_kappa(RaterLabels("a", {}), RaterLabels("b", {}))
    assert result.is_defined is False
    assert result.judgements == 0


def test_status_admits_the_labels_are_not_human():
    status = labelling_status()
    assert status["human_labelled_count"] == 0
    assert status["inter_rater_agreement"] is None
    assert "not yet performed" in status["dataset"]["labelling_status"]
    assert status["dataset"]["reviewer"] is None
    # The count that limits any held-out claim is the group count, and it must
    # not be reported as the case count.
    assert status["independent_group_count"] < status["case_count"]
