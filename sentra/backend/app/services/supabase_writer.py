"""Server-side mirror of a submission into Supabase (#2).

Until now the browser was the only writer of Supabase. FastAPI computed a
submission against SQLite and returned it; `client.ts` then re-inserted that
response into `entries` / `graph_snapshots` / `insights` and a dozen research
tables. Two consequences followed from that split:

  * SQLite, which the baseline is computed from, is the only place a submission
    is guaranteed to land. On a redeployed host that file is gone, so the
    baseline silently restarts from nothing.
  * Every Supabase insert was one network call in a browser tab. A closed tab
    or a failed request between the FastAPI response and the last insert left
    Supabase holding part of a submission, and no retry existed.

The write now happens here, next to the computation, in one place. SQLite stays
the compute cache; Supabase is what the UI reads.

Degradation is deliberate and layered:

  * No `SUPABASE_URL` -> skipped entirely, status ``skipped``. This is the
    normal local-development path and is logged at info level.
  * URL set but no service-role key, or `supabase` not installed -> skipped
    with a warning. That combination is a misconfiguration, not a choice.
  * The three UI tables are chained (`graph_snapshots` and `insights` reference
    the inserted entry), so a failure there stops the sequence and reports
    ``failed``. The research mirrors that follow are independent and each
    records a warning rather than aborting the rest.

Nothing in here raises. The caller has already computed and persisted the
submission locally; a failed mirror must not turn a successful submission into
a 500.
"""

from __future__ import annotations

import hashlib
import logging
import os
import re
from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple

from ..analytics.graph_features import build_temporal_graph_diff
from ..schemas.structured import EntrySubmissionResponse

logger = logging.getLogger(__name__)

# Mirrors `sentra/frontend/src/lib/temporalDiff.ts`. A node id of the form
# `node_1` is positional: it identifies "the node listed first", not a concept.
# Diffing across the boundary where label-derived ids landed compares unrelated
# things and reports every node as both removed and added.
_LEGACY_POSITIONAL_ID = re.compile(r"^node_\d+$")

# Supabase rejects an oversized request body outright, so the per-submission
# event stream is capped the same way the browser capped it.
_MAX_INTERACTION_EVENTS = 1200
_MAX_GRAPH_CHANGE_ROWS = 24

_client_cache: Dict[Tuple[str, str], Any] = {}


def supabase_credentials() -> Tuple[Optional[str], Optional[str]]:
    """(url, service_role_key), either of which may be absent."""
    url = (os.getenv("SUPABASE_URL") or "").strip() or None
    key = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip() or None
    return url, key


def is_configured() -> bool:
    url, key = supabase_credentials()
    return bool(url and key)


def get_client() -> Optional[Any]:
    """A service-role client, or None when the sync should be skipped.

    The service-role key bypasses RLS, which is what lets this process write
    rows owned by an arbitrary `owner_user_id`. It must never reach the browser.
    """
    url, key = supabase_credentials()
    if not url:
        return None
    if not key:
        logger.warning(
            "[supabase-sync] SUPABASE_URL is set but SUPABASE_SERVICE_ROLE_KEY is not; skipping sync"
        )
        return None

    cached = _client_cache.get((url, key))
    if cached is not None:
        return cached

    try:
        from supabase import create_client
    except ImportError:
        logger.warning(
            "[supabase-sync] SUPABASE_URL is set but the 'supabase' package is not installed; skipping sync"
        )
        return None

    try:
        client = create_client(url, key)
    except Exception:
        logger.exception("[supabase-sync] client construction failed; skipping sync")
        return None

    _client_cache[(url, key)] = client
    return client


def reset_client_cache() -> None:
    """Drop memoised clients. Used by tests that swap the environment."""
    _client_cache.clear()


# ── serialisation ────────────────────────────────────────────────────────────


def _json_safe(value: Any) -> Any:
    """Make a SQLModel-derived structure safe for PostgREST's JSON encoder."""
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    if hasattr(value, "model_dump"):
        return _json_safe(value.model_dump())
    return value


