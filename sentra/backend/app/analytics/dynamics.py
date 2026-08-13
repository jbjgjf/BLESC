"""Exploratory time-series dynamics from a participant's own history (#97).

**Not an early-warning system.** This module measures two properties of a
series — how much it varies, and how much each day resembles the one before —
and reports them with the window they were measured over. It does not classify,
does not predict, and does not produce a risk band. The framing is
*critical-slowing-inspired*: the statistics are the ones that literature
associates with slowed recovery from perturbation, computed here on synthetic
and personal data with no validation that they mean anything clinical for this
population. `docs/early_warning_dynamics.md` says that at length, and
`NOT_VALIDATED_HERE` carries it into every serialisation.

**Personal only.** Nothing here consults a population distribution. #91 deleted
`POPULATION_BASELINE`; a "typical variance" would reintroduce it in a new field,
and `test_dynamics.py` fails if one appears.

**The parameters below were fixed before any output was looked at**, in the
spirit of the pre-registration #90 established for the benchmark. They are
engineering choices; changing one after seeing a result is the move
pre-registration exists to prevent, and it should come with a note in the doc
rather than a quiet edit here.

## The three things this gets right that `recompute_longitudinal_features` did not

**A missing day is not a zero.** That function reads
`float(vector.get(name) or 0.0)`, so a feature absent on a day enters the mean
and the variance as a measurement of zero. Here, absence is absence: it is
excluded from every calculation and counted in `observed`.

**One observation is not perfect stability.** Population variance over n=1 is 0,
which reads as maximal consistency for a student who wrote once. This uses the
sample variance and returns `None` below two observations.

**Consecutive rows are not consecutive days.** That function differences
`zip(values, values[1:])`, so a student who wrote on the 1st, 2nd and 9th has the
2nd differenced against the 9th as one step. A lag-1 autocorrelation computed
that way is not lag-1 *in time*, and the whole critical-slowing framing depends
on the lag meaning what it appears to mean.

So the decision is made explicitly and both quantities are reported under
different names:

- `lag1_autocorrelation` pairs observations **exactly one calendar day apart**.
  This is the critical-slowing quantity. Where a participant writes too
  irregularly to supply enough such pairs, it is `not_enough_data` — which is
  frequently, and that is information about the data, not a gap to fill.
- `successive_observation_correlation` pairs consecutive **observations**
  whatever the gap, and travels with the median gap that produced it. It is a
  descriptive statistic. It is NOT the critical-slowing quantity and is named so
  it cannot be mistaken for it.
"""

from __future__ import annotations

import random
from dataclasses import dataclass
from datetime import date, timedelta
from enum import Enum
from statistics import fmean
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

DYNAMICS_VERSION = "early-warning-dynamics-v1"

#: Surrogates per trend, and the seed that makes them reproducible. Fixed rather
#: than drawn, for the same reason `benchmark_retrieval.CHANCE_SEED` is: a
#: calibration that moves between runs is not a calibration.
#:
#: 200 rather than 2000 because the quantity read off it is a percentile, not a
#: p-value at three decimal places, and the whole analysis is per-participant and
#: computed on read.
SURROGATE_TRIALS = 200
SURROGATE_SEED = 20260813

#: Carried into every serialisation, for the same reason
#: `temporal.model.NOT_IMPLEMENTED_HERE` is: a reader arriving from the roadmap
#: should see what this does not claim without having to find the doc.
NOT_VALIDATED_HERE = (
    "clinical early warning or transition prediction",
    "a risk band, a diagnosis, or a screening decision",
    "any comparison against a population distribution",
    "evidence that these indicators generalise beyond this participant's own series",
)


class MeasureStatus(str, Enum):
    """Why a measure has, or does not have, a value.

    Three states rather than two, because "we cannot compute this from what
    exists" and "this series cannot support this calculation in principle" are
    different answers and a caller may want to treat them differently.
    """

    COMPUTED = "computed"
    #: Fewer observations or pairs than the pre-declared minimum.
    NOT_ENOUGH_DATA = "not_enough_data"
    #: Enough data, but the calculation is undefined on it — a constant series
    #: has no correlation, and returning 0 or 1 would both be inventions.
    NOT_COMPUTABLE = "not_computable"


