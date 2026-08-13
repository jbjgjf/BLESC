"""Generate `sentra/shared/baseline_conformance.json` from the BACKEND implementation.

    python scripts/generate_baseline_conformance.py

The backend is the source of truth for this contract: it has computed a personal
baseline, z-scores and a deviation score since the beginning, and its behaviour
is what the TypeScript port in `frontend/src/lib/baseline.ts` must reproduce.
Every expected value in the fixture is produced by running the real functions —
none is hand-written, so the fixture cannot quietly encode a mistake that both
sides then agree on.

Regenerate only when the backend's arithmetic changes DELIBERATELY.
`tests/test_baseline_conformance.py` fails first if it changes by accident, and
that failure is the point: it is what stops the two stores drifting apart in
silence the way they did in #106.
"""

import json
import sys
from datetime import date, timedelta
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
OUT_PATH = BACKEND.parent / "shared" / "baseline_conformance.json"
sys.path.insert(0, str(BACKEND))

# Every model must be imported before any of them is instantiated, or SQLModel's
# mapper cannot resolve the relationship names between them.
from app.schemas import analytics, entry, extraction, research, structured  # noqa: E402,F401

from app.analytics.aggregation import aggregate_daily_features  # noqa: E402
from app.analytics.baseline import RAMP_UP_DAYS, baseline_provenance, get_effective_baseline  # noqa: E402
from app.analytics.hybrid_inference import score_baseline_deviation  # noqa: E402
from app.analytics.scoring import compute_zscores  # noqa: E402

MIN_BASELINE_DAYS = RAMP_UP_DAYS


class Ext:
    """Stands in for an Extraction row; the aggregator reads only these two."""

    def __init__(self, nodes, relations):
        self.nodes_json = nodes
        self.relations_json = relations


def node(node_id, category, label=None, intensity=0.5, confidence=0.8, duration=None):
    payload = {
        "id": node_id,
        "category": category,
        "label": label if label is not None else node_id,
        "intensity": intensity,
        "confidence": confidence,
    }
    if duration is not None:
        payload["duration"] = duration
    return payload


def rel(source, target, rel_type, confidence=0.7):
    return {"source_id": source, "target_id": target, "type": rel_type, "confidence": confidence}


def vector_for(graphs):
    agg = aggregate_daily_features("fixture_user", date(2026, 8, 1), [Ext(g["nodes"], g["relations"]) for g in graphs])
    return agg.feature_vector_json


def evaluate(today_graphs, history_days):
    """The orchestrator's gate, inline: history length, then baseline, then z."""
    today_vector = vector_for(today_graphs)
    history_vectors = [vector_for(day) for day in history_days]
    observed = len(history_vectors)

    if observed < MIN_BASELINE_DAYS:
        return {
            "status": "not_enough_data",
            "observed_days": observed,
            "required_days": MIN_BASELINE_DAYS,
            "baseline_provenance": baseline_provenance("none", observed),
            "feature_vector": today_vector,
        }

    from app.schemas.analytics import DailyFeatureAggregation

    aggregations = [
        DailyFeatureAggregation(
            user_id="fixture_user",
            day=date(2026, 7, 1) + timedelta(days=index),
            state_count=0, trigger_count=0, protective_count=0, behavior_count=0,
            event_count=0, event_avg_duration=0.0, protective_ratio=1.0,
            isolation_signal=0.0, feature_vector_json=vector,
        )
        for index, vector in enumerate(history_vectors)
    ]
    baseline, baseline_type = get_effective_baseline("fixture_user", aggregations)
    z_scores = compute_zscores(today_vector, baseline.stats_json)
    return {
        "status": "ok",
        "observed_days": observed,
        "baseline_type": baseline_type,
        "baseline_provenance": baseline_provenance(baseline_type, observed),
        "feature_vector": today_vector,
        "z_scores": z_scores,
        "deviation_score": round(score_baseline_deviation(z_scores), 3),
    }


# ── Building blocks ──────────────────────────────────────────────────────────
QUIET_DAY = [{
    "nodes": [
        node("study_session", "Behavior", "study session"),
        node("friend_call", "Protective", "friend call", intensity=0.6),
        node("mild_worry", "State", "mild worry", intensity=0.3),
    ],
    "relations": [rel("friend_call", "mild_worry", "buffers")],
}]

JAPANESE_QUIET_DAY = [{
    "nodes": [
        node("眠れない", "State", "眠れない", intensity=0.4),
        node("友達と話した", "Protective", "友達と話した", intensity=0.6),
        node("部活", "Behavior", "部活"),
    ],
    "relations": [rel("友達と話した", "眠れない", "buffers")],
}]


