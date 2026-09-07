"""T3a (#145) — the comparisons the new model has to beat to mean anything.

Three of them, deliberately unglamorous:

**Persistence** returns the last observed value. On daily self-report data this
is a genuinely strong baseline, which is the reason it is here: a model that
does not beat it has not demonstrated anything, however sophisticated its
description.

**Train mean** returns the training-set mean per feature. It is the floor: any
model below it is worse than ignoring the participant entirely.

**Linear AR** fits one matrix from the current observation to the next, on train
rows only, mask-aware. It is what the S1 scenario exists to reward — and if the
memory model cannot beat it on S2, the memory is not doing anything.

All three are `deterministic` and therefore return no uncertainty at all. A
point predictor that emits a standard deviation is claiming a calibration it
never estimated, and the C3 type refuses it.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np

from ..contracts.capabilities import CapabilityFlags
from ..contracts.common import content_hash
from ..contracts.errors import Reason
from ..data.sequences import ParticipantSequence
from .base import Forecaster, ForecastContext, last_observed


class PersistenceForecaster(Forecaster):
    model_id = "persistence"

    def model_hash(self) -> str:
        return content_hash({"model": self.model_id, "version": "v0"})

    def predict(self, context: ForecastContext):
        values, missing = last_observed(context)
        if values is None:
            return None, None, []
        reasons: List[Reason] = []
        if missing:
            names = [context.feature_names[index] for index in missing]
            reasons.append(
                Reason(
                    "feature_never_observed",
                    f"cutoffまでに一度も観測されなかった特徴があります: {', '.join(names)}。"
                    "持続値がないため0を返しています。",
                )
            )
        means = np.tile(values, (len(context.target_times), 1))
        return means, None, reasons


@dataclass
class TrainMeanForecaster(Forecaster):
    """The floor. Fitted on train rows, in simulation units."""

    feature_means: Tuple[float, ...] = ()
    n_rows: int = 0
    model_id: str = field(default="train_mean", init=False)

    def model_hash(self) -> str:
        return content_hash(
            {"model": "train_mean", "means": [round(value, 9) for value in self.feature_means]}
        )

    def predict(self, context: ForecastContext):
        if not self.feature_means:
            return None, None, [Reason("not_fitted", "train平均が未fitです。")]
        if context.sequence.length == 0:
            # This model does not *need* history — it could return the
            # population mean for anyone. It declines anyway, so that every
            # model in the report answers on exactly the same set of forecasts.
            # A baseline that answers where the others decline turns the
            # comparison into two numbers over different subsets. Returning a
            # population mean as one participant's forecast is also the kind of
            # substitution this project should not make quietly.
            return None, None, [
                Reason("no_visible_history", "cutoff以前の観測がないため、比較対象を揃えて予測しません。")
            ]
        means = np.tile(np.asarray(self.feature_means), (len(context.target_times), 1))
        return means, None, []

    @staticmethod
    def fit(sequences: Sequence[ParticipantSequence]) -> "TrainMeanForecaster":
        totals: Optional[np.ndarray] = None
        counts: Optional[np.ndarray] = None
        rows = 0
        for sequence in sequences:
            observed = sequence.mask
            values = np.where(observed, np.nan_to_num(sequence.raw_values), 0.0)
            if totals is None:
                totals = np.zeros(values.shape[1])
                counts = np.zeros(values.shape[1])
            totals += values.sum(axis=0)
            counts += observed.sum(axis=0)
            rows += values.shape[0]
        if totals is None:
            return TrainMeanForecaster()
        means = np.where(counts > 0, totals / np.maximum(counts, 1), 0.0)
        return TrainMeanForecaster(feature_means=tuple(float(value) for value in means), n_rows=rows)


@dataclass
class LinearARForecaster(Forecaster):
    """x_{t+1} ≈ A x_t + b, fitted by ridge on train pairs.

    Rows where a target feature was unobserved are dropped from that feature's
    fit rather than imputed: fitting to an imputed value teaches the model the
    imputation rule, which is not a property of the data.
    """

    coefficients: Optional[np.ndarray] = None  # [features + 1, features]
    ridge: float = 1e-3
    n_pairs: int = 0
    model_id: str = field(default="linear_ar", init=False)

    def model_hash(self) -> str:
        return content_hash(
            {
                "model": "linear_ar",
                "ridge": self.ridge,
                "coefficients": None
                if self.coefficients is None
                else np.round(self.coefficients, 9).tolist(),
            }
        )

    def predict(self, context: ForecastContext):
        if self.coefficients is None:
            return None, None, [Reason("not_fitted", "線形ARが未fitです。")]
        values, missing = last_observed(context)
        if values is None:
            return None, None, []

        # Multi-horizon by iterating the fitted map on its own output. Stated
        # rather than hidden: the horizon-3 number is a three-step rollout, and
        # its error compounds.
        state = values
        rows = []
        for _ in context.target_times:
            state = np.concatenate([state, [1.0]]) @ self.coefficients
            rows.append(state.copy())
        return np.asarray(rows), None, []

    @staticmethod
    def fit(sequences: Sequence[ParticipantSequence], ridge: float = 1e-3) -> "LinearARForecaster":
        designs: List[np.ndarray] = []
        targets: List[np.ndarray] = []
        target_masks: List[np.ndarray] = []
        for sequence in sequences:
            if sequence.length < 2:
                continue
            current = np.nan_to_num(sequence.raw_values[:-1])
            nxt = np.nan_to_num(sequence.raw_values[1:])
            designs.append(np.column_stack([current, np.ones(len(current))]))
            targets.append(nxt)
            target_masks.append(sequence.mask[1:])

        if not designs:
            return LinearARForecaster()

        design = np.vstack(designs)
        target = np.vstack(targets)
        mask = np.vstack(target_masks)
        width = design.shape[1]
        coefficients = np.zeros((width, target.shape[1]))
        for feature in range(target.shape[1]):
            rows = np.flatnonzero(mask[:, feature])
            if rows.size < width:
                continue
            sub_design = design[rows]
            gram = sub_design.T @ sub_design + ridge * np.eye(width)
            coefficients[:, feature] = np.linalg.solve(gram, sub_design.T @ target[rows, feature])

        return LinearARForecaster(coefficients=coefficients, ridge=ridge, n_pairs=len(design))
