"""Scoring: what a number means, and when there is no number to report.

Everything here is computed per participant and then averaged across
participants, not pooled across predictions. Pooling lets a participant who
happens to have more rows dominate the mean, and the evaluation plan asks for
the aggregation to be stated — so it is stated in code, once.

`Metric` carries `status`. `unsupported` with a reason is a first-class outcome:
edge-F1 on a scenario whose truth cannot be expressed in the model's vocabulary
is not a bad score, it is not a score. The alternative — printing a low number —
reads as a measured failure of the model rather than an absence of a yardstick.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

import numpy as np

from ..contracts.evaluation import Metric
from ..contracts.forecast import ForecastBundle
from ..data.sequences import ParticipantSequence

BOOTSTRAP_ROUNDS = 200


@dataclass(frozen=True)
class Prediction:
    """One (forecast, actual) pair, aligned by target time."""

    participant_key: str
    model_id: str
    scenario: str
    horizon_days: float
    target_name: str
    predicted: float
    actual: float
    scale: Optional[float]


def participant_bootstrap_interval(
    values_by_participant: Mapping[str, List[float]], seed: int = 11
) -> Optional[Tuple[float, float]]:
    """A 90% interval by resampling participants, not predictions.

    Resampling predictions would treat a single participant's 40 rows as 40
    independent observations, which they are not, and would produce an interval
    several times too narrow.
    """

    keys = sorted(values_by_participant)
    if len(keys) < 3:
        return None
    rng = np.random.default_rng(seed)
    means = []
    for _ in range(BOOTSTRAP_ROUNDS):
        picked = rng.integers(0, len(keys), size=len(keys))
        pooled = [value for index in picked for value in values_by_participant[keys[index]]]
        if pooled:
            means.append(float(np.mean(pooled)))
    if not means:
        return None
    return float(np.percentile(means, 5)), float(np.percentile(means, 95))


def _per_participant(predictions: Sequence[Prediction], value) -> Dict[str, List[float]]:
    grouped: Dict[str, List[float]] = {}
    for prediction in predictions:
        grouped.setdefault(prediction.participant_key, []).append(value(prediction))
    return grouped


def _summarise(
    predictions: Sequence[Prediction],
    name: str,
    unit: str,
    value,
    model_id: str,
    target: str,
    seed: int = 11,
    transform=lambda x: x,
) -> Metric:
    if not predictions:
        return Metric(
            name=name,
            target=target,
            value=None,
            unit=unit,
            n_participants=0,
            n_predictions=0,
            status="not_enough_data",
            model_id=model_id,
            reason_ja="対象の予測が0件です。",
        )

    grouped = _per_participant(predictions, value)
    per_participant = [float(np.mean(values)) for values in grouped.values()]
    interval = participant_bootstrap_interval(grouped, seed=seed)

    return Metric(
        name=name,
        target=target,
        value=transform(float(np.mean(per_participant))),
        unit=unit,
        n_participants=len(grouped),
        n_predictions=len(predictions),
        uncertainty_method="participant_bootstrap" if interval else None,
        interval=(transform(interval[0]), transform(interval[1])) if interval else None,
        status="ok",
        model_id=model_id,
    )


def mae(predictions: Sequence[Prediction], model_id: str, target: str = "all") -> Metric:
    return _summarise(
        predictions,
        "mae",
        "simulation_unit",
        lambda p: abs(p.predicted - p.actual),
        model_id,
        target,
    )


def rmse(predictions: Sequence[Prediction], model_id: str, target: str = "all") -> Metric:
    return _summarise(
        predictions,
        "rmse",
        "simulation_unit",
        lambda p: (p.predicted - p.actual) ** 2,
        model_id,
        target,
        transform=lambda value: float(np.sqrt(value)),
    )


def interval_coverage(
    predictions: Sequence[Prediction], model_id: str, z: float = 1.6449, level: str = "90"
) -> Metric:
    """Coverage of the nominal interval, and the honest refusal when there is none."""

    with_scale = [p for p in predictions if p.scale is not None]
    if not with_scale:
        return Metric(
            name=f"interval_coverage_{level}",
            target="all",
            value=None,
            unit="ratio",
            n_participants=None,
            n_predictions=None,
            status="unsupported",
            model_id=model_id,
            reason_ja="このモデルは分布を返さない（deterministic）ため、被覆率は定義されません。",
        )

    return _summarise(
        with_scale,
        f"interval_coverage_{level}",
        "ratio",
        lambda p: 1.0 if abs(p.predicted - p.actual) <= z * max(p.scale or 0.0, 1e-12) else 0.0,
        model_id,
        "all",
    )


def interval_width(
    predictions: Sequence[Prediction], model_id: str, z: float = 1.6449, level: str = "90"
) -> Metric:
    """Reported next to coverage, because widening an interval always improves coverage."""

    with_scale = [p for p in predictions if p.scale is not None]
    if not with_scale:
        return Metric(
            name=f"interval_width_{level}",
            target="all",
            value=None,
            unit="simulation_unit",
            n_participants=None,
            n_predictions=None,
            status="unsupported",
            model_id=model_id,
            reason_ja="分布を返さないモデルには区間幅がありません。",
        )
    return _summarise(
        with_scale,
        f"interval_width_{level}",
        "simulation_unit",
        lambda p: 2.0 * z * float(p.scale or 0.0),
        model_id,
        "all",
    )


def structure_metrics(
    recovered_edges: Sequence[Tuple[Tuple[str, ...], str, float]],
    true_edges: Sequence[Tuple[Tuple[str, ...], str, float]],
    model_id: str,
    *,
    structure_defined: bool,
    undefined_reason_ja: Optional[str],
) -> List[Metric]:
    """precision / recall / F1 / sign agreement, or a stated refusal.

    Edges are compared as (sorted sources, target). Magnitudes are not compared:
    the explanation operates on normalised, projected axes, so its coefficients
    are not in the generator's units and an equality check on them would fail for
    a correct recovery.
    """

    if not structure_defined:
        return [
            Metric(
                name=name,
                target="structure",
                value=None,
                unit="ratio",
                n_participants=None,
                n_predictions=None,
                status="unsupported",
                model_id=model_id,
                reason_ja=undefined_reason_ja or "このシナリオでは真の構造が定義されません。",
            )
            for name in ("edge_precision", "edge_recall", "edge_f1", "edge_sign_agreement")
        ]

    recovered = {(tuple(sorted(sources)), target): sign for sources, target, sign in recovered_edges}
    truth = {(tuple(sorted(sources)), target): sign for sources, target, sign in true_edges}

    hits = set(recovered) & set(truth)
    precision = len(hits) / len(recovered) if recovered else 0.0
    recall = len(hits) / len(truth) if truth else 0.0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0.0
    sign_agreement = (
        sum(1 for key in hits if np.sign(recovered[key]) == np.sign(truth[key])) / len(hits)
        if hits
        else 0.0
    )

    def metric(name: str, value: float) -> Metric:
        return Metric(
            name=name,
            target="structure",
            value=float(value),
            unit="ratio",
            n_participants=None,
            n_predictions=len(recovered),
            status="ok",
            model_id=model_id,
        )

    return [
        metric("edge_precision", precision),
        metric("edge_recall", recall),
        metric("edge_f1", f1),
        metric("edge_sign_agreement", sign_agreement),
    ]
