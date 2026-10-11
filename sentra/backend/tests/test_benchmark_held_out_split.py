"""The held-out split can tell methods apart (2026-10-11 amendment).

Measured before the rebuild, on dataset 0.3.0-dev:

- the test split held 22 cases in **3** independent leakage groups, and one of
  the three consisted only of `fatigue_paraphrase` — a one-hop control the graph
  walk solves from the anchor, so every policy including the random walk scored
  1.000 on the whole group;
- no validation or test case contained a foil (both cases built to be failed
  were in train), so every traversable curated path from an anchor led to the
  answer and `relation_aware` scored 1.000 on all 22 test cases in both
  harnesses — a ceiling a learned policy (#98) could never be shown to beat on
  held-out data;
- the split-level numbers themselves were NOT saturated: validation held 24
  cases, and the random walk scored 0.799 on test. The "6 cases, 2 groups,
  empty validation" state in `sentra/docs/graph_walk_policy.md` is pre-#88.

What is pinned here is the composition the rebuild produced, asserted on the
cases' content rather than on a list of ids, so a later edit that brings any of
it back fails here. The graph-walk numbers come from `app/policy` (read only).
"""

from __future__ import annotations

from collections import defaultdict

import pytest

from app.policy.evaluate import evaluate, evaluate_case
from app.policy.policies import baseline_policies
from app.services.benchmark_cases import BENCHMARK_CASES, DRAFTS
from app.services.benchmark_labelling import assign_splits
from app.services.hf_research_benchmark import _rank_evidence

HELD_OUT = [case for case in BENCHMARK_CASES if case.split == "test"]
DRAFT_BY_SLUG = {draft.slug: draft for draft in DRAFTS}


def _policy(name):
    return next(policy for policy in baseline_policies() if policy.name == name)


def _held_out_groups():
    split = assign_splits()
    return [group for group in split.groups if split.assignment[group[0]] == "test"]


# ---- the splits exist, and the held-out one is more than three items --------


def test_validation_and_test_are_both_filled():
    split = assign_splits()
    assert split.cases_in("validation"), "validation is empty"
    assert split.cases_in("test"), "test is empty"


def test_the_held_out_split_has_at_least_four_independent_groups():
    """The number any held-out claim rests on. It was 3, because one case
    (`heavy_three_target_chain`, then LNS -> SD -> IR -> SW) shared an edge with
    the screen-use cases and two with the irritability cases and fused them."""
    assert len(_held_out_groups()) >= 4


# ---- the random walk does not get full marks --------------------------------


def test_the_random_walk_does_not_score_full_marks_on_the_held_out_split():
    report = evaluate("test")
    assert report.chance is not None
    assert report.chance.ndcg_at_5 < 1.0
    assert report.discriminates is True


def test_no_held_out_group_is_one_the_walk_solves_from_the_anchor():
    """A group in which every case scores 1.0 for the random walk carries no
    information about any policy — and the group, not the case, is the unit of
    held-out evidence. `fatigue_paraphrase` alone was such a group."""
    random_walk = _policy("random")
    by_id = {case.case_id: case for case in HELD_OUT}
    for group in _held_out_groups():
        scores = {case_id: evaluate_case(by_id[case_id], random_walk).ndcg_at_5 for case_id in group}
        assert min(scores.values()) < 1.0, f"the random walk solves this whole group: {scores}"


# ---- the fixed rule is not at a ceiling -------------------------------------


def test_the_fixed_rule_walk_has_headroom_on_the_held_out_split():
    """#98 asks whether a learned policy beats the rule the product ships. On a
    split where that rule scores 1.0 everywhere the answer is fixed at "no"."""
    summary = next(item for item in evaluate("test").summaries if item.policy == "relation_aware")
    assert summary.ndcg_at_5 < 1.0


def test_structure_alone_does_not_separate_the_answer_on_some_held_out_case():
    """Tie-break independent on purpose — see the xfail below.

    Some held-out case must contain a wrong day that `relation_aware` scores at
    least as high as a right one, so that only reading the query can rank them.
    """
    found = []
    for case in HELD_OUT:
        expected = set(case.expected_evidence_ids)
        ranked = _rank_evidence(case, "relation_aware")
        target_floor = min(item["relation_aware_score"] for item in ranked if item["evidence_id"] in expected)
        rivals = [
            item["evidence_id"]
            for item in ranked
            if item["evidence_id"] not in expected and item["relation_aware_score"] >= target_floor
        ]
        if rivals:
            found.append((case.case_id, rivals))
    assert found, "every held-out answer is separable from the graph structure alone"


def test_the_held_out_split_carries_a_case_built_to_be_failed_and_a_protective_edge():
    held_out_drafts = {DRAFT_BY_SLUG[case.pair_id] for case in HELD_OUT}
    assert any(draft.foil for draft in held_out_drafts), "no held-out case contains a foil"

    from app.services.benchmark_cases._build import _curated_edges

    relations = {_curated_edges()[step.edge] for draft in held_out_drafts for step in draft.answer}
    assert "buffers" in relations, "the held-out split asserts only deterioration"


def test_the_one_hop_controls_stay_in_the_held_out_split():
    """The rebuild added structure; it did not remove the control.

    The depth sweep in the analysis plan needs one-hop cases on held-out data
    ("if depth 1 is as good as depth 3, multi-hop traversal is not what is
    helping"), and `tests/test_graph_walk_policy.py` checks the walk's
    saturation warning on the first four of them.
    """
    one_hop = [case for case in HELD_OUT if case.family == "vocab_disjoint" and case.required_hops <= 1]
    assert len(one_hop) >= 4


# ---- a harness defect this area cannot fix ----------------------------------


@pytest.mark.xfail(
    strict=True,
    reason=(
        "hf_research_benchmark._rank_evidence breaks score ties on evidence_id, and the "
        "case's own ids spell the role: c* (target) sorts before d* (decoy) and f* "
        "(foil), so every tie goes to the target. Measured on 0.4.0-dev: graph_pattern "
        "0.3727 as ranked vs 0.3572 with a neutral tie order; relation_aware 1.000 vs "
        "0.984 on test. The fix is a role-neutral tie-break in that file, outside area "
        "3's files. When it lands this test passes and strict=True makes it fail: "
        "delete the marker then."
    ),
)
def test_ranking_ties_do_not_favour_targets_by_name():
    tied_groups = favoured = 0
    for case in BENCHMARK_CASES:
        expected = set(case.expected_evidence_ids)
        for method in ("graph_pattern", "relation_aware", "hf_reranker_candidate"):
            by_score = defaultdict(list)
            for position, item in enumerate(_rank_evidence(case, method)):
                by_score[item["score"]].append((position, item["evidence_id"] in expected))
            for members in by_score.values():
                roles = [is_target for _, is_target in sorted(members)]
                if True in roles and False in roles:
                    tied_groups += 1
                    favoured += roles == sorted(roles, reverse=True)
    assert tied_groups, "no tie mixes targets and non-targets; the check has nothing to measure"
    assert favoured / tied_groups < 0.9, f"{favoured}/{tied_groups} mixed ties put every target first"
