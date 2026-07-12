from app.models.safety import SafetyAssessmentInput, SafetyAssessmentReturn

SAFETY_POLICY_REFS = [
    "docs/safety_escalation_policy.md",
    "docs/static_safety_school_support_reference.md",
]

CRISIS_RESPONSE = (
    "Your immediate safety comes first. BLESC cannot provide emergency or crisis care. "
    "If you may act now or are in immediate danger, call your local emergency service now. "
    "Move toward a trusted adult or another safe person and tell them clearly that you need immediate help."
)

ELEVATED_RESPONSE = (
    "This may need support from a real person. Consider telling a trusted adult, counselor, guardian, "
    "or another safe person what is happening. If the danger becomes immediate, contact local emergency services."
)

SELF_HARM_TERMS = (
    "hurt myself", "harm myself", "self-harm", "self harm", "kill myself",
    "end my life", "want to die", "suicide", "suicidal", "overdose",
    "自殺", "死にたい", "消えたい", "自分を傷つけ", "自傷",
)
IMMINENCE_TERMS = (
    "tonight", "tomorrow", "right now", "now", "today", "have a plan", "made a plan",
    "cannot stay safe", "can't stay safe", "do not feel safe", "don't feel safe",
    "今すぐ", "今夜", "今日", "計画がある", "安全でいられない",
)
VIOLENCE_TERMS = (
    "hurt them", "kill them", "make them pay", "attack them", "shoot them",
    "あいつを殺", "相手を傷つけ", "襲う",
)
ABUSE_TERMS = (
    "abusing me", "hurting me", "hits me", "hit me", "domestic violence",
    "assaulted me", "sexual abuse", "暴力を受け", "殴られ", "虐待", "性的暴力",
)
CONCEALMENT_TERMS = (
    "don't tell anyone", "do not tell anyone", "keep this a secret", "keep it secret", "hide this",
    "誰にも言わないで", "秘密にして", "隠して",
)
PASSIVE_RISK_TERMS = (
    "don't want to be here anymore", "do not want to be here anymore",
    "wish i were dead", "no reason to live", "everyone would be better without me",
    "生きていたくない", "生きる意味がない",
)
DISTRESS_TERMS = (
    "panic", "panicking", "hopeless", "worthless", "trapped", "overwhelmed", "disappear",
    "パニック", "絶望", "つらい", "苦しい",
)


def _matches(content: str, terms: tuple[str, ...]) -> list[str]:
    return [term for term in terms if term in content]


def assess_safety(payload: SafetyAssessmentInput) -> SafetyAssessmentReturn:
    content = " ".join(payload.content.casefold().split())
    if not content:
        return SafetyAssessmentReturn(
            risk_level="none", confidence=1.0, escalation_required=False,
            reasons=[], safe_response="", policy_refs=[],
        )

    self_harm = _matches(content, SELF_HARM_TERMS)
    imminent = _matches(content, IMMINENCE_TERMS)
    violence = _matches(content, VIOLENCE_TERMS)
    abuse = _matches(content, ABUSE_TERMS)
    concealment = _matches(content, CONCEALMENT_TERMS)
    passive = _matches(content, PASSIVE_RISK_TERMS)
    distress = _matches(content, DISTRESS_TERMS)

    crisis_reasons = []
    if self_harm and (imminent or any(term in content for term in ("kill myself", "end my life", "want to die", "suicide", "自殺", "死にたい"))):
        crisis_reasons.append("self_harm_or_suicide_risk")
    if violence and imminent:
        crisis_reasons.append("imminent_violence_risk")
    if abuse:
        crisis_reasons.append("abuse_or_violence_disclosure")
    if passive:
        crisis_reasons.append("possible_suicide_risk")
    if any(term in content for term in ("cannot stay safe", "can't stay safe", "安全でいられない")):
        crisis_reasons.append("inability_to_stay_safe")

    if crisis_reasons:
        return SafetyAssessmentReturn(
            risk_level="crisis",
            confidence=0.98 if imminent else 0.92,
            escalation_required=True,
            reasons=list(dict.fromkeys(crisis_reasons)),
            safe_response=CRISIS_RESPONSE,
            policy_refs=SAFETY_POLICY_REFS,
        )

    elevated_reasons = []
    if self_harm or passive:
        elevated_reasons.append("possible_self_harm_or_suicide_risk")
    if abuse:
        elevated_reasons.append("abuse_or_violence_disclosure")
    if concealment and (self_harm or passive or abuse or violence):
        elevated_reasons.append("concealment_request_related_to_harm")
    if violence:
        elevated_reasons.append("possible_violence_risk")
    if elevated_reasons:
        return SafetyAssessmentReturn(
            risk_level="elevated", confidence=0.85, escalation_required=False,
            reasons=list(dict.fromkeys(elevated_reasons)), safe_response=ELEVATED_RESPONSE,
            policy_refs=SAFETY_POLICY_REFS,
        )

    if distress:
        return SafetyAssessmentReturn(
            risk_level="low", confidence=0.75, escalation_required=False,
            reasons=["distress_without_explicit_danger"], safe_response="",
            policy_refs=SAFETY_POLICY_REFS,
        )

    return SafetyAssessmentReturn(
        risk_level="none", confidence=0.95, escalation_required=False,
        reasons=[], safe_response="", policy_refs=[],
    )
