from __future__ import annotations

from statistics import median
from typing import Any, Dict, Iterable, List, Optional


# v2 (#503): a measurement the collection surface sent is kept even when it is
# 0, and the fallbacks use the collection surface's own pause rule. v1 replaced
# a measured 0 with a recount at a different threshold, so `writing_features`
# could disagree with `entry_fields.metrics_json` for the same submission.
PIPELINE_VERSION = "writing-dynamics-v2"

# The pause rule of the collection surface the pilot collects from
# (`PAUSE_THRESHOLD_MS` in `sentra/frontend/src/lib/telemetry.ts`, and
# `pause_count` in `docs/pilot/data-dictionary.json`): a gap between two inputs
# counts as a pause when it is strictly longer than 2500ms. Only used when the
# client sent no `pause_count` of its own.
PAUSE_THRESHOLD_MS = 2500


def _safe_ratio(numerator: float, denominator: float) -> float:
    return round(numerator / denominator, 6) if denominator else 0.0


def _percentile(values: List[int], percentile: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, round((len(ordered) - 1) * percentile)))
    return float(ordered[index])


def _measured(field_metrics: Dict[str, Any], key: str) -> Optional[int]:
    """The client's own measurement, if it sent one — including 0.

    Reading `field_metrics.get(key) or fallback` treats a measured 0 ("no pause
    happened") as missing and replaces it with a recount, which is the defect
    #503 was filed against. Presence decides here, not truthiness.
    """
    value = field_metrics.get(key)
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def writing_dynamics_for_field(field_name: str, field_metrics: Dict[str, Any], raw_events: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
    events = sorted(
        [event for event in raw_events if event.get("field_name") == field_name],
        key=lambda event: int(event.get("relative_ms") or 0),
    )
    input_events = [event for event in events if event.get("event_type") == "input"]
    input_times = [int(event.get("relative_ms") or 0) for event in input_events]
    intervals = [later - earlier for earlier, later in zip(input_times, input_times[1:]) if later >= earlier]
    # `metadata.delta` is written only by the research console
    # (`src/app/research/page.tsx`). The student collection surface
    # (`src/lib/telemetry.ts`) attaches no metadata to `input` events, so for
    # pilot submissions this list is empty and `revision_count` comes from
    # `field_metrics`, which that surface always sends.
    large_jumps = [
        abs(int((event.get("metadata") or {}).get("delta") or 0))
        for event in input_events
        if abs(int((event.get("metadata") or {}).get("delta") or 0)) > 1
    ]
    pauses = [gap for gap in intervals if gap > PAUSE_THRESHOLD_MS]
    # `char_count` is a column of `entry_fields`, not a key of `FieldMetrics`,
    # so it was never in `field_metrics`; the length comes from the events only.
    last_length = input_events[-1].get("value_length") if input_events else None
    final_length = int(last_length) if isinstance(last_length, (int, float)) and not isinstance(last_length, bool) else 0
    first_input_ms = input_times[0] if input_times else None
    last_input_ms = input_times[-1] if input_times else None
    active_span_ms = (last_input_ms - first_input_ms) if first_input_ms is not None and last_input_ms is not None else 0

    def measured_or(key: str, fallback: int) -> int:
        value = _measured(field_metrics, key)
        return fallback if value is None else value

    input_count = measured_or("input_count", len(input_events))
    deletion_count = measured_or("deletion_count", 0)
    revision_count = measured_or("revision_count", len(large_jumps))
    pause_count = measured_or("pause_count", len(pauses))
    # The longest *pause*, not the longest gap between keystrokes: with no gap
    # over the threshold this is 0, as it is on the collection surface.
    max_pause_ms = measured_or("max_pause_ms", max(pauses) if pauses else 0)
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
        "max_pause_ms": max_pause_ms,
        "pause_ratio": _safe_ratio(pause_count, max(len(intervals), 1)),
        "deletion_ratio": _safe_ratio(deletion_count, max(input_count, 1)),
        "revision_ratio": _safe_ratio(revision_count, max(input_count, 1)),
        "large_revision_count": len(large_jumps),
        "paste_count": measured_or("paste_count", 0),
        "focus_count": measured_or("focus_count", 0),
        "blur_count": measured_or("blur_count", 0),
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
