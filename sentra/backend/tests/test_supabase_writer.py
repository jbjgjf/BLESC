"""What the Supabase mirror must guarantee (#2).

The write moved out of the browser and into the request that computed the
submission. Three properties have to hold for that to be an improvement rather
than a relocation of the same fragility:

  * it never turns a successful submission into a failed request,
  * a missing Supabase is a *choice* (local development), not an error, and a
    misconfigured one is loud,
  * the day-over-day diff is computed against the history the UI reads, not
    against the local cache that production may have lost. That is the #106
    defect; moving the writer must not reintroduce it.

The client is faked rather than mocked at the HTTP layer: these tests are about
which rows get built and what happens when one fails, not about PostgREST.
"""

from datetime import date, datetime

import pytest

from app.schemas.analytics import AnomalyResult
from app.schemas.entry import Entry
from app.schemas.structured import EntrySubmissionResponse, ExtractionResponse, GraphSnapshot, HybridExplanation
from app.services import supabase_writer


# ── a fake PostgREST client ──────────────────────────────────────────────────


class FakeResponse:
    def __init__(self, data, count=None):
        self.data = data
        self.count = count


class FakeTable:
    def __init__(self, client, name):
        self._client = client
        self._name = name
        self._payload = None
        self._filters = []

    # writes
    def insert(self, payload):
        self._payload = payload
        return self

    # reads
    def select(self, *_args, **kwargs):
        self._count = kwargs.get("count")
        return self

    def eq(self, column, value):
        self._filters.append(("eq", column, value))
        return self

    def lt(self, column, value):
        self._filters.append(("lt", column, value))
        return self

    def order(self, *_args, **_kwargs):
        return self

    def limit(self, *_args):
        return self

    def execute(self):
        if self._name in self._client.fail_tables:
            raise RuntimeError(f"{self._name} rejected")
        if self._payload is None:
            return FakeResponse(self._client.reads.get(self._name, []), count=0)
        rows = self._payload if isinstance(self._payload, list) else [self._payload]
        self._client.writes.setdefault(self._name, []).extend(rows)
        return FakeResponse([{**row, "id": f"{self._name}-uuid-{index}"} for index, row in enumerate(rows)])


class FakeClient:
    def __init__(self, reads=None, fail_tables=()):
        self.reads = reads or {}
        self.fail_tables = set(fail_tables)
        self.writes = {}

    def table(self, name):
        return FakeTable(self, name)


# ── fixtures ─────────────────────────────────────────────────────────────────


def _node(node_id, category="State"):
    return {"id": node_id, "category": category, "label": node_id, "intensity": 0.5, "confidence": 0.9}


def _relation(source, target, confidence=0.9):
    return {"source_id": source, "target_id": target, "type": "causes", "confidence": confidence}


def _computed(nodes=None, relations=None, day=date(2026, 8, 13)):
    nodes = nodes if nodes is not None else [_node("sleep"), _node("exam", "Trigger")]
    relations = relations if relations is not None else [_relation("exam", "sleep")]
    created_at = datetime(2026, 8, 13, 9, 0, 0)
    return EntrySubmissionResponse(
        entry=Entry(id=1, user_id="p01", raw_text=None, is_masked=True, created_at=created_at),
        extraction=ExtractionResponse(
            id=1,
            entry_id=1,
            nodes_json=nodes,
            relations_json=relations,
            temporal_summary="today",
            safety_assessment_json={"risk_level": "none", "escalation_required": False, "reasons": [], "policy_refs": []},
            extraction_provider="openai",
            extraction_model="gpt-4o-mini",
            created_at=created_at,
        ),
        graph_snapshot=GraphSnapshot(
            id=1,
            entry_id=1,
            user_id="p01",
            day=day,
            nodes_json=nodes,
            relations_json=relations,
            graph_summary_json={"node_count": len(nodes)},
            temporal_diff_json={},
        ),
        anomaly_result=AnomalyResult(id=1, user_id="p01", day=day, anomaly_score=2.4, z_scores_json={"trigger_count": 1.1}),
        explanation=HybridExplanation(
            id=1,
            user_id="p01",
            day=created_at,
            triggered_rules_json=[],
            baseline_deviation_json={},
            changed_relations_json=[],
            protective_decline_json={},
            uncertainty_json={"level": "low"},
            evidence_summaries=["slept badly before the exam"],
            graph_summary_json={"node_count": len(nodes)},
            score_breakdown_json={"final_score": 2.4},
            key_relations=[],
        ),
        research_artifacts={"pipeline_version": "research-pipeline-v1"},
    )


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)
    supabase_writer.reset_client_cache()
    yield
    supabase_writer.reset_client_cache()


def _configured(monkeypatch, client):
    monkeypatch.setenv("SUPABASE_URL", "https://project.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key")
    monkeypatch.setattr(supabase_writer, "get_client", lambda: client)


# ── graceful degradation ─────────────────────────────────────────────────────


def test_no_supabase_url_is_a_skip_not_a_failure():
    """The local-development path. Nothing configured, nothing written, no raise."""
    result = supabase_writer.write_entry_result("owner-1", "participant-1", _computed())
    assert result["status"] == "skipped"
    assert "SUPABASE_URL" in result["reason"]


def test_url_without_service_role_key_skips_loudly(monkeypatch, caplog):
    """Half-configured is a mistake, not a choice, so it warns rather than passing quietly."""
    monkeypatch.setenv("SUPABASE_URL", "https://project.supabase.co")
    with caplog.at_level("WARNING"):
        result = supabase_writer.write_entry_result("owner-1", "participant-1", _computed())
    assert result["status"] == "skipped"
    assert any("SERVICE_ROLE_KEY" in record.message for record in caplog.records)


