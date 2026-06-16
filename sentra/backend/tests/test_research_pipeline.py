import os
import json
from datetime import datetime
from pathlib import Path

os.environ["USE_MOCK_LLM"] = "true"
os.environ["DATABASE_URL"] = "sqlite:///./test_research_pipeline.db"
os.environ["SENTRA_EXPORT_DIR"] = "./test_exports"

from fastapi.testclient import TestClient
from sqlmodel import Session, select

from app.database import engine
from app.main import app
from app.schemas.research import (
    ConsentRecord,
    CognitiveProbeFeature,
    EntryEmbedding,
    EntrySession,
    EvalExample,
    GraphVersion,
    InteractionEvent,
    LongitudinalFeature,
    LongitudinalPattern,
    ModelRun,
    WritingFeature,
)


def teardown_module():
    Path("test_research_pipeline.db").unlink(missing_ok=True)
    export_dir = Path("test_exports")
    if export_dir.exists():
        for child in export_dir.rglob("*"):
            if child.is_file():
                child.unlink()
        for child in sorted(export_dir.rglob("*"), reverse=True):
            if child.is_dir():
                child.rmdir()
        export_dir.rmdir()


def _payload(session_id: str, future_fine_tuning: bool = True):
    return {
        "journal_text": "I felt anxious before class, but talking with a friend helped.",
        "recall_text": "The first thing I remember is looking at the clock.",
        "telemetry": {
            "session_id": session_id,
            "started_at": "2026-06-11T00:00:00Z",
            "submitted_at": "2026-06-11T00:00:05Z",
            "client_timezone": "Asia/Tokyo",
            "events": [
                {
                    "field_name": "journal_entry",
                    "event_type": "focus",
                    "occurred_at": "2026-06-11T00:00:00Z",
                    "relative_ms": 0,
                    "value_length": 0,
                },
                {
                    "field_name": "journal_entry",
                    "event_type": "input",
                    "occurred_at": "2026-06-11T00:00:02Z",
                    "relative_ms": 2000,
                    "value_length": 60,
                    "metadata": {"delta": 60},
                },
                {
                    "field_name": "first_recall_30",
                    "event_type": "input",
                    "occurred_at": "2026-06-11T00:00:04Z",
                    "relative_ms": 4000,
                    "value_length": 50,
                },
            ],
            "field_metrics": {
                "journal_entry": {
                    "focus_count": 1,
                    "blur_count": 0,
                    "input_count": 1,
                    "deletion_count": 0,
                    "paste_count": 0,
                    "revision_count": 1,
                    "pause_count": 0,
                    "max_pause_ms": 0,
                    "active_typing_ms": 0,
                },
                "first_recall_30": {
                    "focus_count": 0,
                    "blur_count": 0,
                    "input_count": 1,
                    "deletion_count": 0,
                    "paste_count": 0,
                    "revision_count": 1,
                    "pause_count": 0,
                    "max_pause_ms": 0,
                    "active_typing_ms": 0,
                },
            },
            "aggregate_metrics": {
                "total_duration_ms": 5000,
                "event_count": 3,
                "field_order": ["journal_entry", "first_recall_30"],
            },
        },
        "consent": {
            "app_use": True,
            "research_analysis": True,
            "anonymized_export": True,
            "future_fine_tuning": future_fine_tuning,
            "consent_version": "research-consent-v1",
        },
    }


