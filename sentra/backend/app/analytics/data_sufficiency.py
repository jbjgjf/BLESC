"""Synthetic participants with a known answer, for measuring how much data the
Reflection Signal actually needs. #M-02 / the data-sufficiency epic.

This module is **study apparatus, not a request path**. Nothing in `app/api` or
`app/services` imports it. It exists because three numbers in the product were
assumptions rather than measurements:

- `RAMP_UP_DAYS = 14` (`app/analytics/baseline.py`) — the length of the personal
  history a baseline is built from, and
- `MIN_REFLECTION_BASELINE_DAYS` (`app/services/inference_orchestrator.py`) —
  the gate below which the honest output is `not_enough_data`.
- `POPULATION_BASELINE` — **deleted** in #91 and not re-estimated here. Synthetic
  participants can tell us what an algorithm needs; they cannot stand in for a
  population of real students. See `docs/baseline_reestimation.md`.

What a synthetic participant buys us is a **known answer**. We write the script,
so we know which day a change happened on and we know the distribution every
feature was drawn from. That makes two things measurable that cannot be measured
on real journals: whether a signal fired when it should have, and how far the
estimated baseline sits from the distribution it was estimated from.

What it does **not** buy us is realism. Everything downstream of this file is
conditional on these generators resembling students, and they were written by
hand. `docs/data_sufficiency_study.md` states that limitation as the first
thing a reader sees, and it is the reason this study can recommend a *floor*
("fewer than N days cannot work even under favourable conditions") far more
safely than a *ceiling* ("N days is enough").

## The generative model

A participant is a `Regime`: Poisson rates over the five node categories, drawn
from a small fixed vocabulary of labels, plus the probability that a protective
node buffers a state and that the day contains withdrawal. Labels are reused
across days on purpose — node identity is what `build_temporal_graph_diff`
keys on, so a fresh label every day would make every node look added and
removed and would inflate the temporal-shift term for stable and shifting
participants alike.

A `shift` participant runs its baseline regime through the history window and a
different regime on the evaluation day: more triggers and distress states, less
protective structure, more withdrawal. A `stable` participant runs one regime
throughout. So the ground truth is not a label somebody attached to an output —
it is the parameter that produced the input.

Event durations are deliberately absent. The production extraction schema never
asks the model for one, so `event_avg_duration` is zero on every real day while
carrying weight 0.08 in the deviation table. Generating durations here would
have hidden that; leaving them out reproduces it.
"""

from __future__ import annotations

import hashlib
import math
from dataclasses import dataclass, replace
from datetime import date
from statistics import fmean
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple

import numpy as np

from .aggregation import aggregate_daily_features

#: Bumped whenever the generators change. Artifacts carry it, so a plot and a
#: table from different generator versions cannot be compared by accident.
STUDY_VERSION = "data-sufficiency-1"

#: Seeds the whole study. Every random draw descends from this and the tuple
#: identifying the run, so any single cell can be regenerated on its own.
STUDY_ENTROPY = "blesc/data-sufficiency/2026-08"

#: The eleven features `aggregate_daily_features` emits, in the order the
#: report tabulates them.
FEATURE_ORDER: Tuple[str, ...] = (
    "state_count",
    "trigger_count",
    "protective_count",
    "behavior_count",
    "event_count",
    "event_avg_duration",
    "event_transition_signal",
    "protective_ratio",
    "protective_buffer_ratio",
    "relation_density",
    "isolation_signal",
)

#: Label pools. Small and reused, so that a day's graph is a *subset* of the
#: participant's vocabulary and the temporal diff measures change rather than
#: renaming. `isolation` is held out of the behaviour pool because
#: `aggregate_daily_features` accumulates `isolation_signal` from that one exact
#: label and nothing else.
STATE_LABELS = ("worry", "cant_sleep", "tired", "low_mood", "panic")
TRIGGER_LABELS = ("exam", "family_argument", "friend_conflict", "deadline")
PROTECTIVE_LABELS = ("friend_call", "sibling_time", "music", "walk")
BEHAVIOR_LABELS = ("study", "homework", "club", "chores")
EVENT_LABELS = ("commute", "lunch", "practice")
ISOLATION_LABEL = "isolation"

