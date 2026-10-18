"""Generate `sentra/shared/writing_dynamics_conformance.json` from the BACKEND implementation (#468).

    python scripts/generate_writing_dynamics_conformance.py

`app/analytics/writing_dynamics.py` is the source of truth for this contract,
as `baseline.py` is for `baseline_conformance.json`. The TypeScript port in
`frontend/src/lib/writingDynamics.ts` is what production runs, and it must
reproduce every expected value here. None of them is hand-written: each one is
the output of the real function on the input beside it, so the fixture cannot
quietly encode a mistake that both sides then agree on.

Regenerate only when the backend's arithmetic changes DELIBERATELY.
`tests/test_writing_dynamics_conformance.py` fails first if it changes by
accident, and that failure is the point.

The inputs are built to hit the places where a port from Python to JavaScript
goes wrong without anyone noticing:

  - `round()` is round-half-even in Python and half-up in `toFixed`. The cases
    `rounding_ties_*` put an exact binary half at the third and sixth decimal.
  - `_percentile` rounds an index, so `round(4.5)` is 4 in Python and
    `Math.round(4.5)` is 5 in JavaScript. `percentile_index_half_even` has six
    intervals for that reason.
  - `x or y` falls through on 0 as well as on a missing key.
  - `int()` truncates a float `relative_ms`.
"""

import json
import random
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
OUT_PATH = BACKEND.parent / "shared" / "writing_dynamics_conformance.json"
sys.path.insert(0, str(BACKEND))

from app.analytics.baseline import RAMP_UP_DAYS  # noqa: E402
from app.analytics.writing_dynamics import (  # noqa: E402
    CHANGE_Z_THRESHOLD,
    MIN_FIELD_INPUTS,
    MIN_STD,
    PIPELINE_VERSION,
    WRITING_CHANGE_FEATURES,
    WRITING_CHANGE_FIELD,
    WRITING_CHANGE_VERSION,
    writing_dynamics_for_session,
    writing_change_against_baseline,
)

START = "2026-10-01T09:00:00.000Z"


def ev(field, event_type, relative_ms, value_length=None, metadata=None):
    event = {"field_name": field, "event_type": event_type, "occurred_at": START, "relative_ms": relative_ms}
    if value_length is not None:
        event["value_length"] = value_length
    if metadata is not None:
        event["metadata"] = metadata
    return event


def metrics(**overrides):
    base = {
        "focus_count": 0, "blur_count": 0, "input_count": 0, "deletion_count": 0, "paste_count": 0,
        "revision_count": 0, "pause_count": 0, "max_pause_ms": 0, "active_typing_ms": 0, "skipped": True,
    }
    base.update(overrides)
    return base


# ---------------------------------------------------------------------------
# Part 1: per-session dynamics
# ---------------------------------------------------------------------------

def collector_shaped_session():
    """What `EntryTelemetryCollector` actually sends for a two-step submission."""
    events = [
        ev("first_recall_30", "focus", 400),
        ev("first_recall_30", "input", 900, 3),
        ev("first_recall_30", "input", 1300, 9),
        ev("first_recall_30", "input", 1700, 15),
        ev("first_recall_30", "blur", 2100),
        ev("mood", "step_change", 2200, metadata={"from": "first_recall_30", "to": "mood"}),
        ev("mood", "select", 3100, 1),
        ev("journal_entry", "step_change", 3500, metadata={"from": "mood", "to": "journal_entry"}),
        ev("journal_entry", "focus", 3600),
        ev("journal_entry", "input", 5200, 4),
        ev("journal_entry", "input", 5600, 11),
        ev("journal_entry", "input", 6100, 19),
        ev("journal_entry", "input", 9800, 23),   # 3700 ms: a pause
        ev("journal_entry", "input", 10100, 17),  # shorter: a deletion
        ev("journal_entry", "input", 10500, 26),
        ev("journal_entry", "input", 16500, 31),  # 6000 ms: a pause
        ev("journal_entry", "input", 16900, 40),
        ev("journal_entry", "paste", 17000, 52),
        ev("journal_entry", "input", 17100, 52),
        ev("journal_entry", "blur", 18000),
        ev("submission", "submit_failed", 18500, metadata={"reason": "network"}),
    ]
    field_metrics = {
        "first_recall_30": metrics(focus_count=1, blur_count=1, input_count=3, active_typing_ms=800, skipped=False),
        "mood": metrics(input_count=1, skipped=False),
        "journal_entry": metrics(
            focus_count=1, blur_count=1, input_count=9, deletion_count=1, paste_count=1,
            revision_count=2, pause_count=2, max_pause_ms=6000, active_typing_ms=2300, skipped=False,
        ),
    }
    return {"field_metrics": field_metrics, "events": events}


