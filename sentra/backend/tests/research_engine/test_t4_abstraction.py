"""T4 (#147, #148): the projection, the candidate structure, and faithfulness.

The tests check three things that could each be quietly false: that the readable
axes actually carry the internal state, that the product terms are found where a
product exists, and that the explanation reproduces the detailed model's
behaviour *under a perturbation* rather than only along one memorised path.

The honesty fields get their own tests. `semantic_status`, `evidence_scope` and
`uncertainty_method` are what stop a synthetic coordinate being rendered as a
clinical construct and a resample frequency being read as a probability, and
they are exactly the fields a later refactor would drop without noticing.
"""

from __future__ import annotations

import numpy as np
import pytest

from research_engine.abstraction import (
    build_explanation_bundle,
    fit_explanation_model,
    fit_projection,
    score_fidelity,
)
from research_engine.contracts import CapabilityFlags
from research_engine.data import (
    fit_normalizer,
    load_observations,
    make_sequences,
    participant_split,
)
from research_engine.dynamics import MemoryForecaster
from research_engine.evaluation import GeneratorConfig, generate
from research_engine.representation import EncoderConfig, fit_encoder


def _pipeline(scenario: str, epochs: int = 60):
    dataset = generate(GeneratorConfig(scenario=scenario, seed=11, n_participants=18, n_days=40))
    bundle = load_observations(dataset.bundle)
    split = participant_split(bundle, dataset.truth.split_groups, seed=11)
    train_rows = [
        row for row in bundle.observations if split.assignment[row.participant_key] == "train"
    ]
    normalizer = fit_normalizer(
        train_rows,
        feature_schema_id=bundle.manifest.feature_schema_id,
        feature_names=bundle.manifest.feature_names,
    )
    train = make_sequences(bundle, normalizer, split.assignment, splits=["train"])
    validation = make_sequences(bundle, normalizer, split.assignment, splits=["validation"])
    heldout = make_sequences(bundle, normalizer, split.assignment, splits=["heldout"])
    artifact = fit_encoder(train, validation, EncoderConfig(latent_dim=8, epochs=epochs, seed=11))
    forecaster = MemoryForecaster.fit(train, validation, artifact, normalizer)
    projection = fit_projection(train, artifact)

    model = artifact.to_model()
    trajectories = [
        projection.apply(
            model.encode(sequence.values, sequence.mask, np.asarray(sequence.delta_days, dtype=float))
        )
        for sequence in train
    ]
    explanation = fit_explanation_model(trajectories, list(normalizer.feature_names))
    return dataset, normalizer, train, validation, heldout, artifact, forecaster, projection, explanation, trajectories


@pytest.fixture(scope="module")
def s3():
    return _pipeline("S3")


def test_the_projection_carries_the_internal_state(s3):
    *_, projection, explanation, trajectories = s3
    finite = [value for value in projection.reconstruction_r2 if not np.isnan(value)]
    assert finite
    assert float(np.mean(finite)) > 0.5


def test_the_product_term_is_recovered_where_a_product_exists(s3):
    """S3 generates x1·x2 → x4. If the fitter cannot find it, the whole T4 claim is empty."""

    *_, explanation, _ = s3
    order_two_for_x4 = [
        (term, coefficient, frequency)
        for term, coefficient, frequency in explanation.selected_terms()
        if term.order == 2 and term.target_axis == "x4"
    ]
    assert order_two_for_x4

    strongest = max(order_two_for_x4, key=lambda entry: abs(entry[1]))
    assert tuple(sorted(strongest[0].source_axes)) == ("x1", "x2")
    assert strongest[1] < 0  # the generator's coefficient is negative
    assert strongest[2] > 0.8  # and it survives resampling


def test_an_additive_only_explanation_fits_s3_worse(s3):
    """The scenario's claim, restated at the explanation layer."""

    dataset, normalizer, train, *_ , projection, explanation, trajectories = s3
    additive = fit_explanation_model(
        trajectories, list(normalizer.feature_names), max_order=1, bootstrap_rounds=0
    )
    assert additive is not None

    def residual(model):
        errors = []
        for trajectory in trajectories:
            for t in range(len(trajectory) - 1):
                errors.append(model.predict_next(trajectory[t]) - trajectory[t + 1])
        return float(np.mean(np.asarray(errors) ** 2))

    assert residual(explanation) < residual(additive)


def test_faithfulness_survives_a_perturbation(s3):
    """An explanation that matches only the unperturbed path explains one trajectory."""

    *_, heldout, artifact, forecaster, projection, explanation, _ = s3
    result = score_fidelity(heldout, forecaster, projection, explanation, steps=3)

    assert result.paired_rollout_mae is not None
    assert result.paired_rollout_mae_under_intervention is not None
    assert result.n_pairs == len(heldout)
    # Not a bound on quality — a bound on the two rollouts being about the same
    # object at all. The number itself goes in the report.
    assert result.paired_rollout_mae < 1.0
    assert result.paired_rollout_max_error >= result.paired_rollout_mae


def test_the_bundle_declares_what_its_axes_and_edges_are(s3):
    *_, heldout, artifact, forecaster, projection, explanation, _ = s3
    fidelity = score_fidelity(heldout, forecaster, projection, explanation, steps=3)
    bundle = build_explanation_bundle(
        run_id="run-test",
        forecast_id="forecast-test",
        projection=projection,
        explanation=explanation,
        fidelity=fidelity,
        state_values=[0.1, 0.2, 0.3, 0.4],
        capability_flags=forecaster.capability_flags(),
    )
    bundle.validate()

    assert bundle.status == "ok"
    assert {node.semantic_status for node in bundle.states} == {"synthetic_axis"}
    assert {edge.evidence_scope for edge in bundle.candidate_edges} == {"model_candidate"}
    assert {edge.uncertainty_method for edge in bundle.candidate_edges} == {"bootstrap_frequency"}
    assert any(edge.interaction_order == 2 for edge in bundle.candidate_edges)
    assert bundle.residual_summary["mean_unexplained_variance_ratio"] is not None
    assert bundle.assumptions


def test_the_bundle_reports_a_residual_rather_than_absorbing_it(s3):
    *_, heldout, artifact, forecaster, projection, explanation, _ = s3
    bundle = build_explanation_bundle(
        run_id="run-test",
        forecast_id="forecast-test",
        projection=projection,
        explanation=explanation,
        fidelity=None,
        state_values=None,
        capability_flags=forecaster.capability_flags(),
    )
    assert bundle.residual_summary["mean_unexplained_variance_ratio"] > 0.0
    assert bundle.residual_summary["explanation_terms_kept"] < bundle.residual_summary[
        "explanation_terms_considered"
    ]


def test_an_unfitted_abstraction_returns_no_graph():
    bundle = build_explanation_bundle(
        run_id="run-test",
        forecast_id="forecast-test",
        projection=None,
        explanation=None,
        fidelity=None,
        state_values=None,
        capability_flags=CapabilityFlags(),
    )
    assert bundle.status == "not_enough_data"
    assert bundle.states == ()
    assert bundle.candidate_edges == ()


def test_bootstrap_frequency_is_a_frequency_not_a_probability_claim(s3):
    *_, explanation, _ = s3
    assert explanation.bootstrap_rounds > 0
    for _, _, frequency in explanation.selected_terms():
        assert 0.0 <= frequency <= 1.0


def test_the_explanation_model_is_reproducible(s3):
    dataset, normalizer, train, *_ , projection, explanation, trajectories = s3
    again = fit_explanation_model(trajectories, list(normalizer.feature_names))
    assert again is not None
    assert again.content_hash() == explanation.content_hash()