def ordinary_fortnight(japanese=False):
    """Fourteen unremarkable days that are not identical to each other.

    A history of fourteen IDENTICAL days is the wrong shape to build a contract
    on: every standard deviation collapses to the 0.01 floor, so any movement at
    all produces a z-score in the hundreds and every case saturates the same way.
    Real history varies. These days vary in the small, boring way a fortnight of
    journalling does — a node more or fewer, a slightly different intensity — so
    the z-scores below are the size a reader would expect and a regression in the
    arithmetic is visible instead of drowned.
    """
    labels = (
        [("眠れない", "テスト", "友達と話した", "部活")] if japanese
        else [("mild worry", "exam", "friend call", "study session")]
    )[0]
    state, trigger, protective, behavior = labels
    second_state = "疲れた" if japanese else "tired"
    second_behavior = "宿題" if japanese else "homework"
    days = []
    for index in range(14):
        nodes = [
            node(state, "State", state, intensity=0.25 + (index % 4) * 0.05),
            node(behavior, "Behavior", behavior),
        ]
        # Every count in the vector has to move across the window, or its
        # standard deviation floors at 0.01 and any change on the day under test
        # produces a z-score in the hundreds — a property of the floor, not of
        # the student. One case below is reserved for exactly that corner; the
        # rest should exercise the ordinary path.
        if index % 2 == 0:
            nodes.append(node(second_state, "State", second_state, intensity=0.3))
        if index % 5 == 0:
            nodes.append(node(second_behavior, "Behavior", second_behavior))
        # A protective node on most days, absent on two of them.
        if index % 7 != 3:
            nodes.append(node(protective, "Protective", protective, intensity=0.55 + (index % 3) * 0.05))
        # A trigger every third day.
        if index % 3 == 0:
            nodes.append(node(trigger, "Trigger", trigger, intensity=0.4 + (index % 2) * 0.1))
        relations = [rel(protective, state, "buffers")] if index % 7 != 3 else []
        if index % 3 == 0:
            relations.append(rel(trigger, state, "causes", 0.7 + (index % 2) * 0.05))
        if index % 2 == 0:
            relations.append(rel(behavior, second_state, "co_occurs", 0.6))
        days.append([{"nodes": nodes, "relations": relations}])
    return days


ORDINARY_FORTNIGHT = ordinary_fortnight()
JAPANESE_FORTNIGHT = ordinary_fortnight(japanese=True)

# The fifteenth day of the same ordinary pattern — index 14 continues the cycle.
ORDINARY_NEXT_DAY = [{
    "nodes": [
        node("mild worry", "State", "mild worry", intensity=0.35),
        node("study session", "Behavior", "study session"),
        node("friend call", "Protective", "friend call", intensity=0.65),
    ],
    "relations": [rel("friend call", "mild worry", "buffers")],
}]

CASES = []


def add_case(name, why, today, history):
    CASES.append({
        "name": name,
        "why": why,
        "today": today,
        "history": history,
        "expected": evaluate(today, history),
    })


add_case(
    "cold_start_day_one",
    "A student's first submission. The epic that produced this contract asked for an anomaly score here; #91 established there is nothing honest to compute one from. The contract pins the refusal.",
    QUIET_DAY,
    [],
)

add_case(
    "ramp_day_thirteen_is_still_not_enough",
    "One day short of the ramp. The boundary is the whole decision, so it is pinned on both sides rather than left to a >= that either implementation could get wrong.",
    ORDINARY_NEXT_DAY,
    ORDINARY_FORTNIGHT[:13],
)

add_case(
    "baseline_settles_at_fourteen_days",
    "The first day a reading is produced at all. is_provisional flips to false here and the educator comparison line is allowed to render.",
    ORDINARY_NEXT_DAY,
    ORDINARY_FORTNIGHT,
)

add_case(
    "an_ordinary_day_deviates_by_little",
    "A fifteenth day continuing an unremarkable fortnight. The z-scores are small and the deviation score is near zero — the reading a student should get on a day nothing happened. The formula this replaces returned 1.05 here, and would have returned it on their very first day too, because it never looked at history at all.",
    ORDINARY_NEXT_DAY,
    ORDINARY_FORTNIGHT,
)

add_case(
    "trigger_and_state_inflation",
    "A quiet fortnight, then a day carrying several triggers and distress states. This is the movement the deviation score exists to catch.",
    [{
        "nodes": [
            node("exam_pressure", "Trigger", "exam pressure", intensity=0.8),
            node("family_argument", "Trigger", "family argument", intensity=0.75),
            node("panic", "State", "panic", intensity=0.85),
            node("cant_sleep", "State", "can't sleep", intensity=0.8),
            node("study_session", "Behavior", "study session"),
        ],
        "relations": [
            rel("exam_pressure", "panic", "causes", 0.85),
            rel("family_argument", "cant_sleep", "escalates", 0.8),
        ],
    }],
    ORDINARY_FORTNIGHT,
)

