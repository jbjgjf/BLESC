import os
import json
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
    EntryEmbedding,
    EntrySession,
    EvalExample,
    GraphVersion,
    InteractionEvent,
    LongitudinalFeature,
    ModelRun,
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

    with Session(engine) as session:
        assert len(session.exec(select(ConsentRecord)).all()) >= 1
        assert len(session.exec(select(EntrySession)).all()) >= 1
        assert len(session.exec(select(InteractionEvent)).all()) >= 3
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

        chat = client.post(
            "/api/chat",
            json={"user_id": "test_chat_user", "message": "What patterns are visible?", "limit": 3},
        )
        assert chat.status_code == 200, chat.text
        assert chat.json()["answer"]
        assert chat.json()["status"] in {"completed", "failed"}

        export = client.post(
            "/api/research/fine-tuning-dataset",
            json={"user_id": "test_chat_user"},
        )
        assert export.status_code == 200, export.text
        assert export.json()["status"] == "blocked"


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
