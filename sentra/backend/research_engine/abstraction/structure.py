"""T4b (#148) — a sparse explanation model over the readable axes, including product terms.

`g` predicts `z_{t+1}` from `z_t` using single-axis terms and pairwise products.
The product terms are there because S3 generates one, and an additive-only
explanation of S3 is wrong in a way no amount of coefficient tuning fixes — the
scenario exists to make that visible rather than arguable.

Selection is two-stage: ridge, then a hard threshold, then a refit on the
surviving terms. The threshold is on the standardised coefficient, so a term is
not kept merely for living on a wide-scaled axis.

The frequency reported per edge is a **bootstrap selection frequency**: resample
participants, refit, count how often the term survives. It answers "how stable
is this term under resampling", which is not the same question as "how probable
is this edge". C4 carries it as `uncertainty_method="bootstrap_frequency"` and
the UI is required to render it as that, because presenting it as a posterior
would be a category error rather than a rounding.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

import numpy as np

from ..contracts.common import content_hash

#: Terms below this standardised magnitude are dropped. Chosen before looking at
#: any scenario's structure score and recorded in the artifact so a later change
#: is visible as a change.
DEFAULT_SELECTION_THRESHOLD = 0.08
DEFAULT_BOOTSTRAP_ROUNDS = 40


@dataclass(frozen=True)
class Term:
    """One column of the explanation design: the axes it multiplies, and its target."""

    source_axes: Tuple[str, ...]
    target_axis: str

    @property
    def order(self) -> int:
        return len(self.source_axes)

    def key(self) -> Tuple[Tuple[str, ...], str]:
        return (tuple(sorted(self.source_axes)), self.target_axis)


@dataclass
class ExplanationModel:
    axis_names: Tuple[str, ...]
    term_sources: Tuple[Tuple[str, ...], ...]
    coefficients: np.ndarray  # [terms + 1, axes]
    selection_frequency: Mapping[Tuple[Tuple[str, ...], str], float]
    selection_threshold: float
    lag_days: float = 1.0
    bootstrap_rounds: int = 0
    n_rows_fitted: int = 0

    # ---- design ----------------------------------------------------------

    def design_row(self, z: np.ndarray) -> np.ndarray:
        index = {name: position for position, name in enumerate(self.axis_names)}
        values = [
            float(np.prod([z[index[name]] for name in sources])) for sources in self.term_sources
        ]
        return np.asarray(values + [1.0])

    def predict_next(self, z: np.ndarray) -> np.ndarray:
        return self.design_row(z) @ self.coefficients

    def rollout(self, z0: np.ndarray, steps: int) -> List[np.ndarray]:
        out = []
        current = np.array(z0, dtype=float)
        for _ in range(steps):
            current = self.predict_next(current)
            out.append(current.copy())
        return out

    # ---- reporting -------------------------------------------------------

    def selected_terms(self) -> List[Tuple[Term, float, float]]:
        """(term, coefficient, selection frequency) for every surviving term."""

        out: List[Tuple[Term, float, float]] = []
        for target_index, target_axis in enumerate(self.axis_names):
            for term_index, sources in enumerate(self.term_sources):
                coefficient = float(self.coefficients[term_index, target_index])
                if coefficient == 0.0:
                    continue
                term = Term(source_axes=sources, target_axis=target_axis)
                out.append((term, coefficient, float(self.selection_frequency.get(term.key(), 0.0))))
        return out

    def content_hash(self) -> str:
        return content_hash(
            {
                "axis_names": list(self.axis_names),
                "terms": [list(sources) for sources in self.term_sources],
                "coefficients": np.round(self.coefficients, 9).tolist(),
                "threshold": self.selection_threshold,
                "lag_days": self.lag_days,
            }
        )


def _term_sources(axis_names: Sequence[str], max_order: int) -> List[Tuple[str, ...]]:
    sources: List[Tuple[str, ...]] = [(name,) for name in axis_names]
    if max_order >= 2:
        for left in range(len(axis_names)):
            for right in range(left, len(axis_names)):
                sources.append((axis_names[left], axis_names[right]))
    return sources


def _build_design(
    trajectories: Sequence[np.ndarray], axis_names: Sequence[str], max_order: int
) -> Tuple[np.ndarray, np.ndarray, List[Tuple[str, ...]]]:
    sources = _term_sources(axis_names, max_order)
    rows: List[np.ndarray] = []
    targets: List[np.ndarray] = []
    index = {name: position for position, name in enumerate(axis_names)}

    for trajectory in trajectories:
        if len(trajectory) < 2:
            continue
        for t in range(len(trajectory) - 1):
            z = trajectory[t]
            rows.append(
                np.asarray(
                    [float(np.prod([z[index[name]] for name in term])) for term in sources] + [1.0]
                )
            )
            targets.append(trajectory[t + 1])

    if not rows:
        return np.zeros((0, len(sources) + 1)), np.zeros((0, len(axis_names))), sources
    return np.vstack(rows), np.vstack(targets), sources


def _fit_once(
    design: np.ndarray,
    target: np.ndarray,
    ridge: float,
    threshold: float,
) -> np.ndarray:
    """Ridge, threshold on the standardised coefficient, refit on survivors."""

    width = design.shape[1]
    coefficients = np.zeros((width, target.shape[1]))
    scales = design.std(axis=0)
    scales[scales < 1e-9] = 1.0

    for axis in range(target.shape[1]):
        gram = design.T @ design + ridge * np.eye(width)
        dense = np.linalg.solve(gram, design.T @ target[:, axis])
        standardised = np.abs(dense * scales)
        keep = standardised >= threshold
        keep[-1] = True  # the intercept is not a claim about structure
        if not keep.any():
            continue
        sub = design[:, keep]
        sub_gram = sub.T @ sub + ridge * np.eye(sub.shape[1])
        refit = np.linalg.solve(sub_gram, sub.T @ target[:, axis])
        coefficients[keep, axis] = refit

    return coefficients


def fit_explanation_model(
    trajectories: Sequence[np.ndarray],
    axis_names: Sequence[str],
    *,
    max_order: int = 2,
    ridge: float = 1e-2,
    threshold: float = DEFAULT_SELECTION_THRESHOLD,
    bootstrap_rounds: int = DEFAULT_BOOTSTRAP_ROUNDS,
    lag_days: float = 1.0,
    seed: int = 11,
) -> Optional[ExplanationModel]:
    """Fit `g`, then resample participants to see which terms survive."""

    design, target, sources = _build_design(trajectories, axis_names, max_order)
    if design.shape[0] < design.shape[1] + 2:
        return None

    coefficients = _fit_once(design, target, ridge, threshold)

    frequency: Dict[Tuple[Tuple[str, ...], str], float] = {}
    if bootstrap_rounds > 0 and len(trajectories) >= 3:
        rng = np.random.default_rng(seed)
        counts: Dict[Tuple[Tuple[str, ...], str], int] = {}
        rounds_run = 0
        for _ in range(bootstrap_rounds):
            picked = rng.integers(0, len(trajectories), size=len(trajectories))
            resampled = [trajectories[index] for index in picked]
            sub_design, sub_target, _ = _build_design(resampled, axis_names, max_order)
            if sub_design.shape[0] < sub_design.shape[1] + 2:
                continue
            rounds_run += 1
            sub_coefficients = _fit_once(sub_design, sub_target, ridge, threshold)
            for target_index, target_axis in enumerate(axis_names):
                for term_index, term in enumerate(sources):
                    if sub_coefficients[term_index, target_index] != 0.0:
                        key = (tuple(sorted(term)), target_axis)
                        counts[key] = counts.get(key, 0) + 1
        if rounds_run:
            frequency = {key: value / rounds_run for key, value in counts.items()}
            bootstrap_rounds = rounds_run
        else:
            bootstrap_rounds = 0

    return ExplanationModel(
        axis_names=tuple(axis_names),
        term_sources=tuple(sources),
        coefficients=coefficients,
        selection_frequency=frequency,
        selection_threshold=threshold,
        lag_days=lag_days,
        bootstrap_rounds=bootstrap_rounds,
        n_rows_fitted=int(design.shape[0]),
    )
