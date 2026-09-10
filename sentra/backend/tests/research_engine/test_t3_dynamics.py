"""T3 (#145, #146): baselines, the memory model, and rollout inside the model.

The claim under test is comparative, so the tests are comparative: the memory
model has to beat persistence on the scenario built to need memory, and every
model has to produce the same bundle shape so that comparison is meaningful in
the first place. The rollout tests are about refusals — an unknown model-internal
operation must fail rather than be dropped, because a dropped operation means
reporting a counterfactual that was never applied.
"""

from __future__ import annotations

from datetime import timedelta

import numpy as np
import pytest

from research_engine.contracts import Code, ContractViolation
from research_engine.data import (
    fit_normalizer,
    load_observations,
    make_sequences,
    participant_split,
)
from research_engine.dynamics import (
    LinearARForecaster,
    MemoryForecaster,
    PersistenceForecaster,
    TrainMeanForecaster,
    build_context,
)
from research_engine.evaluation import GeneratorConfig, generate
from research_engine.representation import EncoderConfig, fit_encoder

HORIZONS = (1, 2, 3)


def _fitted(scenario: str, epochs: int = 60, n_participants: int = 18, n_days: int = 40):
    dataset = generate(
        GeneratorConfig(scenario=scenario, seed=11, n_participants=n_participants, n_days=n_days)
    )
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
    models = {
        "persistence": PersistenceForecaster(),
        "train_mean": TrainMeanForecaster.fit(train),
        "linear_ar": LinearARForecaster.fit(train),
        "memory_gru": MemoryForecaster.fit(train, validation, artifact, normalizer),
    }
    return dataset, bundle, split, normalizer, train, validation, heldout, artifact, models


@pytest.fixture(scope="module")
def s2():
    return _fitted("S2")


def _context(bundle, split, normalizer, sequence, fraction=0.7):
    index = max(1, int(sequence.length * fraction))
    return index, build_context(
        run_id="run-test",
        dataset_id=bundle.manifest.dataset_id,
        split_id=split.split_id,
        sequence=sequence,
        normalizer=normalizer,
        cutoff_at=sequence.available_times[index],
        horizons=HORIZONS,
    )


def _mean_absolute_error(models, bundle, split, normalizer, heldout, name, artifact):
    errors = []
    for sequence in heldout:
        index, context = _context(bundle, split, normalizer, sequence)
        forecast = models[name].forecast(context, encoder_id=artifact.encoder_id)
        if forecast.status != "ok":
            continue
        for h_index, horizon in enumerate(HORIZONS):
            target = index + horizon
            if target >= sequence.length:
                continue
            predicted = np.asarray(forecast.means[h_index])
            actual = sequence.raw_values[target]
            observed = sequence.mask[target]
            errors.extend(np.abs(predicted - actual)[observed])
    return float(np.mean(errors))


def test_every_forecaster_emits_the_same_bundle_shape(s2):
    dataset, bundle, split, normalizer, train, validation, heldout, artifact, models = s2
    _, context = _context(bundle, split, normalizer, heldout[0])

    for name, model in models.items():
        forecast = model.forecast(context, encoder_id=artifact.encoder_id)
        forecast.validate()
        assert forecast.status == "ok", (name, forecast.reasons)
        assert forecast.target_names == context.feature_names
        assert forecast.target_units == tuple("simulation_unit" for _ in context.feature_names)
        assert len(forecast.means) == len(HORIZONS)
        assert all(time > forecast.cutoff_at for time in forecast.target_times)


def test_deterministic_baselines_do_not_invent_uncertainty(s2):
    dataset, bundle, split, normalizer, train, validation, heldout, artifact, models = s2
    _, context = _context(bundle, split, normalizer, heldout[0])

    for name in ("persistence", "train_mean", "linear_ar"):
        forecast = models[name].forecast(context)
        assert forecast.distribution_method == "deterministic"
        assert forecast.scales_or_samples is None


def test_the_memory_model_reports_a_measured_spread_but_not_calibration(s2):
    dataset, bundle, split, normalizer, train, validation, heldout, artifact, models = s2
    _, context = _context(bundle, split, normalizer, heldout[0])

    forecast = models["memory_gru"].forecast(context, encoder_id=artifact.encoder_id)
    assert forecast.distribution_method == "gaussian_diag"
    scales = np.asarray(forecast.scales_or_samples, dtype=float)
    assert scales.shape == (len(HORIZONS), len(context.feature_names))
    assert (scales >= 0).all()
    assert forecast.capability_flags.calibrated_uncertainty is False


def test_uncertainty_widens_with_the_horizon(s2):
    """A three-step rollout is less certain than a one-step one, and says so."""

    dataset, bundle, split, normalizer, train, validation, heldout, artifact, models = s2
    _, context = _context(bundle, split, normalizer, heldout[0])
    forecast = models["memory_gru"].forecast(context, encoder_id=artifact.encoder_id)
    scales = np.asarray(forecast.scales_or_samples, dtype=float)
    assert scales[-1].mean() > scales[0].mean()


