import os

os.environ["USE_MOCK_LLM"] = "true"
os.environ["DATABASE_URL"] = "sqlite:///./test_research_pipeline.db"

from fastapi.testclient import TestClient
from sqlmodel import Session, select

from app.database import engine
from app.main import app
from app.schemas.extraction import Extraction
from app.schemas.research import ModelRun
from app.services.reflection_intelligence import analyze_reflection, run_reflection_eval

def test_reflection_eval_harness_covers_required_cases_and_fails_closed():
    result = run_reflection_eval()
    assert result["status"] == "passed", result
    assert result["total"] == 10
    crisis_cases = [case for case in result["results"] if case["actual_safety"] == "crisis"]
    assert crisis_cases
    assert all(status == "suppressed" for case in crisis_cases for status in case["card_statuses"])


def test_reflection_cards_are_evidence_grounded_and_non_diagnostic():
    analysis = analyze_reflection(
        "reflection-1",
        "I felt anxious about the exam, but drawing helped me calm down.",
    )
    state = analysis["emotional_state"]
    cards = analysis["reflection_cards"]
    assert state["status"] == "complete"
    assert state["primary_emotions"][0]["evidence_ref"]["text"]
    assert len(cards) >= 3
    assert all(card["evidence_refs"] is not None for card in cards)
    assert "diagnosis" not in str(analysis).lower()


def test_entry_submission_persists_emotional_state_and_cards():
    with TestClient(app) as client:
        response = client.post(
            "/api/entries?user_id=reflection_user&observation_type=daily",
            json={
                "journal_text": "Sunday night panic about school came back, but talking with a teacher helped.",
                "recall_text": "I remember staring at the homework page.",
                "consent": {
                    "app_use": True,
                    "research_analysis": True,
                    "anonymized_export": False,
                    "future_fine_tuning": False,
                    "consent_version": "research-consent-v1",
                },
            },
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["extraction"]["emotional_state_json"]["prompt_version"] == "reflection-extraction-v1"
        assert body["extraction"]["reflection_cards_json"]
        assert body["extraction"]["emotional_state_json"]["safety_classification"]["level"] == "elevated"

    with Session(engine) as session:
        extraction = session.exec(select(Extraction).where(Extraction.entry_id == body["entry"]["id"])).first()
        assert extraction is not None
        assert extraction.emotional_state_json["status"] == "complete"
        assert extraction.reflection_cards_json[0]["status"] == "active"


def test_crisis_submission_persists_assessment_suppresses_cards_and_records_audit():
    with TestClient(app) as client:
        response = client.post(
            "/api/entries?user_id=crisis_user&observation_type=daily",
            json={
                "journal_text": "I might hurt myself tonight and cannot stay safe.",
                "recall_text": "",
                "consent": {
                    "app_use": True,
                    "research_analysis": True,
                    "anonymized_export": False,
                    "future_fine_tuning": False,
                    "consent_version": "research-consent-v1",
                },
            },
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assessment = body["extraction"]["safety_assessment_json"]
        cards = body["extraction"]["reflection_cards_json"]
        assert assessment["risk_level"] == "crisis"
        assert assessment["escalation_required"] is True
        assert all(card["status"] == "suppressed" for card in cards)

    with Session(engine) as session:
        extraction = session.exec(
            select(Extraction).where(Extraction.entry_id == body["entry"]["id"])
        ).first()
        assert extraction is not None
        assert extraction.safety_assessment_json["reasons"]
        audit = session.exec(
            select(ModelRun).where(
                ModelRun.artifact_type == "safety_assessment",
                ModelRun.artifact_id == str(extraction.id),
            )
        ).first()
        assert audit is not None
        assert audit.output_summary_json["risk_level"] == "crisis"
        assert audit.output_summary_json["policy_refs"]
