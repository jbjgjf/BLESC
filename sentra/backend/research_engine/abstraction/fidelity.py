"""Faithfulness: does the explanation reproduce what the detailed model does?

The architecture note defines it as `τ(F(h, a)) ≈ g(τ(h), ω(a))`. Read plainly:
take the internal state, roll it forward with the detailed model, and project the
result. Separately, project first and roll forward with the explanation model.
If the explanation is faithful, the two trajectories agree.

Both halves are computed under the *same* model-internal operation `a`, mapped
into explanation space as `ω(a)`, because an explanation that matches only when
nothing is perturbed explains a single trajectory rather than a mechanism.

What this measures and what it does not: agreement between two models. It says
nothing about whether either matches a real person, and nothing about the effect
of a real-world intervention. `real_world_causal_effects` stays false, and the
bundle's `assumptions` say so in the artifact itself rather than only here.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

import numpy as np

from ..data.sequences import ParticipantSequence
from ..dynamics.memory import MemoryForecaster
from .projection import Projection
from .structure import ExplanationModel


@dataclass(frozen=True)
class FidelityResult:
    paired_rollout_mae: Optional[float]
    paired_rollout_max_error: Optional[float]
    paired_rollout_mae_under_intervention: Optional[float]
    n_pairs: int
    steps: int
    intervention_name: Optional[str]

    def as_dict(self) -> Dict[str, Optional[float]]:
        return {
            "paired_rollout_mae": self.paired_rollout_mae,
            "paired_rollout_max_error": self.paired_rollout_max_error,
            "paired_rollout_mae_under_intervention": self.paired_rollout_mae_under_intervention,
            "n_pairs": float(self.n_pairs),
            "steps": float(self.steps),
        }


def _detailed_projected_rollout(
    forecaster: MemoryForecaster,
    projection: Projection,
    state: np.ndarray,
    steps: int,
    latent_shift: Optional[Tuple[int, float]] = None,
) -> List[np.ndarray]:
    """τ(F(h, a)) — roll the detailed model, then project each state."""

    assert forecaster.artifact is not None and forecaster.readout is not None
    model = forecaster.artifact.to_model()
    current = np.array(state, dtype=float)
    if latent_shift is not None:
        index, delta = latent_shift
        current = current.copy()
        current[index] += delta

    out: List[np.ndarray] = []
    for _ in range(steps):
        predicted = np.concatenate([current, [1.0]]) @ forecaster.readout
        current = model.step(current, predicted, np.ones_like(predicted, dtype=bool), 1.0)
        out.append(projection.apply_one(current))
    return out


def score_fidelity(
    sequences: Sequence[ParticipantSequence],
    forecaster: MemoryForecaster,
    projection: Projection,
    explanation: ExplanationModel,
    *,
    steps: int = 3,
    latent_shift_index: int = 0,
    latent_shift_delta: float = 0.5,
) -> FidelityResult:
    if forecaster.artifact is None or forecaster.readout is None:
        return FidelityResult(None, None, None, 0, steps, None)

    model = forecaster.artifact.to_model()
    errors: List[float] = []
    intervened_errors: List[float] = []
    maximum = 0.0
    pairs = 0

    for sequence in sequences:
        if sequence.length < 2:
            continue
        states = model.encode(
            sequence.values, sequence.mask, np.asarray(sequence.delta_days, dtype=float)
        )
        state = states[-1]

        detailed = _detailed_projected_rollout(forecaster, projection, state, steps)
        explained = explanation.rollout(projection.apply_one(state), steps)
        for left, right in zip(detailed, explained):
            difference = np.abs(left - right)
            errors.extend(difference.tolist())
            maximum = max(maximum, float(difference.max()))
        pairs += 1

        # ω(a): the same nudge, applied to the detailed state and to the
        # projected state. Comparing only unperturbed trajectories would let an
        # explanation that memorised one path look faithful.
        shift = (latent_shift_index, latent_shift_delta)
        detailed_shifted = _detailed_projected_rollout(
            forecaster, projection, state, steps, latent_shift=shift
        )
        shifted_state = state.copy()
        shifted_state[latent_shift_index] += latent_shift_delta
        explained_shifted = explanation.rollout(projection.apply_one(shifted_state), steps)
        for left, right in zip(detailed_shifted, explained_shifted):
            intervened_errors.extend(np.abs(left - right).tolist())

    if not errors:
        return FidelityResult(None, None, None, 0, steps, None)

    return FidelityResult(
        paired_rollout_mae=float(np.mean(errors)),
        paired_rollout_max_error=maximum,
        paired_rollout_mae_under_intervention=(
            float(np.mean(intervened_errors)) if intervened_errors else None
        ),
        n_pairs=pairs,
        steps=steps,
        intervention_name="shift_latent",
    )
