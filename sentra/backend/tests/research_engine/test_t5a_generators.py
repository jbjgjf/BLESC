"""T5a (#149): each scenario actually exposes the failure it is named for.

A synthetic scenario that does not discriminate is worse than none — it produces
a table of near-identical numbers that reads like agreement. So every scenario
here is tested for the *gap* it is supposed to create, using least squares
directly rather than the engine's own models, so the check does not pass merely
because our model and our generator share an assumption.
"""

from __future__ import annotations

import numpy as np
import pytest

from research_engine.contracts import Code, ContractViolation
from research_engine.evaluation import SCENARIOS, GeneratorConfig, generate, generate_all


def _series(dataset, participant_key):
    rows = [row for row in dataset.bundle.observations if row.participant_key == participant_key]
    rows.sort(key=lambda row: row.available_at)
    return np.asarray([[np.nan if value is None else value for value in row.values] for row in rows])


def _residual_variance(design: np.ndarray, target: np.ndarray) -> float:
    design = np.column_stack([design, np.ones(len(design))])
    coefficients, *_ = np.linalg.lstsq(design, target, rcond=None)
    return float(np.mean((target - design @ coefficients) ** 2))


@pytest.mark.parametrize("scenario", SCENARIOS)
def test_every_scenario_produces_a_valid_bundle(scenario):
    dataset = generate(GeneratorConfig(scenario=scenario, n_participants=6, n_days=25))
    dataset.bundle.validate()
    assert dataset.bundle.manifest.permitted_uses == ("synthetic_training", "synthetic_evaluation")
    assert all(row.source_kind == "synthetic" for row in dataset.bundle.observations)


@pytest.mark.parametrize("scenario", SCENARIOS)
def test_generation_is_reproducible_and_seed_sensitive(scenario):
    first = generate(GeneratorConfig(scenario=scenario, seed=11, n_participants=4, n_days=15))
    again = generate(GeneratorConfig(scenario=scenario, seed=11, n_participants=4, n_days=15))
    other = generate(GeneratorConfig(scenario=scenario, seed=12, n_participants=4, n_days=15))
    assert first.bundle.content_hash() == again.bundle.content_hash()
    assert first.bundle.content_hash() != other.bundle.content_hash()


def test_s1_is_well_predicted_by_a_linear_model():
    """S1 exists so that a complex model beating a linear one there is suspicious."""

    dataset = generate(GeneratorConfig(scenario="S1", n_participants=10, n_days=60))
    rows = []
    for key in dataset.bundle.participants:
        series = _series(dataset, key)
        rows.append((series[:-1], series[1:]))
    design = np.vstack([pair[0] for pair in rows])
    target = np.vstack([pair[1] for pair in rows])

    linear_residual = _residual_variance(design, target[:, 0])
    persistence_residual = float(np.mean((target[:, 0] - design[:, 0]) ** 2))

    # The floor is set by the generator, not chosen to be passed: process noise
    # plus observation noise is what no model can predict away.
    config = dataset.config
    floor = config.innovation_scale ** 2 + config.noise_scale ** 2

    assert linear_residual < 0.85 * persistence_residual
    assert linear_residual < 1.3 * floor, (linear_residual, floor)


def _same_present_correlation(scenario: str) -> float:
    """The S2 statistic, computed on another scenario as a control.

    A test that only checks S2 cannot tell a real memory effect from a statistic
    that is large everywhere. S1 has no long memory, so the same measurement
    there is the null this compares against.
    """

    dataset = generate(GeneratorConfig(scenario=scenario, n_participants=14, n_days=90))
    current, window_mean, nxt = [], [], []
    for key in dataset.bundle.participants:
        series = _series(dataset, key)[:, 0]
        for t in range(5, len(series) - 1):
            current.append(series[t])
            window_mean.append(float(np.mean(series[t - 4 : t + 1])))
            nxt.append(series[t + 1])
    current = np.asarray(current)
    order = np.argsort(current)
    current = current[order]
    window_mean = np.asarray(window_mean)[order]
    target = np.asarray(nxt)[order]
    near = np.abs(np.diff(current)) < 0.02
    return abs(float(np.corrcoef(np.diff(window_mean)[near], np.diff(target)[near])[0, 1]))


