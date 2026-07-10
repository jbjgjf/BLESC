from app.models.safety import SafetyAssessmentInput, SafetyAssessmentReturn


def assess_safety(payload: SafetyAssessmentInput) -> SafetyAssessmentReturn:
    """
    Analyzes user text content to evaluate risk levels, identify self-harm or 
    crisis intent, and trigger crisis safety bypasses if necessary.
    """
    content_lower = payload.content.lower()

    # Simple trigger check for crisis words (Matches implementation scope indicators)
    crisis_keywords = ["hurt myself", "suicide",
                       "end everything", "cannot stay safe", "imminent danger"]

    if any(keyword in content_lower for keyword in crisis_keywords):
        return SafetyAssessmentReturn(
            risk_level="crisis",
            confidence=0.95,
            escalation_required=True,
            reasons=[
                "Detected explicit crisis indicators or immediate safety risks."],
            safe_response="I'm really sorry you're going through this, but I want to make sure you stay safe. Please connect with a professional or reach out to a crisis hotline immediately.",
            policy_refs=["static_safety_policy_v1"]
        )

    # Default fallback for clean/safe messages
    return SafetyAssessmentReturn(
        risk_level="none",
        confidence=1.0,
        escalation_required=False,
        reasons=[],
        safe_response="",
        policy_refs=[]
    )