add_case(
    "protective_structure_disappears",
    "The protective node present on all fourteen prior days is gone. protective_ratio carries the largest weight in the table (-0.28) and it is the only negative one, so its collapse moves the score more than anything else.",
    [{
        "nodes": [
            node("study session", "Behavior", "study session"),
            node("mild worry", "State", "mild worry", intensity=0.35),
        ],
        "relations": [],
    }],
    ORDINARY_FORTNIGHT,
)

add_case(
    "japanese_entries_score_identically",
    "A contract exercised only in English would not have caught the tokenisation and node-identity defects this codebase has already shipped twice. Category counting is script-independent; this pins that it stays so — the expected values here match the English fortnight exactly.",
    [{
        "nodes": [
            node("眠れない", "State", "眠れない", intensity=0.35),
            node("部活", "Behavior", "部活"),
            node("友達と話した", "Protective", "友達と話した", intensity=0.65),
        ],
        "relations": [rel("友達と話した", "眠れない", "buffers")],
    }],
    JAPANESE_FORTNIGHT,
)

add_case(
    "isolation_matches_one_exact_label",
    "isolation_signal accumulates only for a Behavior node labelled exactly 'isolation'. '社会的孤立' and 'social isolation' score zero. Ported faithfully and pinned so the brittleness is visible in a fixture rather than discovered in production.",
    [{
        "nodes": [
            node("isolation", "Behavior", "isolation", intensity=0.9),
            node("social_isolation", "Behavior", "social isolation", intensity=0.9),
            node("孤立", "Behavior", "孤立", intensity=0.9),
        ],
        "relations": [],
    }],
    ORDINARY_FORTNIGHT,
)

add_case(
    "event_duration_never_varies_on_the_production_path",
    "The production extraction schema does not ask the model for a node duration, so event_avg_duration is zero on every day while carrying weight 0.08. A permanently-constant feature in a stored z-score map is what #85 was about; the port reports it as degenerate instead of letting it look measured.",
    [{
        "nodes": [
            node("walked_home", "Event", "walked home"),
            node("mild_worry", "State", "mild worry", intensity=0.3),
        ],
        "relations": [rel("walked_home", "mild_worry", "precedes")],
    }],
    [[{
        "nodes": [node("walked_home", "Event", "walked home"), node("mild_worry", "State", "mild worry", intensity=0.3)],
        "relations": [rel("walked_home", "mild_worry", "precedes")],
    }] for _ in range(14)],
)

add_case(
    "a_feature_that_never_moved_floors_its_std",
    "Fourteen days with no Event at all, then a day with three. The standard deviation floors at 0.01 rather than zero, so the z-score is enormous but finite — division by zero is what the floor exists to prevent, and the magnitude is a property of the floor, not evidence of anything.",
    [{
        "nodes": [
            node("walked_home", "Event", "walked home"),
            node("bus_ride", "Event", "bus ride"),
            node("lunch", "Event", "lunch"),
            node("mild_worry", "State", "mild worry", intensity=0.3),
        ],
        "relations": [],
    }],
    [[{"nodes": [node("mild_worry", "State", "mild worry", intensity=0.3)], "relations": []}] for _ in range(14)],
)

contract = {
    "contract": "baseline",
    "version": 1,
    "purpose": (
        "One contract, two implementations. The FastAPI research path computes a personal baseline, "
        "z-scores and a deviation score against SQLite; the Next.js production path writes to Supabase and, "
        "until this contract existed, computed none of it — it wrote "
        "`1 + triggers*0.8 - protective*0.25 + relations*0.05` and rendered the result as a Reflection Signal. "
        "Both are now pinned here so the two stores cannot disagree about what a baseline is."
    ),
    "ramp_up_days": RAMP_UP_DAYS,
    "min_baseline_days": MIN_BASELINE_DAYS,
    "notes": [
        "Expected values in this file are generated by running the backend implementation, not written by hand.",
        "Below min_baseline_days there is no baseline and no z-score. The population baseline that used to fill this window was deleted in #91 because its constants were never measured; see docs/baseline_reestimation.md.",
        "Floats are compared with a tolerance of 1e-9, not for equality. Python's round() is banker's rounding and JavaScript's is not; the difference appears only on an exact half and carries no meaning.",
        "Standard deviation is the population one (numpy ddof=0), floored at 0.01.",
        "estimate_baseline takes its feature keys from the FIRST day in the window only. A feature absent on that day is absent from the baseline; both implementations do this.",
    ],
    "cases": CASES,
}

OUT_PATH.write_text(json.dumps(contract, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"wrote {OUT_PATH} with {len(CASES)} cases")
for case in CASES:
    print(f"  {case['name']}: {case['expected']['status']} observed={case['expected']['observed_days']}")
