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
from app.schemas.entry import Entry
from app.schemas.research import (
    ChatMessage,
    ChatSession,
    ConsentRecord,
    ConversationMemoryObject,
    ConversationRecallSummary,
    CognitiveProbeFeature,
    EntryEmbedding,
    EntrySession,
    EvalExample,
    GraphVersion,
    InteractionEvent,
    LongitudinalFeature,
    LongitudinalPattern,
    ModelRun,
    RetrievalEvent,
    WritingFeature,
)
from app.schemas.structured import GraphSnapshot
from app.services.research_pipeline import analyze_conversation_recall_30, record_graph_version, search_relevant_memory_objects, search_similar_graph_patterns, stable_hash


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
        assert body["anomaly_result"] is None
        assert body["explanation"]["baseline_deviation_json"]["status"] == "not_enough_data"
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
        assert chat_body["conversation_recall_30"]["status"] == "not_enough_history"

        personalization = client.get("/api/research/personalization?user_id=test_chat_user")
        assert personalization.status_code == 200, personalization.text
        assert personalization.json()["ready_for_personal_adapter"] is False

        export = client.post(
            "/api/research/fine-tuning-dataset",
            json={"user_id": "test_chat_user"},
        )
        assert export.status_code == 200, export.text
        assert export.json()["status"] == "blocked"


def test_audio_transcription_validates_uploads_and_fails_safely_without_openai_key():
    with TestClient(app) as client:
        empty = client.post(
            "/api/audio/transcriptions",
            files={"file": ("empty.webm", b"", "audio/webm")},
        )
        assert empty.status_code == 422

        invalid = client.post(
            "/api/audio/transcriptions",
            files={"file": ("note.txt", b"hello", "text/plain")},
        )
        assert invalid.status_code == 415

        missing_key = client.post(
            "/api/audio/transcriptions",
            files={"file": ("voice.webm", b"not-real-audio", "audio/webm")},
        )
        assert missing_key.status_code == 503
        assert missing_key.json()["detail"] == "Voice transcription is not configured. Set OPENAI_API_KEY and ensure USE_MOCK_LLM is not true."