def _as_day(value: Any) -> Optional[str]:
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, str) and value:
        return value[:10]
    return None


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _word_count(text: str) -> int:
    stripped = text.strip()
    return len(stripped.split()) if stripped else 0


def _rows(response: Any) -> List[Dict[str, Any]]:
    return list(getattr(response, "data", None) or [])


def _first_id(response: Any) -> Optional[str]:
    """The id of the first returned row.

    PostgREST returns the inserted rows by default (`Prefer: return=representation`),
    which is how the generated uuid comes back without a follow-up read. No
    `.select()` is chained onto the insert: that chaining only exists in newer
    postgrest-py releases and is unnecessary here.
    """
    rows = _rows(response)
    return rows[0].get("id") if rows else None


# ── temporal diff, recomputed against Supabase history ───────────────────────


def _uses_legacy_positional_ids(nodes: List[Dict[str, Any]]) -> bool:
    return any(_LEGACY_POSITIONAL_ID.match(str(node.get("id") or "")) for node in nodes or [])


def _relation_shift_summary(diff: Dict[str, Any], had_previous: bool) -> str:
    if not had_previous:
        return "first snapshot for this participant; no previous day to compare"
    return ", ".join(
        [
            f"{len(diff['added_nodes'])} node(s) added",
            f"{len(diff['removed_nodes'])} removed",
            f"{len(diff['added_relations'])} relation(s) added",
            f"{len(diff['removed_relations'])} removed",
            f"{len(diff['changed_relations'])} changed",
        ]
    )


def _temporal_diff_against_supabase(
    client: Any,
    participant_id: str,
    day: str,
    nodes: List[Dict[str, Any]],
    relations: List[Dict[str, Any]],
    existing_diff: Dict[str, Any],
) -> Dict[str, Any]:
    """Day-over-day diff computed from Supabase's own history.

    The diff carried in `computed` was built against SQLite, which in
    production may hold nothing for this participant. Recomputing here against
    the table the UI reads is what keeps #106 fixed after the write moved: a
    diff against an unread history is a diff against nothing, and would once
    again mark every node as newly added on every day.
    """
    previous_nodes: List[Dict[str, Any]] = []
    previous_relations: List[Dict[str, Any]] = []
    had_previous = False
    lookup_failed = False

    try:
        previous = (
            client.table("graph_snapshots")
            .select("nodes_json, relations_json, day, created_at")
            .eq("participant_id", participant_id)
            .lt("day", day)
            .order("day", desc=True)
            .order("created_at", desc=True)
            .limit(1)
            .execute()
        )
        rows = _rows(previous)
        if rows:
            had_previous = True
            previous_nodes = rows[0].get("nodes_json") or []
            previous_relations = rows[0].get("relations_json") or []
    except Exception:
        # A failed lookup must stay distinguishable from "no previous day".
        # Collapsing the two is exactly the shape of the bug this replaces.
        lookup_failed = True
        logger.exception("[supabase-sync] previous snapshot lookup failed; diff basis degraded")

    legacy_boundary = had_previous and _uses_legacy_positional_ids(previous_nodes)
    if legacy_boundary:
        previous_nodes, previous_relations = [], []

    diff = build_temporal_graph_diff(nodes, relations, previous_nodes, previous_relations)
    return {
        **(existing_diff or {}),
        **diff,
        "relation_shift_summary": (
            "previous snapshot predates label-derived node identity; not comparable"
            if legacy_boundary
            else _relation_shift_summary(diff, had_previous)
        ),
        "diff_basis": (
            "lookup_failed"
            if lookup_failed
            else "legacy_id_scheme_boundary"
            if legacy_boundary
            else "previous_snapshot"
            if had_previous
            else "first_snapshot_for_participant"
        ),
    }


# ── the three tables the UI reads ────────────────────────────────────────────


