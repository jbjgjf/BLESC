"""T4a (#147) — a learned projection τ from the internal state to readable axes.

The architecture note asks for `z_t = τ(h_t)` with an explanation model `g` such
that `τ(F(h, a)) ≈ g(τ(h), ω(a))`. Two design choices here decide whether the
result can be evaluated at all.

**The axes are anchored to the observed features.** τ is fitted to reconstruct
the observed values from the internal state, so `z` has one coordinate per
feature and a name that means something in the generator's terms. An explanation
graph over unaligned latent axes cannot be compared to any truth, and the
evaluation spec forbids scoring structure recovery on one. The axes are still
`synthetic_axis`, not `anchored_measure`: they correspond to simulation
quantities, not to anything measured about a person.

**The residual is kept.** τ is a compression and it loses something. `residual`
records how much of the internal state's predictive behaviour the explanation
axes fail to carry, and it is reported rather than absorbed — an explanation
claiming no residual is claiming the compressed state is sufficient, which the
architecture note refuses to assume up front.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

import numpy as np

from ..contracts.common import content_hash
from ..data.sequences import ParticipantSequence
from ..representation.artifact import EncoderArtifact


@dataclass
class Projection:
    """z = [h, 1] @ weights, one coordinate per observed feature."""

    weights: np.ndarray  # [latent + 1, n_axes]
    axis_names: Tuple[str, ...]
    latent_dim: int
    ridge: float
    reconstruction_r2: Tuple[float, ...]
    n_rows_fitted: int

    def apply(self, states: np.ndarray) -> np.ndarray:
        padded = np.column_stack([states, np.ones(len(states))])
        return padded @ self.weights

    def apply_one(self, state: np.ndarray) -> np.ndarray:
        return np.concatenate([state, [1.0]]) @ self.weights

    def content_hash(self) -> str:
        return content_hash(
            {
                "weights": np.round(self.weights, 9).tolist(),
                "axis_names": list(self.axis_names),
                "ridge": self.ridge,
            }
        )

    def as_dict(self) -> Dict[str, Any]:
        return {
            "axis_names": list(self.axis_names),
            "latent_dim": self.latent_dim,
            "ridge": self.ridge,
            "reconstruction_r2": [float(value) for value in self.reconstruction_r2],
            "n_rows_fitted": self.n_rows_fitted,
        }


def fit_projection(
    sequences: Sequence[ParticipantSequence],
    artifact: EncoderArtifact,
    ridge: float = 1e-2,
) -> Optional[Projection]:
    """Fit τ on train sequences only. Returns None if there is nothing to fit."""

    if artifact.training_status != "trained" or not sequences:
        return None

    model = artifact.to_model()
    states: List[np.ndarray] = []
    targets: List[np.ndarray] = []
    masks: List[np.ndarray] = []
    for sequence in sequences:
        if sequence.length == 0:
            continue
        h = model.encode(
            sequence.values, sequence.mask, np.asarray(sequence.delta_days, dtype=float)
        )
        states.append(h)
        targets.append(sequence.values)
        masks.append(sequence.mask)

    if not states:
        return None

    design = np.column_stack([np.vstack(states), np.ones(sum(len(row) for row in states))])
    target = np.vstack(targets)
    mask = np.vstack(masks)
    width = design.shape[1]
    weights = np.zeros((width, target.shape[1]))
    r2: List[float] = []

    for axis in range(target.shape[1]):
        rows = np.flatnonzero(mask[:, axis])
        if rows.size < width:
            r2.append(float("nan"))
            continue
        sub = design[rows]
        gram = sub.T @ sub + ridge * np.eye(width)
        weights[:, axis] = np.linalg.solve(gram, sub.T @ target[rows, axis])
        predicted = sub @ weights[:, axis]
        actual = target[rows, axis]
        variance = float(np.var(actual))
        residual = float(np.mean((predicted - actual) ** 2))
        r2.append(1.0 - residual / variance if variance > 1e-12 else float("nan"))

    return Projection(
        weights=weights,
        axis_names=tuple(sequences[0].feature_names),
        latent_dim=artifact.latent_dim,
        ridge=ridge,
        reconstruction_r2=tuple(r2),
        n_rows_fitted=int(mask.sum()),
    )
