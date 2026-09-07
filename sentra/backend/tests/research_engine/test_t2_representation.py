"""T2 (#143, #144): the encoder is trained, reloadable, and time-limited.

"Trained" is the claim that costs the most if it is wrong, so the first test
compares the fitted encoder against persistence on data it never saw. The rest
are the properties that make its output safe to hand to T3: a checkpoint that
reloads to the same identity, a cutoff enforced inside `encode`, and the mask
and elapsed-time channels demonstrably reaching the state.
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
from research_engine.evaluation import GeneratorConfig, generate
from research_engine.representation import EncoderArtifact, EncoderConfig, encode, fit_encoder


def _prepare(scenario: str, seed: int = 11, n_participants: int = 18, n_days: int = 30):
    dataset = generate(
        GeneratorConfig(scenario=scenario, seed=seed, n_participants=n_participants, n_days=n_days)
    )
    bundle = load_observations(dataset.bundle)
    split = participant_split(bundle, dataset.truth.split_groups, seed=seed)
    train_rows = [
        row for row in bundle.observations if split.assignment[row.participant_key] == "train"
    ]
    normalizer = fit_normalizer(
        train_rows,
        feature_schema_id=bundle.manifest.feature_schema_id,
        feature_names=bundle.manifest.feature_names,
    )
    return (
        dataset,
        bundle,
        split,
        normalizer,
        make_sequences(bundle, normalizer, split.assignment, splits=["train"]),
        make_sequences(bundle, normalizer, split.assignment, splits=["validation"]),
        make_sequences(bundle, normalizer, split.assignment, splits=["heldout"]),
    )


@pytest.fixture(scope="module")
def fitted():
    dataset, bundle, split, normalizer, train, validation, heldout = _prepare("S1")
    artifact = fit_encoder(train, validation, EncoderConfig(latent_dim=8, epochs=60, seed=11))
    return dataset, bundle, split, normalizer, train, validation, heldout, artifact


def _persistence_loss(sequences):
    losses = []
    for sequence in sequences:
        values, mask = sequence.values, sequence.mask
        scored = mask[1:]
        if not scored.any():
            continue
        losses.append(float((((values[1:] - values[:-1]) ** 2) * scored).sum() / scored.sum()))
    return float(np.mean(losses))


def test_the_encoder_actually_learns(fitted):
    """Beats persistence on sequences it never saw. The whole claim, in one assertion."""

    *_, heldout, artifact = fitted
    assert artifact.training_status == "trained"
    model = artifact.to_model()

    losses = []
    for sequence in heldout:
        _, predictions, _ = model.forward(
            sequence.values, sequence.mask, np.asarray(sequence.delta_days, dtype=float)
        )
        target, scored = sequence.values[1:], sequence.mask[1:]
        if not scored.any():
            continue
        residual = (predictions[: len(target)] - target) * scored
        losses.append(float((residual**2).sum() / scored.sum()))

    assert np.mean(losses) < _persistence_loss(heldout)


def test_training_record_shows_what_actually_happened(fitted):
    *_, artifact = fitted
    record = artifact.training_record
    assert record is not None
    assert record.epochs_run >= record.best_epoch >= 1
    assert len(record.validation_loss_history) == record.epochs_run
    assert record.validation_loss_history[-1] <= record.validation_loss_history[0]


def test_checkpoint_reloads_to_the_same_encoder(fitted, tmp_path):
    dataset, bundle, split, normalizer, train, validation, heldout, artifact = fitted
    artifact.save(tmp_path / "encoder")
    reloaded = EncoderArtifact.load(tmp_path / "encoder")

    assert reloaded.encoder_id == artifact.encoder_id
    assert reloaded.training_status == artifact.training_status
    assert reloaded.dependency_environment == artifact.dependency_environment

    cutoff = max(row.available_at for row in bundle.observations)
    first = encode(heldout[0], artifact, cutoff, dataset.bundle.manifest.dataset_id, split.split_id)
    again = encode(heldout[0], reloaded, cutoff, dataset.bundle.manifest.dataset_id, split.split_id)
    assert first.as_dict() == again.as_dict()


def test_a_tampered_checkpoint_is_refused(fitted, tmp_path):
    """A weights file swapped under a saved id must not load as that encoder."""

    *_, artifact = fitted
    directory = tmp_path / "encoder"
    artifact.save(directory)
    with np.load(directory / "weights.npz") as archive:
        params = {name: np.array(archive[name]) for name in archive.files}
    params["W_out"] = params["W_out"] + 1.0
    np.savez(directory / "weights.npz", **params)

    with pytest.raises(ContractViolation) as caught:
        EncoderArtifact.load(directory)
    assert caught.value.code == Code.ENCODER_MISMATCH


def test_encoder_id_changes_when_the_training_data_changes():
    _, _, _, _, train_a, validation_a, _ = _prepare("S1", seed=11)
    _, _, _, _, train_b, validation_b, _ = _prepare("S1", seed=12)
    config = EncoderConfig(latent_dim=4, epochs=5, seed=11)
    first = fit_encoder(train_a, validation_a, config)
    second = fit_encoder(train_b, validation_b, config)
    assert first.encoder_id != second.encoder_id
    assert first.training_data_hash != second.training_data_hash


def test_an_unfitted_artifact_says_so():
    """Out of time is a legitimate outcome; claiming a trained encoder is not."""

    _, _, _, _, train, validation, _ = _prepare("S1")
    artifact = fit_encoder([], validation, EncoderConfig(latent_dim=4, epochs=5))
    assert artifact.training_status == "untrained"
    assert artifact.training_record is None
    assert artifact.descriptor().training_status == "untrained"


def test_encode_drops_rows_after_the_cutoff(fitted):
    dataset, bundle, split, normalizer, train, validation, heldout, artifact = fitted
    sequence = heldout[0]
    late = sequence.available_times[-1]
    early = sequence.available_times[len(sequence.available_times) // 2]

    full = encode(sequence, artifact, late, dataset.bundle.manifest.dataset_id, split.split_id)
    partial = encode(sequence, artifact, early, dataset.bundle.manifest.dataset_id, split.split_id)

    assert len(partial.event_ids) < len(full.event_ids)
    assert all(time <= early for time in partial.available_times)
    # The prefix must be identical: a filtering encoder cannot revise the past.
    assert partial.h_values == full.h_values[: len(partial.h_values)]


def test_encode_returns_empty_when_nothing_was_available(fitted):
    dataset, bundle, split, normalizer, train, validation, heldout, artifact = fitted
    sequence = heldout[0]
    before_everything = sequence.available_times[0] - timedelta(days=1)

    encoded = encode(
        sequence, artifact, before_everything, dataset.bundle.manifest.dataset_id, split.split_id
    )
    assert encoded.is_empty
    assert encoded.h_values == ()
    assert "no_data_before_cutoff" in encoded.quality_flags


def test_the_mask_channel_reaches_the_state(fitted):
    """Same numbers, different mask, different state — otherwise the mask is decorative."""

    *_, artifact = fitted
    model = artifact.to_model()
    values = np.zeros((6, len(artifact.feature_names)))
    deltas = np.array([0.0, 1.0, 1.0, 1.0, 1.0, 1.0])

    all_observed = model.encode(values, np.ones_like(values, dtype=bool), deltas)
    none_observed = model.encode(values, np.zeros_like(values, dtype=bool), deltas)

    assert not np.allclose(all_observed, none_observed)


def test_the_elapsed_time_channel_reaches_the_state(fitted):
    """Seven days must not be indistinguishable from one."""

    *_, artifact = fitted
    model = artifact.to_model()
    values = np.ones((5, len(artifact.feature_names))) * 0.4
    mask = np.ones_like(values, dtype=bool)

    daily = model.encode(values, mask, np.array([0.0, 1.0, 1.0, 1.0, 1.0]))
    sparse = model.encode(values, mask, np.array([0.0, 7.0, 7.0, 7.0, 7.0]))

    assert not np.allclose(daily, sparse)


def test_encode_refuses_a_mismatched_normalizer(fitted):
    import dataclasses

    dataset, bundle, split, normalizer, train, validation, heldout, artifact = fitted
    cutoff = max(row.available_at for row in bundle.observations)
    other = dataclasses.replace(heldout[0], normalizer_id="train-zscore-somethingelse")

    with pytest.raises(ContractViolation) as caught:
        encode(other, artifact, cutoff, dataset.bundle.manifest.dataset_id, split.split_id)
    assert caught.value.code == Code.NORMALIZER_MISMATCH


def test_encode_refuses_a_mismatched_feature_schema(fitted):
    import dataclasses

    dataset, bundle, split, normalizer, train, validation, heldout, artifact = fitted
    cutoff = max(row.available_at for row in bundle.observations)
    other = dataclasses.replace(heldout[0], feature_schema_id="synthetic-features-v1")

    with pytest.raises(ContractViolation) as caught:
        encode(other, artifact, cutoff, dataset.bundle.manifest.dataset_id, split.split_id)
    assert caught.value.code == Code.FEATURE_SCHEMA_MISMATCH


def test_gradients_match_finite_differences():
    """A hand-written BPTT is exactly where a silent sign error survives review."""

    from research_engine.representation.model import GRUEncoder

    rng = np.random.default_rng(0)
    values = rng.normal(size=(7, 3))
    mask = rng.random((7, 3)) > 0.3
    deltas = np.abs(rng.normal(1.0, 0.5, 7))
    deltas[0] = 0.0

    model = GRUEncoder(3, EncoderConfig(latent_dim=5, seed=3))
    _, _, grads = model.loss_and_grads(values, mask, deltas)

    epsilon = 1e-6
    worst = 0.0
    for name, parameter in model.params.items():
        flat = parameter.reshape(-1)
        analytic = grads[name].reshape(-1)
        for index in rng.choice(len(flat), size=min(4, len(flat)), replace=False):
            original = flat[index]
            flat[index] = original + epsilon
            plus, _, _ = model.loss_and_grads(values, mask, deltas)
            flat[index] = original - epsilon
            minus, _, _ = model.loss_and_grads(values, mask, deltas)
            flat[index] = original
            numeric = (plus - minus) / (2 * epsilon)
            denominator = max(abs(numeric) + abs(analytic[index]), 1e-8)
            worst = max(worst, abs(numeric - analytic[index]) / denominator)

    assert worst < 1e-4, worst
