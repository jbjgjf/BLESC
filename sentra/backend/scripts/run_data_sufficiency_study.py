"""How much data does a Reflection Signal need? Measure it. #M-02.

    python scripts/run_data_sufficiency_study.py            # the full sweep
    python scripts/run_data_sufficiency_study.py --quick    # a smoke run, minutes shorter
    python scripts/run_data_sufficiency_study.py --out DIR  # somewhere other than docs/assets

Writes `runs.jsonl.gz`, `cells.csv`, `summary.json` and four SVG learning curves.
`docs/data_sufficiency_study.md` is written by hand from those artifacts and
cites them; regenerate here, then update the report if a number moved.

## What is actually being run

The real pipeline, against real rows. Synthetic entries are written as `Entry` +
`Extraction` + `GraphSnapshot` in an in-memory SQLite database and
`InferenceOrchestrator.process_day` is called on the evaluation day. No part of
the gate, the baseline, the z-scores, the rule engine or the score combination
is reimplemented here, because a study that reimplements the thing it grades
grades a copy. The one thing this file does mirror is `main._persist_graph_snapshot`
(see `_write_day`), and only because importing `app.main` would drag in the
whole FastAPI app and its LLM configuration to reach forty lines of graph diff.

**Nothing touches production or Supabase.** The database is `sqlite://` held in
memory for the process; every participant id is prefixed `synthetic:`.

## The counterfactual gate

`MIN_REFLECTION_BASELINE_DAYS` is floored at `RAMP_UP_DAYS` in production, so a
window shorter than fourteen days cannot be reached through configuration — the
env var can raise the requirement, never lower it (#91). Asking "would seven
days have been enough?" therefore requires patching both constants in-process,
which `_windowed` does around each cell. **This changes nothing in production**;
it is how a question about a shipped constant gets an answer other than the
constant's own opinion.

The patch also exposes the coupling that turns out to matter: the orchestrator
selects history with `.limit(MIN_REFLECTION_BASELINE_DAYS)`, so the baseline
window *is* the gate. There is no separate "estimate from 30 days once you have
them". `--supply-check` measures that directly.
"""

from __future__ import annotations

import argparse
import contextlib
import csv
import gzip
import json
import logging
import sys
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, Iterator, List, Mapping, Optional, Sequence, Tuple

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

# Every model must be imported before any of them is instantiated, or SQLModel's
# mapper cannot resolve the relationship names between them.
from app.schemas import analytics, entry, extraction, research, structured  # noqa: E402,F401

import numpy as np  # noqa: E402
from sqlalchemy.pool import StaticPool  # noqa: E402
from sqlmodel import Session, SQLModel, create_engine, select  # noqa: E402

from app.analytics import baseline as baseline_module  # noqa: E402
from app.analytics.aggregation import aggregate_daily_features  # noqa: E402
from app.analytics.data_sufficiency import (  # noqa: E402
    FEATURE_ORDER,
    ORDINARY,
    PERSONAS,
    PERSONAS_BY_NAME,
    STUDY_VERSION,
    baseline_error,
    binary_rates,
    bootstrap_ci,
    choose_threshold,
    effect_sizes,
    generate_series,
    reference_stats,
    roc_auc,
    wilson_interval,
)
from app.analytics.graph_features import (  # noqa: E402
    build_graph_summary,
    build_temporal_graph_diff,
    summarize_temporal_diff,
)
from app.schemas.analytics import BaselineStats  # noqa: E402
from app.schemas.entry import Entry  # noqa: E402
from app.schemas.extraction import Extraction  # noqa: E402
from app.schemas.structured import GraphSnapshot, HybridExplanation  # noqa: E402
from app.services import inference_orchestrator as orchestrator_module  # noqa: E402
from app.services.inference_orchestrator import InferenceOrchestrator  # noqa: E402

# ── the design, fixed before any of it was run ───────────────────────────────
#: Baseline window / gate lengths, in days. The two shipped constants (14) and
#: the value the gate carried before #91 floored it (3) are both in the set, so
#: each is read off the same curve as everything else rather than compared
#: against a curve that skipped it.
WINDOWS: Tuple[int, ...] = (1, 3, 5, 7, 10, 14, 21, 30)

#: Entries per day. Swept separately from window length because they are
#: different resources: one is calendar time a student has to wait, the other is
#: how much they write while waiting.
DENSITIES: Tuple[int, ...] = (1, 3, 5)

#: Repetitions per condition. Twenty is the floor the epic set, and twenty
#: cannot answer the question the epic asks.
#:
#: The criterion is "false positive rate ≤ 0.05", read off an interval so a run
#: of luck cannot pass it. A Wilson interval on a *perfect* 0/20 still reaches
#: 0.161, and on 0/40 it reaches 0.088 — so at either size the criterion is
#: undecidable no matter how good the detector is, and every cell would be
#: reported as a failure that was really a shortage of participants. 0/120
#: reaches 0.031 and 1/120 reaches 0.046, so at this size the bar can be cleared
#: by evidence rather than declared unreachable by arithmetic.
EVALUATION_SEEDS: Tuple[int, ...] = tuple(range(1000, 1120))

#: Disjoint from the above. The decision threshold is fitted on these and on
#: nothing else; no number in the report is computed from them.
CALIBRATION_SEEDS: Tuple[int, ...] = tuple(range(1, 21))

#: Where the thresholds are fitted: the shipped window, pooled across densities.
#: Pooled because a shipped threshold does not know how much a given student
#: writes — it is one number applied to everyone, and fitting it per density
#: would report an operating characteristic no deployment could reproduce.
CALIBRATION_WINDOW = 14

