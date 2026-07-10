from app.models.safety import SafetyAssessmentInput, SafetyAssessmentReturn


def assess_safety(payload: SafetyAssessmentInput) -> SafetyAssessmentReturn:
    content_lower = payload.content.lower()

    # 1. Grouping the exact triggers from your scope document
    crisis_triggers = ["hurt myself", "suicide",
                       "end my life", "cannot stay safe", "imminent danger"]
    abuse_violence_triggers = ["abusing me",
                               "hit me", "domestic violence", "assault"]
    concealment_triggers = ["don't tell anyone",
                            "keep this a secret", "hide this"]

    reasons = []

    # 2. Check conditions
    if any(t in content_lower for t in crisis_triggers):
        reasons.append(
            "Detected explicit self-harm intent, suicide ideation, or inability to stay safe.")
    if any(t in content_lower for t in abuse_violence_triggers):
        reasons.append(
            "Detected indicators of abuse, domestic harm, or active violence.")
    if any(t in content_lower for t in concealment_triggers):
        reasons.append(
            "Detected critical concealment or secrecy request regarding personal harm.")

    # 3. If any trigger hit, trigger Crisis Mode
    if reasons:
        return SafetyAssessmentReturn(
            risk_level="crisis",
            confidence=0.98,
            escalation_required=True,
            reasons=reasons,
            # Scope Requirement: Return policy-safe response for crisis mode
            safe_response="Your safety is our top priority. If you or someone you know is struggling or in distress, help is available. Please reach out to a professional or a local crisis line immediately.",
            # Scope Requirement: Link to static safety policy source
            policy_refs=["static_safety_policy_v1", "escalation_protocol_doc"]
        )

    # Default fallback for "none" risk level
    return SafetyAssessmentReturn(
        risk_level="none",
        confidence=1.0,
        escalation_required=False,
        reasons=[],
        safe_response="",
        policy_refs=[]
    )