@dataclass(frozen=True)
class DynamicsParameters:
    """Fixed before any result was inspected. See the module docstring.

    `window_days` is 14 to match `analytics.baseline.RAMP_UP_DAYS`, which is the
    repository's existing answer to "how much of this student's own history is
    enough". Using a different number here would mean the product has two
    opinions about that.
    """

    window_days: int = 14
    #: Within a window. 8 of 14 days is "wrote more days than not" — below that,
    #: a variance is describing the days they happened to write.
    min_observations: int = 8
    #: Consecutive-calendar-day pairs needed for a lag-1 autocorrelation.
    min_lag_pairs: int = 5
    #: Consecutive observations needed for the descriptive correlation.
    min_successive_pairs: int = 5
    #: A rolling series shorter than this gets no trend. Kendall's tau on three
    #: points takes four distinct values and reads as a direction when it is not.
    min_trend_points: int = 5
    #: Below this, a series is treated as constant and correlations are declared
    #: NOT_COMPUTABLE rather than divided by ~0 into a spurious ±1.
    variance_floor: float = 1e-9

    def as_dict(self) -> Dict[str, Any]:
        return {
            "window_days": self.window_days,
            "min_observations": self.min_observations,
            "min_lag_pairs": self.min_lag_pairs,
            "min_successive_pairs": self.min_successive_pairs,
            "min_trend_points": self.min_trend_points,
            "variance_floor": self.variance_floor,
            "declared_before_results": True,
        }


DEFAULT_PARAMETERS = DynamicsParameters()


#: The features this layer measures, and why each one was chosen.
#:
#: An explicit list, not "every key in the vector". #97 asks for "explicitly
#: selected, documented features", and the reason is that the choice changes what
#: the variance means.
#:
#: Every selected feature is a RATIO, normalised by the size of that day's own
#: extraction. The counts (`state_count`, `trigger_count`, `behavior_count`,
#: `event_count`) are excluded because they scale with how much the student wrote
#: that day: variance in `state_count` is substantially variance in verbosity,
#: and a rising variance would read as a destabilising student when it may be a
#: student writing longer entries.
SELECTED_FEATURES: Dict[str, str] = {
    "protective_ratio": (
        "protective nodes over risk-bearing nodes on the same day. Scale-free with "
        "respect to entry length, and the balance it describes is the one the "
        "ontology's `buffers` relation is about."
    ),
    "protective_buffer_ratio": (
        "buffering relations over all relations that day. Measures the same balance "
        "at the relation level rather than the node level; kept alongside "
        "`protective_ratio` because the two can move apart, and a divergence is "
        "more interesting than either alone."
    ),
    "relation_density": (
        "relations per node. How connected the day's account is — the closest thing "
        "in the feature set to a structural property rather than a content one."
    ),
    "event_transition_signal": (
        "`precedes` relations over events. Sequencing density. Included because it "
        "is normalised and structural; excluded from any causal reading, since "
        "`precedes` is documented as explicitly not a causal claim."
    ),
}

#: Named with the reason, rather than left out silently. A reader asking "why is
#: isolation_signal not here" should find the answer next to the selection.
EXCLUDED_FEATURES: Dict[str, str] = {
    "state_count": (
        "a raw count of extracted State nodes, so it scales with how much the student "
        "wrote that day; its variance is confounded with variance in entry length"
    ),
    "trigger_count": (
        "a raw count of extracted Trigger nodes, with the same entry-length confound as "
        "`state_count`; the ratio features carry the same information normalised"
    ),
    "protective_count": (
        "a raw count of extracted Protective nodes. `protective_ratio` is this quantity "
        "divided by the day's risk-bearing nodes, which is the scale-free version"
    ),
    "behavior_count": (
        "a raw count of extracted Behavior nodes, with the same entry-length confound; "
        "nothing normalises it, so it is measured nowhere in this layer"
    ),
    "event_count": (
        "a raw count of extracted Event nodes, usually 0 or 1, so its variance is "
        "dominated by whether an event was extracted at all"
    ),
    "event_avg_duration": (
        "a mean over a count that is usually 0 or 1, so it is dominated by whether an "
        "event was extracted at all rather than by how long it lasted"
    ),
    "isolation_signal": (
        "matches the literal English label 'isolation' in aggregation.py, so it is "
        "structurally near-zero for Japanese entries. Measuring its variance would "
        "measure the language of the entry. Same class of defect as #107 and D-01."
    ),
}