def test_reflection_signal_requires_real_baseline_history_and_changes_with_data():
    from datetime import date, timedelta

    from app.schemas.analytics import DailyFeatureAggregation

    user_id = "test_reflection_user"
    today = date.today()
    with Session(engine) as session:
        for offset, state_count, trigger_count, protective_ratio in [
            (5, 1, 1, 1.0),
            (4, 1, 1, 1.0),
            (3, 2, 1, 0.8),
        ]:
            day = today - timedelta(days=offset)
            session.add(
                DailyFeatureAggregation(
                    user_id=user_id,
                    day=day,
                    state_count=state_count,
                    trigger_count=trigger_count,
                    protective_count=1,
                    behavior_count=0,
                    event_count=1,
                    event_avg_duration=20.0,
                    protective_ratio=protective_ratio,
                    isolation_signal=0.0,
                    feature_vector_json={
                        "state_count": state_count,
                        "trigger_count": trigger_count,
                        "protective_count": 1,
                        "behavior_count": 0,
                        "event_count": 1,
                        "event_avg_duration": 20.0,
                        "event_transition_signal": 0.0,
                        "protective_ratio": protective_ratio,
                        "protective_buffer_ratio": 0.5,
                        "relation_density": 0.5,
                        "isolation_signal": 0.0,
                    },
                )
            )
        session.commit()

    with TestClient(app) as client:
        response = client.post(
            f"/api/entries?user_id={user_id}&observation_type=daily",
            json={
                **_payload("pytest-session-reflection"),
                "journal_text": "I felt intense deadline pressure, isolated, anxious, and could not sleep.",
                "recall_text": "deadline anxiety isolation",
            },
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["anomaly_result"] is not None
        assert body["anomaly_result"]["anomaly_score"] != 1.37
        assert body["anomaly_result"]["anomaly_score"] >= 0
        assert body["explanation"]["baseline_deviation_json"].get("status") != "not_enough_data"


def test_conversation_recall_uses_latest_30_turns_and_stores_hashes():
    user_id = "test_recall_user"
    participant = user_id
    with Session(engine) as session:
        chat_session = ChatSession(user_id=user_id, participant_code=participant, consent_snapshot_json={})
        session.add(chat_session)
        session.commit()
        session.refresh(chat_session)
        for index in range(35):
            text = f"turn {index} deadline anxiety support plan"
            session.add(
                ChatMessage(
                    chat_session_id=chat_session.id,
                    role="user" if index % 2 == 0 else "assistant",
                    content_hash=f"hash-{index}",
                    content_redacted=text,
                    evidence_refs_json=[],
                )
            )
        session.commit()

    with TestClient(app) as client:
        response = client.get(f"/api/research/conversation-recall?user_id={user_id}&refresh=true")
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["status"] == "completed"
        assert body["window_turn_count"] == 30
        assert body["source_message_hashes"] == [f"hash-{index}" for index in range(5, 35)]
        assert body["summary_json"]["recurring_topics"]

    with Session(engine) as session:
        rows = session.exec(
            select(ConversationRecallSummary).where(ConversationRecallSummary.user_id == user_id)
        ).all()
        assert rows
        assert rows[-1].source_message_hashes_json == [f"hash-{index}" for index in range(5, 35)]


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


def test_conversation_recall_produces_multiple_reusable_memory_objects():
    user_id = "test_memory_object_user"
    participant = user_id
    topics = [
        "I have been so anxious about my upcoming exam deadline, it is stressing me out.",
        "I have not been sleeping well at all lately, waking up every night.",
        "My friend invited me for a walk and it actually helped me feel calmer.",
        "The exam deadline pressure is still there, I keep thinking about it.",
        "Walking with my friend again today, it really helps me relax.",
        "Another rough night of barely sleeping, I feel exhausted.",
    ]
    with Session(engine) as session:
        chat_session = ChatSession(user_id=user_id, participant_code=participant, consent_snapshot_json={})
        session.add(chat_session)
        session.commit()
        session.refresh(chat_session)
        for index, text in enumerate(topics):
            session.add(
                ChatMessage(
                    chat_session_id=chat_session.id,
                    role="user",
                    content_hash=f"mem-hash-{index}",
                    content_redacted=text,
                    evidence_refs_json=[],
                )
            )
            session.add(
                ChatMessage(
                    chat_session_id=chat_session.id,
                    role="assistant",
                    content_hash=f"mem-hash-ack-{index}",
                    content_redacted="I hear you, thanks for sharing that.",
                    evidence_refs_json=[],
                )
            )
        session.commit()

        result = analyze_conversation_recall_30(session, user_id, participant)
        assert result["status"] == "completed"
        memory_objects = result["memory_objects"]
        # one blob per window is the old, weak behavior -- this must produce
        # several discrete, individually-scored objects instead.
        assert len(memory_objects) > 1

        all_source_ids = [source_id for obj in memory_objects for source_id in obj["source_message_ids"]]
        assert len(all_source_ids) == len(set(all_source_ids)), "segments must not overlap"

        for obj in memory_objects:
            assert 0.0 <= obj["importance_score"] <= 1.0
            assert 0.0 <= obj["confidence_score"] <= 1.0
            assert obj["embedding_status"] == "pending_no_openai_key"  # USE_MOCK_LLM=true in this test env
            assert set(obj["score_breakdown"]["components"].keys()) == {
                "tone_intensity", "has_open_loop", "specificity", "crisis_or_safety_flag",
            }

        recurring = [obj for obj in memory_objects if obj["recurrence_count"] > 0]
        assert recurring, "at least one repeated topic (exam deadline / walk with friend) should recur"

        stored_rows = session.exec(
            select(ConversationMemoryObject).where(
                ConversationMemoryObject.user_id == user_id,
                ConversationMemoryObject.participant_code == participant,
            )
        ).all()
        assert len(stored_rows) == len(memory_objects)


def test_search_similar_graph_patterns_traverses_and_explains_hybrid_score():
    user_id = "test_graph_rag_user"
    with Session(engine) as session:
        base_nodes = [
            {"id": "n1", "category": "Trigger", "label": "deadline pressure", "confidence": 0.9, "intensity": 0.7},
            {"id": "n2", "category": "State", "label": "anxiety spike", "confidence": 0.8, "intensity": 0.6},
        ]
        base_relations = [
            {"source_id": "n1", "target_id": "n2", "type": "escalates", "confidence": 0.85},
        ]
        for day_offset in range(4):
            entry = Entry(user_id=user_id, observation_type="daily")
            session.add(entry)
            session.commit()
            session.refresh(entry)
            snapshot = GraphSnapshot(
                entry_id=entry.id,
                user_id=user_id,
                day=datetime(2026, 6, 1 + day_offset).date(),
                nodes_json=base_nodes,
                relations_json=base_relations,
                graph_summary_json={"summary": f"day {day_offset}"},
                temporal_diff_json={},
            )
            session.add(snapshot)
            session.commit()
            session.refresh(snapshot)
            record_graph_version(session, user_id, user_id, entry, snapshot)

        results = search_similar_graph_patterns(session, user_id, user_id, query="deadline pressure anxiety", limit=5)
        assert results, "expected at least one ranked graph node for a matching query"
        assert results[0]["retrieval_mode"] == "graph_semantic_v2"

        breakdown = results[0]["score_breakdown"]["components"]
        assert set(breakdown.keys()) == {
            "semantic_similarity", "graph_distance_score", "confidence",
            "recency_score", "recurrence_score", "linked_memory_importance",
        }
        # the motif repeated across 4 days, so the matched node's occurrence_count
        # (surfaced via "seen Nx" in the summary) must reflect that recurrence.
        assert any("seen 4x" in result["summary"] for result in results)
        assert any(result["key_relations"] for result in results), "the escalates edge should surface as a key relation"


def test_search_relevant_memory_objects_round_trips_through_sqlite_json_storage():
    # Regression test: search_relevant_memory_objects persists its results onto a
    # RetrievalEvent.result_refs_json column. _memory_object_to_dict previously
    # returned raw datetime objects for created_at/updated_at/last_reinforced_at,
    # which SQLite's JSON column serializer cannot encode -- this only surfaced
    # once real memory objects existed to be retrieved (an empty-results call
    # never hits the serializer), so it slipped past tests that ran before any
    # memory objects existed. This seeds memory objects first, then asserts the
    # retrieval event actually round-trips through the DB's JSON column.
    user_id = "test_memory_retrieval_user"
    participant = user_id
    with Session(engine) as session:
        chat_session = ChatSession(user_id=user_id, participant_code=participant, consent_snapshot_json={})
        session.add(chat_session)
        session.commit()
        session.refresh(chat_session)
        texts = [
            "I have been anxious about my exam deadline, it is stressing me out.",
            "I hear that, exams can feel overwhelming.",
            "The exam deadline pressure is still there honestly.",
            "That sounds tough, deadlines pile up fast.",
            "My friend invited me for a walk and it helped me feel calmer.",
            "It is great that your friend supported you like that.",
        ]
        for index, text in enumerate(texts):
            session.add(
                ChatMessage(
                    chat_session_id=chat_session.id,
                    role="user" if index % 2 == 0 else "assistant",
                    content_hash=f"retrieval-hash-{index}",
                    content_redacted=text,
                    evidence_refs_json=[],
                )
            )
        session.commit()

        recall_result = analyze_conversation_recall_30(session, user_id, participant)
        assert recall_result["status"] == "completed"
        assert recall_result["memory_objects"], "expected memory objects to exist before exercising retrieval"

        results = search_relevant_memory_objects(session, user_id, participant, query="exam deadline anxiety", limit=5)
        assert isinstance(results, list)

        latest_event = session.exec(
            select(RetrievalEvent)
            .where(
                RetrievalEvent.user_id == user_id,
                RetrievalEvent.participant_code == participant,
            )
            .order_by(RetrievalEvent.created_at.desc())
            .limit(1)
        ).first()
        assert latest_event is not None
        # Forces SQLite to actually decode the stored JSON column back out --
        # this is exactly the round trip that raised TypeError before the fix.
        assert isinstance(latest_event.result_refs_json, list)
        for ref in latest_event.result_refs_json:
            assert isinstance(ref.get("created_at"), str) or ref.get("created_at") is None