def events_only_session():
    """No field metrics at all: every fallback branch in `writing_dynamics_for_field` runs.

    Pauses fall back to the 1500 ms rule, revisions to `metadata.delta`, and the
    final length to the last input event.
    """
    events = [
        ev("journal_entry", "input", 1000, 2, {"delta": 2}),
        ev("journal_entry", "input", 1400, 3, {"delta": 1}),
        ev("journal_entry", "input", 3100, 9, {"delta": 6}),
        ev("journal_entry", "input", 3300, 4, {"delta": -5}),
        ev("journal_entry", "input", 3500, 5, {"delta": 1}),
        ev("journal_entry", "input", 6000, 12, {"delta": 7}),
    ]
    return {"field_metrics": {}, "events": events}


def percentile_session():
    """Six intervals: the p90 index is round(5 * 0.9) = round(4.5), which is 4 in Python."""
    times = [0, 100, 300, 700, 1500, 3100, 6300]
    events = [ev("journal_entry", "input", t, i + 1) for i, t in enumerate(times)]
    return {"field_metrics": {"journal_entry": metrics(input_count=7, skipped=False)}, "events": events}


def unsorted_and_odd_types_session():
    """Out-of-order events, a float relative_ms, a zero value_length, a non-dict metrics value."""
    events = [
        ev("journal_entry", "input", 2500.9, 0),
        ev("journal_entry", "input", 400, 6),
        ev("journal_entry", "input", 1200.2, 10),
        ev("first_recall_30", "input", 700, 5),
    ]
    field_metrics = {
        "journal_entry": metrics(input_count=3, skipped=False, char_count=14),
        "first_recall_30": "not a dict",
    }
    return {"field_metrics": field_metrics, "events": events}


def rounding_tie_session():
    """Exact binary halves at both rounding positions.

    chars_per_minute = 1 / 960000 ms * 60000 = 0.0625, which `round(_, 3)` takes
    to 0.062 and `toFixed(3)` to 0.063. deletion_ratio = 1 / 128 = 0.0078125,
    which `round(_, 6)` takes to 0.007812 and `toFixed(6)` to 0.007813.
    """
    events = [
        ev("journal_entry", "input", 0, 1),
        ev("journal_entry", "input", 960000, 1),
    ]
    return {
        "field_metrics": {"journal_entry": metrics(input_count=128, deletion_count=1, skipped=False)},
        "events": events,
    }


DYNAMICS_CASES = []


def dynamics_case(name, why, session):
    DYNAMICS_CASES.append({
        "name": name,
        "why": why,
        "input": session,
        "expected": writing_dynamics_for_session(session["field_metrics"], session["events"]),
    })


dynamics_case(
    "production_collector_shape",
    "The payload EntryTelemetryCollector sends: metrics present for every touched field, step_change and submit_failed events naming fields of their own.",
    collector_shaped_session(),
)
dynamics_case(
    "events_only_no_field_metrics",
    "Every `x or fallback` branch: pauses from the 1500 ms rule, revisions from metadata.delta, final length from the last input event.",
    events_only_session(),
)
dynamics_case(
    "percentile_index_half_even",
    "Six intervals put the p90 index at round(4.5). Python rounds that to 4; Math.round would pick 5.",
    percentile_session(),
)
dynamics_case(
    "unsorted_float_times_zero_length",
    "Events out of order, a float relative_ms (int() truncates), a value_length of 0 falling through to char_count, and a field whose metrics are not an object.",
    unsorted_and_odd_types_session(),
)
dynamics_case(
    "rounding_ties_half_even",
    "An exact binary half at the third decimal (chars_per_minute) and at the sixth (deletion_ratio). Python rounds both to even.",
    rounding_tie_session(),
)
dynamics_case(
    "empty_session",
    "Nothing collected. No fields, not a field of zeroes.",
    {"field_metrics": {}, "events": []},
)


# ---------------------------------------------------------------------------
# Part 2: change against the student's own baseline
# ---------------------------------------------------------------------------