def test_the_memory_model_beats_persistence_where_memory_is_needed(s2):
    """S2's whole purpose. If this fails, the memory is decorative."""

    dataset, bundle, split, normalizer, train, validation, heldout, artifact, models = s2
    memory = _mean_absolute_error(models, bundle, split, normalizer, heldout, "memory_gru", artifact)
    persistence = _mean_absolute_error(
        models, bundle, split, normalizer, heldout, "persistence", artifact
    )
    assert memory < persistence, (memory, persistence)


def test_linear_ar_wins_on_the_scenario_built_for_it():
    """S1 exists so that a complex model beating it there is a reason to look harder."""

    dataset, bundle, split, normalizer, train, validation, heldout, artifact, models = _fitted("S1")
    linear = _mean_absolute_error(models, bundle, split, normalizer, heldout, "linear_ar", artifact)
    persistence = _mean_absolute_error(
        models, bundle, split, normalizer, heldout, "persistence", artifact
    )
    assert linear < persistence


def test_no_visible_history_produces_a_refusal_not_a_number(s2):
    dataset, bundle, split, normalizer, train, validation, heldout, artifact, models = s2
    sequence = heldout[0]
    context = build_context(
        run_id="run-test",
        dataset_id=bundle.manifest.dataset_id,
        split_id=split.split_id,
        sequence=sequence,
        normalizer=normalizer,
        cutoff_at=sequence.available_times[0] - timedelta(days=1),
        horizons=HORIZONS,
    )
    for name, model in models.items():
        forecast = model.forecast(context, encoder_id=artifact.encoder_id)
        assert forecast.status == "not_enough_data", name
        assert forecast.means == ()
        assert forecast.reasons


def test_forecast_id_is_stable_per_model_and_differs_between_models(s2):
    dataset, bundle, split, normalizer, train, validation, heldout, artifact, models = s2
    _, context = _context(bundle, split, normalizer, heldout[0])

    ids = {}
    for name, model in models.items():
        first = model.forecast(context, encoder_id=artifact.encoder_id).forecast_id
        again = model.forecast(context, encoder_id=artifact.encoder_id).forecast_id
        assert first == again, name
        ids[name] = first
    assert len(set(ids.values())) == len(ids)


def test_a_model_internal_intervention_changes_the_trajectory(s2):
    dataset, bundle, split, normalizer, train, validation, heldout, artifact, models = s2
    memory = models["memory_gru"]
    sequence = heldout[0]

    plain = memory.rollout(sequence, steps=4)
    shifted = memory.rollout(
        sequence,
        steps=4,
        interventions=[{"name": "shift_feature", "feature": "x1", "delta": 1.5, "step": 0}],
    )

    assert plain[0].predicted_values != shifted[0].predicted_values
    assert shifted[0].predicted_values[0] > plain[0].predicted_values[0]
    # And the effect propagates, because the intervened value is fed back in.
    assert plain[2].predicted_values != shifted[2].predicted_values


def test_an_unknown_intervention_is_refused_not_ignored(s2):
    dataset, bundle, split, normalizer, train, validation, heldout, artifact, models = s2
    with pytest.raises(ContractViolation) as caught:
        models["memory_gru"].rollout(
            heldout[0], steps=2, interventions=[{"name": "cure_the_participant"}]
        )
    assert caught.value.code == Code.UNSUPPORTED_INTERVENTION


def test_an_unknown_feature_name_is_refused(s2):
    dataset, bundle, split, normalizer, train, validation, heldout, artifact, models = s2
    with pytest.raises(ContractViolation) as caught:
        models["memory_gru"].rollout(
            heldout[0],
            steps=2,
            interventions=[{"name": "set_feature", "feature": "sleep_quality", "value": 1.0}],
        )
    assert caught.value.code == Code.UNSUPPORTED_INTERVENTION


def test_model_interventions_never_claim_real_world_causal_effects(s2):
    dataset, bundle, split, normalizer, train, validation, heldout, artifact, models = s2
    flags = models["memory_gru"].capability_flags()
    assert flags.model_interventions is True
    assert flags.real_world_causal_effects is False
    assert flags.active_questioning is False


def test_rollout_on_an_unfitted_model_is_refused(s2):
    dataset, bundle, split, normalizer, train, validation, heldout, artifact, models = s2
    empty = MemoryForecaster(artifact=artifact, normalizer=normalizer)
    with pytest.raises(ContractViolation):
        empty.rollout(heldout[0], steps=2)


def test_an_untrained_encoder_yields_an_unfitted_memory_model(s2):
    dataset, bundle, split, normalizer, train, validation, heldout, artifact, models = s2
    from research_engine.representation import fit_encoder as fit

    untrained = fit([], validation, EncoderConfig(latent_dim=4, epochs=2))
    forecaster = MemoryForecaster.fit(train, validation, untrained, normalizer)
    assert forecaster.readout is None
    assert forecaster.capability_flags().trained_dynamics is False
