"""Values `writing_features` stores, checked one by one (#503).

`app/analytics/writing_dynamics.py` is the only producer of `writing_features`,
and before this file nothing imported it: the pipeline test only counted the
rows. These tests pin the values, and above all that a measurement the
collection surface (`sentra/frontend/src/lib/telemetry.ts`) sent is kept as it
is — including 0 — rather than replaced by a recount at another threshold.
"""

from app.analytics.writing_dynamics import (
    PAUSE_THRESHOLD_MS,
    PIPELINE_VERSION,
    writing_dynamics_for_field,
    writing_dynamics_for_session,
)


def _inputs(field_name, times, lengths=None):
    lengths = lengths or list(range(1, len(times) + 1))
    return [
        {"field_name": field_name, "event_type": "input", "relative_ms": at, "value_length": length}
        for at, length in zip(times, lengths)
    ]


# Gaps of 300 / 1800 / 400 ms: no gap is over 2500ms, so the browser counts no pause.
GAPS_UNDER_THRESHOLD = _inputs("journal_entry", [0, 300, 2100, 2500])
# Continuous typing, the longest gap 350ms.
CONTINUOUS = _inputs("journal_entry", [0, 200, 550, 800, 1000])

CLIENT_SAID_NO_PAUSE = {
    "input_count": 4,
    "deletion_count": 0,
    "paste_count": 0,
    "revision_count": 0,
    "pause_count": 0,
    "max_pause_ms": 0,
    "active_typing_ms": 2500,
    "focus_count": 1,
    "blur_count": 0,
}


def test_version_is_v2():
    assert PIPELINE_VERSION == "writing-dynamics-v2"


def test_threshold_matches_the_collection_surface():
    assert PAUSE_THRESHOLD_MS == 2500


def test_a_measured_zero_is_kept_not_recounted():
    features = writing_dynamics_for_field("journal_entry", CLIENT_SAID_NO_PAUSE, GAPS_UNDER_THRESHOLD)
    assert features["pause_count"] == 0
    assert features["max_pause_ms"] == 0
    assert features["pause_ratio"] == 0.0
    assert features["pipeline_version"] == "writing-dynamics-v2"


def test_continuous_typing_has_no_pause_even_without_client_metrics():
    features = writing_dynamics_for_field("journal_entry", {}, CONTINUOUS)
    assert features["pause_count"] == 0
    # Not "the longest gap between keystrokes" (350ms).
    assert features["max_pause_ms"] == 0


def test_fallback_uses_strictly_more_than_2500ms():
    # Gaps: 1800 (not a pause under v1's >=1500 rule any more), 2500 (not > 2500), 2501, 4000.
    events = _inputs("journal_entry", [0, 1800, 4300, 6801, 10801])
    features = writing_dynamics_for_field("journal_entry", {}, events)
    assert features["pause_count"] == 2
    assert features["max_pause_ms"] == 4000
    assert features["pause_ratio"] == round(2 / 4, 6)


def test_client_values_win_over_the_recount_when_present():
    events = _inputs("journal_entry", [0, 3000, 9000])
    metrics = {"pause_count": 1, "max_pause_ms": 6000, "input_count": 3}
    features = writing_dynamics_for_field("journal_entry", metrics, events)
    assert features["pause_count"] == 1
    assert features["max_pause_ms"] == 6000


def test_zero_counts_are_kept_for_every_counted_field():
    metrics = {key: 0 for key in ("input_count", "deletion_count", "revision_count", "paste_count", "focus_count", "blur_count")}
    events = [
        {"field_name": "mood", "event_type": "input", "relative_ms": 0, "value_length": 1, "metadata": {"delta": 5}},
        {"field_name": "mood", "event_type": "input", "relative_ms": 10, "value_length": 6, "metadata": {"delta": 5}},
    ]
    features = writing_dynamics_for_field("mood", metrics, events)
    assert features["input_count"] == 0
    assert features["revision_ratio"] == 0.0


def test_final_length_comes_from_the_last_input_event():
    events = _inputs("journal_entry", [0, 100, 200], lengths=[5, 9, 0])
    # A `char_count` in the metrics is not read: the collection surface never sends one.
    features = writing_dynamics_for_field("journal_entry", {"char_count": 999}, events)
    assert features["final_length"] == 0
    features = writing_dynamics_for_field("journal_entry", {}, _inputs("journal_entry", [0, 100], lengths=[3, 7]))
    assert features["final_length"] == 7


def test_session_covers_fields_from_metrics_and_events():
    out = writing_dynamics_for_session({"mood": CLIENT_SAID_NO_PAUSE}, GAPS_UNDER_THRESHOLD)
    assert set(out) == {"mood", "journal_entry"}
    assert out["mood"]["pause_count"] == 0