def test_submission_creates_research_artifacts():
    with TestClient(app) as client:
        response = client.post(
            "/api/entries?user_id=test_research_user&observation_type=daily",
            json=_payload("pytest-session-1"),
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert len(body["research_artifacts"]["embedding_artifacts"]) == 5
        assert len(body["research_artifacts"]["writing_feature_artifacts"]) >= 2
        assert body["research_artifacts"]["cognitive_probe_artifact"]["probe_name"] == "first_recall_30"
        recall_features = body["research_artifacts"]["cognitive_probe_artifact"]["feature_json"]
        assert "rumination_index" in recall_features
        assert "semantic_distance_to_journal" in recall_features

    with Session(engine) as session:
        assert len(session.exec(select(ConsentRecord)).all()) >= 1
        assert len(session.exec(select(EntrySession)).all()) >= 1
        assert len(session.exec(select(InteractionEvent)).all()) >= 3
        assert len(session.exec(select(WritingFeature)).all()) >= 2
        assert len(session.exec(select(CognitiveProbeFeature)).all()) >= 1
        assert len(session.exec(select(GraphVersion)).all()) >= 1
        assert len(session.exec(select(LongitudinalFeature)).all()) >= 2
        assert len(session.exec(select(EntryEmbedding)).all()) >= 5
        assert len(session.exec(select(EvalExample)).all()) >= 1
        assert len(session.exec(select(ModelRun)).all()) >= 6


def test_eval_review_and_fine_tuning_dataset_export():
    with TestClient(app) as client:
        response = client.post(
            "/api/entries?user_id=test_ft_user&observation_type=daily",
            json=_payload("pytest-session-2"),
        )
        assert response.status_code == 200, response.text

        examples = client.get("/api/research/eval-examples?user_id=test_ft_user")
        assert examples.status_code == 200, examples.text
        eval_id = examples.json()[0]["id"]

        summary = client.get("/api/research/evals/summary?user_id=test_ft_user")
        assert summary.status_code == 200, summary.text
        assert summary.json()["example_count"] >= 1

        review = client.post(
            f"/api/research/eval-examples/{eval_id}/review",
            json={"user_id": "test_ft_user", "review_status": "reviewed"},
        )
        assert review.status_code == 200, review.text
        assert review.json()["review_status"] == "reviewed"

        export = client.post(
            "/api/research/fine-tuning-dataset",
            json={"user_id": "test_ft_user"},
        )
        assert export.status_code == 200, export.text
        assert export.json()["status"] == "completed"
        assert Path(export.json()["output_path"]).exists()


def test_chat_and_similarity_are_logged_without_openai_key():
    with TestClient(app) as client:
        response = client.post(
            "/api/entries?user_id=test_chat_user&observation_type=daily",
            json=_payload("pytest-session-3", future_fine_tuning=False),
        )
        assert response.status_code == 200, response.text

        similar = client.post(
            "/api/research/similar",
            json={"user_id": "test_chat_user", "query": "anxious friend class", "limit": 3},
        )
        assert similar.status_code == 200, similar.text
        assert "similar" in similar.json()
        if similar.json()["similar"]:
            assert "key_nodes" in similar.json()["similar"][0]

        chat = client.post(
            "/api/chat",
            json={"user_id": "test_chat_user", "message": "What patterns are visible?", "limit": 3},
        )
        assert chat.status_code == 200, chat.text
        chat_body = chat.json()
        assert chat_body["answer"]
        assert chat_body["status"] in {"completed", "failed"}
        assert "semantic_matches" in chat_body["evidence_refs"]
        assert "graph_pattern_matches" in chat_body["evidence_refs"]
        assert "static_knowledge_matches" in chat_body["evidence_refs"]
        assert chat_body["retrieval_context"]["static_knowledge_matches"]["source"] == "openai_vector_store"
        assert chat_body["retrieval_context"]["static_knowledge_matches"]["status"] in {
            "missing_vector_store_id",
            "pending_no_openai_key",
            "disabled",
        }
        assert "openai_vector_store" in chat_body["retrieval_context"]["retrieval_sources"]
        assert "personalization" in chat_body["retrieval_context"]

        personalization = client.get("/api/research/personalization?user_id=test_chat_user")
        assert personalization.status_code == 200, personalization.text
        assert personalization.json()["ready_for_personal_adapter"] is False

        export = client.post(
            "/api/research/fine-tuning-dataset",
            json={"user_id": "test_chat_user"},
        )
        assert export.status_code == 200, export.text
        assert export.json()["status"] == "blocked"


def _seed_multiday_history(user_id: str):
    """Insert 5 day-ordered graph snapshots + anomaly scores for one user.

    A ``deadline -> escalates -> anxiety`` motif is present every day (recurring
    motif), the protective ``running`` node toggles on/off (protective decline),
    and the day after each decline carries a high anomaly score (leading
    indicator).
    """
    from datetime import timedelta

    from app.schemas.analytics import AnomalyResult
    from app.schemas.entry import Entry
    from app.schemas.structured import GraphSnapshot

    plan = [
        (4, True, 1.0),    # protective present
        (3, False, 1.0),   # decline vs prev
        (2, True, 8.0),    # spike after decline
        (1, False, 1.0),   # decline vs prev
        (0, True, 8.0),    # spike after decline
    ]
    with Session(engine) as session:
        for days_ago, protective, score in plan:
            day_dt = datetime.utcnow() - timedelta(days=days_ago)
            entry = Entry(user_id=user_id, created_at=day_dt, observation_type="daily")
            session.add(entry)
            session.commit()
            session.refresh(entry)

            nodes = [
                {"node_id": "deadline", "category": "Trigger", "label": "deadline pressure"},
                {"node_id": "anxiety", "category": "State", "label": "anxiety"},
            ]
            relations = [
                {"source_node_id": "deadline", "target_node_id": "anxiety", "type": "escalates", "confidence": 0.8},
            ]
            if protective:
                nodes.append({"node_id": "run", "category": "Protective", "label": "running"})
                relations.append(
                    {"source_node_id": "run", "target_node_id": "anxiety", "type": "buffers", "confidence": 0.7}
                )
            session.add(
                GraphSnapshot(
                    entry_id=entry.id,
                    user_id=user_id,
                    day=day_dt.date(),
                    nodes_json=nodes,
                    relations_json=relations,
                    graph_summary_json={"summary": f"{len(nodes)} nodes"},
                    temporal_diff_json={},
                )
            )
            session.add(
                AnomalyResult(
                    user_id=user_id,
                    day=day_dt.date(),
                    anomaly_score=score,
                    z_scores_json={},
                )
            )
        session.commit()


def test_longitudinal_pattern_mining_learns_recurring_and_leading_patterns():
    user_id = "test_pattern_user"
    _seed_multiday_history(user_id)

    with TestClient(app) as client:
        patterns = client.get(f"/api/research/patterns?user_id={user_id}&refresh=true")
        assert patterns.status_code == 200, patterns.text
        body = patterns.json()

        recurring_keys = {item["pattern_key"] for item in body["recurring_motifs"]}
        assert "trigger:deadline pressure->escalates->state:anxiety" in recurring_keys
        escalate = next(
            item for item in body["recurring_motifs"]
            if item["pattern_key"] == "trigger:deadline pressure->escalates->state:anxiety"
        )
        assert escalate["recurrence_count"] == 5
        assert len(escalate["support_days"]) == 5

        declines = [item for item in body["leading_indicators"] if item["detail"].get("is_protective_decline")]
        assert declines, body
        assert declines[0]["lift"] >= 1.2

    with Session(engine) as session:
        rows = session.exec(
            select(LongitudinalPattern).where(LongitudinalPattern.user_id == user_id)
        ).all()
        assert any(row.pattern_kind == "recurring_motif" for row in rows)
        assert any(row.pattern_kind == "leading_indicator" for row in rows)

    # Re-running mining must be idempotent (replace, not duplicate) for the window.
    with TestClient(app) as client:
        client.get(f"/api/research/patterns?user_id={user_id}&refresh=true")
    with Session(engine) as session:
        escalate_rows = session.exec(
            select(LongitudinalPattern).where(
                LongitudinalPattern.user_id == user_id,
                LongitudinalPattern.pattern_key == "trigger:deadline pressure->escalates->state:anxiety",
            )
        ).all()
        assert len(escalate_rows) == 1

    # Chat retrieval is now pattern-aware.
    with TestClient(app) as client:
        chat = client.post(
            "/api/chat",
            json={"user_id": user_id, "message": "Does my deadline anxiety follow a pattern?"},
        )
        assert chat.status_code == 200, chat.text
        assert "longitudinal_patterns" in chat.json()["evidence_refs"]
        assert "longitudinal_patterns" in chat.json()["retrieval_context"]


def test_replay_endpoint_reconstructs_raw_interaction_process():
    with TestClient(app) as client:
        response = client.post(
            "/api/entries?user_id=test_replay_user&observation_type=daily",
            json=_payload("pytest-session-replay"),
        )
        assert response.status_code == 200, response.text

    with Session(engine) as session:
        entry_session = session.exec(
            select(EntrySession).where(EntrySession.client_session_id == "pytest-session-replay")
        ).one()

    with TestClient(app) as client:
        replay = client.get(
            f"/api/research/replay/{entry_session.id}?user_id=test_replay_user"
        )
        assert replay.status_code == 200, replay.text
        body = replay.json()
        assert body["client_session_hash"] != "pytest-session-replay"
        assert body["subject_id"].startswith("subject_")
        assert [event["event_type"] for event in body["events"]] == ["focus", "input", "input"]
        assert body["events"][1]["field_name"] == "journal_entry"
        assert body["events"][1]["delta_length"] == 60
        assert {field["field_name"] for field in body["fields"]} == {"journal_entry", "first_recall_30"}


def test_research_exports_are_deidentified_and_written_in_all_formats():
    with TestClient(app) as client:
        response = client.post(
            "/api/entries?user_id=test_export_user&observation_type=daily",
            json=_payload("pytest-session-export"),
        )
        assert response.status_code == 200, response.text

        chat = client.post(
            "/api/chat",
            json={"user_id": "test_export_user", "message": "Please reflect on my anxiety before class."},
        )
        assert chat.status_code == 200, chat.text

        # Generating an eval summary records a ModelRun; its artifact_id must not
        # embed the raw user_id, or it would leak through into anonymized exports.
        summary = client.get("/api/research/evals/summary?user_id=test_export_user")
        assert summary.status_code == 200, summary.text

        for export_format in ["jsonl", "csv", "parquet"]:
            export = client.post(
                "/api/research/exports",
                json={"user_id": "test_export_user", "export_format": export_format},
            )
            assert export.status_code == 200, export.text
            body = export.json()
            assert body["status"] == "completed"
            output_path = Path(body["output_path"])
            assert output_path.exists()
            assert body["manifest_json"]["format"] == export_format
            assert body["manifest_json"]["tables"]["chat_messages"] >= 2

            if export_format == "jsonl":
                payload = output_path.read_text(encoding="utf-8")
                assert "test_export_user" not in payload
                assert "Please reflect on my anxiety before class." not in payload
                rows = [json.loads(line) for line in payload.splitlines() if line.strip()]
                assert any(row["table"] == "chat_messages" for row in rows)
                assert all("subject_id" in row["row"] for row in rows)
                eval_summary_runs = [
                    row["row"]
                    for row in rows
                    if row["table"] == "model_runs" and row["row"].get("artifact_type") == "eval_summary"
                ]
                assert eval_summary_runs, "expected an eval_summary model run in the export"
                assert all(
                    "test_export_user" not in str(run.get("artifact_id")) for run in eval_summary_runs
                )
            elif export_format == "csv":
                combined = "\n".join(path.read_text(encoding="utf-8") for path in output_path.glob("*.csv"))
                assert "test_export_user" not in combined
                assert "Please reflect on my anxiety before class." not in combined
                assert (output_path / "interaction_events.csv").exists()
            else:
                import pandas as pd

                chat_messages = pd.read_parquet(output_path / "chat_messages.parquet")
                assert "user_id" not in chat_messages.columns
                assert "participant_code" not in chat_messages.columns
                assert "content_redacted" not in chat_messages.columns
                assert "content_redacted_hash" in chat_messages.columns