@dataclass(frozen=True)
class Observation:
    day: date
    value: float


def observations_from_vectors(
    rows: Sequence[Tuple[date, Mapping[str, Any]]],
    feature: str,
) -> Tuple[Observation, ...]:
    """Pull one feature's series out of day-keyed feature vectors.

    A day whose vector omits the feature, or carries `None`, produces NO
    observation. It is not a zero. This is the single most important line in the
    module and the defect it avoids is live in
    `research_pipeline.recompute_longitudinal_features`.
    """
    series: List[Observation] = []
    for day, vector in sorted(rows, key=lambda item: item[0]):
        if feature not in vector:
            continue
        raw = vector[feature]
        if raw is None or isinstance(raw, bool):
            continue
        try:
            series.append(Observation(day=day, value=float(raw)))
        except (TypeError, ValueError):
            continue
    return tuple(series)


# ── statistics (pure, and deliberately hand-written) ──────────────────────────
def sample_variance(values: Sequence[float]) -> Optional[float]:
    """Sample variance (n-1). `None` below two values.

    n-1 rather than n because the alternative gives a single observation a
    variance of 0, which reads as perfect stability. Absence of spread and
    absence of data are different, and only one of them is a finding.
    """
    if len(values) < 2:
        return None
    mean = fmean(values)
    return sum((value - mean) ** 2 for value in values) / (len(values) - 1)


def pearson(xs: Sequence[float], ys: Sequence[float], variance_floor: float) -> Optional[float]:
    """Pearson correlation, or `None` when either side is constant.

    A constant series has no correlation — the denominator is zero. Returning 0
    would report "no persistence" and returning 1 "perfect persistence"; both are
    inventions, and a student whose ratio sat at exactly the same value all
    fortnight is a case this will meet.
    """
    if len(xs) != len(ys) or len(xs) < 2:
        return None
    mean_x, mean_y = fmean(xs), fmean(ys)
    dx = [x - mean_x for x in xs]
    dy = [y - mean_y for y in ys]
    denominator = (sum(value * value for value in dx) * sum(value * value for value in dy)) ** 0.5
    if denominator <= variance_floor:
        return None
    return sum(a * b for a, b in zip(dx, dy)) / denominator


def kendall_tau_against_time(values: Sequence[float]) -> Optional[float]:
    """Rank-correlation of `values` against their own order. Direction only.

    Tau-a: ties contribute to neither concordant nor discordant, so a series with
    many repeated values reports a tau closer to zero. That is the conservative
    direction, which is the one to be wrong in.

    **No significance test is applied and none is implied.** A tau here says the
    rolling series tended upward or downward over the window. It is not evidence
    of a transition, and the false-positive profile in `false_positive_profile()`
    exists because a direction without a false-positive rate is not a result.
    """
    n = len(values)
    if n < 3:
        return None
    concordant = discordant = 0
    for i in range(n):
        for j in range(i + 1, n):
            delta = values[j] - values[i]
            if delta > 0:
                concordant += 1
            elif delta < 0:
                discordant += 1
    return (concordant - discordant) / (n * (n - 1) / 2)


# ── the measures ──────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class Calibration:
    """Where an observed statistic sits in a null built from the same series.

    **This is the most important object in the module**, and it exists because of
    a measurement rather than a principle. Kendall's tau over a rolling series
    computed from OVERLAPPING windows is not a trend test: consecutive rolling
    values share most of their observations, so the series has far fewer
    independent points than it has entries and long runs appear by construction.
    Measured on 400 synthetic stable series, |tau| exceeded 0.5 in **51%** of
    them — the mean was ~0, so tau is not biased, but its spread is so wide that
    a bare direction carries almost no information.

    The null is built by permuting this participant's own observed VALUES across
    their own observed DAYS. That preserves the marginal distribution and the
    spacing pattern and destroys temporal order, which is exactly the null for
    "is there more temporal structure here than this series' own values in a
    random arrangement". A tau is never reported without it.
    """

    trials: int
    #: Fraction of surrogates whose tau is strictly below the observed one.
    percentile: float
    surrogate_p05: float
    surrogate_p95: float
    seed: int = SURROGATE_SEED

    @property
    def exceeds_p95(self) -> bool:
        """Outside what this series produces in a random arrangement 95% of the time.

        Not a significance test and not a decision rule. One participant, one
        series, one uncorrected comparison — and no evidence that the quantity
        means anything clinical. It is a scale for reading the tau, nothing more.
        """
        return self.percentile >= 0.95

    @property
    def below_p05(self) -> bool:
        return self.percentile <= 0.05

    def as_dict(self) -> Dict[str, Any]:
        return {
            "trials": self.trials,
            "percentile": round(self.percentile, 4),
            "surrogate_p05": round(self.surrogate_p05, 6),
            "surrogate_p95": round(self.surrogate_p95, 6),
            "exceeds_p95": self.exceeds_p95,
            "below_p05": self.below_p05,
            "seed": self.seed,
            "null": "this participant's own values, permuted across their own observed days",
        }


