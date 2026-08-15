"""The study's apparatus, tested — because a wrong measurement is worse than none.

`docs/data_sufficiency_study.md` recommends a value for a shipped constant. That
recommendation is only worth the harness that produced it, so what is pinned
here is the part a reader has to take on trust: that the same seed produces the
same participants, that the ground truth is what the generators actually
generate, that the metrics are right on inputs whose answers are known by hand,
and that the counterfactual gate really moves the orchestrator.

Nothing here re-runs the sweep. The full study takes minutes; these are the
properties it rests on, at a size that runs in seconds.
"""

from __future__ import annotations

import os
from datetime import date, timedelta

os.environ.setdefault("USE_MOCK_LLM", "true")

import numpy as np
import pytest
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.analytics import baseline as baseline_module
from app.analytics.data_sufficiency import (
    BEHAVIOR_LABELS,
    EVENT_LABELS,
    FEATURE_ORDER,
    ISOLATION_LABEL,
    ORDINARY,
    PROTECTIVE_LABELS,
    STATE_LABELS,
    TRIGGER_LABELS,
    PERSONAS,
    PERSONAS_BY_NAME,
    baseline_error,
    binary_rates,
    choose_threshold,
    effect_sizes,
    feature_vector_for_day,
    generate_day,
    generate_series,
    reference_stats,
    rng_for,
    roc_auc,
    wilson_interval,
)
from app.schemas.analytics import DailyFeatureAggregation
from app.schemas.structured import HybridExplanation
from app.services import inference_orchestrator as orchestrator_module


# ── reproducibility ──────────────────────────────────────────────────────────
def test_the_same_seed_produces_the_same_participant():
    first = generate_series(PERSONAS_BY_NAME["shift_moderate"], 7, 10, 3)
    second = generate_series(PERSONAS_BY_NAME["shift_moderate"], 7, 10, 3)
    assert first == second


def test_a_different_seed_produces_a_different_participant():
    first, _ = generate_series(PERSONAS_BY_NAME["stable"], 7, 10, 3)
    second, _ = generate_series(PERSONAS_BY_NAME["stable"], 8, 10, 3)
    assert first != second


def test_seeds_are_addressed_by_identity_not_by_call_order():
    """Adding a persona to the sweep must not move the data under the others."""
    before = rng_for("stable", 3, 1).integers(0, 2**32, size=4).tolist()
    rng_for("some_new_persona", 3, 1).integers(0, 2**32, size=100)
    after = rng_for("stable", 3, 1).integers(0, 2**32, size=4).tolist()
    assert before == after


def test_shorter_windows_are_the_tail_of_longer_ones():
    """The paired design: two windows differ by the window, not the participant."""
    history, evaluation = generate_series(PERSONAS_BY_NAME["shift_large"], 11, 30, 3)
    assert history[-7:] == history[-30:][-7:]
    assert len(history) == 30 and len(evaluation) == 3


# ── the ground truth is what the generator generated ─────────────────────────
def test_a_stable_participant_has_one_regime_and_expects_no_signal():
    persona = PERSONAS_BY_NAME["stable"]
    assert persona.history == persona.evaluation
    assert persona.signal_expected is False


@pytest.mark.parametrize("name", ["shift_moderate", "shift_large"])
def test_a_shift_participant_moves_the_features_the_score_is_built_from(name):
    """The scripted change has to be adverse in the directions the weights read.

    Without this, a "shift" persona could be a change the deviation table is
    blind to, and a low detection rate would be a property of the script rather
    than of the window length.
    """
    sizes = effect_sizes(PERSONAS_BY_NAME[name], entries_per_day=3, draws=600)
    assert sizes["state_count"] > 0.5
    assert sizes["trigger_count"] > 0.5
    assert sizes["isolation_signal"] > 0.5
    assert sizes["protective_ratio"] < -0.3


def test_a_larger_shift_is_actually_larger():
    moderate = effect_sizes(PERSONAS_BY_NAME["shift_moderate"], 3, draws=600)
    large = effect_sizes(PERSONAS_BY_NAME["shift_large"], 3, draws=600)
    for feature in ("state_count", "trigger_count", "isolation_signal"):
        assert large[feature] > moderate[feature]


