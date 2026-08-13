"""Issue #89 — a benchmark test should fail when the benchmark stops measuring.

The previous assertion was `hf_reranker_candidate >= keyword`. Every condition
scoring exactly 1.0 satisfies it, so the test was green precisely in the state
where the benchmark measured nothing. Green carried no information.
"""

import pytest

from app.services.benchmark_retrieval import METHODS
from app.services.hf_research_benchmark import run_hf_research_benchmark

# ---------------------------------------------------------------------------
# Thresholds. Set from the issue, against the reported chance level, and NOT
# adjusted after seeing the first run — fitting a threshold to a result is the
# thing pre-registration exists to prevent.
#
#   SEPARATION 0.10  — the smallest gap worth calling a difference at this case
#                      count. Chance nDCG@5 is ~0.135, so 0.10 is comparable to
#                      the whole chance level: below it, conditions are within
#                      noise of each other.
#   BASELINE_CEILING 0.60 — a lexical baseline scoring above this means the
#                      cases are answerable by wording, which is the failure
#                      the rebuild in #86 addressed.
#
# LOWERING EITHER IS A BENCHMARK-DESIGN DECISION, NOT A TEST FIX.
# The foreseeable failure is someone hitting a red build near a deadline and
# raising the ceiling to 0.8. If that is genuinely right, it needs a note in
# the pre-registration doc (#90) saying why the benchmark got easier — not a
# quiet edit here.
# ---------------------------------------------------------------------------
SEPARATION = 0.10
BASELINE_CEILING = 0.60


@pytest.fixture(scope="module")
def summary():
    return run_hf_research_benchmark()["summary"]


def test_conditions_separate(summary):
    scores = {method: summary[method]["mean_ndcg_at_k"] for method in METHODS}
    spread = max(scores.values()) - min(scores.values())
    assert spread >= SEPARATION, (
        f"conditions do not separate: spread {spread:.4f} < {SEPARATION} ({scores}). "
        f"The benchmark is not discriminating. Expand difficulty — add "
        f"vocabulary-disjoint targets and lexical decoys — rather than lowering "
        f"this threshold."
    )


def test_lexical_baseline_stays_below_the_ceiling(summary):
    keyword = summary["keyword"]["mean_ndcg_at_k"]
    assert keyword <= BASELINE_CEILING, (
        f"keyword scores {keyword:.4f} > {BASELINE_CEILING}: the cases are answerable "
        f"by wording alone, so nothing downstream of retrieval is being tested. "
        f"Make the targets paraphrases and give the decoys the query's vocabulary. "
        f"Do NOT raise the ceiling — see #90."
    )


def test_the_baseline_is_reported_against_chance(summary):
    # "Better than nothing" has to be visible. A condition at chance is not a
    # weak result, it is no result.
    for method in METHODS:
        assert "chance_ndcg_at_k" in summary[method]
        assert "lift_over_chance" in summary[method]


def test_exact_lexical_matching_does_not_beat_chance_on_this_case_set(summary):
    # Narrowed on 2026-08-13 from ("keyword", "semantic_proxy") to keyword only,
    # and the reason is not that the old form went red.
    #
    # semantic_proxy was redefined in the same change from exact-token Jaccard to
    # character-trigram overlap, because in its old form it produced an IDENTICAL
    # ranking to keyword on all 6 cases — a monotone transform, which is the
    # defect #86 existed to remove. A fuzzy matcher is not "purely lexical" in
    # the sense this assertion was written for: Japanese morphology means
    # related words share characters, so a small lift is expected and is what
    # makes the middle condition informative. It tells us how much is
    # recoverable WITHOUT traversal.
    #
    # keyword is the exact-match floor and the claim still holds there. The
    # ceiling on semantic_proxy is now carried by
    # test_the_graph_conditions_are_the_ones_that_separate.
    # Amendment recorded in docs/benchmark_preregistration.md.
    lift = summary["keyword"]["lift_over_chance"]
    assert lift <= 0.05, (
        f"keyword beats chance by {lift:.4f}. Exact lexical matching should not — "
        f"check whether a target now shares vocabulary with its query."
    )


