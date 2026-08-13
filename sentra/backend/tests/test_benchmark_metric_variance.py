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

    @pytest.mark.xfail(
        strict=True,
        reason="#86/#89: no condition separates from the keyword baseline yet — every metric is 1.0",
    )
    def test_every_summary_key_varies(self, result):
        keys = set(result["summary"][METHODS[0]])
        constant = [
            key
            for key in keys
            if len({result["summary"][method][key] for method in METHODS}) == 1
        ]
        assert not constant, f"these summary keys are identical across conditions: {constant}"

    def test_the_saturation_is_total_and_recorded(self, result):
        # Pins the current state so the claim in the PR is checkable and so a
        # partial improvement is visible as a change here rather than passing
        # silently under the xfail above.
        values = {
            metric: {result["summary"][method][metric] for method in METHODS}
            for metric in ("mean_recall_at_k", "mean_ndcg_at_k", "target_hit_rate")
        }
        assert all(observed == {1.0} for observed in values.values()), values