#: Stored on aggregations built outside the sweep, where the day is not part of
#: the measurement. The sweep's own runs carry real dates.
_PLACEHOLDER_DAY = date(2026, 1, 1)


@dataclass(frozen=True)
class Regime:
    """The distribution one entry is drawn from.

    Rates are per *entry*, not per day: `aggregate_daily_features` sums over
    every entry on the day, so a participant writing three times a day has
    roughly three times the counts of one writing once. That is why entry
    density is swept separately from day count — it changes the scale of every
    count feature, and a z-score is only insensitive to that scale because both
    the day and the baseline move together.
    """

    state_rate: float
    trigger_rate: float
    protective_rate: float
    behavior_rate: float
    event_rate: float
    isolation_probability: float
    isolation_intensity: float
    buffer_probability: float
    co_occurs_probability: float
    intensity_mean: float = 0.45
    intensity_sd: float = 0.12
    confidence_mean: float = 0.75
    #: Day-to-day wobble in extraction confidence. `build_temporal_graph_diff`
    #: calls a shared relation "changed" at |Δ| ≥ 0.15, so this is what decides
    #: how often the `relation_reweighting` rule fires on an ordinary day.
    confidence_sd: float = 0.08


@dataclass(frozen=True)
class Persona:
    """A participant plus the answer we are grading against."""

    name: str
    kind: str  # "stable" | "shift"
    description: str
    history: Regime
    evaluation: Regime

    @property
    def signal_expected(self) -> bool:
        """Ground truth for the evaluation day.

        `stable` participants are the whole false-positive measurement: nothing
        changed, so any signal on their evaluation day is a false one.
        """
        return self.kind == "shift"


#: An unremarkable fortnight: a couple of distress states, a trigger every few
#: days, protective structure present most days, withdrawal rare.
ORDINARY = Regime(
    state_rate=1.1,
    trigger_rate=0.45,
    protective_rate=0.9,
    behavior_rate=1.2,
    event_rate=0.7,
    isolation_probability=0.08,
    isolation_intensity=0.45,
    buffer_probability=0.7,
    co_occurs_probability=0.35,
)


def _shifted(multiplier: float, isolation_probability: float) -> Regime:
    """The regime on the evaluation day of a shift participant.

    One knob moves four things at once, in the directions the deviation weight
    table treats as adverse: distress states and triggers up, protective
    structure down, withdrawal more likely. Real deterioration does not arrive
    one feature at a time, and a change confined to a single feature would be
    measuring `compute_zscores` rather than the pipeline.
    """
    return replace(
        ORDINARY,
        state_rate=ORDINARY.state_rate * multiplier,
        trigger_rate=ORDINARY.trigger_rate * multiplier,
        protective_rate=ORDINARY.protective_rate / multiplier,
        isolation_probability=isolation_probability,
        isolation_intensity=0.75,
        buffer_probability=0.35,
    )


PERSONAS: Tuple[Persona, ...] = (
    Persona(
        name="stable",
        kind="stable",
        description=(
            "Nothing changes. The evaluation day is drawn from the same regime as "
            "every history day, so every signal on it is a false positive."
        ),
        history=ORDINARY,
        evaluation=ORDINARY,
    ),
    Persona(
        name="shift_moderate",
        kind="shift",
        description=(
            "A change of the size a week of exam pressure might produce. The "
            "realised effect size per feature is measured, not asserted — see "
            "`effect_sizes`."
        ),
        history=ORDINARY,
        evaluation=_shifted(1.6, isolation_probability=0.35),
    ),
    Persona(
        name="shift_large",
        kind="shift",
        description=(
            "An unmistakable change. Present so that a failure to detect it can "
            "be read as 'the window is too short' rather than 'the change was "
            "too small to ask about'."
        ),
        history=ORDINARY,
        evaluation=_shifted(2.4, isolation_probability=0.7),
    ),
)

PERSONAS_BY_NAME: Mapping[str, Persona] = {persona.name: persona for persona in PERSONAS}


