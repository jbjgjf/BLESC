"""The read-only temporal-graph endpoint (#95).

The assembler is tested against fixtures in
`test_participant_temporal_graph.py`. This covers the seam the fixtures cannot:
that stored `graph_snapshots` rows reach it intact, that provenance survives the
round trip through the database, and that the response says what it is not.

The graph is derived on read rather than stored. Materialising it would create a
second copy of the history to keep in sync with `graph_snapshots`, and the
assembler is deterministic, so recomputing costs less than the drift would.

This module owns its database through `dependency_overrides` rather than through
`DATABASE_URL`. The environment variable is read once, when `app.database` is
first imported, so which module wins depends on pytest's collection order — and
the module that wins deletes the file in its teardown while other modules still
hold connections to it.
"""

from datetime import date, datetime
from pathlib import Path

from fastapi.testclient import TestClient
from sqlmodel import Session, SQLModel, create_engine

from app.database import get_session
from app.main import app
from app.schemas.entry import Entry
from app.schemas.structured import GraphSnapshot

USER = "temporal-graph-user"
DATABASE = Path(__file__).resolve().parent / "test_temporal_graph_endpoint.db"

engine = create_engine(f"sqlite:///{DATABASE}", connect_args={"check_same_thread": False})
client = TestClient(app)


def _session_override():
    with Session(engine) as session:
        yield session


def setup_module():
    DATABASE.unlink(missing_ok=True)
    SQLModel.metadata.create_all(engine)
    app.dependency_overrides[get_session] = _session_override
    _seed()


def teardown_module():
    app.dependency_overrides.pop(get_session, None)
    engine.dispose()
    DATABASE.unlink(missing_ok=True)


def _seed() -> None:
    """Three days: an observation, a disappearance, and a return."""
    days = [
        (
            date(2026, 8, 1),
            [
                {
                    "id": "眠れない",
                    "label": "眠れない",
                    "category": "State",
                    "confidence": 0.8,
                    "provenance": {
                        "matched": True,
                        "match_rule": "normalised_label",
                        "subgraph_id": "sleep_disruption",
                        "seed_id": "insomnia",
                        "source_refs": ["nice_ng134"],
                    },
                },
                {"id": "テスト前のプレッシャー", "label": "テスト前のプレッシャー", "category": "Trigger", "confidence": 0.85},
            ],
            [{"source_id": "テスト前のプレッシャー", "target_id": "眠れない", "type": "causes", "confidence": 0.6}],
        ),
        (date(2026, 8, 2), [{"id": "眠れない", "label": "眠れない", "category": "State", "confidence": 0.7}], []),
        (
            date(2026, 8, 3),
            [
                {"id": "眠れない", "label": "眠れない", "category": "State", "confidence": 0.8},
                {"id": "テスト前のプレッシャー", "label": "テスト前のプレッシャー", "category": "Trigger", "confidence": 0.8},
            ],
            [{"source_id": "テスト前のプレッシャー", "target_id": "眠れない", "type": "causes", "confidence": 0.9}],
        ),
    ]

    with Session(engine) as session:
        for day, nodes, relations in days:
            entry = Entry(
                user_id=USER,
                raw_text=None,
                is_masked=True,
                created_at=datetime(day.year, day.month, day.day, 21, 0),
            )
            session.add(entry)
            session.commit()
            session.refresh(entry)

            session.add(
                GraphSnapshot(
                    entry_id=entry.id,
                    user_id=USER,
                    day=day,
                    nodes_json=nodes,
                    relations_json=relations,
                    graph_summary_json={"node_count": len(nodes), "relation_count": len(relations)},
                    temporal_diff_json={"diff_basis": "previous_snapshot"} if day != date(2026, 8, 1) else {},
                    extraction_provider="openai",
                    extraction_model="gpt-4o-mini",
                )
            )
            session.commit()


def test_stored_snapshots_assemble_into_a_temporal_graph():
    response = client.get("/api/research/temporal-graph", params={"user_id": USER})
    assert response.status_code == 200
    payload = response.json()

    assert payload["contract_version"] == "participant-temporal-graph-v1"
    assert "temporal graph networks (TGN/TGAT)" in payload["not_implemented_here"]

    nodes = {node["node_id"]: node for node in payload["nodes"]}
    assert set(nodes) == {"眠れない", "テスト前のプレッシャー"}

    pressure = nodes["テスト前のプレッシャー"]
    assert pressure["recurrence_count"] == 2, "absent on day 2, back on day 3"
    assert [interval["observed_days"] for interval in pressure["intervals"]] == [
        ["2026-08-01"],
        ["2026-08-03"],
    ]

    kinds = [event["kind"] for event in payload["events"]]
    assert "node_absent" in kinds and "node_reappeared" in kinds
    assert "edge_confidence_shifted" not in kinds, "a reappearance is not a confidence shift"

    edge = payload["edges"][0]
    assert edge["directed"] is True
    assert edge["relation_type"] == "causes"
    assert edge["confidence_by_day"] == [["2026-08-01", 0.6], ["2026-08-03", 0.9]]


def test_provenance_survives_the_round_trip_and_stays_separated():
    payload = client.get("/api/research/temporal-graph", params={"user_id": USER}).json()

    node = next(node for node in payload["nodes"] if node["node_id"] == "眠れない")
    assert node["curated_provenance"]["source_refs"] == ["nice_ng134"]
    assert node["curated_provenance"]["is_matched"] is True
    assert "snapshot" not in node["curated_provenance"], "curated evidence carries no observation"

    observation = node["personal_observations"][0]
    assert observation["snapshot"]["snapshot_id"] and observation["snapshot"]["entry_id"]
    assert observation["snapshot"]["extraction_provider"] == "openai"
    assert "source_refs" not in observation, "a journal entry cites nothing but itself"

    uncurated = next(node for node in payload["nodes"] if node["node_id"] == "テスト前のプレッシャー")
    assert uncurated["curated_provenance"]["source_refs"] == []
    assert uncurated["personal_observations"]


def test_as_of_reconstructs_the_day_and_rejects_a_bad_date():
    payload = client.get(
        "/api/research/temporal-graph", params={"user_id": USER, "as_of": "2026-08-02"}
    ).json()
    assert payload["as_of"]["present_node_ids"] == ["眠れない"]
    assert payload["as_of"]["absent_node_ids"] == ["テスト前のプレッシャー"]

    rejected = client.get("/api/research/temporal-graph", params={"user_id": USER, "as_of": "not-a-date"})
    assert rejected.status_code == 400


def test_a_participant_with_no_snapshots_gets_an_empty_graph_not_an_error():
    payload = client.get("/api/research/temporal-graph", params={"user_id": "nobody"}).json()

    assert payload["nodes"] == [] and payload["edges"] == [] and payload["events"] == []
    assert payload["report"]["snapshots_seen"] == 0
    assert payload["report"]["identity_is_usable"] is True