@dataclass(frozen=True)
class Measure:
    """One number, or an explicit account of why there is no number."""

    status: MeasureStatus
    value: Optional[float] = None
    #: What the value rests on — observations, or pairs, depending on the measure.
    support: int = 0
    reason: str = ""
    #: Present on trends only. A trend without one is not reportable — see
    #: `Calibration`.
    calibration: Optional[Calibration] = None

    @property
    def has_value(self) -> bool:
        return self.status is MeasureStatus.COMPUTED and self.value is not None

    def as_dict(self) -> Dict[str, Any]:
        return {
            "status": self.status.value,
            "value": round(self.value, 6) if self.value is not None else None,
            "support": self.support,
            "reason": self.reason,
            "calibration": self.calibration.as_dict() if self.calibration else None,
        }


@dataclass(frozen=True)
class RollingPoint:
    day: date
    value: float
    support: int

    def as_dict(self) -> Dict[str, Any]:
        return {"day": self.day.isoformat(), "value": round(self.value, 6), "support": self.support}


@dataclass(frozen=True)
class Spacing:
    """How regularly this participant writes.

    Reported next to every correlation because it is what decides whether the
    correlation means what its name suggests. A `successive_observation_correlation`
    over a median gap of 4 days is not a lag-1 anything.
    """

    observation_count: int
    span_days: int
    consecutive_day_pairs: int
    median_gap_days: Optional[float]
    max_gap_days: Optional[int]

    @property
    def consecutive_fraction(self) -> Optional[float]:
        """Of all successive-observation pairs, how many are one day apart."""
        pairs = self.observation_count - 1
        if pairs <= 0:
            return None
        return round(self.consecutive_day_pairs / pairs, 6)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "observation_count": self.observation_count,
            "span_days": self.span_days,
            "consecutive_day_pairs": self.consecutive_day_pairs,
            "consecutive_fraction": self.consecutive_fraction,
            "median_gap_days": self.median_gap_days,
            "max_gap_days": self.max_gap_days,
        }


def describe_spacing(series: Sequence[Observation]) -> Spacing:
    if not series:
        return Spacing(0, 0, 0, None, None)
    gaps = [
        (later.day - earlier.day).days for earlier, later in zip(series, series[1:])
    ]
    ordered = sorted(gaps)
    median: Optional[float] = None
    if ordered:
        middle = len(ordered) // 2
        median = (
            float(ordered[middle])
            if len(ordered) % 2
            else (ordered[middle - 1] + ordered[middle]) / 2
        )
    return Spacing(
        observation_count=len(series),
        span_days=(series[-1].day - series[0].day).days + 1,
        consecutive_day_pairs=sum(1 for gap in gaps if gap == 1),
        median_gap_days=median,
        max_gap_days=max(ordered) if ordered else None,
    )


def _windows(series: Sequence[Observation], params: DynamicsParameters) -> List[Tuple[date, List[Observation]]]:
    """Every anchor day with its trailing window, in day order.

    Anchored on observed days rather than on every calendar day in the span: a
    window ending on a day the participant did not write adds no information and
    would make the rolling series longer without making it more informed.
    """
    result: List[Tuple[date, List[Observation]]] = []
    for anchor in series:
        start = anchor.day - timedelta(days=params.window_days - 1)
        window = [point for point in series if start <= point.day <= anchor.day]
        result.append((anchor.day, window))
    return result