#: Two operating points, because the choice between them is a product decision
#: and the study should not make it silently:
#:
#: - `max_f1` — the cut that maximises F1 on the calibration participants. What
#:   an optimiser picks when told the classes are equally common and the two
#:   errors cost the same. Neither is true here.
#: - `fpr_controlled` — the lowest cut whose false-positive rate on stable
#:   calibration participants stays within `TARGET_FPR`. This is the shape of
#:   the constraint the product actually has: a signal shown to a student who is
#:   fine is a cost paid by someone who came for help, and the acceptance
#:   criterion names 5% for a reason.
THRESHOLD_POLICIES: Tuple[str, ...] = ("fpr_controlled", "max_f1")

#: The practical bar, stated in advance. A cell "passes" only if the *lower*
#: bound of its F1 interval clears 0.90 and the *upper* bound of its
#: false-positive interval stays under 0.05. Reading point estimates instead
#: would let a twenty-run cell pass on noise.
TARGET_F1 = 0.90
TARGET_FPR = 0.05

#: Below this, an added day of history buys less than a hundredth of a standard
#: deviation of baseline accuracy. Used to locate the plateau in the estimation
#: error curve; stated here so it is a criterion rather than a description of
#: whatever the curve did.
PLATEAU_MARGINAL_GAIN = 0.01

EVALUATION_DAY = date(2026, 6, 15)
REFERENCE_DRAWS = 5000
BOOTSTRAP_RESAMPLES = 2000


@dataclass
class RunOutcome:
    """One participant, one window, one density, one seed."""

    persona: str
    kind: str
    signal_expected: bool
    window: int
    entries_per_day: int
    seed: int
    split: str
    status: str
    signal_emitted: bool
    final_score: Optional[float]
    rule_score: Optional[float]
    deviation_score: Optional[float]
    temporal_shift_score: Optional[float]
    triggered_rules: Tuple[str, ...]
    uncertainty_level: Optional[str]
    is_provisional: Optional[bool]
    observed_days: Optional[int]
    baseline_mean_error_in_sd: Optional[float]
    baseline_std_relative_error: Optional[float]
    degenerate_features: Tuple[str, ...]

    @property
    def score(self) -> float:
        """The score a threshold is applied to.

        A declined day scores zero. `not_enough_data` is not a low reading, it
        is the refusal to take one — but for the purpose of "did a signal reach
        the student", refusal and a score below threshold are the same event,
        and collapsing them here is what makes the short-window cells comparable
        with the long ones at all. `status` keeps the distinction for anyone who
        needs it, and `abstention_rate` reports it per cell.
        """
        return float(self.final_score) if self.final_score is not None else 0.0

    def as_row(self) -> Dict[str, Any]:
        row = dict(self.__dict__)
        row["triggered_rules"] = ",".join(self.triggered_rules)
        row["degenerate_features"] = ",".join(self.degenerate_features)
        row["study_version"] = STUDY_VERSION
        return row


# ── database ─────────────────────────────────────────────────────────────────
def _open_session() -> Session:
    """An in-memory database that lives as long as the process.

    `StaticPool` because SQLite's in-memory database is per-connection: without
    it every checkout would get an empty schema.
    """
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return Session(engine)


@contextlib.contextmanager
def _windowed(window: int) -> Iterator[None]:
    """Run the block with the baseline window and the gate set to `window`.

    Both constants, because they are read from two modules at call time and a
    disagreement between them would silently produce a gate of one length and a
    baseline of another.
    """
    previous_ramp = baseline_module.RAMP_UP_DAYS
    previous_gate = orchestrator_module.MIN_REFLECTION_BASELINE_DAYS
    baseline_module.RAMP_UP_DAYS = window
    orchestrator_module.MIN_REFLECTION_BASELINE_DAYS = window
    try:
        yield
    finally:
        baseline_module.RAMP_UP_DAYS = previous_ramp
        orchestrator_module.MIN_REFLECTION_BASELINE_DAYS = previous_gate


def _write_day(
    session: Session,
    user_id: str,
    day: date,
    day_entries: Sequence[Dict[str, Any]],
    previous_snapshot: Optional[GraphSnapshot],
) -> Optional[GraphSnapshot]:
    """Persist one day as the submission path would: entries, extractions, snapshots.

    Mirrors `main._persist_graph_snapshot`, including the part that looks odd:
    every entry on a day diffs against the last snapshot of the *previous* day,
    not against the entry before it, because `_latest_graph_snapshot` filters on
    `day < today`. The orchestrator then reads only the newest snapshot of the
    day, so on a multi-entry day the rule engine sees the last entry's graph
    while the aggregator has already summed all of them. That asymmetry is
    production behaviour and is reproduced rather than corrected, since
    correcting it here would measure a pipeline nobody ships.
    """
    latest: Optional[GraphSnapshot] = previous_snapshot
    for index, generated in enumerate(day_entries):
        row = Entry(
            user_id=user_id,
            raw_text=None,
            is_masked=True,
            created_at=datetime.combine(day, datetime.min.time()) + timedelta(hours=8 + index),
            observation_type="daily",
        )
        session.add(row)
        session.commit()
        session.refresh(row)

        session.add(
            Extraction(
                entry_id=row.id,
                nodes_json=generated["nodes"],
                relations_json=generated["relations"],
                prompt_version="synthetic",
                extractor_version=STUDY_VERSION,
                extraction_provider="synthetic",
                extraction_model="data_sufficiency",
            )
        )

        summary = build_graph_summary(generated["nodes"], generated["relations"])
        diff = build_temporal_graph_diff(
            generated["nodes"],
            generated["relations"],
            previous_snapshot.nodes_json if previous_snapshot else [],
            previous_snapshot.relations_json if previous_snapshot else [],
        )
        snapshot = GraphSnapshot(
            entry_id=row.id,
            user_id=user_id,
            day=day,
            nodes_json=generated["nodes"],
            relations_json=generated["relations"],
            graph_summary_json=summary,
            temporal_diff_json=summarize_temporal_diff(
                diff,
                summary,
                previous_snapshot.graph_summary_json if previous_snapshot else None,
            ),
            created_at=row.created_at,
            extraction_provider="synthetic",
            extraction_model="data_sufficiency",
        )
        session.add(snapshot)
        session.commit()
        session.refresh(snapshot)
        latest = snapshot

    return latest


