"""Producing C2 from a fitted artifact — with the cutoff enforced here, once.

`encode` takes the cutoff explicitly and drops every row that was not yet
available. Doing it at the call site instead would mean every caller has to
remember; doing it here means a caller that forgets gets a shorter sequence, not
a leak.

The compatibility check is equally deliberate: the artifact's feature schema and
normaliser must match the sequence's. Same width is not the same basis, and a
sequence normalised with different statistics is a different quantity wearing
the same shape.
"""

from __future__ import annotations

from datetime import datetime
from typing import List, Optional, Sequence

import numpy as np

from ..contracts.common import require
from ..contracts.encoded import EncodedSequence
from ..contracts.errors import Code
from ..data.sequences import ParticipantSequence
from .artifact import EncoderArtifact

#: Flags a consumer can act on rather than discovering from the numbers.
SHORT_HISTORY_STEPS = 5
HEAVY_MASKING_RATIO = 0.5
IRREGULAR_GAP_DAYS = 2.0


def quality_flags(sequence: ParticipantSequence) -> List[str]:
    flags: List[str] = []
    if sequence.length < SHORT_HISTORY_STEPS:
        flags.append("short_history")
    if sequence.mask.size and float(1.0 - sequence.mask.mean()) > HEAVY_MASKING_RATIO:
        flags.append("heavy_masking")
    if any(delta > IRREGULAR_GAP_DAYS for delta in sequence.delta_days[1:]):
        flags.append("irregular_timing")
    return flags


def encode(
    sequence: ParticipantSequence,
    artifact: EncoderArtifact,
    cutoff_at: datetime,
    dataset_id: str,
    split_id: str,
) -> EncodedSequence:
    require(
        artifact.feature_schema_id == sequence.feature_schema_id,
        Code.FEATURE_SCHEMA_MISMATCH,
        "encoderとsequenceのfeature_schema_idが一致しません。",
        "encode.feature_schema_id",
        expected=artifact.feature_schema_id,
        got=sequence.feature_schema_id,
    )
    require(
        artifact.normalizer_id == sequence.normalizer_id,
        Code.NORMALIZER_MISMATCH,
        "encoderとsequenceのnormalizer_idが一致しません。同じ幅でも別の量です。",
        "encode.normalizer_id",
        expected=artifact.normalizer_id,
        got=sequence.normalizer_id,
    )

    keep = [index for index, time in enumerate(sequence.available_times) if time <= cutoff_at]
    if not keep:
        # Nothing was available. An empty sequence, not a row of zeros: the
        # model must not receive a fabricated observation at the mean.
        return EncodedSequence(
            dataset_id=dataset_id,
            split_id=split_id,
            participant_key=sequence.participant_key,
            encoder_id=artifact.encoder_id,
            feature_schema_id=artifact.feature_schema_id,
            normalizer_id=artifact.normalizer_id,
            cutoff_at=cutoff_at,
            event_ids=(),
            available_times=(),
            delta_days=(),
            latent_dim=artifact.latent_dim,
            h_values=(),
            sequence_mask=(),
            quality_flags=("no_data_before_cutoff",),
        )

    values = sequence.values[keep]
    mask = sequence.mask[keep]
    deltas = np.asarray([sequence.delta_days[index] for index in keep], dtype=float)
    deltas[0] = 0.0  # the first surviving row starts the visible history

    states = artifact.to_model().encode(values, mask, deltas)

    encoded = EncodedSequence(
        dataset_id=dataset_id,
        split_id=split_id,
        participant_key=sequence.participant_key,
        encoder_id=artifact.encoder_id,
        feature_schema_id=artifact.feature_schema_id,
        normalizer_id=artifact.normalizer_id,
        cutoff_at=cutoff_at,
        event_ids=tuple(sequence.event_ids[index] for index in keep),
        available_times=tuple(sequence.available_times[index] for index in keep),
        delta_days=tuple(float(value) for value in deltas),
        latent_dim=artifact.latent_dim,
        h_values=tuple(tuple(float(value) for value in row) for row in states),
        sequence_mask=tuple(bool(row.any()) for row in mask),
        quality_flags=tuple(quality_flags(sequence)),
        encoding_mode="filtering",
    )
    encoded.validate()
    return encoded