# ── determinism ──────────────────────────────────────────────────────────────
def rng_for(*parts: Any) -> np.random.Generator:
    """A generator addressed by what it is generating, not by call order.

    Deriving the seed from the run's identity rather than advancing one global
    stream means a single cell can be re-run in isolation and produce byte-identical
    input, and that adding a persona or a density to the sweep does not shift
    the data underneath every other cell.
    """
    key = "|".join([STUDY_ENTROPY, *(str(part) for part in parts)])
    digest = hashlib.blake2b(key.encode("utf-8"), digest_size=8).digest()
    return np.random.default_rng(int.from_bytes(digest, "big"))


# ── generation ───────────────────────────────────────────────────────────────
def _clip(value: float, low: float, high: float) -> float:
    return float(min(high, max(low, value)))


def _pick(rng: np.random.Generator, pool: Sequence[str], rate: float) -> List[str]:
    """Distinct labels from `pool`, Poisson-many, capped by the pool size.

    Distinct rather than with replacement so that a label means "present today";
    the cap is why the rates above sit well below the pool sizes, and it is also
    a ceiling on how far a shifted regime can actually push a count.
    """
    count = int(min(rng.poisson(rate), len(pool)))
    if count <= 0:
        return []
    return [str(label) for label in rng.choice(np.asarray(pool, dtype=object), size=count, replace=False)]


def generate_entry(regime: Regime, rng: np.random.Generator) -> Dict[str, List[Dict[str, Any]]]:
    """One journal entry, in the shape `Extraction` stores and the aggregator reads."""

    def intensity() -> float:
        return round(_clip(rng.normal(regime.intensity_mean, regime.intensity_sd), 0.05, 1.0), 3)

    def confidence() -> float:
        return round(_clip(rng.normal(regime.confidence_mean, regime.confidence_sd), 0.1, 1.0), 3)

    nodes: List[Dict[str, Any]] = []

    states = _pick(rng, STATE_LABELS, regime.state_rate)
    triggers = _pick(rng, TRIGGER_LABELS, regime.trigger_rate)
    protectives = _pick(rng, PROTECTIVE_LABELS, regime.protective_rate)
    behaviors = _pick(rng, BEHAVIOR_LABELS, regime.behavior_rate)
    events = _pick(rng, EVENT_LABELS, regime.event_rate)

    for group, category in (
        (states, "State"),
        (triggers, "Trigger"),
        (protectives, "Protective"),
        (behaviors, "Behavior"),
    ):
        for label in group:
            nodes.append(
                {
                    "id": label,
                    "category": category,
                    "label": label,
                    "intensity": intensity(),
                    "confidence": confidence(),
                }
            )

    for label in events:
        # No `duration` key: the production extraction schema does not ask for
        # one, so `event_avg_duration` is zero on every real day. Reproduced
        # rather than papered over.
        nodes.append(
            {
                "id": label,
                "category": "Event",
                "label": label,
                "intensity": intensity(),
                "confidence": confidence(),
            }
        )

    if rng.random() < regime.isolation_probability:
        nodes.append(
            {
                "id": ISOLATION_LABEL,
                "category": "Behavior",
                "label": ISOLATION_LABEL,
                "intensity": round(_clip(rng.normal(regime.isolation_intensity, 0.1), 0.05, 1.0), 3),
                "confidence": confidence(),
            }
        )

    relations: List[Dict[str, Any]] = []

    def relate(source: str, target: str, rel_type: str) -> None:
        relations.append(
            {"source_id": source, "target_id": target, "type": rel_type, "confidence": confidence()}
        )

    if states:
        for trigger in triggers:
            relate(trigger, str(rng.choice(np.asarray(states, dtype=object))), "causes")
        for protective in protectives:
            if rng.random() < regime.buffer_probability:
                relate(protective, str(rng.choice(np.asarray(states, dtype=object))), "buffers")
        for behavior in behaviors:
            if rng.random() < regime.co_occurs_probability:
                relate(behavior, str(rng.choice(np.asarray(states, dtype=object))), "co_occurs")

    for earlier, later in zip(events, events[1:]):
        relate(earlier, later, "precedes")

    return {"nodes": nodes, "relations": relations}


def generate_day(regime: Regime, entries_per_day: int, rng: np.random.Generator) -> List[Dict[str, Any]]:
    return [generate_entry(regime, rng) for _ in range(entries_per_day)]


