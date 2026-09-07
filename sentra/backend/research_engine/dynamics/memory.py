"""T3b (#146) — the memory model over a frozen encoder, and rollout inside the model.

The encoder is frozen. This module fits a readout from the encoder's state to
the next observation and nothing else, which is what makes the comparison in the
report interpretable: any gain over `linear_ar` is attributable to the state the
encoder carries, not to a second round of representation learning happening
under a different name.

Multi-step forecasts are produced by rollout *through the same cell*: predict
the next observation, feed it back as the next input, advance the state, repeat.
Two consequences are stated rather than hidden. The horizon-3 number is a
three-step rollout and its error compounds. And the fed-back input is a
prediction, so it enters with `mask=true` — the model is told it is looking at a
value, because that is what it is being asked to assume.

Uncertainty is `gaussian_diag` with per-horizon residual standard deviations
measured on the validation split. That is an honest spread, not a calibrated
one: `calibrated_uncertainty` stays false, and the coverage metrics in the
report are what would justify flipping it.

`rollout` takes model-internal interventions — setting or shifting a feature,
nudging a latent coordinate. These are operations on the model's own state. They
are not interventions on a person, they do not estimate a treatment effect, and
`real_world_causal_effects` is false in every bundle this module produces.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

import numpy as np

from ..contracts.capabilities import CapabilityFlags
from ..contracts.common import content_hash, require
from ..contracts.errors import Code, ContractViolation, Reason
from ..data.normalizer import Normalizer
from ..data.sequences import ParticipantSequence
from ..representation.artifact import EncoderArtifact
from .base import Forecaster, ForecastContext

#: The interventions v0 understands. An unknown name is refused rather than
#: ignored: silently dropping an operation would report a counterfactual that
#: was never applied.
SUPPORTED_INTERVENTIONS = ("set_feature", "shift_feature", "shift_latent")


@dataclass
class RolloutStep:
    step: int
    latent: Tuple[float, ...]
    predicted_values: Tuple[float, ...]

    def as_dict(self) -> Dict[str, Any]:
        return {
            "step": self.step,
            "latent": list(self.latent),
            "predicted_values": list(self.predicted_values),
        }


@dataclass
class MemoryForecaster(Forecaster):
    """Frozen encoder + fitted readout + rollout through the same cell."""

    artifact: Optional[EncoderArtifact] = None
    normalizer: Optional[Normalizer] = None
    readout: Optional[np.ndarray] = None  # [latent + 1, features], predicts normalised values
    horizon_scales: Tuple[Tuple[float, ...], ...] = ()
    ridge: float = 1e-2
    n_pairs: int = 0
    model_id: str = field(default="memory_gru", init=False)
    distribution_method: str = field(default="gaussian_diag", init=False)

    # ---- identity and capabilities ---------------------------------------

    def capability_flags(self) -> CapabilityFlags:
        trained = self.readout is not None and self.artifact is not None
        return CapabilityFlags(
            trained_encoder=bool(self.artifact and self.artifact.training_status == "trained"),
            trained_dynamics=trained,
            calibrated_uncertainty=False,
            model_interventions=trained,
            real_world_causal_effects=False,
            active_questioning=False,
        )

    def model_hash(self) -> str:
        return content_hash(
            {
                "model": "memory_gru",
                "encoder_id": self.artifact.encoder_id if self.artifact else None,
                "ridge": self.ridge,
                "readout": None if self.readout is None else np.round(self.readout, 9).tolist(),
                "horizon_scales": [list(row) for row in self.horizon_scales],
            }
        )

    # ---- fitting ---------------------------------------------------------

    @staticmethod
    def fit(
        train: Sequence[ParticipantSequence],
        validation: Sequence[ParticipantSequence],
        artifact: EncoderArtifact,
        normalizer: Normalizer,
        horizons: Sequence[int] = (1, 2, 3),
        ridge: float = 1e-2,
    ) -> "MemoryForecaster":
        if artifact.training_status != "trained":
            return MemoryForecaster(artifact=artifact, normalizer=normalizer, ridge=ridge)

        model = artifact.to_model()
        designs: List[np.ndarray] = []
        targets: List[np.ndarray] = []
        masks: List[np.ndarray] = []

        for sequence in train:
            if sequence.length < 2:
                continue
            states = model.encode(
                sequence.values, sequence.mask, np.asarray(sequence.delta_days, dtype=float)
            )
            designs.append(np.column_stack([states[:-1], np.ones(len(states) - 1)]))
            targets.append(sequence.values[1:])
            masks.append(sequence.mask[1:])

        if not designs:
            return MemoryForecaster(artifact=artifact, normalizer=normalizer, ridge=ridge)

        design = np.vstack(designs)
        target = np.vstack(targets)
        mask = np.vstack(masks)
        width = design.shape[1]
        readout = np.zeros((width, target.shape[1]))
        for feature in range(target.shape[1]):
            rows = np.flatnonzero(mask[:, feature])
            if rows.size < width:
                continue
            sub = design[rows]
            gram = sub.T @ sub + ridge * np.eye(width)
            readout[:, feature] = np.linalg.solve(gram, sub.T @ target[rows, feature])

        forecaster = MemoryForecaster(
            artifact=artifact,
            normalizer=normalizer,
            readout=readout,
            ridge=ridge,
            n_pairs=len(design),
        )
        forecaster.horizon_scales = forecaster._measure_scales(validation, horizons)
        return forecaster

    def _measure_scales(
        self, validation: Sequence[ParticipantSequence], horizons: Sequence[int]
    ) -> Tuple[Tuple[float, ...], ...]:
        """Residual spread per horizon, measured on validation, in simulation units.

        Measured rather than assumed, and measured on the split reserved for
        selection — using heldout here would make every coverage number in the
        report a statement about data the model had already been tuned on.
        """

        assert self.artifact is not None and self.normalizer is not None
        model = self.artifact.to_model()
        n_features = len(self.normalizer.feature_names)
        squares = np.zeros((len(horizons), n_features))
        counts = np.zeros((len(horizons), n_features))

        for sequence in validation:
            if sequence.length < 2:
                continue
            states = model.encode(
                sequence.values, sequence.mask, np.asarray(sequence.delta_days, dtype=float)
            )
            for start in range(sequence.length - 1):
                trajectory = self._roll(model, states[start], max(horizons))
                for h_index, horizon in enumerate(horizons):
                    target_index = start + horizon
                    if target_index >= sequence.length:
                        continue
                    predicted = trajectory[horizon - 1]
                    actual = sequence.values[target_index]
                    observed = sequence.mask[target_index]
                    residual = (predicted - actual) * observed
                    squares[h_index] += residual**2
                    counts[h_index] += observed

        stds = np.sqrt(np.divide(squares, np.maximum(counts, 1.0)))
        # Back to simulation units so the scale matches the means the bundle carries.
        stds = stds * np.asarray(self.normalizer.stds)
        return tuple(tuple(float(value) for value in row) for row in stds)

    # ---- rollout ---------------------------------------------------------

    def _roll(
        self,
        model: Any,
        state: np.ndarray,
        steps: int,
        interventions: Optional[Sequence[Mapping[str, Any]]] = None,
        step_days: float = 1.0,
    ) -> List[np.ndarray]:
        """Advance `steps` times, returning the predicted normalised values."""

        assert self.readout is not None
        predictions: List[np.ndarray] = []
        current = np.array(state, dtype=float)
        for step in range(steps):
            current = self._apply_latent_interventions(current, interventions, step)
            predicted = np.concatenate([current, [1.0]]) @ self.readout
            predicted = self._apply_value_interventions(predicted, interventions, step)
            predictions.append(predicted.copy())
            current = model.step(
                current, predicted, np.ones_like(predicted, dtype=bool), step_days
            )
        return predictions

    def _feature_index(self, name: str) -> int:
        assert self.normalizer is not None
        names = list(self.normalizer.feature_names)
        if name not in names:
            raise ContractViolation(
                Code.UNSUPPORTED_INTERVENTION,
                f"未知の特徴名です: {name}",
                "intervention.feature",
                {"known": names},
            )
        return names.index(name)

    def _apply_value_interventions(
        self,
        predicted: np.ndarray,
        interventions: Optional[Sequence[Mapping[str, Any]]],
        step: int,
    ) -> np.ndarray:
        for intervention in interventions or ():
            name = intervention.get("name")
            if name not in SUPPORTED_INTERVENTIONS:
                raise ContractViolation(
                    Code.UNSUPPORTED_INTERVENTION,
                    f"未知のモデル内操作です: {name!r}。黙って無視すると、適用していない反実仮想を報告することになります。",
                    "intervention.name",
                    {"supported": list(SUPPORTED_INTERVENTIONS)},
                )
            if intervention.get("step") not in (None, step):
                continue
            assert self.normalizer is not None
            if name == "set_feature":
                index = self._feature_index(str(intervention["feature"]))
                scaled = (
                    float(intervention["value"]) - self.normalizer.means[index]
                ) / self.normalizer.stds[index]
                predicted[index] = scaled
            elif name == "shift_feature":
                index = self._feature_index(str(intervention["feature"]))
                predicted[index] += float(intervention["delta"]) / self.normalizer.stds[index]
        return predicted

    def _apply_latent_interventions(
        self,
        state: np.ndarray,
        interventions: Optional[Sequence[Mapping[str, Any]]],
        step: int,
    ) -> np.ndarray:
        for intervention in interventions or ():
            name = intervention.get("name")
            if name not in SUPPORTED_INTERVENTIONS:
                raise ContractViolation(
                    Code.UNSUPPORTED_INTERVENTION,
                    f"未知のモデル内操作です: {name!r}。",
                    "intervention.name",
                    {"supported": list(SUPPORTED_INTERVENTIONS)},
                )
            if name != "shift_latent" or intervention.get("step") not in (None, step):
                continue
            index = int(intervention["index"])
            require(
                0 <= index < len(state),
                Code.UNSUPPORTED_INTERVENTION,
                f"latentの添字が範囲外です: {index}",
                "intervention.index",
            )
            state = state.copy()
            state[index] += float(intervention["delta"])
        return state

    def rollout(
        self,
        sequence: ParticipantSequence,
        steps: int,
        interventions: Optional[Sequence[Mapping[str, Any]]] = None,
        seed: int = 0,
    ) -> List[RolloutStep]:
        """A model-internal trajectory, optionally with interventions applied.

        Deterministic: `seed` is accepted for interface stability with stochastic
        variants that do not exist in v0, and a caller passing a different one
        gets the same answer. Saying so is better than implying a sampling that
        is not happening.
        """

        require(
            self.readout is not None and self.artifact is not None,
            Code.STATUS_PAYLOAD_MISMATCH,
            "未学習のモデルでrolloutはできません。",
            "rollout",
        )
        assert self.artifact is not None
        model = self.artifact.to_model()
        states = model.encode(
            sequence.values, sequence.mask, np.asarray(sequence.delta_days, dtype=float)
        )
        state = states[-1] if len(states) else np.zeros(self.artifact.latent_dim)

        out: List[RolloutStep] = []
        current = np.array(state, dtype=float)
        assert self.normalizer is not None
        for step in range(steps):
            current = self._apply_latent_interventions(current, interventions, step)
            predicted = np.concatenate([current, [1.0]]) @ self.readout
            predicted = self._apply_value_interventions(predicted, interventions, step)
            raw = self.normalizer.inverse_transform_matrix(predicted[None, :])[0]
            out.append(
                RolloutStep(
                    step=step,
                    latent=tuple(float(value) for value in current),
                    predicted_values=tuple(float(value) for value in raw),
                )
            )
            current = model.step(current, predicted, np.ones_like(predicted, dtype=bool), 1.0)
        return out

    # ---- forecasting -----------------------------------------------------

    def predict(self, context: ForecastContext):
        if self.readout is None or self.artifact is None:
            return None, None, [Reason("not_fitted", "記憶モデルが未学習です。")]
        if context.sequence.length == 0:
            return None, None, [Reason("not_enough_data", "cutoff以前の観測がありません。")]

        model = self.artifact.to_model()
        states = model.encode(
            context.sequence.values,
            context.sequence.mask,
            np.asarray(context.sequence.delta_days, dtype=float),
        )
        horizons = [max(1, int(round(days))) for days in context.horizon_days()]
        trajectory = self._roll(model, states[-1], max(horizons))

        assert self.normalizer is not None
        means = np.vstack([trajectory[horizon - 1] for horizon in horizons])
        means = self.normalizer.inverse_transform_matrix(means)

        scales = None
        if self.horizon_scales:
            rows = []
            for horizon in horizons:
                index = min(horizon, len(self.horizon_scales)) - 1
                rows.append(self.horizon_scales[index])
            scales = np.asarray(rows)

        return means, scales, []
