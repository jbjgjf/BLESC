"""Writing-process measures for one submission, per field.

## What this module is allowed to decide

Almost nothing. The collection surface (`src/lib/telemetry.ts`,
`EntryTelemetryCollector`) measures the writing process while the student
types, and the collection inventory approvers read
(`docs/pilot/data-dictionary.json`) states those definitions. This module
reshapes what arrived into the `writing_features` row; it is not a second
opinion about what a pause is.

That distinction was not kept, and the values disagreed (#503). Every metric
was read as

    int(field_metrics.get("pause_count") or <recompute> or 0)

and `0` is falsy, so **the client's correct answer of "no pause happened" was
always replaced by this module's own recomputation** — at a different threshold
(`>= 1500` against the documented `> 2500`) and, for `revision_count`, under a
different definition. One submission therefore carried two answers:
`entry_fields.metrics_json.pause_count` kept the collector's figure verbatim
(`research_pipeline.record_entry_session`), while
`writing_features.feature_json.pause_count` carried this module's. Joining the
two tables gave two numbers for the same field of the same entry.

So: a key the client **sent** is reported as sent, including when it is zero.
The recomputation below is only for a field the client sent no metrics for at
all, and it uses the documented thresholds so that the two paths cannot mean
different things.
"""

from __future__ import annotations

from math import isfinite
from statistics import median
from typing import Any, Dict, Iterable, List, Mapping, Optional


#: Bumped from v1 with #503: the stored values change for any field where the
#: collector reported a zero this module used to overwrite. Rows written under
#: v1 were computed at the 1500ms threshold and carry a `max_pause_ms` that is
#: the largest inter-keystroke interval rather than the largest pause, so they
#: are not comparable with v2 rows and need recomputing from
#: `entry_fields.metrics_json` before the two are read together.
PIPELINE_VERSION = "writing-dynamics-v2"

#: A gap longer than this is a pause rather than continuous typing.
#:
#: `PAUSE_THRESHOLD_MS` in `src/lib/telemetry.ts`, and the definition the
#: collection inventory states for `pause_count`
#: (`docs/pilot/data-dictionary.json`: 「2500ms を超える入力の間隙を1回と数え
#: る」). Strictly greater, as in both of those — a gap of exactly 2500ms is not
#: a pause.
#:
#: `src/app/research/page.tsx`, the research console, uses `>= 1500` for its own
#: collector. That surface is not what the pilot collects (the data dictionary's
#: `field_order` entry says so), and this module used to carry its number.
PAUSE_THRESHOLD_MS = 2500


def _safe_ratio(numerator: float, denominator: float) -> float:
    return round(numerator / denominator, 6) if denominator else 0.0


def _percentile(values: List[int], percentile: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, round((len(ordered) - 1) * percentile)))
    return float(ordered[index])


def _reported(source: Mapping[str, Any], key: str) -> Optional[int]:
    """The figure `source` carries for `key`, or None when it carries none.

    "None" means the key is absent, or holds something that is not a usable
    number — a string from a drifted client, a `null`, a NaN. It does **not**
    mean zero: a zero that arrived is an answer, and the whole of #503 is that
    it used to be discarded. `bool` is excluded because `True` is an `int` in
    Python and is not a count.
    """
    if key not in source:
        return None
    value = source[key]
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if isinstance(value, float) and not isfinite(value):
        return None
    return int(value)


def _metric(source: Mapping[str, Any], key: str, fallback: int) -> int:
    """`source`'s own figure when it has one, otherwise `fallback`."""
    reported = _reported(source, key)
    return fallback if reported is None else reported


def writing_dynamics_for_field(field_name: str, field_metrics: Dict[str, Any], raw_events: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
    events = sorted(
        [event for event in raw_events if event.get("field_name") == field_name],
        key=lambda event: int(event.get("relative_ms") or 0),
    )
    input_events = [event for event in events if event.get("event_type") == "input"]
    input_times = [int(event.get("relative_ms") or 0) for event in input_events]
    intervals = [later - earlier for earlier, later in zip(input_times, input_times[1:]) if later >= earlier]
    # The gaps that are pauses by the documented definition. `pause_count` and
    # `max_pause_ms` are both derived from this one list, so they cannot
    # disagree about which gaps counted — in v1 `max_pause_ms` fell back to
    # `max(intervals)`, the largest inter-keystroke interval, and reported a
    # "longest pause" of 350ms for a student who never stopped typing.
    pauses = [gap for gap in intervals if gap > PAUSE_THRESHOLD_MS]
    # `metadata.delta` is sent by the research console's collector
    # (`src/app/research/page.tsx`) and not by the one the pilot collects with,
    # so this is empty for a participant submission. It is kept because it is
    # the only revision signal available for a field that arrived with no
    # metrics at all, and reported separately as `large_revision_count` so a
    # reader can see which definition produced a figure.
    large_jumps = [
        abs(int((event.get("metadata") or {}).get("delta") or 0))
        for event in input_events
        if abs(int((event.get("metadata") or {}).get("delta") or 0)) > 1
    ]
    # v1 fell back to `field_metrics["char_count"]`, which is never there:
    # `char_count` is a column on `entry_fields` computed from the final text
    # (`research_pipeline.record_entry_session`), not a key on `FieldMetrics`.
    final_length = _metric(input_events[-1], "value_length", 0) if input_events else 0
    first_input_ms = input_times[0] if input_times else None
    last_input_ms = input_times[-1] if input_times else None
    active_span_ms = (last_input_ms - first_input_ms) if first_input_ms is not None and last_input_ms is not None else 0
    input_count = _metric(field_metrics, "input_count", len(input_events))
    deletion_count = _metric(field_metrics, "deletion_count", 0)
    revision_count = _metric(field_metrics, "revision_count", len(large_jumps))
    pause_count = _metric(field_metrics, "pause_count", len(pauses))
    return {
        "pipeline_version": PIPELINE_VERSION,
        "field_name": field_name,
        "event_count": len(events),
        "input_count": input_count,
        "first_input_latency_ms": first_input_ms,
        "active_span_ms": active_span_ms,
        "final_length": final_length,
        "chars_per_minute": round((final_length / active_span_ms) * 60000, 3) if active_span_ms > 0 else 0.0,
        "inter_input_median_ms": float(median(intervals)) if intervals else 0.0,
        "inter_input_p90_ms": _percentile(intervals, 0.9),
        "pause_count": pause_count,
        "max_pause_ms": _metric(field_metrics, "max_pause_ms", max(pauses, default=0)),
        "pause_ratio": _safe_ratio(pause_count, max(len(intervals), 1)),
        "deletion_ratio": _safe_ratio(deletion_count, max(input_count, 1)),
        "revision_ratio": _safe_ratio(revision_count, max(input_count, 1)),
        "large_revision_count": len(large_jumps),
        "paste_count": _metric(field_metrics, "paste_count", 0),
        "focus_count": _metric(field_metrics, "focus_count", 0),
        "blur_count": _metric(field_metrics, "blur_count", 0),
    }


def writing_dynamics_for_session(field_metrics: Dict[str, Any], raw_events: Iterable[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    field_names = set(field_metrics.keys())
    for event in raw_events:
        if event.get("field_name"):
            field_names.add(str(event["field_name"]))
    return {
        field_name: writing_dynamics_for_field(
            field_name,
            field_metrics.get(field_name, {}) if isinstance(field_metrics.get(field_name), dict) else {},
            raw_events,
        )
        for field_name in sorted(field_names)
    }
