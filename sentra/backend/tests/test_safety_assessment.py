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
        ("Someone at home is hurting me.", "crisis"),
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


# The spelling a Japanese keyboard happens to produce must not change the
# answer (#388).
#
# Before this, every Japanese term was matched in its kanji spelling only, so
# 「しにたい」 — the same sentence when the student does not press the conversion
# key — assessed as "none". "none" is not a milder verdict than "crisis": it is
# the absence of the whole escalation path.
#
# Each case is a pair, so the kanji spelling is the expectation rather than a
# literal copied from the implementation. If the kanji form's verdict ever
# moves, the variant's moves with it and this still passes for the right reason.
SPELLING_PAIRS = [
    ("死にたい", "もうしにたい"),
    ("死にたい", "もうシニタイ"),
    ("死にたい", "もう死ニタイ"),
    ("死にたい", "もうｼﾆﾀｲ"),
    ("消えたい", "きえたい"),
    ("消えたい", "キエタイ"),
    ("自殺", "じさつ"),
    ("苦しい", "くるしい"),
    ("絶望", "ぜつぼう"),
    ("虐待", "ぎゃくたい"),
    ("殴られ", "なぐられ"),
    ("生きていたくない", "いきていたくない"),
    ("生きる意味がない", "いきるいみがない"),
    ("自分を傷つけ", "じぶんをきずつけ"),
    ("相手を傷つけ", "あいてをきずつけ"),
    ("暴力を受け", "ぼうりょくをうけ"),
    ("性的暴力", "せいてきぼうりょく"),
    ("安全でいられない", "あんぜんでいられない"),
    # The concealment terms carry no verdict on their own — they add a reason
    # only alongside a harm signal — so they are paired inside one.
    ("自傷してしまった。誰にも言わないで。", "自傷してしまった。だれにもいわないで。"),
    ("自傷してしまった。秘密にして。", "自傷してしまった。ひみつにして。"),
    # Width folding reaches the ASCII terms too.
    ("i want to die", "ｉ　ｗａｎｔ　ｔｏ　ｄｉｅ"),
]


def _assess(content):
    return assess_safety(SafetyAssessmentInput(reflection_id="spelling", content=content))


@pytest.mark.parametrize(("written", "variant"), SPELLING_PAIRS)
def test_spelling_variants_assess_as_the_written_form(written, variant):
    expected = _assess(written)
    # A pair is only meaningful if the written form is detected at all.
    assert expected.risk_level != "none", written

    actual = _assess(variant)
    assert actual.risk_level == expected.risk_level
    assert actual.escalation_required == expected.escalation_required
    # The reasons too: a variant reaching the same level by a different route
    # would still be a spelling the lexicons read differently.
    assert sorted(actual.reasons) == sorted(expected.reasons)


# Two readings are deliberately absent from KANA_SPELLINGS because they are also
# ordinary words. A later edit that "completes the table" would make this fire
# on お掃除, which is how a reviewer learns to click past the queue.
@pytest.mark.parametrize(
    "content",
    [
        "今日は部屋のおそうじをした。",   # おそう is not 襲う
        "あの子は自称ゲーマーらしい。",   # じしょう is not 自傷
        "ラーメンとカレーを食べた。",
        "今日は体育祭の練習をして、すごく楽しかった。",
    ],
)
def test_readings_that_are_ordinary_words_stay_out(content):
    assert _assess(content).risk_level == "none"


@pytest.mark.parametrize("content", ["自傷してしまった。", "あいつを殺すつもりだ。今すぐ。"])
def test_the_kanji_spelling_is_still_matched(content):
    """Leaving a reading out must not cost the kanji form it was read from."""
    assert _assess(content).risk_level != "none"


def test_the_kana_spelling_table_stays_honest():
    """An entry naming no live term is a claim about code that has since changed.

    The same reasoning as `scripts/ui-strings-allowlist.mjs`: left in place it
    reads as coverage that is not there.
    """
    from app.services.safety import ALL_SAFETY_TERMS, KANA_SPELLINGS

    stale = [key for key in KANA_SPELLINGS if key not in ALL_SAFETY_TERMS]
    assert stale == [], f"KANA_SPELLINGS keys naming no live term: {stale}"


def test_no_imminence_term_is_given_a_reading():
    """#290 is an open false positive on 「今日」; this must not get louder."""
    from app.services.safety import KANA_SPELLINGS

    for key in ("今すぐ", "今夜", "今日", "計画がある"):
        assert key not in KANA_SPELLINGS, key
