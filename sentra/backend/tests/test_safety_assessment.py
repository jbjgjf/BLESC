import pytest

from app.models.safety import SafetyAssessmentInput
from app.services.safety import assess_safety


@pytest.mark.parametrize(
    ("content", "expected_level"),
    [
        ("", "none"),
        ("I am stressed about tomorrow's math exam.", "none"),
        ("I had a panic attack but I am safe now.", "low"),
        ("I don't want to be here anymore.", "crisis"),
        ("I might hurt myself tonight and cannot stay safe.", "crisis"),
        ("Someone at home is hurting me and said don't tell anyone.", "crisis"),
        ("Don't tell anyone about the surprise party.", "none"),
        ("Sure, I could just kill myself, lol.", "crisis"),
        ("今夜、自殺したい。安全でいられない。", "crisis"),
        ("家で殴られている。誰にも言わないでと言われた。", "crisis"),
        ("I will hurt them right now.", "crisis"),
        ("Maybe I'll disappear for a while; I feel overwhelmed.", "low"),
    ],
)
def test_safety_assessment_cases(content, expected_level):
    result = assess_safety(
        SafetyAssessmentInput(reflection_id="case", content=content)
    )

    assert result.risk_level == expected_level
    assert result.escalation_required is (expected_level == "crisis")
    if expected_level == "crisis":
        assert result.reasons
        assert result.policy_refs
        assert "trusted adult" in result.safe_response.lower()


def test_crisis_response_stays_non_diagnostic_and_direct():
    result = assess_safety(
        SafetyAssessmentInput(
            reflection_id="crisis",
            content="I want to die tonight and I made a plan.",
        )
    )

    response = result.safe_response.lower()
    assert result.risk_level == "crisis"
    assert "diagnos" not in response
    assert "emergency service" in response
    assert len(result.safe_response.split()) < 70