def _lag1_pairs(window: Sequence[Observation]) -> Tuple[List[float], List[float]]:
    """Values on days t and t+1, for every consecutive calendar-day pair."""
    by_day = {point.day: point.value for point in window}
    xs: List[float] = []
    ys: List[float] = []
    for point in window:
        following = by_day.get(point.day + timedelta(days=1))
        if following is not None:
            xs.append(point.value)
            ys.append(following)
    return xs, ys


@dataclass(frozen=True)
class FeatureDynamics:
    """Everything measured for one feature of one participant."""

    feature: str
    rationale: str
    window_start: Optional[date]
    window_end: Optional[date]
    spacing: Spacing
    rolling_variance: Tuple[RollingPoint, ...]
    rolling_lag1: Tuple[RollingPoint, ...]
    lag1_autocorrelation: Measure
    successive_observation_correlation: Measure
    variance_trend: Measure
    autocorrelation_trend: Measure

    @property
    def quality_flags(self) -> Tuple[str, ...]:
        """What a reader should know before using any number above.

        Flags, not a score. A single quality number would have to weigh
        irregularity against sparsity, and there is no basis for that weighting.
        """
        flags: List[str] = []
        if self.spacing.observation_count == 0:
            flags.append("no_observations")
        if self.spacing.consecutive_fraction is not None and self.spacing.consecutive_fraction < 0.5:
            flags.append("mostly_non_consecutive_observations")
        if self.spacing.max_gap_days is not None and self.spacing.max_gap_days > 7:
            flags.append("gap_longer_than_a_week")
        if not self.lag1_autocorrelation.has_value:
            flags.append("no_calendar_lag1_autocorrelation")
        if not self.rolling_variance:
            flags.append("no_rolling_variance")
        return tuple(flags)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "feature": self.feature,
            "selection_rationale": self.rationale,
            "observation_window": {
                "start": self.window_start.isoformat() if self.window_start else None,
                "end": self.window_end.isoformat() if self.window_end else None,
            },
            "spacing": self.spacing.as_dict(),
            "rolling_variance": [point.as_dict() for point in self.rolling_variance],
            "rolling_lag1_autocorrelation": [point.as_dict() for point in self.rolling_lag1],
            "lag1_autocorrelation": self.lag1_autocorrelation.as_dict(),
            "successive_observation_correlation": self.successive_observation_correlation.as_dict(),
            "variance_trend_kendall_tau": self.variance_trend.as_dict(),
            "autocorrelation_trend_kendall_tau": self.autocorrelation_trend.as_dict(),
            "quality_flags": list(self.quality_flags),
        }


def _measure_lag1(window: Sequence[Observation], params: DynamicsParameters) -> Measure:
    xs, ys = _lag1_pairs(window)
    if len(xs) < params.min_lag_pairs:
        return Measure(
            status=MeasureStatus.NOT_ENOUGH_DATA,
            support=len(xs),
            reason=(
                f"{len(xs)} consecutive-calendar-day pair(s); {params.min_lag_pairs} required. "
                "A lag-1 autocorrelation over non-consecutive days is not a lag-1 autocorrelation."
            ),
        )
    value = pearson(xs, ys, params.variance_floor)
    if value is None:
        return Measure(
            status=MeasureStatus.NOT_COMPUTABLE,
            support=len(xs),
            reason="the series is constant over these pairs, so the correlation is undefined",
        )
    return Measure(status=MeasureStatus.COMPUTED, value=value, support=len(xs), reason="")


def _measure_successive(series: Sequence[Observation], params: DynamicsParameters) -> Measure:
    if len(series) - 1 < params.min_successive_pairs:
        return Measure(
            status=MeasureStatus.NOT_ENOUGH_DATA,
            support=max(0, len(series) - 1),
            reason=f"{max(0, len(series) - 1)} successive pair(s); {params.min_successive_pairs} required",
        )
    xs = [point.value for point in series[:-1]]
    ys = [point.value for point in series[1:]]
    value = pearson(xs, ys, params.variance_floor)
    if value is None:
        return Measure(
            status=MeasureStatus.NOT_COMPUTABLE,
            support=len(xs),
            reason="the series is constant, so the correlation is undefined",
        )
    return Measure(
        status=MeasureStatus.COMPUTED,
        value=value,
        support=len(xs),
        reason="pairs consecutive OBSERVATIONS, not consecutive days; read with spacing.median_gap_days",
    )