def _run_one(
    session: Session,
    persona_name: str,
    seed: int,
    split: str,
    window: int,
    entries_per_day: int,
    history: Sequence[Sequence[Dict[str, Any]]],
    evaluation: Sequence[Dict[str, Any]],
    truth: Dict[str, Dict[str, float]],
) -> RunOutcome:
    """Seed one participant's history, run `process_day`, read what came out."""
    persona = PERSONAS_BY_NAME[persona_name]
    user_id = f"synthetic:{persona_name}:w{window}:d{entries_per_day}:s{seed}"
    used = list(history)[-window:] if window else []
    first_day = EVALUATION_DAY - timedelta(days=len(used))

    # History enters as aggregations directly. The orchestrator reads history
    # from `DailyFeatureAggregation` and never re-reads those days' entries, so
    # writing entries for all thirty of them would cost the sweep an order of
    # magnitude and change no input to the measurement.
    for offset, day_entries in enumerate(used):
        day = first_day + timedelta(days=offset)
        session.add(
            aggregate_daily_features(
                user_id,
                day,
                [_Row(generated) for generated in day_entries],
            )
        )
    session.commit()

    # The last history day and the evaluation day do need real rows: the
    # temporal diff on the evaluation day is taken against the previous day's
    # snapshot, and an absent one would hand every participant the empty diff.
    previous_snapshot = None
    if used:
        previous_snapshot = _write_day(
            session, user_id, EVALUATION_DAY - timedelta(days=1), used[-1], None
        )
    _write_day(session, user_id, EVALUATION_DAY, list(evaluation), previous_snapshot)

    result = InferenceOrchestrator(session).process_day(user_id, EVALUATION_DAY)

    explanation = session.exec(
        select(HybridExplanation)
        .where(
            HybridExplanation.user_id == user_id,
            HybridExplanation.day == datetime.combine(EVALUATION_DAY, datetime.min.time()),
        )
        .order_by(HybridExplanation.id.desc())
    ).first()

    breakdown = dict(explanation.score_breakdown_json or {}) if explanation else {}
    deviation = dict(explanation.baseline_deviation_json or {}) if explanation else {}
    provenance = dict(deviation.get("baseline_provenance") or {})
    status = str(breakdown.get("status") or ("ok" if result is not None else "no_output"))

    estimated = session.exec(
        select(BaselineStats).where(BaselineStats.user_id == user_id).order_by(BaselineStats.id.desc())
    ).first()
    error = baseline_error(estimated.stats_json, truth) if estimated else {}

    return RunOutcome(
        persona=persona_name,
        kind=persona.kind,
        signal_expected=persona.signal_expected,
        window=window,
        entries_per_day=entries_per_day,
        seed=seed,
        split=split,
        status=status,
        signal_emitted=result is not None,
        final_score=_as_float(breakdown.get("final_score")),
        rule_score=_as_float(breakdown.get("rule_score")),
        deviation_score=_as_float(breakdown.get("deviation_score")),
        temporal_shift_score=_as_float(breakdown.get("temporal_shift_score")),
        triggered_rules=tuple(
            str(hit.get("rule")) for hit in (explanation.triggered_rules_json or []) if explanation
        ),
        uncertainty_level=(explanation.uncertainty_json or {}).get("level") if explanation else None,
        is_provisional=provenance.get("is_provisional"),
        observed_days=provenance.get("observed_days"),
        baseline_mean_error_in_sd=error.get("mean_error_in_sd"),
        baseline_std_relative_error=error.get("std_relative_error"),
        degenerate_features=tuple(error.get("degenerate_features") or ()),
    )


class _Row:
    """`aggregate_daily_features` reads exactly these two attributes."""

    __slots__ = ("nodes_json", "relations_json")

    def __init__(self, generated: Dict[str, Any]) -> None:
        self.nodes_json = generated["nodes"]
        self.relations_json = generated["relations"]


def _as_float(value: Any) -> Optional[float]:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


# ── the sweep ────────────────────────────────────────────────────────────────
def run_sweep(
    windows: Sequence[int],
    densities: Sequence[int],
    evaluation_seeds: Sequence[int],
    calibration_seeds: Sequence[int],
    reference_draws: int,
    progress: Callable[[str], None],
) -> Tuple[List[RunOutcome], Dict[int, Dict[str, Dict[str, float]]]]:
    session = _open_session()
    truths = {}
    for density in densities:
        progress(f"reference distribution at {density} entries/day ({reference_draws} draws)")
        truths[density] = reference_stats(ORDINARY, density, reference_draws, label="ordinary")

    splits = [("calibration", calibration_seeds), ("evaluation", evaluation_seeds)]
    outcomes: List[RunOutcome] = []
    longest = max(windows)

    for density in densities:
        for persona in PERSONAS:
            for split, seeds in splits:
                for seed in seeds:
                    # Generated once at the longest window; each cell takes its
                    # tail, so the windows are paired within a participant.
                    history, evaluation = generate_series(persona, seed, longest, density)
                    for window in windows:
                        with _windowed(window):
                            outcomes.append(
                                _run_one(
                                    session,
                                    persona.name,
                                    seed,
                                    split,
                                    window,
                                    density,
                                    history,
                                    evaluation,
                                    truths[density],
                                )
                            )
            progress(f"  {persona.name} @ {density} entries/day: {len(outcomes)} runs so far")

    return outcomes, truths