def test_no_two_conditions_produce_the_same_ranking_on_every_case():
    """An ablation with two identical conditions has fewer arms than it reports.

    This is what caught semantic_proxy: it scored differently from keyword but
    ranked identically, so the summary showed four conditions where three
    existed. Comparing mean scores would not have found it — only the rankings.
    """
    import itertools

    result = run_hf_research_benchmark()
    cases = result["cases"]
    degenerate = []
    for left, right in itertools.combinations(METHODS, 2):
        pairs = zip(cases[left], cases[right])
        if all(a["retrieval_metrics"]["top_k"] == b["retrieval_metrics"]["top_k"] for a, b in pairs):
            degenerate.append(f"{left} == {right}")

    # hf_reranker_candidate is a deterministic placeholder for a cross-encoder
    # that does not exist yet. It differs from graph_pattern only in weights,
    # and on this case set traversal dominates both, so the rankings coincide.
    # Exempted BY NAME with the reason, rather than by relaxing the rule — and
    # it is reported in `condition_independence` so the ablation is never read
    # as four independent arms.
    #
    # `relation_aware` (#96) collapses onto the same ranking for a DIFFERENT and
    # more interesting reason: every chain in the current six cases runs forward
    # from the query anchor and uses one relation type per case, so directed
    # typed traversal reaches exactly what undirected untyped traversal reaches,
    # in the same order. This case set cannot tell the two apart. That is a
    # finding about the cases, not about the implementation —
    # `test_relation_aware_traversal.py` shows the two separating on a case that
    # can discriminate, and #88 is where discriminating cases get added:
    # a distractor reached only against an arrow, and two routes of equal length
    # whose relation types differ.
    known_placeholder = {
        "graph_pattern == hf_reranker_candidate",
        "graph_pattern == relation_aware",
        "relation_aware == hf_reranker_candidate",
    }
    unexpected = [entry for entry in degenerate if entry not in known_placeholder]
    assert not unexpected, (
        f"these conditions rank identically on every case and are not separate "
        f"arms: {unexpected}"
    )


def test_the_graph_conditions_are_the_ones_that_separate(summary):
    # Directional, and able to fail: if traversal stops helping, this fails
    # rather than an inequality quietly passing on ties.
    lexical = max(summary[method]["mean_ndcg_at_k"] for method in ("keyword", "semantic_proxy"))
    graph = min(summary[method]["mean_ndcg_at_k"] for method in ("graph_pattern", "hf_reranker_candidate"))
    assert graph - lexical >= SEPARATION, (
        f"graph conditions ({graph:.4f}) no longer separate from lexical ones "
        f"({lexical:.4f}). Either traversal regressed or the cases became "
        f"lexically answerable."
    )


def test_no_condition_reads_the_answer_key(summary):
    # hf_reranker_candidate used to add +0.10 for being in
    # expected_evidence_ids. Whatever it scored was not retrieval performance.
    import inspect

    from app.services import benchmark_retrieval

    # AST rather than text: the comment recording why the bonus was removed
    # names the field, and a substring check trips on its own explanation.
    import ast

    tree = ast.parse(inspect.getsource(benchmark_retrieval.score_candidate).lstrip())
    names = {node.attr for node in ast.walk(tree) if isinstance(node, ast.Attribute)}
    names |= {node.id for node in ast.walk(tree) if isinstance(node, ast.Name)}
    assert "expected_evidence_ids" not in names, "a condition is reading the answer key again"

    # And the scoring function cannot see the case at all, which is the
    # structural guarantee rather than a check on one field name.
    assert "case" not in inspect.signature(benchmark_retrieval.score_candidate).parameters


def test_preregistration_matches_the_constants_it_registers():
    """A pre-registration nobody checks is a document, not a commitment.

    #90 requires that any deviation is an amendment with a date, never a silent
    edit. This is what makes that enforceable: changing SEPARATION or
    BASELINE_CEILING here without changing the document fails the suite, and
    changing both makes the diff show the document moving too.
    """
    from pathlib import Path

    doc = Path(__file__).resolve().parents[3] / "docs" / "benchmark_preregistration.md"
    assert doc.exists(), f"pre-registration is missing at {doc}"
    text = doc.read_text(encoding="utf-8")

    assert f"**{SEPARATION:.2f}**" in text, (
        f"SEPARATION is {SEPARATION} but the pre-registration does not state it. "
        "Record the change as an amendment with a reason and a date."
    )
    assert f"**{BASELINE_CEILING:.2f}**" in text, (
        f"BASELINE_CEILING is {BASELINE_CEILING} but the pre-registration does not "
        "state it. Record the change as an amendment with a reason and a date."
    )
    assert "## What would falsify the hypothesis" in text
    # The disclosure is the part most likely to be quietly dropped in a tidy-up,
    # and it is the part a judge will ask about.
    assert "Disclosure: what has already been seen" in text


def test_preregistration_fixes_k_to_what_the_harness_uses():
    from pathlib import Path

    from app.services.hf_research_benchmark import TOP_K

    doc = Path(__file__).resolve().parents[3] / "docs" / "benchmark_preregistration.md"
    assert f"| `k` | {TOP_K} |" in doc.read_text(encoding="utf-8"), (
        f"harness runs at k={TOP_K}; the pre-registration fixes a different k"
    )