def _rolling(
    series: Sequence[Observation], params: DynamicsParameters
) -> Tuple[List[RollingPoint], List[RollingPoint]]:
    """The rolling variance and rolling lag-1 series, in day order.

    Factored out because the surrogate null has to run the SAME pipeline on
    permuted values. A null computed by a shortcut would be a null for a
    different statistic.
    """
    rolling_variance: List[RollingPoint] = []
    rolling_lag1: List[RollingPoint] = []
    for anchor_day, window in _windows(series, params):
        if len(window) < params.min_observations:
            continue
        variance = sample_variance([point.value for point in window])
        if variance is not None:
            rolling_variance.append(RollingPoint(anchor_day, variance, len(window)))
        xs, ys = _lag1_pairs(window)
        if len(xs) >= params.min_lag_pairs:
            correlation = pearson(xs, ys, params.variance_floor)
            if correlation is not None:
                rolling_lag1.append(RollingPoint(anchor_day, correlation, len(xs)))
    return rolling_variance, rolling_lag1


def _surrogate_taus(
    series: Sequence[Observation],
    params: DynamicsParameters,
    use_variance: bool,
) -> List[float]:
    """Taus from this series' own values, permuted across its own days."""
    values = [point.value for point in series]
    days = [point.day for point in series]
    rng = random.Random(SURROGATE_SEED)
    taus: List[float] = []
    for _ in range(SURROGATE_TRIALS):
        shuffled = list(values)
        rng.shuffle(shuffled)
        permuted = [Observation(day, value) for day, value in zip(days, shuffled)]
        variance_points, lag1_points = _rolling(permuted, params)
        points = variance_points if use_variance else lag1_points
        if len(points) < params.min_trend_points:
            continue
        tau = kendall_tau_against_time([point.value for point in points])
        if tau is not None:
            taus.append(tau)
    return sorted(taus)


def _percentile(ordered: Sequence[float], fraction: float) -> float:
    if not ordered:
        return 0.0
    index = min(len(ordered) - 1, max(0, int(round((len(ordered) - 1) * fraction))))
    return ordered[index]


def _measure_trend(
    points: Sequence[RollingPoint],
    series: Sequence[Observation],
    params: DynamicsParameters,
    label: str,
    use_variance: bool,
) -> Measure:
    if len(points) < params.min_trend_points:
        return Measure(
            status=MeasureStatus.NOT_ENOUGH_DATA,
            support=len(points),
            reason=f"{len(points)} {label} point(s); {params.min_trend_points} required for a direction",
        )
    value = kendall_tau_against_time([point.value for point in points])
    if value is None:
        return Measure(status=MeasureStatus.NOT_COMPUTABLE, support=len(points), reason="tau undefined")

    surrogates = _surrogate_taus(series, params, use_variance)
    calibration = (
        Calibration(
            trials=len(surrogates),
            percentile=sum(1 for tau in surrogates if tau < value) / len(surrogates),
            surrogate_p05=_percentile(surrogates, 0.05),
            surrogate_p95=_percentile(surrogates, 0.95),
        )
        if surrogates
        else None
    )
    return Measure(
        status=MeasureStatus.COMPUTED,
        value=value,
        support=len(points),
        reason=(
            "direction only. Read against `calibration`, never bare: overlapping windows "
            "make this tau's spread very wide, and |tau| > 0.5 occurred in 51% of 400 "
            "synthetic STABLE series."
        ),
        calibration=calibration,
    )


def analyse_feature(
    series: Sequence[Observation],
    feature: str,
    params: DynamicsParameters = DEFAULT_PARAMETERS,
) -> FeatureDynamics:
    """Measure one feature's series. Pure; no database, no clock, no population."""
    spacing = describe_spacing(series)
    rolling_variance, rolling_lag1 = _rolling(series, params)

    return FeatureDynamics(
        feature=feature,
        rationale=SELECTED_FEATURES.get(feature, "not in the documented selection"),
        window_start=series[0].day if series else None,
        window_end=series[-1].day if series else None,
        spacing=spacing,
        rolling_variance=tuple(rolling_variance),
        rolling_lag1=tuple(rolling_lag1),
        lag1_autocorrelation=_measure_lag1(series, params),
        successive_observation_correlation=_measure_successive(series, params),
        variance_trend=_measure_trend(
            rolling_variance, series, params, "rolling-variance", use_variance=True
        ),
        autocorrelation_trend=_measure_trend(
            rolling_lag1, series, params, "rolling-autocorrelation", use_variance=False
        ),
    )


