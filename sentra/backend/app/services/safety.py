import hashlib
import json
import re
import unicodedata
from pathlib import Path

from app.models.safety import SafetyAssessmentInput, SafetyAssessmentReturn

#: The same string `frontend/src/lib/safety-assessment.ts` writes. One name must
#: mean one behaviour (#374): the two are held to the same answers by
#: `sentra/shared/safety_assessment_conformance.json`, which both test suites run.
SAFETY_ASSESSMENT_VERSION = "safety-assessment-v2"

_CONFORMANCE_PATH = Path(__file__).resolve().parents[3] / "shared" / "safety_assessment_conformance.json"

SAFETY_POLICY_REFS = [
    "docs/safety_escalation_policy.md",
    "docs/static_safety_school_support_reference.md",
]

# What the student reads on the first card of a crisis. Read from the shared
# contract rather than written here a second time: this used to be an English
# paragraph next to an extraction prompt that asks for Japanese, and the copy in
# the Next.js path is pinned to the same file by its own test.
_RESPONSES = json.loads(_CONFORMANCE_PATH.read_text(encoding="utf-8"))["responses"]
CRISIS_RESPONSE: str = _RESPONSES["crisis"]
ELEVATED_RESPONSE: str = _RESPONSES["elevated"]

SELF_HARM_TERMS = (
    "hurt myself", "hurting myself", "harm myself", "harming myself", "self-harm", "self harm",
    "kill myself", "killing myself", "end my life", "ending my life", "want to die",
    "suicide", "suicidal", "overdose",
    "自殺", "死にたい", "消えたい", "自分を傷つけ", "自傷",
)
IMMINENCE_TERMS = (
    "tonight", "tomorrow", "right now", "now", "today", "have a plan", "made a plan",
    "cannot stay safe", "can't stay safe", "do not feel safe", "don't feel safe",
    "not safe tonight", "not safe right now",
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
# Language that may describe withdrawal from life without naming self-harm.
# Kept apart from ordinary distress because ambiguity must err toward support.
AMBIGUOUS_RISK_TERMS = (
    "disappear", "disappearing", "disappeared", "vanish", "stop existing", "not be here",
    "tired of everything", "tired of being here", "everything is grey", "everything is gray",
    "what's the point", "what is the point", "no point in anything", "give up on everything",
    "can't go on", "cannot go on", "not safe", "not be safe",
    "いなくなりたい", "消えてしまいたい", "全部どうでもいい", "もう限界",
)
DISTRESS_TERMS = (
    "panic", "panicking", "hopeless", "worthless", "trapped", "overwhelmed",
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
    "消えてしまいたい": ("きえてしまいたい",),
    "全部どうでもいい": ("ぜんぶどうでもいい",),
    "もう限界": ("もうげんかい",),
    "絶望": ("ぜつぼう",),
    "苦しい": ("くるしい",),
    "安全でいられない": ("あんぜんでいられない",),
}

#: Every lexicon's terms, for the test that keeps ``KANA_SPELLINGS`` honest.
ALL_SAFETY_TERMS = (
    SELF_HARM_TERMS + IMMINENCE_TERMS + VIOLENCE_TERMS + ABUSE_TERMS
    + CONCEALMENT_TERMS + PASSIVE_RISK_TERMS + AMBIGUOUS_RISK_TERMS + DISTRESS_TERMS
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


#: What the assessment actually compares against, under the names the shared
#: contract uses. Built once, folded, so the text and the terms meet in one
#: spelling.
#:
#: ``imminent`` is folded like the rest but given no readings: see
#: ``KANA_SPELLINGS`` on #290. 安全でいられない is still an imminence signal; its
#: reading reaches ``cannot_stay_safe``, which is the check that term exists for.
LEXICON_SPELLINGS: dict[str, tuple[str, ...]] = {
    "self_harm": spellings(SELF_HARM_TERMS),
    "imminent": tuple(dict.fromkeys(fold_writing(term) for term in IMMINENCE_TERMS)),
    "violence": spellings(VIOLENCE_TERMS),
    "abuse": spellings(ABUSE_TERMS),
    "concealment": spellings(CONCEALMENT_TERMS),
    "passive": spellings(PASSIVE_RISK_TERMS),
    "ambiguous": spellings(AMBIGUOUS_RISK_TERMS),
    "distress": spellings(DISTRESS_TERMS),
    "explicit_lethal": spellings((
        "kill myself", "killing myself", "end my life", "ending my life",
        "want to die", "suicide", "自殺", "死にたい",
    )),
    "cannot_stay_safe": spellings(("cannot stay safe", "can't stay safe", "安全でいられない")),
}


def lexicon_fingerprint() -> str:
    """SHA-256 over every spelling the assessment matches.

    The shared contract records this value and the Next.js path computes the
    same digest over its own lexicons, so a term added to one side alone fails
    both test suites instead of quietly changing one deployment's answers.
    """
    lines = [f"{name}={'|'.join(sorted(terms))}" for name, terms in sorted(LEXICON_SPELLINGS.items())]
    return hashlib.sha256("\n".join(lines).encode("utf-8")).hexdigest()


_ASCII_TERM = re.compile(r"[\x20-\x7e]+")


def _lexicon(terms: tuple[str, ...]) -> re.Pattern[str]:
    """ASCII terms match on word boundaries so "now" cannot fire on "know" or
    "nowhere"; Japanese has no word boundaries, so those terms stay substrings.

    ``re.ASCII`` makes ``\\b`` mean what it means in JavaScript, where only
    ``[A-Za-z0-9_]`` are word characters: without it 「nowだ」 has no boundary
    after "now" here and has one in the Next.js path.
    """
    alternatives = [
        rf"\b{re.escape(term)}\b" if _ASCII_TERM.fullmatch(term) else re.escape(term)
        for term in terms
    ]
    return re.compile("|".join(alternatives), re.ASCII)


_LEXICONS = {name: _lexicon(terms) for name, terms in LEXICON_SPELLINGS.items()}


def _matches(content: str, name: str) -> bool:
    return _LEXICONS[name].search(content) is not None


def assess_safety(payload: SafetyAssessmentInput) -> SafetyAssessmentReturn:
    # Folded, not merely case-folded: the lexicons are compared in one
    # spelling. See `fold_writing`.
    content = " ".join(fold_writing(payload.content).split())
    if not content:
        return SafetyAssessmentReturn(
            risk_level="none", confidence=1.0, escalation_required=False,
            reasons=[], safe_response="", policy_refs=[],
        )

    self_harm = _matches(content, "self_harm")
    imminent = _matches(content, "imminent")
    violence = _matches(content, "violence")
    abuse = _matches(content, "abuse")
    concealment = _matches(content, "concealment")
    passive = _matches(content, "passive")
    ambiguous = _matches(content, "ambiguous")
    distress = _matches(content, "distress")

    # Reasons are appended in the order the Next.js path appends them; the
    # shared contract compares the lists, not sets.
    crisis_reasons = []
    if self_harm and (imminent or _matches(content, "explicit_lethal")):
        crisis_reasons.append("self_harm_or_suicide_risk")
    if violence and imminent:
        crisis_reasons.append("imminent_violence_risk")
    if abuse:
        crisis_reasons.append("abuse_or_violence_disclosure")
    if _matches(content, "cannot_stay_safe"):
        crisis_reasons.append("inability_to_stay_safe")
    if passive:
        crisis_reasons.append("possible_suicide_risk")

    if crisis_reasons:
        return SafetyAssessmentReturn(
            risk_level="crisis",
            confidence=0.98 if imminent else 0.92,
            escalation_required=True,
            reasons=list(dict.fromkeys(crisis_reasons)),
            safe_response=CRISIS_RESPONSE,
            policy_refs=SAFETY_POLICY_REFS,
        )

    # Abuse and passive risk never reach here: either one is a crisis above.
    elevated_reasons = []
    if self_harm:
        elevated_reasons.append("possible_self_harm_or_suicide_risk")
    if concealment and (self_harm or violence):
        elevated_reasons.append("concealment_request_related_to_harm")
    if violence:
        elevated_reasons.append("possible_violence_risk")
    # Ambiguity about wanting to be gone is graded as elevated rather than
    # crisis: it earns a supportive response with real-person routes, but not
    # the reflection-card suppression that escalation_required drives.
    if ambiguous:
        elevated_reasons.append("ambiguous_withdrawal_signal")
    if elevated_reasons:
        ambiguous_only = elevated_reasons == ["ambiguous_withdrawal_signal"]
        return SafetyAssessmentReturn(
            risk_level="elevated", confidence=0.6 if ambiguous_only else 0.85, escalation_required=False,
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
