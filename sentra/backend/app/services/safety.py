import unicodedata

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


#: Katakana ァ-ヶ onto hiragana ぁ-ゖ. ヷ-ヺ are left out: they have no hiragana
#: form, so there is nothing to fold them onto.
_KATAKANA_TO_HIRAGANA = {codepoint: codepoint - 0x60 for codepoint in range(0x30A1, 0x30F7)}


def fold_writing(value: str) -> str:
    """Writing-system folding, applied to the text and to every term alike (#388).

    A Japanese keyboard offers more than one spelling of the same word, and the
    lexicons above were written in one of them. 「死にたい」 was matched;
    「しにたい」 — the same sentence when the student does not press the
    conversion key — was not, and `risk_level="none"` is not a milder verdict
    than `"crisis"` but the absence of the whole escalation path.

    NFKC folds the width variants (全角英数, ｶﾞ); katakana is then mapped onto
    hiragana, which is what carries 「シニタイ」 to 「しにたい」.

    **Terms are folded too, not only the text.** Without that, `パニック` —
    written in katakana in `DISTRESS_TERMS` — would stop matching the moment the
    text was folded.

    This is the same fold as `frontend/src/lib/safety-assessment.ts`
    `foldWriting`. The two implementations of this assessment already differ in
    other ways (#374); they must not also differ in which spellings they read.
    """
    return unicodedata.normalize("NFKC", value).translate(_KATAKANA_TO_HIRAGANA).casefold()


#: Kana spellings of the terms written with kanji.
#:
#: Folding cannot reach these: 「死」 and 「し」 are different characters, not two
#: encodings of one. So each kanji term a student might send unconverted carries
#: its reading here.
#:
#: **A reading is listed only when it is not also an ordinary word.** Two are
#: deliberately absent:
#:
#:   ``自傷`` → じしょう   also 「自称」; a diary saying 自称 discloses nothing.
#:   ``襲う``  → おそう     a prefix of 「おそうじ」(お掃除).
#:
#: Both would fire on sentences with nothing to do with danger. The kanji
#: spellings of those two stay matched; only the readings are left out.
#:
#: ``IMMINENCE_TERMS`` is deliberately given no readings. 「今日」 already raises
#: a false imminence signal (#290), and widening it before that is settled would
#: only make the same mistake louder.
KANA_SPELLINGS = {
    "自殺": ("じさつ",),
    "死にたい": ("しにたい",),
    "消えたい": ("きえたい",),
    "自分を傷つけ": ("じぶんをきずつけ",),
    "あいつを殺": ("あいつをころ",),
    "相手を傷つけ": ("あいてをきずつけ",),
    "暴力を受け": ("ぼうりょくをうけ",),
    "殴られ": ("なぐられ",),
    "虐待": ("ぎゃくたい",),
    "性的暴力": ("せいてきぼうりょく",),
    "誰にも言わないで": ("だれにもいわないで",),
    "秘密にして": ("ひみつにして",),
    "生きていたくない": ("いきていたくない",),
    "生きる意味がない": ("いきるいみがない",),
    "絶望": ("ぜつぼう",),
    "苦しい": ("くるしい",),
    "安全でいられない": ("あんぜんでいられない",),
}

#: Every lexicon's terms, for the test that keeps ``KANA_SPELLINGS`` honest.
ALL_SAFETY_TERMS = (
    SELF_HARM_TERMS + IMMINENCE_TERMS + VIOLENCE_TERMS + ABUSE_TERMS
    + CONCEALMENT_TERMS + PASSIVE_RISK_TERMS + DISTRESS_TERMS
)


def spellings(
    terms: tuple[str, ...], extra_readings: dict[str, tuple[str, ...]] | None = None,
) -> tuple[str, ...]:
    """Every spelling of ``terms``, folded: the written one plus any reading.

    ``extra_readings`` is for a caller whose list carries a term the lexicons
    above do not (``memory_objects.CRISIS_TERMS``, #392). A term both know is
    read from ``KANA_SPELLINGS``, so its readings are kept in one place.
    """
    readings = {**(extra_readings or {}), **KANA_SPELLINGS}
    folded: list[str] = []
    for term in terms:
        folded.append(fold_writing(term))
        folded.extend(fold_writing(reading) for reading in readings.get(term, ()))
    return tuple(dict.fromkeys(folded))


#: What the assessment actually compares against. Built once, folded, so the
#: text and the terms meet in one spelling.
_SELF_HARM = spellings(SELF_HARM_TERMS)
#: Folded like the rest, but given no readings: see ``KANA_SPELLINGS`` on #290.
#: Every term stays — 安全でいられない is still an imminence signal, it just does
#: not gain あんぜんでいられない here. The reading reaches `_CANNOT_STAY_SAFE`,
#: which is the check that term exists for.
_IMMINENCE = tuple(dict.fromkeys(fold_writing(term) for term in IMMINENCE_TERMS))
_VIOLENCE = spellings(VIOLENCE_TERMS)
_ABUSE = spellings(ABUSE_TERMS)
_CONCEALMENT = spellings(CONCEALMENT_TERMS)
_PASSIVE_RISK = spellings(PASSIVE_RISK_TERMS)
_DISTRESS = spellings(DISTRESS_TERMS)
_EXPLICIT_LETHAL = spellings(
    ("kill myself", "end my life", "want to die", "suicide", "自殺", "死にたい")
)
_CANNOT_STAY_SAFE = spellings(("cannot stay safe", "can't stay safe", "安全でいられない"))


def _matches(content: str, terms: tuple[str, ...]) -> list[str]:
    return [term for term in terms if term in content]


def assess_safety(payload: SafetyAssessmentInput) -> SafetyAssessmentReturn:
    # Folded, not merely case-folded: the lexicons are compared in one
    # spelling. See `fold_writing`.
    content = " ".join(fold_writing(payload.content).split())
    if not content:
        return SafetyAssessmentReturn(
            risk_level="none", confidence=1.0, escalation_required=False,
            reasons=[], safe_response="", policy_refs=[],
        )

    self_harm = _matches(content, _SELF_HARM)
    imminent = _matches(content, _IMMINENCE)
    violence = _matches(content, _VIOLENCE)
    abuse = _matches(content, _ABUSE)
    concealment = _matches(content, _CONCEALMENT)
    passive = _matches(content, _PASSIVE_RISK)
    distress = _matches(content, _DISTRESS)

    crisis_reasons = []
    if self_harm and (imminent or _matches(content, _EXPLICIT_LETHAL)):
        crisis_reasons.append("self_harm_or_suicide_risk")
    if violence and imminent:
        crisis_reasons.append("imminent_violence_risk")
    if abuse:
        crisis_reasons.append("abuse_or_violence_disclosure")
    if passive:
        crisis_reasons.append("possible_suicide_risk")
    if _matches(content, _CANNOT_STAY_SAFE):
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