def generate_series(
    persona: Persona,
    seed: int,
    history_days: int,
    entries_per_day: int,
) -> Tuple[List[List[Dict[str, Any]]], List[Dict[str, Any]]]:
    """`history_days` of history plus one evaluation day, for one participant.

    The full history is generated once at the longest window the sweep uses and
    shorter windows take its **tail**, so the 3-day and the 30-day cell share
    the days immediately before the evaluation day. The comparison across window
    lengths is then paired: a difference between two cells is the window, not a
    different participant.
    """
    rng = rng_for(persona.name, seed, entries_per_day)
    history = [generate_day(persona.history, entries_per_day, rng) for _ in range(history_days)]
    evaluation = generate_day(persona.evaluation, entries_per_day, rng)
    return history, evaluation


class _Extraction:
    """Stands in for an `Extraction` row where no database is involved.

    `aggregate_daily_features` reads exactly these two attributes. The sweep
    driver writes real rows; the reference distribution below runs thousands of
    days and has no reason to.
    """

    __slots__ = ("nodes_json", "relations_json")

    def __init__(self, entry: Mapping[str, Any]) -> None:
        self.nodes_json = entry["nodes"]
        self.relations_json = entry["relations"]


def feature_vector_for_day(day_entries: Sequence[Mapping[str, Any]]) -> Dict[str, float]:
    """The production aggregator, on one generated day.

    The date is a placeholder: `aggregate_daily_features` stores it and does not
    read it, and callers here want the vector rather than a row.
    """
    aggregation = aggregate_daily_features(
        "synthetic",
        _PLACEHOLDER_DAY,
        [_Extraction(entry) for entry in day_entries],
    )
    return dict(aggregation.feature_vector_json)


# ── the known answer ─────────────────────────────────────────────────────────
def reference_stats(
    regime: Regime,
    entries_per_day: int,
    draws: int = 5000,
    label: str = "reference",
) -> Dict[str, Dict[str, float]]:
    """The distribution a baseline estimated from this regime is *trying* to hit.

    The features are derived — `protective_ratio` is a quotient of Poisson
    counts, `relation_density` a quotient of sums — so their means and standard
    deviations have no clean closed form. They are estimated by Monte Carlo from
    the same generator instead, with a dedicated seed stream so the reference
    never shares draws with a run being graded against it.

    At `draws = 5000` the standard error on each mean is about 1.4% of that
    feature's standard deviation, an order of magnitude below the estimation
    error this study is measuring (≈ 27% of a standard deviation at a 14-day
    window). Raise `draws` before trusting any difference smaller than that.
    """
    rng = rng_for("reference", label, entries_per_day, draws)
    vectors = [feature_vector_for_day(generate_day(regime, entries_per_day, rng)) for _ in range(draws)]

    stats: Dict[str, Dict[str, float]] = {}
    for feature in FEATURE_ORDER:
        values = np.asarray([vector.get(feature, 0.0) for vector in vectors], dtype=float)
        stats[feature] = {
            "mean": float(values.mean()),
            # Population sd, matching `estimate_baseline` (numpy ddof=0). The
            # 0.01 floor is NOT applied here: the floor is a property of the
            # estimator, and applying it to the truth would hide the one place
            # the estimator cannot be right.
            "std": float(values.std()),
        }
    return stats


def effect_sizes(
    persona: Persona,
    entries_per_day: int,
    draws: int = 5000,
) -> Dict[str, float]:
    """How large the scripted change actually is, per feature, in baseline sds.

    Naming a shift "moderate" asserts nothing. This measures it: the evaluation
    regime's mean minus the history regime's mean, over the history regime's
    standard deviation — the z-score a perfect baseline would produce on average.
    A detection rate is only interpretable next to these numbers.
    """
    history = reference_stats(persona.history, entries_per_day, draws, label=f"{persona.name}:history")
    evaluation = reference_stats(persona.evaluation, entries_per_day, draws, label=f"{persona.name}:evaluation")
    sizes: Dict[str, float] = {}
    for feature in FEATURE_ORDER:
        spread = history[feature]["std"]
        if spread < 1e-9:
            # A feature that never moves has no scale to express a shift in.
            # `event_avg_duration` is always this case; see the module docstring.
            sizes[feature] = 0.0
            continue
        sizes[feature] = (evaluation[feature]["mean"] - history[feature]["mean"]) / spread
    return sizes