@dataclass(frozen=True)
class ParticipantDynamics:
    participant_id: str
    features: Tuple[FeatureDynamics, ...]
    parameters: DynamicsParameters
    days_observed: int
    version: str = DYNAMICS_VERSION

    def as_dict(self) -> Dict[str, Any]:
        return {
            "participant_id": self.participant_id,
            "dynamics_version": self.version,
            "not_validated_here": list(NOT_VALIDATED_HERE),
            "interpretation": (
                "Reports how much each series varied and how much each day resembled the "
                "one before, over the stated window. Critical-slowing-INSPIRED and "
                "exploratory: no threshold, no risk band, no predicted transition, and no "
                "comparison against anyone else."
            ),
            "days_observed": self.days_observed,
            "parameters": self.parameters.as_dict(),
            "feature_selection": {
                "selected": dict(sorted(SELECTED_FEATURES.items())),
                "excluded": dict(sorted(EXCLUDED_FEATURES.items())),
            },
            "features": [feature.as_dict() for feature in self.features],
        }


def analyse_participant(
    participant_id: str,
    rows: Sequence[Tuple[date, Mapping[str, Any]]],
    params: DynamicsParameters = DEFAULT_PARAMETERS,
) -> ParticipantDynamics:
    """Measure every selected feature for one participant.

    `rows` is `(day, feature_vector)` — plain data, so this is testable without a
    database and a caller reading from either store goes through one door. The
    same convention as `temporal.SnapshotInput`.
    """
    return ParticipantDynamics(
        participant_id=participant_id,
        features=tuple(
            analyse_feature(observations_from_vectors(rows, feature), feature, params)
            for feature in sorted(SELECTED_FEATURES)
        ),
        parameters=params,
        days_observed=len({day for day, _ in rows}),
    )


# ── calibration ───────────────────────────────────────────────────────────────
def false_positive_profile(
    stable_series: Sequence[Sequence[Observation]],
    params: DynamicsParameters = DEFAULT_PARAMETERS,
    rising_tau: float = 0.5,
) -> Dict[str, Any]:
    """How often a stable series reports a rising variance trend anyway.

    #97 asks for false-positive behaviour to be reported on stable synthetic
    series, and this is the function that found the reason `Calibration` exists.
    Both rates are returned side by side, because the comparison is the finding:

    - `bare_tau_false_positive_rate` — reading the tau directly against a
      threshold. Measured at ~24.5% on 400 stable series at tau >= 0.5.
    - `calibrated_false_positive_rate` — using `calibration.exceeds_p95`.
      Measured at ~7.3% on the same kind of input, against ~94.7% detection on
      gradually destabilising input.

    A direction indicator without a false-positive rate is not a result, and the
    first number is why the bare tau is never reported without the second.

    Callers pass their own stable series; this function generates nothing, so it
    cannot be accused of grading its own homework on a distribution it chose.
    """
    considered = 0
    flagged_bare = 0
    flagged_calibrated = 0
    calibrated_considered = 0
    taus: List[float] = []
    for series in stable_series:
        result = analyse_feature(series, "synthetic_stable", params)
        trend = result.variance_trend
        if not trend.has_value:
            continue
        considered += 1
        taus.append(trend.value or 0.0)
        if (trend.value or 0.0) >= rising_tau:
            flagged_bare += 1
        if trend.calibration is not None:
            calibrated_considered += 1
            if trend.calibration.exceeds_p95:
                flagged_calibrated += 1
    return {
        "series_supplied": len(stable_series),
        "series_with_a_trend": considered,
        "bare_tau_flagged": flagged_bare,
        "bare_tau_false_positive_rate": round(flagged_bare / considered, 6) if considered else None,
        "calibrated_flagged": flagged_calibrated,
        "calibrated_false_positive_rate": (
            round(flagged_calibrated / calibrated_considered, 6) if calibrated_considered else None
        ),
        "mean_tau": round(fmean(taus), 6) if taus else None,
        "rising_tau_threshold": rising_tau,
        "note": (
            "Measured on series the CALLER declared stable. Neither threshold is a "
            "product decision rule; both exist so the tau has an operating "
            "characteristic attached rather than being read as a direction."
        ),
    }
