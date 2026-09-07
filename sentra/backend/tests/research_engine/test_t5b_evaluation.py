"""T5b (#150): the report, the sealed ledger and the checks that can go red.

An evaluation suite that only tests the happy path certifies that the code runs,
not that it detects anything. So half of these tests break something on purpose
— refit the normaliser on everything, edit a sealed forecast, hand the evaluator
a scenario with no expressible truth — and require the report to say so.
"""

from __future__ import annotations

import dataclasses
import json
from pathlib import Path

import numpy as np
import pytest

from research_engine.contracts import EvaluationReport
from research_engine.data import fit_normalizer, load_observations, participant_split
from research_engine.evaluation import GeneratorConfig, generate
from research_engine.evaluation import leakage as leakage_checks
from research_engine.evaluation.ledger import PredictionLedger, input_hash_for
from research_engine.evaluation.metrics import Prediction, mae, structure_metrics
from research_engine.pipeline import RunConfig, run_pipeline

CI_CONFIG = RunConfig(
    config_id="research-test-v0",
    scenarios=("S1", "S2"),
    seeds=(11,),
    n_participants=12,
    n_days=25,
    latent_dim=6,
    epochs=25,
    horizons=(1, 2),
    bootstrap_rounds=8,
    fidelity_steps=2,
)


@pytest.fixture(scope="module")
def run(tmp_path_factory):
    out = tmp_path_factory.mktemp("run")
    return run_pipeline(CI_CONFIG, out)


def test_the_report_validates_and_carries_the_required_hashes(run):
    report = run.report
    report.validate()
    for key in ("dataset_hash", "split_hash", "config_hash", "model_hash"):
        assert report.artifact_hashes[key].startswith("sha256:")
    assert report.reproducibility_command
    assert report.status == "ok"


def test_baselines_and_the_new_model_appear_in_the_same_table(run):
    """The comparison requirement: same report, same units, same targets."""

    models = {metric.model_id for metric in run.report.metrics if metric.name == "mae"}
    assert {"persistence", "train_mean", "linear_ar", "memory_gru"} <= models
    units = {metric.unit for metric in run.report.metrics if metric.name == "mae"}
    assert units == {"simulation_unit"}


def test_a_worse_result_is_reported_rather_than_dropped(run):
    """Whatever the ordering turns out to be, every model's number is present."""

    by_model = {
        metric.model_id: metric.value for metric in run.report.metrics if metric.name == "mae"
    }
    assert all(value is not None for value in by_model.values())
    assert len(by_model) == 4


def test_every_leakage_check_ran_and_passed(run):
    names = {check.name for check in run.report.leakage_checks}
    assert names >= {
        "available_at_le_cutoff",
        "future_row_must_fail",
        "split_group_disjoint",
        "normalizer_fit_on_train_only",
        "no_smoothing_in_online_evaluation",
        "sealed_predictions_unchanged",
    }
    assert all(check.checked_items is not None for check in run.report.leakage_checks)
    assert not run.report.failed_leakage_checks


def test_the_normalizer_check_goes_red_when_it_is_fitted_on_everything():
    """The check has to be able to fail, or its green is worthless."""

    dataset = generate(GeneratorConfig(scenario="S1", seed=11, n_participants=12, n_days=20))
    bundle = load_observations(dataset.bundle)
    split = participant_split(bundle, dataset.truth.split_groups, seed=11)
    train_ids = [
        row.event_id
        for row in bundle.observations
        if split.assignment[row.participant_key] == "train"
    ]

    leaked = fit_normalizer(
        bundle.observations,
        feature_schema_id=bundle.manifest.feature_schema_id,
        feature_names=bundle.manifest.feature_names,
    )
    check = leakage_checks.normalizer_was_fitted_on_train_only(leaked, train_ids)
    assert check.passed is False
    assert "heldout" in check.detail_ja


def test_the_future_row_check_actually_runs_the_negative_case():
    dataset = generate(GeneratorConfig(scenario="S1", seed=11, n_participants=6, n_days=15))
    bundle = load_observations(dataset.bundle)
    check = leakage_checks.future_row_is_refused(bundle)
    assert check.passed is True
    assert check.checked_items == 1


