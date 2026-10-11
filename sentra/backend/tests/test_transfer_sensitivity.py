"""#216 — the missingness sensitivity analysis changes what forecasts are scored against, never what they see.

Synthetic data only. The analyses defined for real data (analysis rules,
delta adjustment) are shown to go through the consent gate, which refuses a
real-shaped dataset without its approval record.
"""

from __future__ import annotations

import dataclasses

import pytest

from research_engine.contracts.errors import ContractViolation
from research_engine.transfer.codes import TransferCode
from research_engine.transfer.consent_gate import dataset_from_research_export, export_rows_from_dataset
from research_engine.transfer.forecasting import SPLIT_KINDS, SPLIT_PARTICIPANT, evaluate_dataset
from research_engine.transfer.generator import SyntheticCohortConfig, generate
from research_engine.transfer.plan import DRY_RUN_PLAN, FIT_TARGET_SPLIT, ORIGIN_LAST_OBSERVED
from research_engine.transfer.sensitivity import (
    analysis_rules,
    delta_adjustment,
    missingness_scenarios,
    observed_vs_truth,
)

PLAN = dataclasses.replace(DRY_RUN_PLAN, target_items=("mood", "stress"), bootstrap_rounds=200)
GRID = (("none", 0.0), ("independent", 0.0), ("state_dependent", 2.0))


@pytest.fixture(scope="module")
def cohort():
    return generate(SyntheticCohortConfig(seed=51, missingness="state_dependent", mnar_strength=2.0))


def _predictions(evaluation):
    return {(p.research_code, p.origin_day): dict(p.predictions) for p in evaluation.points}


# --------------------------------------------------------------------------
# Scoring targets change; model inputs do not
# --------------------------------------------------------------------------


def test_a_target_override_does_not_change_any_forecast(cohort) -> None:
    plain = evaluate_dataset(cohort.dataset, PLAN, fit_mode=FIT_TARGET_SPLIT)
    constant = evaluate_dataset(cohort.dataset, PLAN, fit_mode=FIT_TARGET_SPLIT, target_value=lambda *args: 5.0)
    for kind in SPLIT_KINDS:
        before = _predictions(plain["evaluations"][kind]["mood"])
        after = _predictions(constant["evaluations"][kind]["mood"])
        shared = set(before) & set(after)
        assert shared
        assert all(before[key] == after[key] for key in shared)
        assert all(point.actual == 5.0 for point in constant["evaluations"][kind]["mood"].points)


def test_truth_scoring_scores_more_days_with_the_same_forecasts(cohort) -> None:
    result = observed_vs_truth(cohort, PLAN)
    assert result["scope"] == "synthetic_only"
    for kind in SPLIT_KINDS:
        for item in PLAN.target_items:
            observed = result["observed_targets"][kind][item]
            truth = result["truth_targets"][kind][item]
            assert truth["n_points_scored"] > observed["n_points_scored"]
            assert truth["reduction"]["target_missing"] == 0
    assert "合成データにしか計算できず" in result["note_ja"]


# --------------------------------------------------------------------------
# 1. Missingness scenarios
# --------------------------------------------------------------------------


def test_every_seed_and_scenario_is_reported_against_the_complete_reference() -> None:
    result = missingness_scenarios([51, 52], PLAN, GRID)
    assert result["scope"] == "synthetic_only"
    assert result["seeds"] == [51, 52]
    for seed in ("51", "52"):
        payload = result["results"][seed]
        assert payload["reference"] == "none"
        assert set(payload["scenarios"]) == {"none", "independent", "state_dependent-k2"}
        assert payload["scenarios"]["none"]["shift_from_reference"] is None
        reference_points = sum(payload["scenarios"]["none"]["summary"][SPLIT_PARTICIPANT][item]["n_points_scored"] for item in PLAN.target_items)
        for label in ("independent", "state_dependent-k2"):
            scenario = payload["scenarios"][label]
            points = sum(scenario["summary"][SPLIT_PARTICIPANT][item]["n_points_scored"] for item in PLAN.target_items)
            assert points < reference_points
            for kind in SPLIT_KINDS:
                for row in scenario["shift_from_reference"][kind].values():
                    if row["status"] == "ok":
                        assert {"winner_changed", "winner_changed_within_tie_zone", "pair_counts", "difference_shift"} <= set(row)


def test_the_scenarios_differ_only_in_what_went_missing() -> None:
    result = missingness_scenarios([51], PLAN, GRID)
    hashes = {label: values["dataset_hash"] for label, values in result["results"]["51"]["scenarios"].items()}
    assert len(set(hashes.values())) == len(hashes)
    assert "実データの事実ではない" in result["note_ja"]


# --------------------------------------------------------------------------
# 3 and 4. Analysis rules and delta adjustment
# --------------------------------------------------------------------------


def test_analysis_rules_vary_p5_and_p6_around_the_plan(cohort) -> None:
    result = analysis_rules(cohort.dataset, PLAN)
    assert f"origin_rule={ORIGIN_LAST_OBSERVED}" in result["variants"]
    assert f"inclusion_min_submitted_days={PLAN.inclusion_min_submitted_days}" not in result["variants"]
    assert {"inclusion_min_submitted_days=7", "inclusion_min_submitted_days=14"} <= set(result["variants"])
    strict = result["variants"]["inclusion_min_submitted_days=14"]["summary"][SPLIT_PARTICIPANT]["mood"]
    assert strict["reduction"]["below_inclusion_minimum"] > 0
    assert "提案ではない" in result["note_ja"]


def test_delta_adjustment_keeps_observed_targets_and_fills_only_the_rest(cohort) -> None:
    result = delta_adjustment(cohort.dataset, PLAN, deltas=(0.0, -1.0))
    assert result["role"] == "exploratory"
    observed = result["observed_only"][SPLIT_PARTICIPANT]["mood"]
    for label in ("delta=0", "delta=-1"):
        variant = result["variants"][label]["summary"][SPLIT_PARTICIPANT]["mood"]
        assert variant["n_points_scored"] > observed["n_points_scored"]
    assert "識別できない" in result["note_ja"]


def test_the_real_capable_analyses_go_through_the_consent_gate(cohort) -> None:
    real = dataset_from_research_export(export_rows_from_dataset(cohort.dataset), dataset_id="real-shaped")
    for analysis in (analysis_rules, delta_adjustment):
        with pytest.raises(ContractViolation) as caught:
            analysis(real, PLAN)
        assert caught.value.code == TransferCode.APPROVAL_MISSING