def features(input_count=20, pause_ratio=0.15, max_pause_ms=6000, deletion_ratio=0.1,
             chars_per_minute=80.0, final_length=200):
    """A `writing_dynamics_for_field` output, reduced to what the comparison reads plus input_count."""
    return {
        "pipeline_version": PIPELINE_VERSION,
        "field_name": WRITING_CHANGE_FIELD,
        "input_count": input_count,
        "pause_ratio": pause_ratio,
        "max_pause_ms": max_pause_ms,
        "deletion_ratio": deletion_ratio,
        "chars_per_minute": chars_per_minute,
        "final_length": final_length,
    }


def ordinary_days(count, seed):
    """A student whose writing varies a little from day to day, around a stable centre."""
    rng = random.Random(seed)
    return [
        [features(
            input_count=rng.randint(15, 40),
            pause_ratio=round(rng.uniform(0.08, 0.2), 6),
            max_pause_ms=rng.randint(4000, 9000),
            deletion_ratio=round(rng.uniform(0.05, 0.15), 6),
            chars_per_minute=round(rng.uniform(60, 100), 3),
            final_length=rng.randint(150, 260),
        )]
        for _ in range(count)
    ]


CHANGE_CASES = []


def change_case(name, why, current, history):
    CHANGE_CASES.append({
        "name": name,
        "why": why,
        "current": current,
        "history_days": history,
        "expected": writing_change_against_baseline(current, history),
    })


change_case(
    "cold_start_day_one",
    "A first entry. There is no baseline, so there is no comparison and no change: the refusal is the contract.",
    features(),
    [],
)
change_case(
    "thirteen_days_is_not_enough",
    "One day short of the ramp. Still nothing, exactly as the graph baseline.",
    features(max_pause_ms=60000),
    ordinary_days(13, seed=1),
)
change_case(
    "an_ordinary_day_is_within_baseline",
    "Fourteen ordinary days and a fifteenth like them. No change is reported.",
    features(input_count=25, pause_ratio=0.14, max_pause_ms=6500, deletion_ratio=0.1, chars_per_minute=80.0, final_length=205),
    ordinary_days(14, seed=2),
)
change_case(
    "longer_hesitation_is_observed",
    "The longest pause and the share of pauses both well above this student's own range. Both reported, larger |z| first.",
    features(input_count=30, pause_ratio=0.45, max_pause_ms=42000, deletion_ratio=0.1, chars_per_minute=78.0, final_length=200),
    ordinary_days(14, seed=3),
)
change_case(
    "shorter_slower_writing_is_observed_as_lower",
    "Less written, and more slowly. Direction 'lower', never a judgement about why.",
    features(input_count=12, pause_ratio=0.15, max_pause_ms=6000, deletion_ratio=0.1, chars_per_minute=20.0, final_length=40),
    ordinary_days(14, seed=4),
)
change_case(
    "more_rewriting_is_observed",
    "Deletions per edit far above the student's own rate: the 'wrote it and took it back' signal.",
    features(input_count=40, pause_ratio=0.15, max_pause_ms=6000, deletion_ratio=0.55, chars_per_minute=75.0, final_length=190),
    ordinary_days(14, seed=5),
)

constant_deletions = ordinary_days(14, seed=6)
for day in constant_deletions:
    for entry in day:
        entry["deletion_ratio"] = 0.0
change_case(
    "a_feature_that_never_moved_is_degenerate_not_a_change",
    "Fourteen days without a single deletion, then some. With no spread the z-score is the change over a floor constant, so it is listed as degenerate and NOT reported (cf. #85).",
    features(input_count=25, deletion_ratio=0.3, pause_ratio=0.14, max_pause_ms=6500, chars_per_minute=80.0, final_length=205),
    constant_deletions,
)

short_interleaved = ordinary_days(14, seed=7)
for index in (1, 4, 9):
    short_interleaved.insert(index, [features(input_count=2, max_pause_ms=0, final_length=30, chars_per_minute=500.0)])