def supply_check(densities: Sequence[int], seeds: Sequence[int]) -> Dict[str, Any]:
    """Does supplying history beyond the gate change the reading? (No.)

    The epic's independent variable was days of history *supplied*. The
    orchestrator's history query is `.limit(MIN_REFLECTION_BASELINE_DAYS)`, so
    only the most recent gate-many days are ever read and the rest of a
    participant's journal has no effect on their baseline. This measures that
    claim instead of asserting it from a reading of the query.
    """
    session = _open_session()
    truth = reference_stats(ORDINARY, densities[0], 1000, label="ordinary")
    rows: List[Dict[str, Any]] = []
    identical = True
    for persona in PERSONAS:
        for seed in seeds:
            history, evaluation = generate_series(persona, seed, 30, densities[0])
            scores = {}
            for supplied in (14, 21, 30):
                with _windowed(14):
                    outcome = _run_one(
                        session,
                        persona.name,
                        seed + supplied * 10_000,  # a distinct participant id per arm
                        "supply_check",
                        14,
                        densities[0],
                        history[-supplied:],
                        evaluation,
                        truth,
                    )
                # The gate is 14 and the query limit is 14, so only the last 14
                # of `supplied` days can reach the baseline.
                scores[supplied] = outcome.final_score
            rows.append({"persona": persona.name, "seed": seed, **{f"supplied_{k}": v for k, v in scores.items()}})
            if len({json.dumps(value) for value in scores.values()}) != 1:
                identical = False
    return {
        "gate_days": 14,
        "supplied_arms": [14, 21, 30],
        "participants": len(rows),
        "all_arms_identical": identical,
        "finding": (
            "The baseline window is the gate. `.limit(MIN_REFLECTION_BASELINE_DAYS)` means "
            "a participant with thirty days of history is scored against fourteen of them, "
            "so 'days of history supplied' stops being an independent variable above the gate."
            if identical
            else "Arms differed — the coupling assumed by this study does not hold; re-read the query."
        ),
        "rows": rows,
    }


# ── aggregation ──────────────────────────────────────────────────────────────
def _f1_of(sample: Sequence[RunOutcome], threshold: float) -> Optional[float]:
    true_positive = sum(1 for run in sample if run.signal_expected and run.score >= threshold)
    false_positive = sum(1 for run in sample if not run.signal_expected and run.score >= threshold)
    false_negative = sum(1 for run in sample if run.signal_expected and run.score < threshold)
    true_negative = sum(1 for run in sample if not run.signal_expected and run.score < threshold)
    return binary_rates(true_positive, false_positive, false_negative, true_negative)["f1"]


def _auc_of(sample: Sequence[RunOutcome]) -> Optional[float]:
    return roc_auc(
        [run.score for run in sample if run.signal_expected],
        [run.score for run in sample if not run.signal_expected],
    )


def _auc_of_component(sample: Sequence[RunOutcome], component: str) -> Optional[float]:
    """The same separation, from one term of `combine_hybrid_score` on its own.

    `final_score` is `rule*2.0 + deviation*1.15 + temporal*0.85`, three terms
    weighted by numbers that were chosen rather than fitted. Measuring each term
    against the same ground truth is the cheapest way to find out whether the
    combination is adding information or diluting it, and it costs one pass over
    a sample that has already been collected.
    """
    return roc_auc(
        [float(getattr(run, component) or 0.0) for run in sample if run.signal_expected],
        [float(getattr(run, component) or 0.0) for run in sample if not run.signal_expected],
    )


def _mean_or_none(values: Iterable[Optional[float]]) -> Optional[float]:
    present = [value for value in values if value is not None]
    return float(np.mean(present)) if present else None


def summarise_cell(
    positives: Sequence[RunOutcome],
    negatives: Sequence[RunOutcome],
    threshold: float,
    label: str,
    resamples: int,
) -> Dict[str, Any]:
    sample = list(positives) + list(negatives)
    true_positive = sum(1 for run in positives if run.score >= threshold)
    false_negative = len(positives) - true_positive
    false_positive = sum(1 for run in negatives if run.score >= threshold)
    true_negative = len(negatives) - false_positive

    rates = binary_rates(true_positive, false_positive, false_negative, true_negative)
    f1_ci = bootstrap_ci(sample, lambda s: _f1_of(s, threshold), [label, "f1"], resamples)
    auc = _auc_of(sample)
    auc_ci = bootstrap_ci(sample, _auc_of, [label, "auc"], resamples)
    fpr_ci = wilson_interval(false_positive, len(negatives))
    recall_ci = wilson_interval(true_positive, len(positives))

    # Baseline estimation is a property of the history window, which every
    # persona shares, so all runs in the cell contribute to it.
    baseline_mean_errors = [run.baseline_mean_error_in_sd for run in sample]
    baseline_std_errors = [run.baseline_std_relative_error for run in sample]
    baseline_ci = bootstrap_ci(baseline_mean_errors, _mean_or_none, [label, "bmean"], resamples)

    oracle = choose_threshold([(run.signal_expected, run.score) for run in sample])

    return {
        "n_positive": len(positives),
        "n_negative": len(negatives),
        "threshold": threshold,
        **rates,
        "f1_ci_low": f1_ci[0] if f1_ci else None,
        "f1_ci_high": f1_ci[1] if f1_ci else None,
        "recall_ci_low": recall_ci[0] if recall_ci else None,
        "recall_ci_high": recall_ci[1] if recall_ci else None,
        "false_positive_rate_ci_low": fpr_ci[0] if fpr_ci else None,
        "false_positive_rate_ci_high": fpr_ci[1] if fpr_ci else None,
        "auroc": auc,
        "auroc_ci_low": auc_ci[0] if auc_ci else None,
        "auroc_ci_high": auc_ci[1] if auc_ci else None,
        # Each term of the combined score, graded against the same answer.
        "auroc_deviation_only": _auc_of_component(sample, "deviation_score"),
        "auroc_rules_only": _auc_of_component(sample, "rule_score"),
        "auroc_temporal_shift_only": _auc_of_component(sample, "temporal_shift_score"),
        "mean_temporal_shift_positive": _mean_or_none(
            run.temporal_shift_score for run in positives
        ),
        "mean_temporal_shift_negative": _mean_or_none(
            run.temporal_shift_score for run in negatives
        ),
        # Zero in every cell, by construction: a cell supplies exactly `window`
        # days, so the gate is always met and nothing is ever declined. It is
        # reported anyway because a non-zero value means the harness and the
        # orchestrator disagree about the gate, which would invalidate the row.
        "not_enough_data_rate": sum(1 for run in sample if run.status == "not_enough_data") / len(sample)
        if sample
        else None,
        "baseline_mean_error_in_sd": _mean_or_none(baseline_mean_errors),
        "baseline_mean_error_ci_low": baseline_ci[0] if baseline_ci else None,
        "baseline_mean_error_ci_high": baseline_ci[1] if baseline_ci else None,
        "baseline_std_relative_error": _mean_or_none(baseline_std_errors),
        # Best F1 reachable if the threshold were chosen after seeing this cell.
        # An upper bound, not a result: no deployment can pick its threshold
        # from the answers.
        "oracle_f1_in_hindsight": oracle["f1"],
        "oracle_threshold_in_hindsight": oracle["threshold"],
    }


