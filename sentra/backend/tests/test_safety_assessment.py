import pytest
from app.models.safety import SafetyAssessmentInput, SafetyAssessmentReturn

# =====================================================================
# 1. FIXTURES (Setup Mock Payloads matching your Data Contract)
# =====================================================================


@pytest.fixture
def safe_input_payload() -> SafetyAssessmentInput:
    """Generates a standard user payload with no critical risk indicators."""
    return SafetyAssessmentInput(
        reflection_id="reflect-safe-101",
        content="I had a highly productive session today and managed to complete my design objectives.",
        extraction={"sentiment": "positive"}
    )


@pytest.fixture
def crisis_input_payload() -> SafetyAssessmentInput:
    """Generates a payload containing explicit self-harm/crisis markers."""
    return SafetyAssessmentInput(
        reflection_id="reflect-crisis-202",
        content="I feel completely trapped, I cannot stay safe tonight, and I want to end everything.",
        extraction={"sentiment": "highly_distressed"}
    )


# =====================================================================
# 2. AUTOMATED TEST SUITE
# =====================================================================

def test_safety_assessment_handles_safe_input(safe_input_payload):
    """
    Test that normal inputs result in 'none' or 'low' risk levels, 
    do not request escalation, and allow standard card workflows.
    """
    # Replace 'assess_safety' with the actual function name your app uses
    from app.services.safety import assess_safety

    result: SafetyAssessmentReturn = assess_safety(safe_input_payload)

    assert result.risk_level in ["none", "low"]
    assert result.escalation_required is False
    assert len(result.reasons) == 0


def test_safety_assessment_triggers_crisis_mode(crisis_input_payload):
    """
    Test that high-risk indicators successfully trigger 'crisis' mode,
    force escalation flags to True, return a policy safety message, 
    and provide references to the static policy document.
    """
    from app.services.safety import assess_safety

    result: SafetyAssessmentReturn = assess_safety(crisis_input_payload)

    # Assertions validating the exact scope requirements from your PR specs
    assert result.risk_level == "crisis"
    assert result.escalation_required is True
    assert result.confidence >= 0.90
    assert len(result.reasons) > 0
    assert "crisis hotline" in result.safe_response.lower() or len(result.policy_refs) > 0