def test_s2_futures_differ_for_the_same_present_value():
    """The scenario's claim, tested as stated rather than through a model.

    Take pairs of moments whose *current* value is nearly identical. If only the
    present mattered, their next values would differ only by noise and would be
    uncorrelated with anything else. They are in fact strongly correlated with
    the difference in the two histories, which is what a memoryless model has no
    way to represent.
    """

    dataset = generate(GeneratorConfig(scenario="S2", n_participants=14, n_days=90))
    current, window_mean, nxt = [], [], []
    for key in dataset.bundle.participants:
        series = _series(dataset, key)[:, 0]
        for t in range(5, len(series) - 1):
            current.append(series[t])
            window_mean.append(float(np.mean(series[t - 4 : t + 1])))
            nxt.append(series[t + 1])

    current = np.asarray(current)
    window_mean = np.asarray(window_mean)
    target = np.asarray(nxt)

    order = np.argsort(current)
    current, window_mean, target = current[order], window_mean[order], target[order]
    near = np.abs(np.diff(current)) < 0.02
    assert near.sum() > 200, f"too few near-equal present values: {near.sum()}"

    history_gap = np.diff(window_mean)[near]
    future_gap = np.diff(target)[near]
    correlation = float(np.corrcoef(history_gap, future_gap)[0, 1])

    # The threshold is a floor well below the observed value, not a tracked
    # number: what it has to separate is "history predicts the difference" from
    # "it does not". The S1 control below is what gives it meaning.
    assert correlation > 0.35, correlation
    assert correlation > 3 * _same_present_correlation("S1"), correlation

    # And the residual does drop once history is available.
    memoryless = _residual_variance(current[:, None], target)
    with_memory = _residual_variance(np.column_stack([current, window_mean]), target)
    assert with_memory < 0.85 * memoryless, (memoryless, with_memory)


def test_s3_needs_the_product_term():
    dataset = generate(GeneratorConfig(scenario="S3", n_participants=12, n_days=80))
    x1, x2, target = [], [], []
    for key in dataset.bundle.participants:
        series = _series(dataset, key)
        x1.extend(series[:-1, 0])
        x2.extend(series[:-1, 1])
        target.extend(series[1:, 3] - 0.20 * series[:-1, 3])

    x1 = np.asarray(x1)
    x2 = np.asarray(x2)
    target = np.asarray(target)

    additive = _residual_variance(np.column_stack([x1, x2]), target)
    with_product = _residual_variance(np.column_stack([x1, x2, x1 * x2]), target)

    assert with_product < 0.6 * additive, (additive, with_product)


def test_s4_has_masked_values_and_real_gaps():
    dataset = generate(GeneratorConfig(scenario="S4", n_participants=8, n_days=40))
    masked = sum(
        1
        for row in dataset.bundle.observations
        for flag in row.observed_mask
        if not flag
    )
    assert masked > 0
    for row in dataset.bundle.observations:
        for value, flag in zip(row.values, row.observed_mask):
            assert (value is None) == (not flag)

    days = {}
    for row in dataset.bundle.observations:
        days.setdefault(row.participant_key, []).append(row.available_at)
    gaps = {
        (later - earlier).days
        for times in days.values()
        for earlier, later in zip(sorted(times), sorted(times)[1:])
    }
    assert gaps - {1}, "S4 must contain gaps longer than a day"


def test_s5_correlates_x1_and_x2_without_an_edge_between_them():
    """The trap: a lag-1 fitter will want to draw x1 → x2. The truth has no such edge."""

    dataset = generate(GeneratorConfig(scenario="S5", n_participants=12, n_days=80))
    earlier, later = [], []
    for key in dataset.bundle.participants:
        series = _series(dataset, key)
        earlier.extend(series[:-1, 0])
        later.extend(series[1:, 1])

    correlation = float(np.corrcoef(earlier, later)[0, 1])
    assert abs(correlation) > 0.3, correlation

    observed_edges = {
        (edge.source_names, edge.target_name) for edge in dataset.truth.true_edges
    }
    assert (("x1",), "x2") not in observed_edges
    assert (("x2",), "x1") not in observed_edges


def test_s2_structure_is_declared_undefined_with_a_reason():
    """Grading against a truth the model cannot express produces a meaningless number."""

    dataset = generate(GeneratorConfig(scenario="S2", n_participants=4, n_days=20))
    assert dataset.truth.structure_defined is False
    assert dataset.truth.structure_undefined_reason_ja


def test_sealed_latents_are_not_in_the_bundle():
    """S5's driver is the thing a learner must not receive."""

    dataset = generate(GeneratorConfig(scenario="S5", n_participants=6, n_days=30))
    emitted = {
        round(float(value), 9)
        for row in dataset.bundle.observations
        for value in row.values
        if value is not None
    }
    latent_values = {
        round(float(row[0]), 9)
        for series in dataset.truth.latent_values.values()
        for row in series
    }
    assert not (emitted & latent_values)
    assert len(dataset.bundle.manifest.feature_names) == 4


def test_s2_pairs_share_a_split_group():
    dataset = generate(GeneratorConfig(scenario="S2", n_participants=6, n_days=15))
    groups = dataset.truth.split_groups
    assert groups["s2-p000"] == groups["s2-p001"]
    assert groups["s2-p000"] != groups["s2-p002"]


def test_unknown_scenario_is_refused():
    with pytest.raises(ValueError):
        generate(GeneratorConfig(scenario="S9"))


def test_generate_all_covers_the_day_three_minimum():
    datasets = generate_all(seed=11, n_participants=4, n_days=12)
    assert set(datasets) == set(SCENARIOS)