def baseline_error(
    estimated: Mapping[str, Mapping[str, float]],
    truth: Mapping[str, Mapping[str, float]],
    degenerate_std: float = 0.01,
) -> Dict[str, Any]:
    """How far an estimated baseline sits from the distribution it came from.

    Two numbers, because they mean different things:

    - `mean_error_in_sd` — |estimated mean − true mean| / true sd, averaged over
      features. This is exactly the bias it puts into a z-score, which is the
      only thing the baseline is used for, so it is reported in the units the
      error actually lands in. Sampling theory says it falls as 1/√window; the
      point of measuring it is to find where that stops mattering.
    - `std_relative_error` — |estimated sd − true sd| / true sd. A baseline that
      gets the centre right and the spread wrong produces z-scores of the wrong
      *size*, which is what a threshold is read against.

    Features whose true standard deviation is below `degenerate_std` are held
    out of both averages and listed separately. They are not estimation failures:
    there is nothing there to estimate, and dividing by their spread would
    produce a large number that describes the divisor.
    """
    mean_errors: Dict[str, float] = {}
    std_errors: Dict[str, float] = {}
    degenerate: List[str] = []

    for feature in FEATURE_ORDER:
        true = truth.get(feature)
        got = estimated.get(feature)
        if true is None or got is None:
            # `estimate_baseline` takes its feature keys from the first day in
            # the window only, so a feature absent that day is absent from the
            # baseline. Recorded rather than defaulted to zero.
            continue
        true_std = float(true["std"])
        if true_std < degenerate_std:
            degenerate.append(feature)
            continue
        mean_errors[feature] = abs(float(got["mean"]) - float(true["mean"])) / true_std
        std_errors[feature] = abs(float(got["std"]) - true_std) / true_std

    return {
        "mean_error_in_sd": round(fmean(mean_errors.values()), 6) if mean_errors else None,
        "std_relative_error": round(fmean(std_errors.values()), 6) if std_errors else None,
        "per_feature_mean_error_in_sd": {k: round(v, 6) for k, v in sorted(mean_errors.items())},
        "per_feature_std_relative_error": {k: round(v, 6) for k, v in sorted(std_errors.items())},
        "degenerate_features": sorted(degenerate),
        "features_missing_from_baseline": sorted(set(FEATURE_ORDER) - set(estimated)),
    }


# ── metrics ──────────────────────────────────────────────────────────────────
def roc_auc(positive: Sequence[float], negative: Sequence[float]) -> Optional[float]:
    """Threshold-free separation between the two groups, ties counted as half.

    The product ships **no** decision threshold — nothing in the codebase turns
    `final_score` into "signal / no signal". Every precision and recall in this
    study therefore depends on a threshold the study invented, and this number
    does not: it is the probability that a shifted day outscores a stable one.
    Where the two disagree, this is the one that is about the pipeline.

    Ties matter here rather than being a technicality. `score_baseline_deviation`
    clamps at zero and the rule engine contributes nothing on an ordinary day,
    so a large share of stable days score exactly 0.0, and any tie-blind
    implementation would quietly award those a win.
    """
    if not positive or not negative:
        return None
    wins = 0.0
    for pos in positive:
        for neg in negative:
            if pos > neg:
                wins += 1.0
            elif pos == neg:
                wins += 0.5
    return wins / (len(positive) * len(negative))


def binary_rates(true_positive: int, false_positive: int, false_negative: int, true_negative: int) -> Dict[str, Any]:
    """Precision / recall / F1 / FPR from a confusion matrix, undefined where undefined.

    `None` rather than 0.0 when a denominator is empty: a precision of zero
    ("everything it flagged was wrong") and an undefined precision ("it flagged
    nothing") are different findings, and at short windows the second is the
    common one.
    """
    predicted_positive = true_positive + false_positive
    actual_positive = true_positive + false_negative
    actual_negative = false_positive + true_negative

    precision = true_positive / predicted_positive if predicted_positive else None
    recall = true_positive / actual_positive if actual_positive else None
    f1: Optional[float]
    if precision is None or recall is None or (precision + recall) == 0:
        # No true positives: F1 is 0 when something was flagged or something was
        # there to flag, and undefined only when neither was true.
        f1 = 0.0 if (predicted_positive or actual_positive) else None
    else:
        f1 = 2 * precision * recall / (precision + recall)

    return {
        "true_positive": true_positive,
        "false_positive": false_positive,
        "false_negative": false_negative,
        "true_negative": true_negative,
        "precision": precision,
        "recall": recall,
        "f1": f1,
        "false_positive_rate": false_positive / actual_negative if actual_negative else None,
    }