def test_editing_a_sealed_forecast_is_detected(tmp_path):
    """The seal exists so that "the prediction did not change" is checkable."""

    from datetime import timedelta

    from research_engine.data import fit_normalizer, make_sequences
    from research_engine.dynamics import PersistenceForecaster, build_context

    dataset = generate(GeneratorConfig(scenario="S1", seed=11, n_participants=9, n_days=20))
    bundle = load_observations(dataset.bundle)
    split = participant_split(bundle, dataset.truth.split_groups, seed=11)
    normalizer = fit_normalizer(
        bundle.observations,
        feature_schema_id=bundle.manifest.feature_schema_id,
        feature_names=bundle.manifest.feature_names,
    )
    sequences = make_sequences(bundle, normalizer, split.assignment)
    context = build_context(
        run_id="run-seal",
        dataset_id=bundle.manifest.dataset_id,
        split_id=split.split_id,
        sequence=sequences[0],
        normalizer=normalizer,
        cutoff_at=sequences[0].available_times[5],
        horizons=(1, 2),
    )
    model = PersistenceForecaster()
    forecast = model.forecast(context)

    ledger = PredictionLedger(tmp_path / "predictions.jsonl")
    ledger.append(
        forecast,
        input_hash=input_hash_for(context.sequence.event_ids, context.cutoff_at),
        model_hash=model.model_hash(),
    )

    assert ledger.verify_unchanged([forecast]) == []

    improved = dataclasses.replace(
        forecast, means=tuple(tuple(value + 0.01 for value in row) for row in forecast.means)
    )
    assert ledger.verify_unchanged([improved]) == [forecast.forecast_id]

    check = leakage_checks.predictions_were_sealed(ledger, [improved])
    assert check.passed is False


def test_structure_is_unsupported_where_the_truth_is_inexpressible(run):
    """S2's five-day dependence has no single-lag representation. Null, not a bad score."""

    names = {
        (metric.name, metric.status)
        for metric in run.report.unsupported_metrics
        if metric.name.startswith("edge_")
    }
    assert ("edge_f1", "unsupported") in names
    reasons = [
        metric.reason_ja for metric in run.report.unsupported_metrics if metric.name == "edge_f1"
    ]
    assert reasons and "移動平均" in reasons[0]


def test_coverage_is_unsupported_for_deterministic_models(run):
    unsupported = {
        (metric.name, metric.model_id)
        for metric in run.report.unsupported_metrics
        if metric.name.startswith("interval_")
    }
    assert ("interval_coverage_90", "persistence") in unsupported
    assert ("interval_coverage_90", "linear_ar") in unsupported

    reported = {
        (metric.name, metric.model_id)
        for metric in run.report.metrics
        if metric.name.startswith("interval_")
    }
    assert ("interval_coverage_90", "memory_gru") in reported
    assert ("interval_width_90", "memory_gru") in reported


def test_structure_metrics_refuse_an_undefined_truth():
    metrics = structure_metrics(
        [(("x1",), "x2", 0.4)],
        [],
        "model",
        structure_defined=False,
        undefined_reason_ja="このシナリオでは真の構造が定義されない。",
    )
    assert {metric.status for metric in metrics} == {"unsupported"}
    assert all(metric.value is None for metric in metrics)


def test_metrics_are_averaged_per_participant_not_per_prediction():
    """One prolific participant must not dominate the mean."""

    predictions = [
        Prediction("loud", "m", "S1", 1.0, "x1", 10.0, 0.0, None) for _ in range(50)
    ] + [Prediction("quiet", "m", "S1", 1.0, "x1", 1.0, 0.0, None)]

    metric = mae(predictions, "m")
    assert metric.value == pytest.approx(5.5)  # (10 + 1) / 2, not (50*10 + 1) / 51
    assert metric.n_participants == 2
    assert metric.n_predictions == 51


def test_usage_records_zero_provider_calls_as_a_fact(run):
    usage = run.report.measured_usage
    assert usage.provider_calls == 0
    assert usage.input_tokens == 0
    assert usage.elapsed_seconds is not None
    assert "cpu-only" in usage.compute_environment


def test_the_run_directory_holds_everything_needed_to_re_read_it(run):
    files = {path.name for path in Path(run.run_dir).iterdir()}
    assert {"report.json", "explanations.json", "predictions.jsonl", "run_config.json"} <= files

    report = EvaluationReport.from_dict(
        json.loads((Path(run.run_dir) / "report.json").read_text(encoding="utf-8"))
    )
    assert report.run_id == run.run_id

    ledger = PredictionLedger(Path(run.run_dir) / "predictions.jsonl")
    entries = ledger.entries()
    assert entries
    assert {entry.evaluation_mode for entry in entries} == {"historical_simulation"}


def test_the_same_configuration_reproduces_the_same_numbers(tmp_path):
    first = run_pipeline(CI_CONFIG, tmp_path / "a")
    second = run_pipeline(CI_CONFIG, tmp_path / "b")

    def numbers(result):
        return [
            (metric.name, metric.model_id, metric.value) for metric in result.report.metrics
        ]

    assert numbers(first) == numbers(second)
    assert first.report.artifact_hashes["model_hash"] == second.report.artifact_hashes["model_hash"]
    assert first.run_id == second.run_id