def _insert_entry(
    client: Any,
    owner_user_id: str,
    participant_id: str,
    computed: EntrySubmissionResponse,
    observation_type: str,
) -> str:
    extraction = computed.extraction
    response = (
        client.table("entries")
        .insert(
            {
                "owner_user_id": owner_user_id,
                "participant_id": participant_id,
                # The backend has already masked raw_text by this point; the
                # column exists for the TTL window, not for storage.
                "raw_text": None,
                "is_masked": True,
                "extraction_json": _json_safe(extraction),
                "extraction_provider": extraction.extraction_provider,
                "extraction_model": extraction.extraction_model,
                "provenance_hash": computed.entry.provenance_hash,
                "expires_at": _json_safe(computed.entry.expires_at),
                "observation_type": observation_type,
            }
        )
        .execute()
    )
    entry_id = _first_id(response)
    if not entry_id:
        raise RuntimeError("entries insert returned no id")
    return entry_id


def _insert_graph_snapshot(
    client: Any,
    owner_user_id: str,
    participant_id: str,
    entry_id: str,
    computed: EntrySubmissionResponse,
) -> Optional[str]:
    snapshot = computed.graph_snapshot
    if snapshot is None:
        return None

    day = _as_day(snapshot.day) or date.today().isoformat()
    nodes = _json_safe(snapshot.nodes_json or [])
    relations = _json_safe(snapshot.relations_json or [])
    temporal_diff = _temporal_diff_against_supabase(
        client,
        participant_id,
        day,
        nodes,
        relations,
        _json_safe(snapshot.temporal_diff_json or {}),
    )

    response = (
        client.table("graph_snapshots")
        .insert(
            {
                "owner_user_id": owner_user_id,
                "participant_id": participant_id,
                "entry_id": entry_id,
                "day": day,
                "nodes_json": nodes,
                "relations_json": relations,
                "graph_summary_json": _json_safe(snapshot.graph_summary_json or {}),
                "temporal_diff_json": temporal_diff,
                "extraction_provider": computed.extraction.extraction_provider,
                "extraction_model": computed.extraction.extraction_model,
            }
        )
        .execute()
    )
    return _first_id(response)


def _insert_insight(
    client: Any,
    owner_user_id: str,
    participant_id: str,
    entry_id: str,
    graph_snapshot_id: Optional[str],
    computed: EntrySubmissionResponse,
) -> Optional[str]:
    anomaly = computed.anomaly_result
    explanation = computed.explanation
    if anomaly is None and explanation is None:
        return None

    day = (
        _as_day(anomaly.day if anomaly else None)
        or _as_day(explanation.day if explanation else None)
        or date.today().isoformat()
    )
    graph_summary = (
        _json_safe(explanation.graph_summary_json) if explanation and explanation.graph_summary_json else None
    )
    if graph_summary is None and computed.graph_snapshot is not None:
        graph_summary = _json_safe(computed.graph_snapshot.graph_summary_json or {})

    response = (
        client.table("insights")
        .insert(
            {
                "owner_user_id": owner_user_id,
                "participant_id": participant_id,
                "entry_id": entry_id,
                "graph_snapshot_id": graph_snapshot_id,
                "day": day,
                "anomaly_score": anomaly.anomaly_score if anomaly else 0,
                "z_scores_json": _json_safe(anomaly.z_scores_json) if anomaly else {},
                "triggered_rules_json": _json_safe(explanation.triggered_rules_json) if explanation else [],
                "baseline_deviation_json": _json_safe(explanation.baseline_deviation_json) if explanation else {},
                "changed_relations_json": _json_safe(explanation.changed_relations_json) if explanation else [],
                "protective_decline_json": _json_safe(explanation.protective_decline_json) if explanation else {},
                "uncertainty_json": _json_safe(explanation.uncertainty_json) if explanation else {},
                "evidence_summaries": _json_safe(explanation.evidence_summaries) if explanation else [],
                "graph_summary_json": graph_summary or {},
                "score_breakdown_json": _json_safe(explanation.score_breakdown_json) if explanation else {},
                "key_relations": _json_safe(explanation.key_relations) if explanation else [],
                "extraction_provider": computed.extraction.extraction_provider,
                "extraction_model": computed.extraction.extraction_model,
            }
        )
        .execute()
    )
    return _first_id(response)