change_case(
    "short_entries_do_not_count_toward_the_baseline",
    "Three days whose only entry was pasted or dictated (fewer than min_field_inputs edits) sit inside the window. They are skipped, and observed_days counts the fourteen that qualify.",
    features(input_count=25, pause_ratio=0.14, max_pause_ms=6500, deletion_ratio=0.1, chars_per_minute=80.0, final_length=205),
    short_interleaved,
)
change_case(
    "a_short_entry_today_is_not_compared",
    "A baseline exists, but today's entry has too few edits to say anything about how it was written.",
    features(input_count=3, max_pause_ms=90000, final_length=12),
    ordinary_days(14, seed=8),
)

multi = ordinary_days(14, seed=9)
multi[0].append(features(input_count=18, pause_ratio=0.3, max_pause_ms=12000, deletion_ratio=0.2, chars_per_minute=50.0, final_length=120))
multi[5].append(features(input_count=1, max_pause_ms=0))
change_case(
    "several_entries_on_one_day_are_averaged",
    "A day with two qualifying entries contributes their mean; a non-qualifying second entry is ignored.",
    features(input_count=25, pause_ratio=0.14, max_pause_ms=6500, deletion_ratio=0.1, chars_per_minute=80.0, final_length=205),
    multi,
)

long_history = ordinary_days(14, seed=10) + [[features(max_pause_ms=900000, final_length=5000)] for _ in range(6)]
change_case(
    "only_the_most_recent_fourteen_days_are_the_window",
    "Twenty days of history, the oldest six extreme. History is most recent first and the window stops at fourteen qualifying days, so the old extremes never enter it.",
    features(input_count=25, pause_ratio=0.14, max_pause_ms=6500, deletion_ratio=0.1, chars_per_minute=80.0, final_length=205),
    long_history,
)

end_to_end_current = writing_dynamics_for_session(
    collector_shaped_session()["field_metrics"], collector_shaped_session()["events"]
)[WRITING_CHANGE_FIELD]
change_case(
    "the_collector_session_end_to_end",
    "Today's features are the production_collector_shape output, as the route computes them, compared with fourteen ordinary days.",
    end_to_end_current,
    ordinary_days(14, seed=11),
)


contract = {
    "contract": "writing_dynamics",
    "version": 1,
    "purpose": (
        "One contract, two implementations (#468). The FastAPI research path computed writing dynamics from input "
        "telemetry and was never deployed; the Next.js production path stored the same telemetry and analysed none "
        "of it, while blesc.jp described noticing changes in how a student writes relative to their own past. "
        "Production now runs a TypeScript port. Both are pinned here so they cannot disagree about what a pause, a "
        "rewrite or a change against a student's own baseline is."
    ),
    "pipeline_version": PIPELINE_VERSION,
    "change_pipeline_version": WRITING_CHANGE_VERSION,
    "change_field": WRITING_CHANGE_FIELD,
    "change_features": list(WRITING_CHANGE_FEATURES),
    "ramp_up_days": RAMP_UP_DAYS,
    "min_field_inputs": MIN_FIELD_INPUTS,
    "change_z_threshold": CHANGE_Z_THRESHOLD,
    "min_std": MIN_STD,
    "notes": [
        "Expected values in this file are generated by running the backend implementation (scripts/generate_writing_dynamics_conformance.py), not written by hand.",
        "Rounding is Python's: round-half-even at the third and sixth decimal, and for the percentile index. The TypeScript port reproduces it, so values are compared with a tolerance of 1e-9 and the tie cases are expected to match exactly.",
        "change_z_threshold (2.0) and min_field_inputs (5) are engineering choices, not measured values. Nothing in this repository has measured how often a student's own writing moves two standard deviations on an ordinary day.",
        "Below ramp_up_days qualifying days there is no comparison, as for the graph baseline (#91). Days whose only entries have fewer than min_field_inputs edits do not count.",
        "Standard deviation is the population one, floored at min_std. A feature constant across the window is reported in degenerate_features and never as a change.",
        "The output carries z_scores and baseline statistics for research. The educator surface receives only `changes` (feature and direction), never a z-score (docs/educator_display_policy.md).",
    ],
    "dynamics_cases": DYNAMICS_CASES,
    "change_cases": CHANGE_CASES,
}

OUT_PATH.write_text(json.dumps(contract, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"wrote {OUT_PATH}: {len(DYNAMICS_CASES)} dynamics cases, {len(CHANGE_CASES)} change cases")
for case in CHANGE_CASES:
    expected = case["expected"]
    print(f"  {case['name']}: {expected['status']} observed={expected['observed_days']} changes={expected['changes']}")
