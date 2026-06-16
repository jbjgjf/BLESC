from __future__ import annotations

from statistics import median
from typing import Any, Dict, Iterable, List


PIPELINE_VERSION = "writing-dynamics-v1"


def _safe_ratio(numerator: float, denominator: float) -> float:
    return round(numerator / denominator, 6) if denominator else 0.0


def _percentile(values: List[int], percentile: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, round((len(ordered) - 1) * percentile)))
    return float(ordered[index])


def writing_dynamics_for_field(field_name: str, field_metrics: Dict[str, Any], raw_events: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
    events = sorted(
        [event for event in raw_events if event.get("field_name") == field_name],
        key=lambda event: int(event.get("relative_ms") or 0),
    )
    input_events = [event for event in events if event.get("event_type") == "input"]
    input_times = [int(event.get("relative_ms") or 0) for event in input_events]
    intervals = [later - earlier for earlier, later in zip(input_times, input_times[1:]) if later >= earlier]
    large_jumps = [
        abs(int((event.get("metadata") or {}).get("delta") or 0))
        for event in input_events
        if abs(int((event.get("metadata") or {}).get("delta") or 0)) > 1
    ]
    final_length = int(input_events[-1].get("value_length") or field_metrics.get("char_count") or 0) if input_events else 0
    first_input_ms = input_times[0] if input_times else None
    last_input_ms = input_times[-1] if input_times else None
    active_span_ms = (last_input_ms - first_input_ms) if first_input_ms is not None and last_input_ms is not None else 0
    input_count = int(field_metrics.get("input_count") or len(input_events) or 0)
    deletion_count = int(field_metrics.get("deletion_count") or 0)
    revision_count = int(field_metrics.get("revision_count") or len(large_jumps) or 0)
    pause_count = int(field_metrics.get("pause_count") or len([gap for gap in intervals if gap >= 1500]) or 0)
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
        "max_pause_ms": int(field_metrics.get("max_pause_ms") or max(intervals or [0])),
        "pause_ratio": _safe_ratio(pause_count, max(len(intervals), 1)),
        "deletion_ratio": _safe_ratio(deletion_count, max(input_count, 1)),
        "revision_ratio": _safe_ratio(revision_count, max(input_count, 1)),
        "large_revision_count": len(large_jumps),
        "paste_count": int(field_metrics.get("paste_count") or 0),
        "focus_count": int(field_metrics.get("focus_count") or 0),
        "blur_count": int(field_metrics.get("blur_count") or 0),
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
