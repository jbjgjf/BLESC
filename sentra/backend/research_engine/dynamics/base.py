"""T3 — the shared shape every forecaster fills, baselines included.

The reason persistence and the memory model implement the same interface is the
evaluation requirement: the comparison and the new model must appear in one
report, in the same units, over the same targets. A baseline computed by a
different code path with its own conventions is not a comparison, it is two
numbers side by side.

`ForecastContext` carries everything a forecaster is allowed to see. It is
constructed once, from data already filtered to the cutoff, so no forecaster has
the opportunity to reach past it.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

import numpy as np

from ..contracts.capabilities import CapabilityFlags
from ..contracts.common import content_hash, elapsed_days
from ..contracts.errors import Reason
from ..contracts.forecast import ForecastBundle, failed_forecast, stable_forecast_id
from ..data.normalizer import Normalizer
from ..data.sequences import ParticipantSequence

TARGET_UNIT = "simulation_unit"


@dataclass(frozen=True)
class ForecastContext:
    """Everything a forecaster may use, and nothing that postdates the cutoff."""

    run_id: str
    dataset_id: str
    split_id: str
    participant_key: str
    cutoff_at: datetime
    sequence: ParticipantSequence
    normalizer: Normalizer
    target_times: Tuple[datetime, ...]
    feature_names: Tuple[str, ...]

    @property
    def visible_length(self) -> int:
        return self.sequence.length

    def horizon_days(self) -> List[float]:
        return [elapsed_days(time, self.cutoff_at) for time in self.target_times]


def build_context(
    *,
    run_id: str,
    dataset_id: str,
    split_id: str,
    sequence: ParticipantSequence,
    normalizer: Normalizer,
    cutoff_at: datetime,
    horizons: Sequence[int],
) -> ForecastContext:
    """Truncate to the cutoff and lay out the target times.

    The truncation happens here rather than in each forecaster: one place to get
    right, and a forecaster that forgets ends up with less history rather than
    with the future.
    """

    keep = [index for index, time in enumerate(sequence.available_times) if time <= cutoff_at]
    truncated = ParticipantSequence(
        participant_key=sequence.participant_key,
        split=sequence.split,
        event_ids=tuple(sequence.event_ids[index] for index in keep),
        available_times=tuple(sequence.available_times[index] for index in keep),
        delta_days=tuple(
            0.0 if position == 0 else sequence.delta_days[index]
            for position, index in enumerate(keep)
        ),
        values=sequence.values[keep] if keep else np.zeros((0, len(sequence.feature_names))),
        mask=sequence.mask[keep] if keep else np.zeros((0, len(sequence.feature_names)), dtype=bool),
        raw_values=sequence.raw_values[keep]
        if keep
        else np.zeros((0, len(sequence.feature_names))),
        feature_names=sequence.feature_names,
        normalizer_id=sequence.normalizer_id,
        feature_schema_id=sequence.feature_schema_id,
    )
    return ForecastContext(
        run_id=run_id,
        dataset_id=dataset_id,
        split_id=split_id,
        participant_key=sequence.participant_key,
        cutoff_at=cutoff_at,
        sequence=truncated,
        normalizer=normalizer,
        target_times=tuple(cutoff_at + timedelta(days=int(horizon)) for horizon in horizons),
        feature_names=tuple(sequence.feature_names),
    )


class Forecaster:
    """Base class: identity, capabilities, and the two helpers every subclass needs."""

    model_id = "abstract"
    distribution_method = "deterministic"

    def capability_flags(self) -> CapabilityFlags:
        return CapabilityFlags()

    def model_hash(self) -> str:
        raise NotImplementedError

    def predict(self, context: ForecastContext) -> Tuple[Optional[np.ndarray], Optional[np.ndarray], List[Reason]]:
        """Return means `[horizon, target]`, optional scales, and any reasons.

        Returning `None` for means is how a forecaster declines; `forecast()`
        turns that into a `not_enough_data` bundle rather than a number.
        """

        raise NotImplementedError

    # ---- shared plumbing -------------------------------------------------

    def forecast_id_for(self, context: ForecastContext) -> str:
        return stable_forecast_id(
            dataset_id=context.dataset_id,
            split_id=context.split_id,
            participant_key=context.participant_key,
            cutoff_at=context.cutoff_at,
            target_times=context.target_times,
            target_names=context.feature_names,
            model_hash=self.model_hash(),
        )

    def forecast(self, context: ForecastContext, encoder_id: Optional[str] = None) -> ForecastBundle:
        forecast_id = self.forecast_id_for(context)
        means, scales, reasons = self.predict(context)

        if means is None:
            return failed_forecast(
                run_id=context.run_id,
                forecast_id=forecast_id,
                model_id=self.model_id,
                dataset_id=context.dataset_id,
                split_id=context.split_id,
                participant_key=context.participant_key,
                cutoff_at=context.cutoff_at,
                status="not_enough_data",
                reasons=reasons
                or [Reason("not_enough_data", "cutoff以前に利用可能な観測がありません。")],
                capability_flags=self.capability_flags(),
                encoder_id=encoder_id,
                target_names=context.feature_names,
                target_units=tuple(TARGET_UNIT for _ in context.feature_names),
            )

        bundle = ForecastBundle(
            run_id=context.run_id,
            forecast_id=forecast_id,
            model_id=self.model_id,
            encoder_id=encoder_id,
            dataset_id=context.dataset_id,
            split_id=context.split_id,
            participant_key=context.participant_key,
            cutoff_at=context.cutoff_at,
            target_times=context.target_times,
            target_names=context.feature_names,
            target_units=tuple(TARGET_UNIT for _ in context.feature_names),
            distribution_method=self.distribution_method,
            means=tuple(tuple(float(value) for value in row) for row in means),
            scales_or_samples=(
                tuple(tuple(float(value) for value in row) for row in scales)
                if scales is not None
                else None
            ),
            inference_mode="forecast",
            source_event_ids=tuple(context.sequence.event_ids),
            capability_flags=self.capability_flags(),
            status="ok",
            reasons=tuple(reasons),
        )
        bundle.validate()
        return bundle


def last_observed(context: ForecastContext) -> Tuple[Optional[np.ndarray], List[int]]:
    """Most recent observed value per feature, in simulation units.

    Returns the vector and the indices of features never observed, so a caller
    can say which ones it had to substitute for rather than silently filling.
    """

    raw = context.sequence.raw_values
    mask = context.sequence.mask
    if raw.shape[0] == 0:
        return None, list(range(len(context.feature_names)))

    values = np.zeros(raw.shape[1])
    missing: List[int] = []
    for feature in range(raw.shape[1]):
        observed = np.flatnonzero(mask[:, feature])
        if observed.size == 0:
            missing.append(feature)
            continue
        values[feature] = raw[observed[-1], feature]
    return values, missing