def fit_thresholds(calibration: Sequence[RunOutcome]) -> Dict[str, Dict[str, Any]]:
    """Both operating points, from the calibration participants and nothing else."""
    labelled = [(run.signal_expected, run.score) for run in calibration]
    negatives = sorted((run.score for run in calibration if not run.signal_expected), reverse=True)

    fitted: Dict[str, Dict[str, Any]] = {"max_f1": choose_threshold(labelled)}

    # The lowest cut that keeps at most `TARGET_FPR` of stable participants above
    # it. `allowed` is a floor, so the fitted rate is at or under the target
    # rather than rounding up to it.
    allowed = int(len(negatives) * TARGET_FPR)
    if not negatives:
        cut = 0.0
    elif allowed == 0:
        cut = negatives[0] + 1e-6
    elif allowed >= len(negatives):
        cut = negatives[-1] - 1e-6
    else:
        cut = (negatives[allowed - 1] + negatives[allowed]) / 2
    fitted["fpr_controlled"] = {
        "threshold": round(float(cut), 6),
        "f1": _f1_of(list(calibration), cut),
        "calibration_false_positive_rate": (
            sum(1 for score in negatives if score >= cut) / len(negatives) if negatives else None
        ),
    }
    return fitted


def build_cells(
    outcomes: Sequence[RunOutcome],
    thresholds: Mapping[str, float],
    windows: Sequence[int],
    densities: Sequence[int],
    resamples: int,
) -> List[Dict[str, Any]]:
    evaluation = [run for run in outcomes if run.split == "evaluation"]
    cells: List[Dict[str, Any]] = []
    groups = ("shift_moderate", "shift_large", "all_shift")

    for policy in THRESHOLD_POLICIES:
        threshold = thresholds[policy]
        for window in windows:
            for density in densities:
                in_cell = [run for run in evaluation if run.window == window and run.entries_per_day == density]
                negatives = [run for run in in_cell if not run.signal_expected]
                for group in groups:
                    positives = [
                        run
                        for run in in_cell
                        if run.signal_expected and (group == "all_shift" or run.persona == group)
                    ]
                    if not positives:
                        continue
                    label = f"{policy}:w{window}:d{density}:{group}"
                    cells.append(
                        {
                            "study_version": STUDY_VERSION,
                            "threshold_policy": policy,
                            "window_days": window,
                            "entries_per_day": density,
                            "positive_group": group,
                            **summarise_cell(positives, negatives, threshold, label, resamples),
                        }
                    )
    return cells


def rule_profile(outcomes: Sequence[RunOutcome], windows: Sequence[int]) -> Dict[str, Any]:
    """How often each rule fires, on participants where nothing happened.

    A rule that fires on half of all ordinary days is not detecting anything; it
    is a constant with a name. The rule engine's hits are weighted at 2.0 in
    `combine_hybrid_score` — twice the deviation term — so their base rate on
    stable participants is the single largest thing standing between the score
    and a low false-positive rate, and it is invisible from the code alone.
    """
    profile: Dict[str, Any] = {}
    for window in windows:
        by_persona: Dict[str, Dict[str, float]] = {}
        for persona in PERSONAS:
            runs = [
                run
                for run in outcomes
                if run.split == "evaluation" and run.window == window and run.persona == persona.name
            ]
            if not runs:
                continue
            counts: Dict[str, int] = {}
            for run in runs:
                for rule in set(run.triggered_rules):
                    counts[rule] = counts.get(rule, 0) + 1
            by_persona[persona.name] = {
                rule: round(count / len(runs), 4) for rule, count in sorted(counts.items())
            }
        profile[str(window)] = by_persona
    return {
        "firing_rate_by_window_and_persona": profile,
        "note": (
            "Share of evaluation runs on which the rule contributed, pooled over entry "
            "densities. The stable row is the base rate: what the rule says about a "
            "participant nothing happened to."
        ),
    }


