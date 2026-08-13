"""Issue #85 — a per-condition column that cannot vary is not a measurement.

`_safety_metrics(case)` was computed outside the method loop and attached to
all four retrieval conditions, so `safety_pass_rate` was one number copied
four times. It appeared in the summary table, and in the consulting write-up,
as one of four metrics "saturated at 1.0".
"""

import pytest

from app.services.hf_research_benchmark import (
    SYNTHETIC_BENCHMARK_CASES,
    _safety_metrics,
    run_hf_research_benchmark,
)

METHODS = ("keyword", "semantic_proxy", "graph_pattern", "hf_reranker_candidate")


@pytest.fixture(scope="module")
def result():
    return run_hf_research_benchmark()


class TestSafetyIsNotReportedPerCondition:
    def test_summary_carries_no_safety_column(self, result):
        for method, metrics in result["summary"].items():
            assert not [key for key in metrics if "safety" in key], f"{method} still reports safety per condition"
            assert not [key for key in metrics if "overreach" in key], method

    def test_per_case_results_carry_no_safety_metrics(self, result):
        for method, cases in result["cases"].items():
            for case in cases:
                assert "safety_metrics" not in case, method

    def test_safety_is_reported_once_at_case_level(self, result):
        case_level = result["case_level_safety"]
        assert set(case_level["cases"]) == {case.case_id for case in SYNTHETIC_BENCHMARK_CASES}
        assert "safety_pass_rate" in case_level
        assert case_level["note"]

    def test_safety_genuinely_cannot_vary_by_condition(self):
        # The reason for the change, asserted rather than assumed: the function
        # takes only the case. If it ever grows a condition parameter, this
        # fails and the decision gets revisited deliberately.
        import inspect

        parameters = inspect.signature(_safety_metrics).parameters
        assert list(parameters) == ["case"]


class TestReportedMetricsCanActuallyDiffer:
    """The rule this fix establishes: everything in `summary` must be *able* to
    differ between conditions.

    Writing this test surfaced something larger than #85. All three remaining
    metrics are also identical across all four conditions — every one of them
    is 1.0. So removing the safety column does not leave three real
    measurements and one fake; it leaves a table where nothing separates the
    conditions at all.

    That is #86 (rebuild the harness so the keyword baseline can lose) and #89
    (assert separation rather than an inequality). The assertion below is
    written the way it should read once those land, and is marked xfail with
    strict=True so it fails loudly the day the harness starts separating — at
    which point the marker comes off. It is not weakened to pass today.
    """

    def test_every_summary_key_varies(self, result):
        # chance is the same for every condition BY CONSTRUCTION — it is the
        # expected score from ranking the same candidate set at random, so it
        # does not depend on the method. That is the opposite of the #85 bug:
        # there, a value that should have varied did not. Here a value that
        # must not vary is being used as the yardstick the others are measured
        # against, so it is exempted by name rather than by a pattern that
        # would also let a real regression through.
        invariant_by_design = {"chance_ndcg_at_k"}
        keys = set(result["summary"][METHODS[0]]) - invariant_by_design
        constant = [
            key
            for key in keys
            if len({result["summary"][method][key] for method in METHODS}) == 1
        ]
        assert not constant, f"these summary keys are identical across conditions: {constant}"

    def test_the_saturation_is_gone(self, result):
        # This test used to pin total saturation — every metric 1.0 for every
        # condition — with the xfail above marking it as the state to escape.
        # #86 rebuilt the harness and #89 added the ceiling, so the assertion
        # is inverted rather than deleted: the history of what this measured
        # is the point.
        values = {
            metric: {result["summary"][method][metric] for method in METHODS}
            for metric in ("mean_recall_at_k", "mean_ndcg_at_k", "target_hit_rate")
        }
        assert not any(observed == {1.0} for observed in values.values()), values
