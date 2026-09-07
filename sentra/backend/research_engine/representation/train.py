"""Fitting the encoder, and deciding when to stop.

Per-sequence stochastic gradient descent over shuffled participants, with a
validation set chosen from the split — never from heldout. The self-supervised
objective is still training: mixing heldout rows into it would leak just as
surely as fitting a supervised model on them, which the evaluation plan states
explicitly and which is easy to forget precisely because "it has no labels".

Early stopping keeps the best-validation weights rather than the last ones, and
the artifact records which epoch that was, so a run that stopped at 23 of 60 is
visible as such in the report instead of reading as a full 60.
"""

from __future__ import annotations

import time
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

from ..contracts.common import content_hash
from ..data.sequences import ParticipantSequence
from .artifact import EncoderArtifact, TrainingRecord, dependency_environment
from .model import EncoderConfig, GRUEncoder

Batch = Tuple[np.ndarray, np.ndarray, np.ndarray]


def _as_batches(sequences: Sequence[ParticipantSequence]) -> List[Batch]:
    return [
        (sequence.values, sequence.mask, np.asarray(sequence.delta_days, dtype=float))
        for sequence in sequences
        if sequence.length >= 2
    ]


def training_data_hash(sequences: Sequence[ParticipantSequence]) -> str:
    return content_hash(
        {
            "participants": sorted(sequence.participant_key for sequence in sequences),
            "event_ids": sorted(
                event_id for sequence in sequences for event_id in sequence.event_ids
            ),
        }
    )


def fit_encoder(
    train: Sequence[ParticipantSequence],
    validation: Sequence[ParticipantSequence],
    config: Optional[EncoderConfig] = None,
) -> EncoderArtifact:
    """Fit on `train`, select on `validation`, return a saveable artifact."""

    config = config or EncoderConfig()
    train_batches = _as_batches(train)
    validation_batches = _as_batches(validation)

    feature_names = tuple(train[0].feature_names) if train else ()
    feature_schema_id = train[0].feature_schema_id if train else "unknown"
    normalizer_id = train[0].normalizer_id if train else "unknown"

    if not train_batches:
        # No sequence long enough to contain a transition. An untrained artifact
        # is the honest output; the alternative is a random projection reported
        # as a learned representation.
        empty = GRUEncoder(len(feature_names) or 1, config)
        return EncoderArtifact(
            config=config,
            feature_schema_id=feature_schema_id,
            feature_names=feature_names,
            normalizer_id=normalizer_id,
            training_data_hash=training_data_hash(train),
            params=empty.params,
            training_status="untrained",
            training_record=None,
            dependency_environment=dependency_environment(),
        )

    model = GRUEncoder(len(feature_names), config)
    rng = np.random.default_rng(config.seed + 1)
    started = time.monotonic()

    best_loss = float("inf")
    best_params = {name: value.copy() for name, value in model.params.items()}
    best_epoch = 0
    train_history: List[float] = []
    validation_history: List[float] = []
    since_improvement = 0
    stopped_early = False
    epochs_run = 0

    for epoch in range(1, config.epochs + 1):
        epochs_run = epoch
        order = rng.permutation(len(train_batches))
        epoch_loss, epoch_count = 0.0, 0
        for index in order:
            values, mask, delta = train_batches[index]
            loss, scored, grads = model.loss_and_grads(values, mask, delta)
            if scored == 0:
                continue
            epoch_loss += loss * scored
            epoch_count += scored
            for name, gradient in grads.items():
                gradient = gradient + config.weight_decay * model.params[name]
                norm = float(np.linalg.norm(gradient))
                if norm > config.gradient_clip:
                    gradient = gradient * (config.gradient_clip / norm)
                model.params[name] -= config.learning_rate * gradient

        train_history.append(epoch_loss / epoch_count if epoch_count else float("nan"))
        selection_loss = (
            model.evaluate_loss(validation_batches)
            if validation_batches
            else train_history[-1]
        )
        validation_history.append(selection_loss)

        if selection_loss < best_loss - 1e-6:
            best_loss = selection_loss
            best_params = {name: value.copy() for name, value in model.params.items()}
            best_epoch = epoch
            since_improvement = 0
        else:
            since_improvement += 1
            if since_improvement >= config.patience:
                stopped_early = True
                break

    model.params = best_params
    record = TrainingRecord(
        epochs_run=epochs_run,
        best_epoch=best_epoch,
        train_loss=train_history[best_epoch - 1] if train_history else float("nan"),
        validation_loss=best_loss if validation_batches else None,
        train_loss_history=tuple(train_history),
        validation_loss_history=tuple(validation_history),
        n_train_sequences=len(train_batches),
        n_validation_sequences=len(validation_batches),
        stopped_early=stopped_early,
        elapsed_seconds=time.monotonic() - started,
    )

    return EncoderArtifact(
        config=config,
        feature_schema_id=feature_schema_id,
        feature_names=feature_names,
        normalizer_id=normalizer_id,
        training_data_hash=training_data_hash(train),
        params=model.params,
        training_status="trained",
        training_record=record,
        dependency_environment=dependency_environment(),
    )