def derive_minimum(cells: Sequence[Dict[str, Any]], densities: Sequence[int], policy: str) -> Dict[str, Any]:
    """The smallest window that clears the bar, per density and shift size.

    "Clears" is read off interval bounds, not point estimates: F1's lower bound
    at or above `TARGET_F1`, the false-positive rate's upper bound at or below
    `TARGET_FPR`. A `null` means no window in the sweep cleared it, which is a
    result and not a missing value.
    """
    minimums: Dict[str, Any] = {}
    for group in ("shift_moderate", "shift_large", "all_shift"):
        for density in densities:
            candidates = sorted(
                (
                    cell
                    for cell in cells
                    if cell["threshold_policy"] == policy
                    and cell["positive_group"] == group
                    and cell["entries_per_day"] == density
                    and cell["f1_ci_low"] is not None
                    and cell["f1_ci_low"] >= TARGET_F1
                    and cell["false_positive_rate_ci_high"] is not None
                    and cell["false_positive_rate_ci_high"] <= TARGET_FPR
                ),
                key=lambda cell: cell["window_days"],
            )
            minimums[f"{group}@{density}"] = candidates[0]["window_days"] if candidates else None
    return {
        "threshold_policy": policy,
        "criterion": {
            "f1_ci_low_at_least": TARGET_F1,
            "false_positive_rate_ci_high_at_most": TARGET_FPR,
            "stated": "before the sweep was run; see the constants at the top of this script",
        },
        "minimum_window_days": minimums,
    }


def derive_plateau(cells: Sequence[Dict[str, Any]], densities: Sequence[int]) -> Dict[str, Any]:
    """Where baseline estimation error stops repaying an extra day."""
    plateau: Dict[str, Any] = {}
    for density in densities:
        curve = sorted(
            (
                (cell["window_days"], cell["baseline_mean_error_in_sd"])
                for cell in cells
                if cell["entries_per_day"] == density
                and cell["positive_group"] == "all_shift"
                # Baseline error does not depend on the decision threshold; one
                # policy's rows carry it and the other's would duplicate them.
                and cell["threshold_policy"] == THRESHOLD_POLICIES[0]
                and cell["baseline_mean_error_in_sd"] is not None
            ),
        )
        point = None
        for (window_a, error_a), (window_b, error_b) in zip(curve, curve[1:]):
            gain_per_day = (error_a - error_b) / max(1, window_b - window_a)
            if gain_per_day < PLATEAU_MARGINAL_GAIN:
                point = window_a
                break
        plateau[str(density)] = {
            "plateau_window_days": point,
            "curve": [{"window_days": w, "mean_error_in_sd": round(e, 6)} for w, e in curve],
        }
    return {
        "criterion": {"marginal_gain_per_added_day_below": PLATEAU_MARGINAL_GAIN, "units": "standard deviations"},
        "by_density": plateau,
    }


# ── artifacts ────────────────────────────────────────────────────────────────
def _svg_line_chart(
    path: Path,
    title: str,
    y_label: str,
    series: Sequence[Dict[str, Any]],
    windows: Sequence[int],
    y_max: float,
    reference_lines: Sequence[Tuple[float, str]] = (),
) -> None:
    """A line chart with confidence bands, written as SVG by hand.

    matplotlib is not a backend dependency and this study is not a reason to add
    one: three charts of eight points each do not need a plotting stack, and a
    dependency added for a document is a dependency the API image carries
    forever.
    """
    width, height = 760, 420
    left, right, top, bottom = 70, 210, 46, 56
    plot_width = width - left - right
    plot_height = height - top - bottom
    colours = ("#2f6fdb", "#c0562f", "#2c8a5f", "#7a4fb5")

    def x_of(window: int) -> float:
        span = max(windows) - min(windows)
        return left + plot_width * ((window - min(windows)) / span if span else 0.5)

    def y_of(value: float) -> float:
        return top + plot_height * (1 - min(max(value, 0.0), y_max) / y_max)

    parts: List[str] = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" width="{width}" height="{height}" '
        'font-family="Inter, Segoe UI, sans-serif" role="img">',
        f'<title>{title}</title>',
        f'<rect width="{width}" height="{height}" fill="#ffffff"/>',
        f'<text x="{left}" y="26" font-size="15" font-weight="600" fill="#1b1f24">{title}</text>',
    ]

    for step in range(6):
        value = y_max * step / 5
        y = y_of(value)
        parts.append(
            f'<line x1="{left}" y1="{y:.1f}" x2="{left + plot_width}" y2="{y:.1f}" stroke="#e4e7eb" stroke-width="1"/>'
        )
        parts.append(
            f'<text x="{left - 10}" y="{y + 4:.1f}" font-size="11" fill="#6b7280" text-anchor="end">{value:.2f}</text>'
        )

    for window in windows:
        x = x_of(window)
        parts.append(
            f'<text x="{x:.1f}" y="{top + plot_height + 20}" font-size="11" fill="#6b7280" text-anchor="middle">{window}</text>'
        )

    parts.append(
        f'<text x="{left + plot_width / 2:.1f}" y="{height - 16}" font-size="12" fill="#374151" text-anchor="middle">'
        "baseline window / gate (days of the participant's own history)</text>"
    )
    parts.append(
        f'<text transform="translate(20,{top + plot_height / 2:.1f}) rotate(-90)" font-size="12" fill="#374151" '
        f'text-anchor="middle">{y_label}</text>'
    )

    for value, caption in reference_lines:
        y = y_of(value)
        parts.append(
            f'<line x1="{left}" y1="{y:.1f}" x2="{left + plot_width}" y2="{y:.1f}" stroke="#9ca3af" '
            'stroke-width="1" stroke-dasharray="5 4"/>'
        )
        parts.append(f'<text x="{left + 6}" y="{y - 6:.1f}" font-size="11" fill="#6b7280">{caption}</text>')

    for index, line in enumerate(series):
        colour = colours[index % len(colours)]
        points = [(x_of(w), v) for w, v in line["points"] if v is not None]
        band = [(x_of(w), lo, hi) for w, lo, hi in line.get("band", []) if lo is not None and hi is not None]
        if band:
            upper = " ".join(f"{x:.1f},{y_of(hi):.1f}" for x, _, hi in band)
            lower = " ".join(f"{x:.1f},{y_of(lo):.1f}" for x, lo, _ in reversed(band))
            parts.append(f'<polygon points="{upper} {lower}" fill="{colour}" fill-opacity="0.12"/>')
        path_points = " ".join(f"{x:.1f},{y_of(v):.1f}" for x, v in points)
        parts.append(f'<polyline points="{path_points}" fill="none" stroke="{colour}" stroke-width="2"/>')
        for x, value in points:
            parts.append(f'<circle cx="{x:.1f}" cy="{y_of(value):.1f}" r="3" fill="{colour}"/>')
        legend_y = top + 8 + index * 20
        parts.append(
            f'<line x1="{left + plot_width + 16}" y1="{legend_y}" x2="{left + plot_width + 40}" y2="{legend_y}" '
            f'stroke="{colour}" stroke-width="2"/>'
        )
        parts.append(
            f'<text x="{left + plot_width + 46}" y="{legend_y + 4}" font-size="11" fill="#374151">{line["label"]}</text>'
        )

    parts.append("</svg>")
    path.write_text("\n".join(parts) + "\n", encoding="utf-8")


