"""The read-only ontology-layer endpoints (#101).

The layers, revision operations, precedence and gate are tested directly in
`test_ontology_evolution.py`. This covers the seam those cannot: that the curated
layer really loads from the seed YAML at request time, that a participant's own
stored entries reach the personal layer through the temporal graph (#95), and
that a curated claim and a participant's account come back as two answers rather
than one.

Owns its database through `dependency_overrides` rather than `DATABASE_URL`, for
the reason set out at the top of `test_temporal_graph_endpoint.py`.
"""

from datetime import date, datetime
from pathlib import Path

from fastapi.testclient import TestClient
from sqlmodel import Session, SQLModel, create_engine

from app.database import get_session
from app.main import app
from app.schemas.entry import Entry
from app.schemas.structured import GraphSnapshot

USER = "ontology-layer-user"
DATABASE = Path(__file__).resolve().parent / "test_ontology_evolution_endpoint.db"

engine = create_engine(f"sqlite:///{DATABASE}", connect_args={"check_same_thread": False})
client = TestClient(app)

#: The participant reports the opposite of what the curated graph says: the seed
#: has `trusted_adult_contact buffers depressed_mood`, sourced to WHO mhGAP and
#: MEXT. This student writes that the same contact makes things worse.
CONTRADICTING_RELATION = {
    "source_id": "trusted_adult_contact",
    "target_id": "depressed_mood",
    "type": "escalates",
    "confidence": 0.8,
}


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
    day = date(2026, 8, 1)
    nodes = [
        {"id": "trusted_adult_contact", "label": "担任の先生", "category": "Protective", "confidence": 0.8},
        {"id": "depressed_mood", "label": "気分の落ち込み", "category": "State", "confidence": 0.85},
    ]
    with Session(engine) as session:
        for offset in range(2):
            entry = Entry(
                user_id=USER,
                raw_text=None,
                is_masked=True,
                created_at=datetime(2026, 8, 1 + offset, 21, 0),
            )
            session.add(entry)
            session.commit()
            session.refresh(entry)
            session.add(
                GraphSnapshot(
                    entry_id=entry.id,
                    user_id=USER,
                    day=date(2026, 8, 1 + offset),
                    nodes_json=nodes,
                    relations_json=[CONTRADICTING_RELATION],
                    graph_summary_json={"node_count": 2, "relation_count": 1},
                    temporal_diff_json={},
                    extraction_provider="openai",
                    extraction_model="gpt-4o-mini",
                )
            )
            session.commit()
        assert day  # the seeded window starts here


def test_the_layer_contract_is_served_and_matches_the_documented_policy():
    payload = client.get("/api/research/ontology-layers").json()

    assert set(payload["layers"]) == {"curated", "personal", "candidate"}
    assert payload["layers"]["curated"]["writers"] == ["curator"]
    assert payload["layers"]["curated"]["requires_human_review"] is True
    assert payload["layers"]["personal"]["writers"] == ["participant"]
    assert "model" in payload["layers"]["candidate"]["writers"]

    assert "graph structure learning of any kind" in payload["not_implemented_here"]
    assert payload["precedence"]["layer_rank"] == {"curated": 0, "personal": 1, "candidate": 2}
    assert payload["structure_learning_gate"]["thresholds"]["declared_before_results"] is True
    assert payload["curated_attribution"]["review_status"] == "attributed, not independently reviewed"


def test_a_general_question_answers_from_the_curated_layer_only():
    payload = client.get(
        "/api/research/ontology-resolution",
        params={"source_id": "sleep_deprivation", "target_id": "cognitive_impairment"},
    ).json()

    assert payload["general"] is not None
    assert payload["general"]["layer"] == "curated"
    assert payload["general"]["source_refs"] == ["who_adolescent_mh"]
    assert payload["about_participant"] is None
    assert payload["causal_support"] is False, "the source reports an association"
    assert any("not a demonstrated cause" in warning for warning in payload["warnings"])


def test_a_participants_own_entries_reach_the_personal_layer():
    payload = client.get(
        "/api/research/ontology-resolution",
        params={
            "source_id": "trusted_adult_contact",
            "target_id": "depressed_mood",
            "user_id": USER,
        },
    ).json()

    assert payload["about_participant"] is not None
    personal = payload["about_participant"]
    assert personal["layer"] == "personal"
    assert personal["participant_id"] == USER
    assert personal["observations"], "traceable back to the snapshot"
    assert personal["observations"][0]["snapshot_id"]
    assert "source_refs" not in personal, "no citations reach the personal layer"


def test_a_curated_claim_and_a_contradicting_entry_are_both_returned():
    """The conflict #101 names. The seed says a trusted adult buffers low mood;
    this participant writes that the same contact makes it worse. Both come
    back, neither is suppressed, and the disagreement is reported."""
    payload = client.get(
        "/api/research/ontology-resolution",
        params={
            "source_id": "trusted_adult_contact",
            "target_id": "depressed_mood",
            "user_id": USER,
        },
    ).json()

    assert payload["general"]["layer"] == "curated"
    assert payload["general"]["edge_key"][2] == "buffers"
    assert payload["about_participant"]["edge_key"][2] == "escalates"

    assert payload["contradictions"], "the disagreement is reported"
    conflict = payload["contradictions"][0]
    assert set(conflict["layers"]) == {"curated", "personal"}
    assert "not resolved" in conflict["resolution"]
    assert payload["contradictions_are"].startswith("recorded, never resolved")
    assert any("neither replaces the other" in warning for warning in payload["warnings"])


def test_the_participants_account_never_becomes_causal_support():
    payload = client.get(
        "/api/research/ontology-resolution",
        params={
            "source_id": "trusted_adult_contact",
            "target_id": "depressed_mood",
            "user_id": USER,
        },
    ).json()

    assert payload["causal_support"] is False
    assert payload["about_participant"]["asserts_causation"] is False


def test_a_pair_nobody_has_a_claim_about_is_answered_rather_than_erroring():
    payload = client.get(
        "/api/research/ontology-resolution",
        params={"source_id": "nothing", "target_id": "here", "user_id": "nobody"},
    ).json()

    assert payload["general"] is None
    assert payload["about_participant"] is None
    assert payload["ranked"] == []
    assert payload["causal_support"] is False
