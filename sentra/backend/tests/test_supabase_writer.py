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


class FakeUser:
    def __init__(self, user_id):
        self.id = user_id


class FakeUserResponse:
    def __init__(self, user):
        self.user = user


class FakeAuth:
    """Stands in for Supabase Auth's token introspection.

    `valid_tokens` maps an access token to the user it belongs to. Anything
    else raises, the way `GET /auth/v1/user` rejects a token it did not issue.
    """

    def __init__(self, valid_tokens):
        self.valid_tokens = valid_tokens
        self.seen = []

    def get_user(self, jwt):
        self.seen.append(jwt)
        if jwt not in self.valid_tokens:
            raise RuntimeError("invalid JWT")
        return FakeUserResponse(FakeUser(self.valid_tokens[jwt]))


class FakeClient:
    def __init__(self, reads=None, fail_tables=(), valid_tokens=None, participants=()):
        self.reads = reads or {}
        self.fail_tables = set(fail_tables)
        self.writes = {}
        self.auth = FakeAuth(valid_tokens or {})
        # (owner_user_id, code) -> participant id, as `participants` would hold.
        self.participants = dict(participants)
        self.queries = []

    def table(self, name):
        if name == "participants":
            return FakeParticipantsTable(self, name)
        return FakeTable(self, name)


class FakeParticipantsTable(FakeTable):
    """`participants` answers from `client.participants`, honouring the filters.

    Written as a real filter application rather than a canned response so that
    a test can catch the owner constraint being dropped — which is the whole
    point of the lookup.
    """

    def execute(self):
        if "participants" in self._client.fail_tables:
            raise RuntimeError("participants rejected")
        self._client.queries.append(list(self._filters))
        owner = next((value for op, col, value in self._filters if op == "eq" and col == "owner_user_id"), None)
        code = next((value for op, col, value in self._filters if op == "eq" and col == "code"), None)
        matches = [
            {"id": participant_id}
            for (row_owner, row_code), participant_id in self._client.participants.items()
            if (owner is None or row_owner == owner) and (code is None or row_code == code)
        ]
        return FakeResponse(matches)


# ── fixtures ─────────────────────────────────────────────────────────────────


def _node(node_id, category="State"):
    return {"id": node_id, "category": category, "label": node_id, "intensity": 0.5, "confidence": 0.9}


def _relation(source, target, confidence=0.9):
    return {"source_id": source, "target_id": target, "type": "causes", "confidence": confidence}


def _computed(nodes=None, relations=None, day=date(2026, 8, 13), baseline_available=False):
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
            baseline_deviation_json={"baseline_available": baseline_available},
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


# ── authorization ────────────────────────────────────────────────────────────
#
# The service-role key bypasses RLS, so `resolve_identity` is the only check
# between a request and another student's rows. Each of these is a way that
# check could be lost.


def _auth_client(monkeypatch, **kwargs):
    client = FakeClient(**kwargs)
    _configured(monkeypatch, client)
    return client


def test_a_request_with_no_token_resolves_to_nobody(monkeypatch):
    _auth_client(monkeypatch, participants={("owner-1", "P01"): "participant-1"})
    with pytest.raises(supabase_writer.NotAuthorized):
        supabase_writer.resolve_identity(None, "P01")


def test_a_non_bearer_authorization_header_is_not_a_token(monkeypatch):
    _auth_client(monkeypatch, participants={("owner-1", "P01"): "participant-1"})
    for header in ("Basic aGk6dGhlcmU=", "Bearer", "Bearer    ", "token-without-scheme"):
        with pytest.raises(supabase_writer.NotAuthorized):
            supabase_writer.resolve_identity(header, "P01")


def test_a_token_supabase_does_not_recognise_is_rejected(monkeypatch):
    """The token is introspected, not decoded here. A forged one has no issuer."""
    _auth_client(
        monkeypatch,
        valid_tokens={"real-token": "owner-1"},
        participants={("owner-1", "P01"): "participant-1"},
    )
    with pytest.raises(supabase_writer.NotAuthorized):
        supabase_writer.resolve_identity("Bearer forged-token", "P01")


