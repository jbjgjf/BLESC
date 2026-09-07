"""T1a/T1b — from an ObservationBundle to the arrays a model consumes.

`load_observations` is the one place the permission boundary and the leakage
filter are applied, so no downstream module has to remember to do either. It
refuses non-synthetic data, refuses a use the manifest does not declare, drops
anything not yet available at the cutoff, and sorts deterministically.

`make_sequences` produces one `ParticipantSequence` per participant: the
normalised values, the mask, and the elapsed days between consecutive rows. The
mask travels as its own channel rather than being folded into the values,
because "0.0 after centring" and "not measured" have to stay distinguishable all
the way into the model — that is the whole content of scenario S4.

Order-independence is a property, not an accident: the same bundle shuffled
produces byte-identical sequences. There is a test for it, because the natural
implementation (iterate and append) quietly depends on input order.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

import numpy as np

from ..contracts.common import content_hash, elapsed_days, format_time, require
from ..contracts.errors import Code
from ..contracts.observation import (
    ObservationBundle,
    refuse_real_source_kinds,
    refuse_unpermitted_uses,
)
from .normalizer import Normalizer


@dataclass(frozen=True)
class ParticipantSequence:
    """One participant's rows, normalised, in time order."""

    participant_key: str
    split: str
    event_ids: Tuple[str, ...]
    available_times: Tuple[datetime, ...]
    delta_days: Tuple[float, ...]
    values: np.ndarray  # [time, feature], normalised, 0.0 where masked
    mask: np.ndarray  # [time, feature], bool
    raw_values: np.ndarray  # [time, feature], simulation units, nan where masked
    feature_names: Tuple[str, ...]
    normalizer_id: str
    feature_schema_id: str

    @property
    def length(self) -> int:
        return len(self.event_ids)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "participant_key": self.participant_key,
            "split": self.split,
            "event_ids": list(self.event_ids),
            "available_times": [format_time(time) for time in self.available_times],
            "delta_days": [float(value) for value in self.delta_days],
            "values": [[float(value) for value in row] for row in self.values],
            "mask": [[bool(flag) for flag in row] for row in self.mask],
            "feature_names": list(self.feature_names),
            "normalizer_id": self.normalizer_id,
            "feature_schema_id": self.feature_schema_id,
        }


def load_observations(
    bundle: ObservationBundle,
    cutoff_at: Optional[datetime] = None,
    required_use: str = "synthetic_training",
) -> ObservationBundle:
    """Validate, check permission, drop the not-yet-available, sort."""

    bundle.validate()
    refuse_unpermitted_uses(bundle.manifest, required_use)
    refuse_real_source_kinds(bundle)

    visible = bundle.visible_at(cutoff_at) if cutoff_at is not None else bundle
    ordered = sorted(
        visible.observations,
        key=lambda row: (row.participant_key, row.available_at, row.event_id),
    )
    return ObservationBundle(manifest=visible.manifest, observations=ordered)


def make_sequences(
    bundle: ObservationBundle,
    normalizer: Normalizer,
    assignment: Optional[Mapping[str, str]] = None,
    splits: Optional[Sequence[str]] = None,
    min_length: int = 2,
) -> List[ParticipantSequence]:
    """Group rows into per-participant sequences.

    A participant shorter than `min_length` is dropped rather than padded: a
    one-row "sequence" has no transition to learn from, and padding it would
    teach the model that the padding is a transition.
    """

    wanted = set(splits) if splits is not None else None
    by_participant: Dict[str, List[Any]] = {}
    for row in bundle.observations:
        split = (assignment or {}).get(row.participant_key, "train")
        if wanted is not None and split not in wanted:
            continue
        by_participant.setdefault(row.participant_key, []).append(row)

    sequences: List[ParticipantSequence] = []
    for participant_key in sorted(by_participant):
        rows = sorted(by_participant[participant_key], key=lambda row: (row.available_at, row.event_id))
        if len(rows) < min_length:
            continue

        values: List[List[float]] = []
        masks: List[List[bool]] = []
        raw: List[List[float]] = []
        deltas: List[float] = []
        for index, row in enumerate(rows):
            normalised, mask = normalizer.transform(row.values, row.observed_mask)
            values.append(normalised)
            masks.append(mask)
            raw.append(
                [
                    float(value) if (observed and value is not None) else float("nan")
                    for value, observed in zip(row.values, row.observed_mask)
                ]
            )
            deltas.append(
                0.0 if index == 0 else elapsed_days(row.available_at, rows[index - 1].available_at)
            )

        sequences.append(
            ParticipantSequence(
                participant_key=participant_key,
                split=(assignment or {}).get(participant_key, "train"),
                event_ids=tuple(row.event_id for row in rows),
                available_times=tuple(row.available_at for row in rows),
                delta_days=tuple(deltas),
                values=np.asarray(values, dtype=float),
                mask=np.asarray(masks, dtype=bool),
                raw_values=np.asarray(raw, dtype=float),
                feature_names=tuple(normalizer.feature_names),
                normalizer_id=normalizer.normalizer_id,
                feature_schema_id=bundle.manifest.feature_schema_id,
            )
        )
    return sequences


def sequences_hash(sequences: Sequence[ParticipantSequence]) -> str:
    return content_hash([sequence.as_dict() for sequence in sequences])