# ── research mirrors ─────────────────────────────────────────────────────────
#
# Each of the helpers below owns one concern and is called inside a guard that
# turns a failure into a warning. They are mirrors of records that already
# exist in SQLite, so losing one degrades research completeness rather than the
# student-facing product.


_DEFAULT_CONSENT: Dict[str, Any] = {
    "app_use": True,
    "research_analysis": True,
    "anonymized_export": False,
    "future_fine_tuning": False,
    "consent_version": "research-consent-v1",
}


def _consent_snapshot(consent: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if not consent:
        return dict(_DEFAULT_CONSENT)
    return {**_DEFAULT_CONSENT, **consent}


def _insert_consent(client: Any, owner_user_id: str, participant_id: str, consent: Dict[str, Any]) -> None:
    client.table("consent_records").insert(
        {
            "owner_user_id": owner_user_id,
            "participant_id": participant_id,
            "app_use": bool(consent["app_use"]),
            "research_analysis": bool(consent["research_analysis"]),
            "anonymized_export": bool(consent["anonymized_export"]),
            "future_fine_tuning": bool(consent["future_fine_tuning"]),
            "consent_version": str(consent["consent_version"]),
            "source": "fastapi_sync",
        }
    ).execute()


def _insert_entry_session(
    client: Any,
    owner_user_id: str,
    participant_id: str,
    entry_id: str,
    journal_text: str,
    recall_text: str,
    telemetry: Dict[str, Any],
    consent: Dict[str, Any],
) -> Optional[str]:
    """entry_sessions + entry_fields + interaction_events + entry_research_links."""
    session_response = (
        client.table("entry_sessions")
        .insert(
            {
                "owner_user_id": owner_user_id,
                "participant_id": participant_id,
                "client_session_id": telemetry.get("session_id"),
                "status": "submitted",
                "started_at": telemetry.get("started_at"),
                "submitted_at": telemetry.get("submitted_at"),
                "client_timezone": telemetry.get("client_timezone"),
                "user_agent": telemetry.get("user_agent"),
                "consent_snapshot_json": consent,
                "aggregate_metrics_json": telemetry.get("aggregate_metrics") or {},
            }
        )
        .execute()
    )
    entry_session_id = _first_id(session_response)
    if not entry_session_id:
        return None

    field_metrics = telemetry.get("field_metrics") or {}
    field_rows = []
    for field_name, text in (("journal_entry", journal_text), ("first_recall_30", recall_text)):
        metrics = field_metrics.get(field_name) or {}
        started_at = metrics.get("first_input_at")
        completed_at = metrics.get("last_input_at")
        field_rows.append(
            {
                "owner_user_id": owner_user_id,
                "participant_id": participant_id,
                "entry_session_id": entry_session_id,
                "field_name": field_name,
                "final_text_hash": _sha256(text),
                "char_count": len(text),
                "word_count": _word_count(text),
                "metrics_json": metrics,
                "started_at": started_at if isinstance(started_at, str) else None,
                "completed_at": completed_at if isinstance(completed_at, str) else None,
            }
        )
    client.table("entry_fields").insert(field_rows).execute()

    events = (telemetry.get("events") or [])[:_MAX_INTERACTION_EVENTS]
    if events:
        client.table("interaction_events").insert(
            [
                {
                    "owner_user_id": owner_user_id,
                    "participant_id": participant_id,
                    "entry_session_id": entry_session_id,
                    "field_name": event.get("field_name"),
                    "event_type": event.get("event_type"),
                    "occurred_at": event.get("occurred_at"),
                    "relative_ms": event.get("relative_ms") or 0,
                    "value_length": event.get("value_length"),
                    "selection_start": event.get("selection_start"),
                    "selection_end": event.get("selection_end"),
                    "metadata_json": event.get("metadata") or {},
                }
                for event in events
            ]
        ).execute()

    client.table("entry_research_links").insert(
        {
            "owner_user_id": owner_user_id,
            "participant_id": participant_id,
            "entry_id": entry_id,
            "entry_session_id": entry_session_id,
            "field_name": "combined_submission",
            "source_hash": _sha256(f"{journal_text}\n\n{recall_text}"),
        }
    ).execute()
    return entry_session_id


def _insert_embeddings(
    client: Any,
    owner_user_id: str,
    participant_id: str,
    entry_id: str,
    artifacts: List[Dict[str, Any]],
    pipeline_version: str,
) -> None:
    rows = []
    for artifact in artifacts:
        vector = artifact.get("vector_json") or []
        rows.append(
            {
                "owner_user_id": owner_user_id,
                "participant_id": participant_id,
                "entry_id": entry_id,
                "content_kind": artifact.get("content_kind"),
                "embedding_model": artifact.get("embedding_model"),
                # pgvector's text input format. An empty vector is stored as
                # NULL rather than as a zero-dimensional literal, which the
                # column type would reject.
                "embedding": f"[{','.join(str(value) for value in vector)}]" if vector else None,
                "content_hash": artifact.get("content_hash"),
                "metadata_json": {
                    **(artifact.get("metadata_json") or {}),
                    "backend_local_id": artifact.get("local_id"),
                    "synced_from_backend_response": True,
                    "pipeline_version": pipeline_version,
                },
            }
        )
    if rows:
        client.table("entry_embeddings").insert(rows).execute()


def _insert_writing_features(
    client: Any,
    owner_user_id: str,
    participant_id: str,
    entry_id: str,
    entry_session_id: str,
    artifacts: List[Dict[str, Any]],
) -> None:
    rows = [
        {
            "owner_user_id": owner_user_id,
            "participant_id": participant_id,
            "entry_id": entry_id,
            "entry_session_id": entry_session_id,
            "field_name": artifact.get("field_name"),
            "feature_json": artifact.get("feature_json") or {},
            "pipeline_version": artifact.get("pipeline_version"),
        }
        for artifact in artifacts
    ]
    if rows:
        client.table("writing_features").insert(rows).execute()


def _insert_cognitive_probe(
    client: Any,
    owner_user_id: str,
    participant_id: str,
    entry_id: str,
    entry_session_id: Optional[str],
    artifact: Dict[str, Any],
) -> None:
    client.table("cognitive_probe_features").insert(
        {
            "owner_user_id": owner_user_id,
            "participant_id": participant_id,
            "entry_id": entry_id,
            "entry_session_id": entry_session_id,
            "probe_name": artifact.get("probe_name"),
            "journal_text_hash": artifact.get("journal_text_hash"),
            "recall_text_hash": artifact.get("recall_text_hash"),
            "feature_json": artifact.get("feature_json") or {},
            "pipeline_version": artifact.get("pipeline_version"),
        }
    ).execute()


def _insert_model_runs_and_extraction(
    client: Any,
    owner_user_id: str,
    participant_id: str,
    entry_id: str,
    journal_text: str,
    recall_text: str,
    computed: EntrySubmissionResponse,
    pipeline_version: str,
) -> None:
    """model_runs (extraction + safety_assessment) and the extractions mirror.

    The safety_assessment run is not bookkeeping: the educator cohort view
    reads `model_runs` filtered to that artifact_type. Losing it empties the
    safety column of the dashboard.
    """
    extraction = computed.extraction
    embedding_artifacts = (computed.research_artifacts or {}).get("embedding_artifacts") or []

    run_response = (
        client.table("model_runs")
        .insert(
            {
                "owner_user_id": owner_user_id,
                "participant_id": participant_id,
                "artifact_type": "extraction",
                "artifact_id": str(entry_id),
                "provider": extraction.extraction_provider or "unknown",
                "model": extraction.extraction_model or "unknown",
                "prompt_version": "sentra-production-extraction-v1",
                "schema_version": "sentra-entry-extraction-v1",
                "pipeline_version": pipeline_version,
                "temperature": 0.2,
                "retrieval_config_json": {
                    "embedding_model": (embedding_artifacts[0].get("embedding_model") if embedding_artifacts else "unknown"),
                    "source": "fastapi_sync",
                },
                "input_provenance_json": {
                    "entry_id": entry_id,
                    "field_names": ["journal_entry", "first_recall_30"],
                    "journal_text_hash": _sha256(journal_text),
                    "recall_text_hash": _sha256(recall_text),
                },
                "output_hash": _sha256(str(_json_safe(extraction))),
                "status": "completed",
            }
        )
        .execute()
    )
    model_run_id = _first_id(run_response)

    safety_assessment = extraction.safety_assessment_json or {}
    if safety_assessment:
        client.table("model_runs").insert(
            {
                "owner_user_id": owner_user_id,
                "participant_id": participant_id,
                "artifact_type": "safety_assessment",
                "artifact_id": str(entry_id),
                "provider": "rules",
                "model": "safety-assessment-v1",
                "prompt_version": "safety-assessment-v1",
                "schema_version": "safety-assessment-v1",
                "pipeline_version": pipeline_version,
                "temperature": 0,
                "retrieval_config_json": {
                    "risk_level": safety_assessment.get("risk_level"),
                    "escalation_required": safety_assessment.get("escalation_required"),
                    "reasons": safety_assessment.get("reasons"),
                    "policy_refs": safety_assessment.get("policy_refs"),
                },
                "input_provenance_json": {"entry_id": entry_id},
                "output_hash": _sha256(str(_json_safe(safety_assessment))),
                "status": "completed",
            }
        ).execute()

    client.table("extractions").insert(
        {
            "owner_user_id": owner_user_id,
            "participant_id": participant_id,
            "entry_id": entry_id,
            "model_run_id": model_run_id,
            "nodes_json": _json_safe(extraction.nodes_json or []),
            "relations_json": _json_safe(extraction.relations_json or []),
            "temporal_json": {"summary": extraction.temporal_summary},
            "uncertainty_json": _json_safe(computed.explanation.uncertainty_json) if computed.explanation else {},
            "safety_flags": _json_safe(extraction.safety_flags_json or []),
        }
    ).execute()


def _insert_graph_version(
    client: Any,
    owner_user_id: str,
    participant_id: str,
    entry_id: str,
    graph_snapshot_id: Optional[str],
    computed: EntrySubmissionResponse,
) -> None:
    snapshot = computed.graph_snapshot
    if snapshot is None:
        return

    existing = (
        client.table("graph_versions")
        .select("id", count="exact")
        .eq("owner_user_id", owner_user_id)
        .eq("participant_id", participant_id)
        .execute()
    )
    version_index = (getattr(existing, "count", None) or 0) + 1

    nodes = _json_safe(snapshot.nodes_json or [])
    relations = _json_safe(snapshot.relations_json or [])
    version_response = (
        client.table("graph_versions")
        .insert(
            {
                "owner_user_id": owner_user_id,
                "participant_id": participant_id,
                "entry_id": entry_id,
                "graph_snapshot_id": graph_snapshot_id,
                "version_index": version_index,
                "nodes_json": nodes,
                "relations_json": relations,
                "summary_json": _json_safe(snapshot.graph_summary_json or {}),
            }
        )
        .execute()
    )
    graph_version_id = _first_id(version_response)
    if not graph_version_id:
        return

    change_rows = [
        {
            "owner_user_id": owner_user_id,
            "participant_id": participant_id,
            "graph_version_id": graph_version_id,
            "change_type": "added",
            "entity_type": "node",
            "entity_key": node.get("id"),
            "previous_json": None,
            "current_json": node,
            "semantic_drift_score": 0,
            "trajectory_tags": [node.get("category")],
        }
        for node in nodes[:_MAX_GRAPH_CHANGE_ROWS]
    ] + [
        {
            "owner_user_id": owner_user_id,
            "participant_id": participant_id,
            "graph_version_id": graph_version_id,
            "change_type": "added",
            "entity_type": "relation",
            "entity_key": f"{relation.get('source_id')}:{relation.get('type')}:{relation.get('target_id')}",
            "previous_json": None,
            "current_json": relation,
            "semantic_drift_score": 0,
            "trajectory_tags": [relation.get("type")],
        }
        for relation in relations[:_MAX_GRAPH_CHANGE_ROWS]
    ]
    if change_rows:
        client.table("graph_change_events").insert(change_rows).execute()


def _insert_longitudinal_features(
    client: Any,
    owner_user_id: str,
    participant_id: str,
    computed: EntrySubmissionResponse,
) -> None:
    snapshot = computed.graph_snapshot
    day_value = (
        _as_day(snapshot.day if snapshot else None)
        or _as_day(computed.anomaly_result.day if computed.anomaly_result else None)
        or date.today().isoformat()
    )
    nodes = list(snapshot.nodes_json or []) if snapshot else []
    relations = list(snapshot.relations_json or []) if snapshot else []
    node_count = len(nodes)
    protective_count = sum(1 for node in nodes if node.get("category") == "Protective")
    trigger_count = sum(1 for node in nodes if node.get("category") == "Trigger")
    relation_count = len(relations)
    added_nodes = ((snapshot.temporal_diff_json or {}).get("added_nodes") if snapshot else None) or []

    end = date.fromisoformat(day_value)
    rows = []
    for window_days in (7, 30):
        rows.append(
            {
                "owner_user_id": owner_user_id,
                "participant_id": participant_id,
                "window_days": window_days,
                "window_start": (end - timedelta(days=window_days - 1)).isoformat(),
                "window_end": day_value,
                "pipeline_version": "longitudinal-v1",
                "feature_json": {
                    "latest_anomaly_score": (
                        computed.anomaly_result.anomaly_score if computed.anomaly_result else None
                    ),
                    "node_count": node_count,
                    "relation_count": relation_count,
                    "protective_count": protective_count,
                    "trigger_count": trigger_count,
                    "protective_ratio": (protective_count / node_count) if node_count else 0,
                    "trigger_ratio": (trigger_count / node_count) if node_count else 0,
                    "consistency_proxy": (node_count / relation_count) if relation_count else node_count,
                    "change_rate_proxy": len(added_nodes) if added_nodes else node_count,
                },
            }
        )
    client.table("longitudinal_features").insert(rows).execute()


def _insert_eval_example(
    client: Any,
    owner_user_id: str,
    participant_id: str,
    entry_id: str,
    journal_text: str,
    recall_text: str,
    computed: EntrySubmissionResponse,
    consent: Dict[str, Any],
) -> None:
    if not consent.get("research_analysis", True):
        return
    client.table("eval_examples").insert(
        {
            "owner_user_id": owner_user_id,
            "participant_id": participant_id,
            "source_entry_id": entry_id,
            "task_type": "entry_extraction",
            "input_json": {
                "journal_text_hash": _sha256(journal_text),
                "recall_text_hash": _sha256(recall_text),
                "field_names": ["journal_entry", "first_recall_30"],
                "journal_char_count": len(journal_text),
                "recall_char_count": len(recall_text),
            },
            "expected_output_json": {
                "nodes_json": _json_safe(computed.extraction.nodes_json or []),
                "relations_json": _json_safe(computed.extraction.relations_json or []),
                "graph_summary_json": (
                    _json_safe(computed.graph_snapshot.graph_summary_json or {}) if computed.graph_snapshot else {}
                ),
            },
            "consent_snapshot_json": consent,
            "review_status": "unreviewed",
        }
    ).execute()


# ── entry point ──────────────────────────────────────────────────────────────


def write_entry_result(
    owner_user_id: str,
    participant_id: str,
    computed: EntrySubmissionResponse,
    *,
    observation_type: str = "daily",
    journal_text: str = "",
    recall_text: str = "",
    telemetry: Optional[Dict[str, Any]] = None,
    consent: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Mirror one computed submission into Supabase. Never raises.

    Returns a status record suitable for embedding in the API response, so the
    caller can tell a genuine skip (no Supabase configured) from a failure, and
    the frontend can adopt the Supabase row ids when they exist.
    """
    if not owner_user_id or not participant_id:
        return {"status": "skipped", "reason": "owner_user_id/participant_id not supplied", "warnings": []}

    url, _ = supabase_credentials()
    if not url:
        return {"status": "skipped", "reason": "SUPABASE_URL not set", "warnings": []}

    client = get_client()
    if client is None:
        return {"status": "skipped", "reason": "supabase client unavailable", "warnings": []}

    warnings: List[str] = []
    consent_snapshot = _consent_snapshot(consent)
    telemetry_payload = telemetry or {}
    pipeline_version = (computed.research_artifacts or {}).get("pipeline_version") or "research-pipeline-v1"

    def mirror(label: str, action) -> Any:
        """Run one research mirror; a failure is recorded, not raised."""
        try:
            return action()
        except Exception as exc:
            logger.warning("[supabase-sync] %s mirror failed: %s", label, exc, exc_info=True)
            warnings.append(label)
            return None

    # The three UI tables are chained by foreign key, so this block is
    # all-or-nothing and its failure is the one the caller should see.
    try:
        entry_id = _insert_entry(client, owner_user_id, participant_id, computed, observation_type)
        graph_snapshot_id = _insert_graph_snapshot(client, owner_user_id, participant_id, entry_id, computed)
        insight_id = _insert_insight(
            client, owner_user_id, participant_id, entry_id, graph_snapshot_id, computed
        )
    except Exception as exc:
        logger.warning("[supabase-sync] core write failed: %s", exc, exc_info=True)
        return {"status": "failed", "reason": str(exc), "warnings": warnings}

    logger.info(
        "[supabase-sync] core rows written entry=%s graph_snapshot=%s insight=%s",
        entry_id,
        graph_snapshot_id,
        insight_id,
    )

    artifacts = computed.research_artifacts or {}
    mirror("consent_records", lambda: _insert_consent(client, owner_user_id, participant_id, consent_snapshot))

    entry_session_id: Optional[str] = None
    if telemetry_payload:
        entry_session_id = mirror(
            "entry_sessions",
            lambda: _insert_entry_session(
                client,
                owner_user_id,
                participant_id,
                entry_id,
                journal_text,
                recall_text,
                telemetry_payload,
                consent_snapshot,
            ),
        )

    embedding_artifacts = artifacts.get("embedding_artifacts") or []
    if embedding_artifacts:
        mirror(
            "entry_embeddings",
            lambda: _insert_embeddings(
                client, owner_user_id, participant_id, entry_id, embedding_artifacts, pipeline_version
            ),
        )

    writing_artifacts = artifacts.get("writing_feature_artifacts") or []
    if entry_session_id and writing_artifacts:
        mirror(
            "writing_features",
            lambda: _insert_writing_features(
                client, owner_user_id, participant_id, entry_id, entry_session_id, writing_artifacts
            ),
        )

    cognitive_artifact = artifacts.get("cognitive_probe_artifact")
    if cognitive_artifact:
        mirror(
            "cognitive_probe_features",
            lambda: _insert_cognitive_probe(
                client, owner_user_id, participant_id, entry_id, entry_session_id, cognitive_artifact
            ),
        )

    mirror(
        "model_runs",
        lambda: _insert_model_runs_and_extraction(
            client,
            owner_user_id,
            participant_id,
            entry_id,
            journal_text,
            recall_text,
            computed,
            pipeline_version,
        ),
    )
    mirror(
        "graph_versions",
        lambda: _insert_graph_version(
            client, owner_user_id, participant_id, entry_id, graph_snapshot_id, computed
        ),
    )
    mirror(
        "longitudinal_features",
        lambda: _insert_longitudinal_features(client, owner_user_id, participant_id, computed),
    )
    mirror(
        "eval_examples",
        lambda: _insert_eval_example(
            client,
            owner_user_id,
            participant_id,
            entry_id,
            journal_text,
            recall_text,
            computed,
            consent_snapshot,
        ),
    )

    return {
        "status": "written",
        "entry_id": entry_id,
        "graph_snapshot_id": graph_snapshot_id,
        "insight_id": insight_id,
        "entry_session_id": entry_session_id,
        "warnings": warnings,
    }