def write_artifacts(
    out_dir: Path,
    outcomes: Sequence[RunOutcome],
    cells: Sequence[Dict[str, Any]],
    summary: Dict[str, Any],
    windows: Sequence[int],
    densities: Sequence[int],
) -> List[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    written: List[Path] = []

    # Gzipped: ten thousand runs is ~6 MB of JSONL and this directory is
    # committed. `mtime=0` so re-running without changing a result produces a
    # byte-identical file rather than a diff made of a timestamp.
    runs_path = out_dir / "runs.jsonl.gz"
    payload = "".join(
        json.dumps(outcome.as_row(), ensure_ascii=False, sort_keys=True) + "\n" for outcome in outcomes
    ).encode("utf-8")
    with gzip.GzipFile(runs_path, "wb", compresslevel=9, mtime=0) as handle:
        handle.write(payload)
    written.append(runs_path)

    cells_path = out_dir / "cells.csv"
    if cells:
        with cells_path.open("w", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=list(cells[0].keys()))
            writer.writeheader()
            writer.writerows(cells)
        written.append(cells_path)

    summary_path = out_dir / "summary.json"
    summary_path.write_text(json.dumps(summary, indent=2, ensure_ascii=False, sort_keys=True) + "\n", encoding="utf-8")
    written.append(summary_path)

    #: The charts show one policy. `cells.csv` carries every policy, and the
    #: report reads the other one out of it.
    plotted_policy = THRESHOLD_POLICIES[0]

    def series_for(metric: str, low: Optional[str] = None, high: Optional[str] = None, group: str = "all_shift"):
        lines = []
        for density in densities:
            selected = {
                cell["window_days"]: cell
                for cell in cells
                if cell["entries_per_day"] == density
                and cell["positive_group"] == group
                and cell["threshold_policy"] == plotted_policy
            }
            lines.append(
                {
                    "label": f"{density} entries/day",
                    "points": [(w, selected[w][metric]) for w in windows if w in selected],
                    "band": [
                        (w, selected[w][low], selected[w][high]) for w in windows if w in selected
                    ]
                    if low and high
                    else [],
                }
            )
        return lines

    auroc_path = out_dir / "auroc_vs_window.svg"
    _svg_line_chart(
        auroc_path,
        "Separation of shift from stable participants (threshold-free)",
        "AUROC (band: 95% bootstrap CI)",
        series_for("auroc", "auroc_ci_low", "auroc_ci_high"),
        windows,
        1.0,
        reference_lines=((0.5, "chance = 0.50"),),
    )
    written.append(auroc_path)

    f1_path = out_dir / "f1_vs_window.svg"
    _svg_line_chart(
        f1_path,
        f"Reflection Signal F1 against window length ({plotted_policy} threshold)",
        "F1 (band: 95% bootstrap CI)",
        series_for("f1", "f1_ci_low", "f1_ci_high"),
        windows,
        1.0,
        reference_lines=((TARGET_F1, f"practical bar F1 = {TARGET_F1:.2f}"),),
    )
    written.append(f1_path)

    fpr_path = out_dir / "fpr_vs_window.svg"
    _svg_line_chart(
        fpr_path,
        f"False positives on stable participants ({plotted_policy} threshold)",
        "false positive rate (band: 95% Wilson CI)",
        series_for("false_positive_rate", "false_positive_rate_ci_low", "false_positive_rate_ci_high"),
        windows,
        1.0,
        reference_lines=((TARGET_FPR, f"practical bar FPR = {TARGET_FPR:.2f}"),),
    )
    written.append(fpr_path)

    baseline_path = out_dir / "baseline_error_vs_window.svg"
    _svg_line_chart(
        baseline_path,
        "Baseline estimation error against window length",
        "mean |estimate - truth| in standard deviations",
        series_for("baseline_mean_error_in_sd", "baseline_mean_error_ci_low", "baseline_mean_error_ci_high"),
        windows,
        1.0,
    )
    written.append(baseline_path)

    return written


# ── entry point ──────────────────────────────────────────────────────────────
def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", default=str(BACKEND.parent / "docs" / "assets" / "data_sufficiency"))
    parser.add_argument("--quick", action="store_true", help="Fewer seeds, windows and draws. Smoke only — not a result.")
    parser.add_argument("--supply-check", action="store_true", help="Also measure whether history beyond the gate is read.")
    parser.add_argument("--reference-draws", type=int, default=REFERENCE_DRAWS)
    parser.add_argument("--resamples", type=int, default=BOOTSTRAP_RESAMPLES)
    args = parser.parse_args()

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    # The orchestrator and the aggregator log at INFO on every day of every run.
    # Left on, the sweep's own progress would be unreadable inside ~200k lines.
    logging.basicConfig(level=logging.WARNING)
    logging.getLogger("app").setLevel(logging.WARNING)

    windows = (1, 3, 14) if args.quick else WINDOWS
    densities = (3,) if args.quick else DENSITIES
    evaluation_seeds = EVALUATION_SEEDS[:6] if args.quick else EVALUATION_SEEDS
    calibration_seeds = CALIBRATION_SEEDS[:6] if args.quick else CALIBRATION_SEEDS
    reference_draws = 400 if args.quick else args.reference_draws
    resamples = 200 if args.quick else args.resamples

    started = time.time()
    outcomes, _ = run_sweep(
        windows, densities, evaluation_seeds, calibration_seeds, reference_draws, progress=print
    )
    print(f"{len(outcomes)} runs in {time.time() - started:.1f}s")

    calibration_window = CALIBRATION_WINDOW if CALIBRATION_WINDOW in windows else max(windows)
    calibration = [
        run for run in outcomes if run.split == "calibration" and run.window == calibration_window
    ]
    fitted = fit_thresholds(calibration)
    thresholds = {policy: float(fitted[policy]["threshold"] or 0.0) for policy in THRESHOLD_POLICIES}
    for policy in THRESHOLD_POLICIES:
        print(f"threshold[{policy}] = {thresholds[policy]:.4f} "
              f"fitted on {len(calibration)} calibration runs at window {calibration_window}")

    cells = build_cells(outcomes, thresholds, windows, densities, resamples)

    summary: Dict[str, Any] = {
        "study_version": STUDY_VERSION,
        "data_classification": "synthetic",
        "generated_at_utc": datetime.now(timezone.utc).replace(microsecond=0, tzinfo=None).isoformat() + "Z",
        "design": {
            "windows": list(windows),
            "densities": list(densities),
            "evaluation_seeds": len(evaluation_seeds),
            "calibration_seeds": len(calibration_seeds),
            "personas": [
                {"name": p.name, "kind": p.kind, "signal_expected": p.signal_expected, "description": p.description}
                for p in PERSONAS
            ],
            "runs": len(outcomes),
            "bootstrap_resamples": resamples,
            "reference_draws": reference_draws,
            "quick": args.quick,
        },
        "shipped_constants_under_test": {
            "RAMP_UP_DAYS": 14,
            "MIN_REFLECTION_BASELINE_DAYS": "max(env, RAMP_UP_DAYS) = 14",
            "POPULATION_BASELINE": "deleted in #91; not re-estimated here and not restored",
        },
        "thresholds": {
            "fitted": fitted,
            "fitted_on": {
                "split": "calibration",
                "window_days": calibration_window,
                "densities": "pooled",
                "runs": len(calibration),
            },
            "note": (
                "The product ships no decision threshold — nothing in the codebase turns "
                "final_score into signal / no signal. These exist only so precision and "
                "recall are defined at all. Both are fitted once, on participants no "
                "reported number is computed from, and held fixed across every cell. "
                "AUROC is reported alongside because it does not depend on either."
            ),
        },
        "effect_sizes_in_baseline_sd": {
            persona.name: {
                str(density): {
                    feature: round(value, 4)
                    for feature, value in effect_sizes(persona, density, reference_draws).items()
                }
                for density in densities
            }
            for persona in PERSONAS
            if persona.signal_expected
        },
        "decidability": {
            "negatives_per_cell": len(evaluation_seeds),
            "false_positives_allowed": max(
                (k for k in range(len(evaluation_seeds) + 1)
                 if (wilson_interval(k, len(evaluation_seeds)) or (0.0, 1.0))[1] <= TARGET_FPR),
                default=None,
            ),
            "note": (
                "How many stable participants may be flagged in a cell before its "
                "false-positive interval stops clearing the target. `null` means no "
                "count clears it — the cell size is too small for the criterion to be "
                "decidable, and every cell would fail for want of participants rather "
                "than for want of accuracy."
            ),
        },
        "prevalence_caveat": (
            "Precision and F1 depend on how often a real change day occurs, and this design "
            "fixes that at one shifted participant per stable one inside a magnitude group "
            "(two per stable one in all_shift). A day on which a student's state genuinely "
            "changes is far rarer than that in life, and at a lower base rate the same "
            "false-positive rate buys much worse precision. Every F1 here is therefore an "
            "upper bound. AUROC and the false-positive rate do not move with prevalence, "
            "which is why the recommendation rests on them."
        ),
        "minimum_data": {policy: derive_minimum(cells, densities, policy) for policy in THRESHOLD_POLICIES},
        "baseline_error_plateau": derive_plateau(cells, densities),
        "rule_profile": rule_profile(outcomes, windows),
        "feature_order": list(FEATURE_ORDER),
    }

    if args.supply_check:
        summary["supply_check"] = supply_check(densities, evaluation_seeds[:10])

    out_dir = Path(args.out)
    written = write_artifacts(out_dir, outcomes, cells, summary, windows, densities)

    print()
    print(f"minimum window clearing F1>={TARGET_F1} and FPR<={TARGET_FPR} (interval bounds):")
    for policy in THRESHOLD_POLICIES:
        print(f"  [{policy}]")
        for key, value in sorted(summary["minimum_data"][policy]["minimum_window_days"].items()):
            print(f"    {key:<26} {value if value is not None else 'no window in the sweep cleared it'}")
    print()
    print("baseline error plateau (marginal gain per added day < "
          f"{PLATEAU_MARGINAL_GAIN} sd):")
    for density, block in sorted(summary["baseline_error_plateau"]["by_density"].items()):
        print(f"  {density} entries/day: {block['plateau_window_days']} days")
    print()
    for path in written:
        print(f"wrote {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
