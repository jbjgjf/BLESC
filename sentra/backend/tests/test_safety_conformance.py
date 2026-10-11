"""The FastAPI half of the safety assessment contract (#374).

The deterministic crisis assessment has two implementations: this one, and
`frontend/src/lib/safety-assessment.ts`, which is the one in production. They
shared a version string and disagreed — "know" raised imminence here, 「もう限界」
was `none`, and the crisis card was English. Both suites now run
`sentra/shared/safety_assessment_conformance.json`; the frontend's half is
`frontend/tests/safety-conformance.test.mjs`.
"""

import json
from pathlib import Path

import pytest

from app.models.safety import SafetyAssessmentInput
from app.services import safety

CONTRACT = json.loads(
    (Path(__file__).resolve().parents[2] / "shared" / "safety_assessment_conformance.json").read_text(encoding="utf-8")
)


def _assess(content: str):
    return safety.assess_safety(SafetyAssessmentInput(reflection_id="conformance", content=content))


@pytest.mark.parametrize("expected", CONTRACT["cases"], ids=lambda case: case["input"] or "(empty)")
def test_assesses_every_case_the_way_the_contract_records(expected):
    actual = _assess(expected["input"])
    assert actual.risk_level == expected["risk_level"]
    assert actual.escalation_required is expected["escalation_required"]
    assert actual.confidence == expected["confidence"]
    assert actual.reasons == expected["reasons"]


def test_matches_the_lexicon_the_contract_was_generated_from():
    assert safety.lexicon_fingerprint() == CONTRACT["lexicon_sha256"], (
        "A safety term changed here. Make the same change in "
        "frontend/src/lib/safety-assessment.ts, then regenerate lexicon_sha256 and the cases."
    )


def test_shows_the_student_the_responses_the_contract_carries():
    assert _assess("もう死にたい").safe_response == CONTRACT["responses"]["crisis"]
    assert _assess("もう限界").safe_response == CONTRACT["responses"]["elevated"]


def test_writes_the_version_the_contract_names():
    assert safety.SAFETY_ASSESSMENT_VERSION == CONTRACT["assessment_version"]