def test_event_duration_stays_degenerate_like_production():
    """`event_avg_duration` is zero on every real day; the generator must not fix it."""
    truth = reference_stats(ORDINARY, 3, draws=200, label="test")
    assert truth["event_avg_duration"] == {"mean": 0.0, "std": 0.0}
    error = baseline_error({f: {"mean": 0.0, "std": 0.01} for f in FEATURE_ORDER}, truth)
    assert "event_avg_duration" in error["degenerate_features"]
    assert "event_avg_duration" not in error["per_feature_mean_error_in_sd"]


def test_labels_are_reused_across_days_so_the_graph_diff_measures_change():
    """A fresh label every day would make every node look added and removed."""
    rng = rng_for("test", "vocabulary")
    seen = [
        {node["id"] for entry in generate_day(ORDINARY, 3, rng) for node in entry["nodes"]}
        for _ in range(30)
    ]
    # Bounded vocabulary: thirty days cannot invent new labels.
    vocabulary = {
        *STATE_LABELS, *TRIGGER_LABELS, *PROTECTIVE_LABELS,
        *BEHAVIOR_LABELS, *EVENT_LABELS, ISOLATION_LABEL,
    }
    assert set.union(*seen) <= vocabulary

    # And consecutive days genuinely share nodes — about a third of them — so
    # `added_nodes` on an ordinary day is a handful rather than the whole graph.
    # A fresh vocabulary each day would put this at zero.
    overlaps = [len(a & b) / len(a | b) for a, b in zip(seen, seen[1:])]
    assert float(np.mean(overlaps)) > 0.25, overlaps


# ── metrics, on inputs whose answers are known by hand ───────────────────────
def test_auroc_counts_ties_as_half():
    assert roc_auc([1.0, 1.0], [1.0, 1.0]) == 0.5
    assert roc_auc([2.0, 3.0], [0.0, 1.0]) == 1.0
    assert roc_auc([0.0, 1.0], [2.0, 3.0]) == 0.0
    # The case that matters: a clamped score floors many stable days at exactly
    # zero, and a tie-blind implementation would award every one of them a win.
    assert roc_auc([0.0, 0.0, 5.0], [0.0, 0.0, 0.0]) == pytest.approx((0.5 * 2 * 3 + 3) / 9)


def test_auroc_is_undefined_without_both_classes():
    assert roc_auc([1.0], []) is None
    assert roc_auc([], [1.0]) is None


def test_binary_rates_distinguishes_zero_from_undefined():
    flagged_nothing = binary_rates(true_positive=0, false_positive=0, false_negative=5, true_negative=5)
    assert flagged_nothing["precision"] is None  # nothing was flagged
    assert flagged_nothing["recall"] == 0.0  # five were there to flag
    assert flagged_nothing["f1"] == 0.0

    perfect = binary_rates(true_positive=5, false_positive=0, false_negative=0, true_negative=5)
    assert (perfect["precision"], perfect["recall"], perfect["f1"]) == (1.0, 1.0, 1.0)
    assert perfect["false_positive_rate"] == 0.0


def test_wilson_does_not_claim_certainty_from_twenty_observations():
    low, high = wilson_interval(0, 20)
    assert low == 0.0
    assert 0.15 < high < 0.17  # not zero: this is why the sweep runs forty seeds
    low, high = wilson_interval(0, 40)
    assert 0.08 < high < 0.09


def test_threshold_is_chosen_between_observed_scores():
    chosen = choose_threshold([(True, 5.0), (True, 6.0), (False, 1.0), (False, 2.0)])
    assert chosen["f1"] == 1.0
    assert 2.0 < chosen["threshold"] < 5.0


def test_baseline_error_is_measured_in_standard_deviations():
    truth = {"state_count": {"mean": 3.0, "std": 2.0}}
    estimated = {"state_count": {"mean": 4.0, "std": 3.0}}
    error = baseline_error(estimated, truth)
    assert error["mean_error_in_sd"] == pytest.approx(0.5)  # one count, half a sd
    assert error["std_relative_error"] == pytest.approx(0.5)


def test_baseline_error_records_features_the_estimator_dropped():
    """`estimate_baseline` takes its keys from the first day only; that is visible."""
    truth = {feature: {"mean": 1.0, "std": 1.0} for feature in FEATURE_ORDER}
    error = baseline_error({"state_count": {"mean": 1.0, "std": 1.0}}, truth)
    assert "trigger_count" in error["features_missing_from_baseline"]
    assert error["mean_error_in_sd"] == 0.0


