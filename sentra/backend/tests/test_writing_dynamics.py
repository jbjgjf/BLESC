"""What `writing_features` is allowed to say about how a student wrote (#503).

The collection surface measures the writing process (`src/lib/telemetry.ts`),
the collection inventory states those definitions
(`docs/pilot/data-dictionary.json`), and `research_pipeline` stores the
collector's figures verbatim in `entry_fields.metrics_json` while
`writing_dynamics` reshapes them into `writing_features.feature_json`. The
property under test is that the second does not contradict the first.

Before #503 it did. Every metric was read as `metrics.get(key) or <recompute>`,
so a legitimate `0` was always replaced — at `>= 1500ms` rather than the
documented `> 2500ms` — and `max_pause_ms` fell back to the largest
inter-keystroke interval, which is not a pause at all.

No database here: the whole claim is about one function's arithmetic, and the
cross-table part of it reduces to "a key the client sent is reported as sent",
because `record_entry_session` stores `metrics_json=metrics` unchanged.
"""

from __future__ import annotations

import pytest

from app.analytics.writing_dynamics import (
    PAUSE_THRESHOLD_MS,
    PIPELINE_VERSION,
    writing_dynamics_for_field,
    writing_dynamics_for_session,
)


FIELD = "journal_entry"


def _inputs(*relative_ms: int, field: str = FIELD):
    """One `input` event per timestamp, lengthening by ten characters each."""
    return [
        {
            "field_name": field,
            "event_type": "input",
            "relative_ms": at,
            "value_length": (index + 1) * 10,
        }
        for index, at in enumerate(relative_ms)
    ]


#: What `EntryTelemetryCollector` sends for a field that was typed into
#: continuously: it saw no gap over its 2500ms threshold, so both pause figures
#: are zero. This is the shape that v1 discarded.
NO_PAUSE_OBSERVED = {
    "focus_count": 1,
    "blur_count": 1,
    "input_count": 3,
    "deletion_count": 0,
    "paste_count": 0,
    "revision_count": 0,
    "pause_count": 0,
    "max_pause_ms": 0,
    "active_typing_ms": 2200,
}


def test_the_pipeline_version_records_that_the_definitions_changed():
    assert PIPELINE_VERSION == "writing-dynamics-v2"


def test_the_threshold_is_the_one_the_collection_inventory_states():
    assert PAUSE_THRESHOLD_MS == 2500


class TestAReportedZeroIsAnAnswer:
    """The defect in #503, as the two figures it produced."""

    def test_no_pause_observed_stays_no_pause(self):
        # Gaps of 300ms, 1800ms and 400ms. None is over 2500ms, so the
        # collector counted none. v1 stored pause_count=1, max_pause_ms=1800.
        features = writing_dynamics_for_field(
            FIELD, NO_PAUSE_OBSERVED, _inputs(1000, 1300, 3100, 3500)
        )
        assert features["pause_count"] == 0
        assert features["max_pause_ms"] == 0
        assert features["pause_ratio"] == 0.0

    def test_a_reported_zero_survives_for_every_count(self):
        """Including the counts that reach the row only as a ratio.

        `deletion_count` and `revision_count` are not emitted themselves — they
        divide `input_count`. A recomputed count therefore showed up as a ratio
        nobody could trace back to a figure the collector had reported.
        """
        zeroed = dict(NO_PAUSE_OBSERVED, input_count=0, revision_count=0, deletion_count=0)
        features = writing_dynamics_for_field(FIELD, zeroed, _inputs(0, 3000, 9000))
        for key in ("input_count", "pause_count", "max_pause_ms"):
            assert features[key] == 0, key
        assert features["deletion_ratio"] == 0.0
        assert features["revision_ratio"] == 0.0

    def test_every_figure_the_collector_sent_is_reported_unchanged(self):
        """`entry_fields.metrics_json` and `writing_features.feature_json` agree.

        `record_entry_session` stores `metrics_json=metrics`, so the collector's
        figure is what the first table holds; this asserts the second holds the
        same one for every key both tables carry.
        """
        metrics = dict(
            NO_PAUSE_OBSERVED,
            input_count=7,
            deletion_count=2,
            revision_count=3,
            paste_count=1,
            pause_count=4,
            max_pause_ms=12_000,
            focus_count=5,
            blur_count=4,
        )
        features = writing_dynamics_for_field(FIELD, metrics, _inputs(0, 1000, 2000))
        shared = (
            "input_count",
            "pause_count",
            "max_pause_ms",
            "paste_count",
            "focus_count",
            "blur_count",
        )
        assert {key: features[key] for key in shared} == {key: metrics[key] for key in shared}
        # The two counts that reach the row only as a ratio of `input_count`.
        assert features["deletion_ratio"] == round(2 / 7, 6)
        assert features["revision_ratio"] == round(3 / 7, 6)


class TestTheFallbackWhenNoMetricsArrived:
    """A field that appears only in the event stream has no reported figures."""

    def test_steady_typing_has_no_longest_pause(self):
        # Gaps of 300ms, 350ms, 250ms. v1 reported max_pause_ms=350 — the
        # largest interval — for a student who never stopped.
        features = writing_dynamics_for_field(FIELD, {}, _inputs(0, 300, 650, 900))
        assert features["pause_count"] == 0
        assert features["max_pause_ms"] == 0

    def test_the_longest_pause_is_the_longest_pause_not_the_longest_interval(self):
        # A 1800ms interval (not a pause) and a 3000ms one (a pause).
        features = writing_dynamics_for_field(FIELD, {}, _inputs(0, 1800, 4800))
        assert features["pause_count"] == 1
        assert features["max_pause_ms"] == 3000

    @pytest.mark.parametrize(
        ("gap", "pauses"),
        [(PAUSE_THRESHOLD_MS - 1, 0), (PAUSE_THRESHOLD_MS, 0), (PAUSE_THRESHOLD_MS + 1, 1)],
    )
    def test_the_threshold_is_strictly_greater(self, gap, pauses):
        features = writing_dynamics_for_field(FIELD, {}, _inputs(0, gap))
        assert features["pause_count"] == pauses

    def test_a_value_that_is_not_a_number_falls_back(self):
        for unusable in ("3", None, True, float("nan")):
            features = writing_dynamics_for_field(
                FIELD, {"pause_count": unusable}, _inputs(0, 9000)
            )
            assert features["pause_count"] == 1, unusable


def test_char_count_is_not_consulted_for_the_final_length():
    """v1 read `field_metrics["char_count"]`, a key `FieldMetrics` does not have.

    `char_count` is a column on `entry_fields`, computed from the final text.
    Reading it here would have mixed a whole-field length into a figure taken
    from the last input event.
    """
    events = [{"field_name": FIELD, "event_type": "input", "relative_ms": 10, "value_length": 0}]
    features = writing_dynamics_for_field(FIELD, {"char_count": 480}, events)
    assert features["final_length"] == 0


def test_a_field_present_only_in_the_event_stream_still_gets_a_row():
    """`submitFailed` and `step` record events without touching `field_metrics`."""
    events = _inputs(0, 9000) + [
        {"field_name": "submission", "event_type": "submit_failed", "relative_ms": 9500}
    ]
    session = writing_dynamics_for_session({FIELD: NO_PAUSE_OBSERVED}, events)
    assert sorted(session) == [FIELD, "submission"]
    assert session[FIELD]["pause_count"] == 0
    assert session["submission"]["pause_count"] == 0
    assert session["submission"]["max_pause_ms"] == 0