def test_missing_identity_skips_without_touching_supabase(monkeypatch):
    """A caller that never resolved a participant cannot have rows written for it."""
    client = FakeClient()
    _configured(monkeypatch, client)
    result = supabase_writer.write_entry_result("", "", _computed())
    assert result["status"] == "skipped"
    assert client.writes == {}


# ── the three tables the UI reads ────────────────────────────────────────────


def test_anomaly_score_reaches_the_insights_table(monkeypatch):
    """The submission's score is readable from Supabase without the browser writing it."""
    client = FakeClient()
    _configured(monkeypatch, client)

    result = supabase_writer.write_entry_result("owner-1", "participant-1", _computed())

    assert result["status"] == "written"
    insight = client.writes["insights"][0]
    assert insight["anomaly_score"] == 2.4
    assert insight["z_scores_json"] == {"trigger_count": 1.1}
    assert insight["evidence_summaries"] == ["slept badly before the exam"]
    # The rows are chained: the insight points at the entry and snapshot just
    # inserted, not at the backend's local integer ids.
    assert insight["entry_id"] == result["entry_id"] == "entries-uuid-0"
    assert insight["graph_snapshot_id"] == result["graph_snapshot_id"]


def test_entry_is_written_masked_and_without_raw_text(monkeypatch):
    client = FakeClient()
    _configured(monkeypatch, client)

    supabase_writer.write_entry_result("owner-1", "participant-1", _computed(), observation_type="weekly")

    entry = client.writes["entries"][0]
    assert entry["raw_text"] is None
    assert entry["is_masked"] is True
    assert entry["observation_type"] == "weekly"
    assert entry["owner_user_id"] == "owner-1"
    assert entry["participant_id"] == "participant-1"


def test_dates_are_serialised_for_postgrest(monkeypatch):
    """`date`/`datetime` do not survive JSON encoding; the snapshot day must be a string."""
    client = FakeClient()
    _configured(monkeypatch, client)

    supabase_writer.write_entry_result("owner-1", "participant-1", _computed())

    assert client.writes["graph_snapshots"][0]["day"] == "2026-08-13"
    assert client.writes["insights"][0]["day"] == "2026-08-13"


# ── the diff is computed against Supabase, not the local cache ───────────────


def test_diff_is_computed_against_the_previous_supabase_snapshot(monkeypatch):
    """#106: a diff built against an unread history marks every node as new, forever."""
    previous_nodes = [_node("sleep"), _node("exam", "Trigger")]
    client = FakeClient(
        reads={
            "graph_snapshots": [
                {"nodes_json": previous_nodes, "relations_json": [_relation("exam", "sleep")], "day": "2026-08-12"}
            ]
        }
    )
    _configured(monkeypatch, client)

    # Today repeats yesterday exactly, and adds nothing.
    supabase_writer.write_entry_result("owner-1", "participant-1", _computed())

    diff = client.writes["graph_snapshots"][0]["temporal_diff_json"]
    assert diff["diff_basis"] == "previous_snapshot"
    assert diff["added_nodes"] == []
    assert diff["added_relations"] == []
    assert "0 node(s) added" in diff["relation_shift_summary"]


def test_first_snapshot_is_labelled_as_such(monkeypatch):
    client = FakeClient(reads={"graph_snapshots": []})
    _configured(monkeypatch, client)

    supabase_writer.write_entry_result("owner-1", "participant-1", _computed())

    diff = client.writes["graph_snapshots"][0]["temporal_diff_json"]
    assert diff["diff_basis"] == "first_snapshot_for_participant"
    assert len(diff["added_nodes"]) == 2


def test_positional_id_history_suppresses_the_comparison(monkeypatch):
    """`node_1` yesterday and a concept today are not the same thing."""
    client = FakeClient(
        reads={"graph_snapshots": [{"nodes_json": [_node("node_1"), _node("node_2")], "relations_json": [], "day": "2026-08-12"}]}
    )
    _configured(monkeypatch, client)

    supabase_writer.write_entry_result("owner-1", "participant-1", _computed())

    diff = client.writes["graph_snapshots"][0]["temporal_diff_json"]
    assert diff["diff_basis"] == "legacy_id_scheme_boundary"
    assert diff["removed_nodes"] == []


# ── failure containment ──────────────────────────────────────────────────────


def test_a_failing_research_mirror_does_not_lose_the_submission(monkeypatch):
    """Research rows duplicate records that survive in SQLite; the UI rows do not."""
    client = FakeClient(fail_tables={"longitudinal_features"})
    _configured(monkeypatch, client)

    result = supabase_writer.write_entry_result("owner-1", "participant-1", _computed())

    assert result["status"] == "written"
    assert result["warnings"] == ["longitudinal_features"]
    assert client.writes["insights"]


def test_a_failing_core_write_is_reported_not_raised(monkeypatch):
    """The submission already computed; a remote failure must not become a 500."""
    client = FakeClient(fail_tables={"entries"})
    _configured(monkeypatch, client)

    result = supabase_writer.write_entry_result("owner-1", "participant-1", _computed())

    assert result["status"] == "failed"
    assert "entries rejected" in result["reason"]
    assert "insights" not in client.writes


def test_safety_assessment_audit_row_is_written(monkeypatch):
    """The educator cohort view reads model_runs filtered to this artifact_type."""
    client = FakeClient()
    _configured(monkeypatch, client)

    supabase_writer.write_entry_result("owner-1", "participant-1", _computed())

    artifact_types = [row["artifact_type"] for row in client.writes["model_runs"]]
    assert "safety_assessment" in artifact_types
    assert "extraction" in artifact_types
