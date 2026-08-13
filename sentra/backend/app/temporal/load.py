"""Adapters from stored rows to `SnapshotInput` (#95).

The assembler takes a narrow struct so it can be tested without a database.
This is the other half: the one place that knows what a `graph_snapshots` row
looks like, so a caller reading from the research SQLModel database, from a
Supabase result, or from a fixture file all reach the same assembler through
the same door.

Nothing here computes anything. If a field is missing it stays missing and the
assembler reports the hole — an adapter that invented a default would be
manufacturing provenance, which is the failure the rest of this module exists
to prevent.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any, Iterable, List, Mapping, Optional, Sequence

from .assemble import SnapshotInput


def _as_day(value: Any) -> Optional[date]:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, str) and value:
        try:
            return date.fromisoformat(value[:10])
        except ValueError:
            return None
    return None


def _as_list(value: Any) -> Sequence[Mapping[str, Any]]:
    return [item for item in value if isinstance(item, Mapping)] if isinstance(value, list) else []


def snapshot_input_from_row(row: Any) -> Optional[SnapshotInput]:
    """One `GraphSnapshot` SQLModel row (or any object with the same attributes).

    Returns `None` for a row with no usable day: a snapshot that cannot be
    placed in time cannot participate in a temporal graph, and guessing a date
    for it would put a fabricated observation on a real timeline.
    """
    day = _as_day(getattr(row, "day", None))
    if day is None:
        return None

    snapshot_id = getattr(row, "id", None)
    entry_id = getattr(row, "entry_id", None)
    return SnapshotInput(
        snapshot_id=str(snapshot_id) if snapshot_id is not None else "",
        day=day,
        nodes=_as_list(getattr(row, "nodes_json", None)),
        relations=_as_list(getattr(row, "relations_json", None)),
        entry_id=str(entry_id) if entry_id is not None else None,
        extraction_provider=str(getattr(row, "extraction_provider", None) or "unknown"),
        extraction_model=str(getattr(row, "extraction_model", None) or "unknown"),
        extractor_version=_optional_str(getattr(row, "extractor_version", None)),
        temporal_diff=getattr(row, "temporal_diff_json", None),
    )


def snapshot_input_from_mapping(row: Mapping[str, Any]) -> Optional[SnapshotInput]:
    """One row as a plain dict — the shape a Supabase client returns."""
    day = _as_day(row.get("day"))
    if day is None:
        return None

    snapshot_id = row.get("id")
    entry_id = row.get("entry_id")
    return SnapshotInput(
        snapshot_id=str(snapshot_id) if snapshot_id is not None else "",
        day=day,
        nodes=_as_list(row.get("nodes_json")),
        relations=_as_list(row.get("relations_json")),
        entry_id=str(entry_id) if entry_id is not None else None,
        extraction_provider=str(row.get("extraction_provider") or "unknown"),
        extraction_model=str(row.get("extraction_model") or "unknown"),
        extractor_version=_optional_str(row.get("extractor_version")),
        temporal_diff=row.get("temporal_diff_json"),
    )


def snapshot_inputs(rows: Iterable[Any]) -> List[SnapshotInput]:
    """Adapt a mixed iterable of rows, dropping only what cannot be dated.

    Order does not matter — `assemble_participant_graph` sorts. Rows that carry
    no usable day are dropped here and the count difference is visible to the
    caller as `AssemblyReport.snapshots_seen` being lower than the number of
    rows it fetched.
    """
    adapted: List[SnapshotInput] = []
    for row in rows:
        candidate = (
            snapshot_input_from_mapping(row)
            if isinstance(row, Mapping)
            else snapshot_input_from_row(row)
        )
        if candidate is not None:
            adapted.append(candidate)
    return adapted


def _optional_str(value: Any) -> Optional[str]:
    return str(value) if value not in (None, "") else None