def test_a_valid_token_resolves_its_own_participant(monkeypatch):
    client = _auth_client(
        monkeypatch,
        valid_tokens={"token-1": "owner-1"},
        participants={("owner-1", "P01"): "participant-1"},
    )
    identity = supabase_writer.resolve_identity("Bearer token-1", "P01")
    assert identity == {"owner_user_id": "owner-1", "participant_id": "participant-1"}
    assert client.auth.seen == ["token-1"]


def test_a_valid_token_cannot_reach_another_users_participant(monkeypatch):
    """The defect this replaces, stated as a test.

    `owner-2` is signed in and legitimately holds a token. `P01` belongs to
    `owner-1`. Before the fix the participant id arrived in the request body and
    was written straight through, so this succeeded and produced rows under
    another student. The owner filter is what makes it resolve to nothing.
    """
    _auth_client(
        monkeypatch,
        valid_tokens={"token-2": "owner-2"},
        participants={("owner-1", "P01"): "participant-1", ("owner-2", "P02"): "participant-2"},
    )
    with pytest.raises(supabase_writer.NotAuthorized):
        supabase_writer.resolve_identity("Bearer token-2", "P01")


def test_the_participant_lookup_is_constrained_by_owner(monkeypatch):
    """Pins the `.eq("owner_user_id", ...)` filter itself.

    Without it the lookup means "any participant with this code", which across
    tenants is any student at all — and the test above would still pass on a
    fixture where codes happen to be unique.
    """
    client = _auth_client(
        monkeypatch,
        valid_tokens={"token-1": "owner-1"},
        participants={("owner-1", "P01"): "participant-1"},
    )
    supabase_writer.resolve_identity("Bearer token-1", "P01")
    filters = client.queries[-1]
    assert ("eq", "owner_user_id", "owner-1") in filters
    assert ("eq", "code", "P01") in filters


def test_a_failed_participant_lookup_does_not_fall_open(monkeypatch):
    _auth_client(
        monkeypatch,
        valid_tokens={"token-1": "owner-1"},
        participants={("owner-1", "P01"): "participant-1"},
        fail_tables={"participants"},
    )
    with pytest.raises(supabase_writer.NotAuthorized):
        supabase_writer.resolve_identity("Bearer token-1", "P01")


def test_the_request_model_carries_no_identity_fields():
    """The endpoint must not accept an owner or participant id from the body.

    Re-adding either field would silently restore the hole: the body value
    would be written with the service role's authority, and every test above
    would still pass because they exercise the resolver rather than the route.
    """
    from app.main import EntryCreateRequest

    fields = set(EntryCreateRequest.model_fields)
    assert "owner_user_id" not in fields
    assert "participant_id" not in fields


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


def test_an_unsettled_baseline_writes_no_longitudinal_score(monkeypatch):
    """During the 14-day ramp the orchestrator writes 0.0 as "no reading".

    Copying that into `longitudinal_features` would turn the absence of a
    measurement into a time series of zeroes, and a series reads as far
    stronger evidence than any single value in it.
    """
    client = FakeClient()
    _configured(monkeypatch, client)

    supabase_writer.write_entry_result("owner-1", "participant-1", _computed(baseline_available=False))

    for row in client.writes["longitudinal_features"]:
        assert row["feature_json"]["latest_anomaly_score"] is None


def test_a_settled_baseline_carries_its_score_through(monkeypatch):
    client = FakeClient()
    _configured(monkeypatch, client)

    supabase_writer.write_entry_result("owner-1", "participant-1", _computed(baseline_available=True))

    for row in client.writes["longitudinal_features"]:
        assert row["feature_json"]["latest_anomaly_score"] == 2.4


def test_safety_assessment_audit_row_is_written(monkeypatch):
    """The educator cohort view reads model_runs filtered to this artifact_type."""
    client = FakeClient()
    _configured(monkeypatch, client)

    supabase_writer.write_entry_result("owner-1", "participant-1", _computed())

    artifact_types = [row["artifact_type"] for row in client.writes["model_runs"]]
    assert "safety_assessment" in artifact_types
    assert "extraction" in artifact_types