def wilson_interval(successes: int, trials: int, z: float = 1.959963985) -> Optional[Tuple[float, float]]:
    """95% interval for a rate, Wilson rather than normal-approximation.

    At twenty repetitions the normal approximation puts the interval for a rate
    of 0/20 at exactly [0, 0], which would report "never happens" from twenty
    observations. Wilson gives [0, 0.161], which is the honest reading of that
    evidence and is why the sample floor in the report is stated as it is.
    """
    if trials <= 0:
        return None
    phat = successes / trials
    denominator = 1 + z * z / trials
    centre = (phat + z * z / (2 * trials)) / denominator
    margin = z * math.sqrt(phat * (1 - phat) / trials + z * z / (4 * trials * trials)) / denominator
    return (round(max(0.0, centre - margin), 6), round(min(1.0, centre + margin), 6))


def bootstrap_ci(
    items: Sequence[Any],
    statistic: Callable[[Sequence[Any]], Optional[float]],
    seed_parts: Sequence[Any],
    resamples: int = 2000,
    alpha: float = 0.05,
) -> Optional[Tuple[float, float]]:
    """Percentile bootstrap over runs, for statistics that are not plain rates.

    F1 and AUROC are functions of the whole sample rather than counts of
    successes, so Wilson does not apply to them. Resampling is over *runs*
    (participant-seeds), which is the unit that was independently drawn — the
    days inside a run are not exchangeable with each other and resampling those
    would understate the interval.
    """
    if len(items) < 2:
        return None
    rng = rng_for("bootstrap", *seed_parts, resamples)
    values: List[float] = []
    indices = np.arange(len(items))
    for _ in range(resamples):
        sample = [items[index] for index in rng.choice(indices, size=len(items), replace=True)]
        value = statistic(sample)
        if value is not None:
            values.append(value)
    if not values:
        return None
    return (
        round(float(np.percentile(values, 100 * alpha / 2)), 6),
        round(float(np.percentile(values, 100 * (1 - alpha / 2))), 6),
    )


def choose_threshold(labelled_scores: Sequence[Tuple[bool, float]]) -> Dict[str, Any]:
    """The score cut that maximises F1 on the sample it is given.

    Chosen **once**, on calibration participants that no reported number is
    computed from, and then held fixed across every cell. Re-picking the best
    threshold per cell would be tuning on the test set: each cell would report
    the best F1 achievable in hindsight, and the learning curve would measure
    how much a hindsight threshold can rescue rather than how much data the
    pipeline needs.

    Cuts are taken midway between adjacent observed scores so the threshold does
    not sit exactly on a value the estimator can produce.
    """
    if not labelled_scores:
        return {"threshold": None, "f1": None, "candidates": 0}

    scores = sorted({score for _, score in labelled_scores})
    candidates = [scores[0] - 1e-6]
    candidates += [(low + high) / 2 for low, high in zip(scores, scores[1:])]
    candidates.append(scores[-1] + 1e-6)

    best_threshold = candidates[0]
    best_f1 = -1.0
    for threshold in candidates:
        true_positive = sum(1 for label, score in labelled_scores if label and score >= threshold)
        false_positive = sum(1 for label, score in labelled_scores if not label and score >= threshold)
        false_negative = sum(1 for label, score in labelled_scores if label and score < threshold)
        true_negative = sum(1 for label, score in labelled_scores if not label and score < threshold)
        f1 = binary_rates(true_positive, false_positive, false_negative, true_negative)["f1"] or 0.0
        if f1 > best_f1:
            best_f1 = f1
            best_threshold = threshold

    return {
        "threshold": round(float(best_threshold), 6),
        "f1": round(float(best_f1), 6),
        "candidates": len(candidates),
    }