def test_estimated_baseline_error_falls_as_the_square_root_of_the_window():
    """The harness against sampling theory: the error of a mean goes as 1/√n.

    If this did not hold, the learning curve would be measuring a bug.
    """
    truth = reference_stats(ORDINARY, 3, draws=1500, label="test-sqrt")
    errors = {}
    for window in (4, 16):
        per_run = []
        for seed in range(12):
            rng = rng_for("test-sqrt", window, seed)
            vectors = [feature_vector_for_day(generate_day(ORDINARY, 3, rng)) for _ in range(window)]
            estimated = {
                feature: {
                    "mean": float(np.mean([v[feature] for v in vectors])),
                    "std": max(float(np.std([v[feature] for v in vectors])), 0.01),
                }
                for feature in FEATURE_ORDER
            }
            per_run.append(baseline_error(estimated, truth)["mean_error_in_sd"])
        errors[window] = float(np.mean(per_run))

    # Quadrupling the window should roughly halve the error. Loose bounds: this
    # is a sanity check on the harness, not a test of numpy.
    ratio = errors[4] / errors[16]
    assert 1.5 < ratio < 2.6, errors


# ── the counterfactual gate really moves the orchestrator ────────────────────
@pytest.fixture(name="session")
def _session():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)
    with Session(engine) as session:
        yield session


def _seed_history(session, user_id: str, days: int, evaluation_day: date) -> None:
    rng = rng_for("gate-test", user_id)
    for offset in range(days):
        vector = feature_vector_for_day(generate_day(ORDINARY, 2, rng))
        session.add(
            DailyFeatureAggregation(
                user_id=user_id,
                day=evaluation_day - timedelta(days=days - offset),
                state_count=int(vector["state_count"]),
                trigger_count=int(vector["trigger_count"]),
                protective_count=int(vector["protective_count"]),
                behavior_count=int(vector["behavior_count"]),
                event_count=int(vector["event_count"]),
                event_avg_duration=vector["event_avg_duration"],
                protective_ratio=vector["protective_ratio"],
                isolation_signal=vector["isolation_signal"],
                feature_vector_json=vector,
            )
        )
    session.commit()


def test_production_floors_the_gate_at_the_ramp_up_length():
    """The premise of the counterfactual: 7 days cannot be reached by configuration.

    `MIN_REFLECTION_BASELINE_DAYS` is `max(env, RAMP_UP_DAYS)`, which is why the
    study patches the constants in-process rather than setting an environment
    variable — and why patching them is the only way to ask the question at all.
    """
    assert orchestrator_module.MIN_REFLECTION_BASELINE_DAYS == baseline_module.RAMP_UP_DAYS == 14


def test_patching_the_window_changes_what_the_orchestrator_requires(session, monkeypatch):
    """Seven days of history: declined at the shipped gate, scored at a gate of seven."""
    from app.schemas.entry import Entry
    from app.schemas.extraction import Extraction

    evaluation_day = date(2026, 6, 15)

    def evaluate(user_id: str) -> str:
        _seed_history(session, user_id, 7, evaluation_day)
        rng = rng_for("gate-test-eval", user_id)
        for generated in generate_day(ORDINARY, 2, rng):
            entry = Entry(
                user_id=user_id,
                created_at=date_to_datetime(evaluation_day),
                is_masked=True,
            )
            session.add(entry)
            session.commit()
            session.refresh(entry)
            session.add(
                Extraction(
                    entry_id=entry.id,
                    nodes_json=generated["nodes"],
                    relations_json=generated["relations"],
                )
            )
        session.commit()
        orchestrator_module.InferenceOrchestrator(session).process_day(user_id, evaluation_day)
        explanation = session.exec(
            select(HybridExplanation)
            .where(HybridExplanation.user_id == user_id)
            .order_by(HybridExplanation.id.desc())
        ).first()
        return str((explanation.score_breakdown_json or {}).get("status", "ok"))

    assert evaluate("synthetic:shipped-gate") == "not_enough_data"

    monkeypatch.setattr(baseline_module, "RAMP_UP_DAYS", 7)
    monkeypatch.setattr(orchestrator_module, "MIN_REFLECTION_BASELINE_DAYS", 7)
    assert evaluate("synthetic:patched-gate") == "ok"


def date_to_datetime(day: date):
    from datetime import datetime

    return datetime.combine(day, datetime.min.time()).replace(hour=9)


def test_every_persona_is_generated_from_the_ordinary_history_regime():
    """Baseline error is pooled across personas in a cell; that is only valid
    because they share a history regime. Pinned so pooling cannot go stale."""
    assert {persona.history for persona in PERSONAS} == {ORDINARY}
