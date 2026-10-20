"""Unit tests for the deterministic conversation-memory-object scorer."""

from datetime import datetime

import pytest

from app.analytics.memory_objects import (
    CRISIS_TERMS,
    IMPORTANCE_WEIGHTS,
    build_topic_label,
    PriorMemoryObject,
    RecallMessage,
    decay_factor,
    detect_contradictions,
    effective_importance,
    emotional_tone,
    find_duplicate,
    has_crisis_language,
    jaccard,
    score_confidence,
    score_importance,
    score_recurrence,
    segment_window,
    tokenize,
    topic_tokens,
)
from app.analytics.tokenize import japanese_analysis_available

# The convention `test_tokenize_and_probe.py` sets: a Japanese assertion skips
# where the multi-megabyte dictionary is not installed, and that file's
# CI-only test is what keeps a missing install from turning this suite green
# with fewer tests.
requires_dictionary = pytest.mark.skipif(
    not japanese_analysis_available(),
    reason="fugashi/unidic-lite not installed",
)


def _msg(id_: int, role: str, text: str, day: int = 1) -> RecallMessage:
    return RecallMessage(id=id_, role=role, text=text, created_at=datetime(2026, 6, day, 12, 0, 0))


def test_segment_window_splits_on_user_topic_shift_not_assistant_replies():
    messages = [
        _msg(1, "user", "I have been anxious about my exam deadline all week."),
        _msg(2, "assistant", "That sounds stressful, deadlines can be a lot."),
        _msg(3, "user", "On a totally different note, my sleep has been awful lately."),
        _msg(4, "assistant", "Poor sleep can make everything else harder too."),
    ]
    segments = segment_window(messages)
    assert len(segments) == 2
    assert [m.id for m in segments[0]] == [1, 2]
    assert [m.id for m in segments[1]] == [3, 4]


def test_segment_window_empty_input_returns_empty_list():
    assert segment_window([]) == []


def test_score_importance_open_loop_and_crisis_flags_raise_score():
    baseline_segment = [_msg(1, "user", "I went for a walk today and it was nice.")]
    open_loop_segment = [_msg(2, "user", "I went for a walk today, but why do I still feel this way?")]
    crisis_segment = [_msg(3, "user", "I went for a walk today but honestly I want to die.")]

    baseline_score, baseline_breakdown = score_importance(baseline_segment)
    open_loop_score, _ = score_importance(open_loop_segment)
    crisis_score, crisis_breakdown = score_importance(crisis_segment)

    assert open_loop_score > baseline_score
    assert crisis_score > baseline_score
    assert crisis_breakdown["components"]["crisis_or_safety_flag"] == 1.0
    assert baseline_breakdown["components"]["crisis_or_safety_flag"] == 0.0
    # every weighted component must be present and sum to the documented weights
    assert set(baseline_breakdown["weights"].keys()) == {
        "tone_intensity", "has_open_loop", "specificity", "crisis_or_safety_flag",
    }
    assert abs(sum(baseline_breakdown["weights"].values()) - 1.0) < 1e-9


def test_score_importance_is_bounded_between_zero_and_one():
    extreme_segment = [
        _msg(1, "user", "anxious anxious scared panic stress hopeless lonely worried? want to die"),
    ]
    score, _ = score_importance(extreme_segment)
    assert 0.0 <= score <= 1.0


def test_emotional_tone_dominant_polarity():
    assert emotional_tone("I feel calm and safe with support")["dominant"] == "protective"
    assert emotional_tone("I feel anxious and scared and stuck")["dominant"] == "negative"
    assert emotional_tone("I went to the store")["dominant"] == "neutral"


def test_has_crisis_language_matches_ported_frontend_terms():
    assert has_crisis_language("I want to die honestly")
    assert has_crisis_language("self-harm crossed my mind")
    assert not has_crisis_language("I had a long day at school")


# The spelling a Japanese keyboard happens to produce must not change the
# crisis component (#392). Each kana form is checked against its kanji form
# rather than against a literal, the way test_safety_assessment.py pairs them.
@pytest.mark.parametrize(
    ("written", "variant"),
    [
        ("もう死にたい", "もうしにたい"),
        ("もう死にたい", "もうシニタイ"),
        ("もう死にたい", "もうｼﾆﾀｲ"),
        ("もう死にたい", "もう死ニタイ"),
        ("消えたい", "きえたい"),
        ("自殺を考えた", "じさつを考えた"),
        ("あいつを殺したい", "あいつをころしたい"),
        ("自分を傷つけたい", "自分をきずつけたい"),
        ("i want to die", "Ｉ　ｗａｎｔ　ｔｏ　ｄｉｅ"),
    ],
)
def test_crisis_flag_reads_every_spelling_like_the_written_form(written, variant):
    assert has_crisis_language(written), written
    assert has_crisis_language(variant), variant

    written_score, written_breakdown = score_importance([_msg(1, "user", written)])
    variant_score, variant_breakdown = score_importance([_msg(1, "user", variant)])
    assert variant_breakdown["components"]["crisis_or_safety_flag"] == 1.0
    assert variant_breakdown["components"]["crisis_or_safety_flag"] == written_breakdown["components"]["crisis_or_safety_flag"]
    assert variant_score >= IMPORTANCE_WEIGHTS["crisis_or_safety_flag"]


@pytest.mark.parametrize(
    "text",
    ["今日は部屋のおそうじをした。", "あの子は自称ゲーマーらしい。", "きょうは体育祭でたのしかった"],
)
def test_crisis_flag_stays_down_for_ordinary_kana(text):
    assert not has_crisis_language(text)
    _, breakdown = score_importance([_msg(1, "user", text)])
    assert breakdown["components"]["crisis_or_safety_flag"] == 0.0


def test_crisis_readings_come_from_the_safety_lexicon():
    """A reading added for the chat gate reaches this score without a second edit."""
    from app.services import safety

    for term in CRISIS_TERMS & set(safety.KANA_SPELLINGS):
        for reading in safety.KANA_SPELLINGS[term]:
            assert has_crisis_language(reading), reading


def test_score_recurrence_counts_topic_or_embedding_matches_and_saturates():
    new_topic_tokens = {"deadline", "exam", "anxious"}
    new_embedding = [1.0, 0.0, 0.0]
    no_match = PriorMemoryObject(id=1, topic_tokens={"sleep", "tired"}, embedding=[0.0, 1.0, 0.0])
    topic_match = PriorMemoryObject(id=2, topic_tokens={"deadline", "exam"}, embedding=[])
    embedding_match = PriorMemoryObject(id=3, topic_tokens={"unrelated"}, embedding=[1.0, 0.0, 0.0])

    score, count, matched_ids = score_recurrence(new_topic_tokens, new_embedding, [no_match, topic_match, embedding_match])
    assert count == 2
    assert set(matched_ids) == {2, 3}
    assert 0.0 < score <= 1.0

    zero_score, zero_count, zero_matches = score_recurrence(new_topic_tokens, new_embedding, [no_match])
    assert zero_count == 0
    assert zero_score == 0.0
    assert zero_matches == []


def test_score_confidence_is_tiered_not_blended():
    assert score_confidence("llm_assisted", "generated") == 0.9
    assert score_confidence("deterministic_fallback", "generated") == 0.5
    assert score_confidence("llm_assisted", "pending_no_openai_key") == 0.3
    assert score_confidence("deterministic_fallback", "pending_no_openai_key") == 0.3


def test_decay_factor_halves_at_half_life_and_resets_on_reinforcement():
    now = datetime(2026, 6, 22)
    fresh = decay_factor(now, last_reinforced_at=now, half_life_days=21.0)
    half_life_later = decay_factor(now, last_reinforced_at=datetime(2026, 6, 1), half_life_days=21.0)
    assert fresh == 1.0
    assert abs(half_life_later - 0.5) < 0.01

    importance = 0.8
    assert effective_importance(importance, now, now) == importance
    assert effective_importance(importance, now, datetime(2026, 5, 1)) < importance


def test_find_duplicate_requires_both_cosine_and_topic_overlap():
    new_tokens = {"deadline", "exam", "anxious"}
    new_embedding = [1.0, 0.0]
    high_cosine_low_topic = PriorMemoryObject(id=1, topic_tokens={"unrelated", "topic"}, embedding=[1.0, 0.0])
    low_cosine_high_topic = PriorMemoryObject(id=2, topic_tokens={"deadline", "exam"}, embedding=[0.0, 1.0])
    both_match = PriorMemoryObject(id=3, topic_tokens={"deadline", "exam"}, embedding=[1.0, 0.0001])

    assert find_duplicate(new_tokens, new_embedding, [high_cosine_low_topic]) is None
    assert find_duplicate(new_tokens, new_embedding, [low_cosine_high_topic]) is None
    duplicate = find_duplicate(new_tokens, new_embedding, [high_cosine_low_topic, low_cosine_high_topic, both_match])
    assert duplicate is not None
    assert duplicate[0] == 3
    assert "cosine=" in duplicate[1] and "topic_jaccard=" in duplicate[1]


def test_detect_contradictions_supersedes_older_opposite_tone_same_topic():
    topic_tokens = {"deadline", "exam"}
    older = PriorMemoryObject(id=1, topic_tokens=topic_tokens, dominant_tone="negative", created_at=datetime(2026, 6, 1))
    unrelated = PriorMemoryObject(id=2, topic_tokens={"sleep"}, dominant_tone="negative", created_at=datetime(2026, 6, 1))
    same_tone = PriorMemoryObject(id=3, topic_tokens=topic_tokens, dominant_tone="protective", created_at=datetime(2026, 6, 1))

    results = detect_contradictions(topic_tokens, "protective", datetime(2026, 6, 10), [older, unrelated, same_tone])
    assert len(results) == 1
    assert results[0]["id"] == 1
    assert results[0]["status"] == "superseded"


def test_detect_contradictions_neutral_new_tone_never_resolves_anything():
    topic_tokens = {"deadline", "exam"}
    older = PriorMemoryObject(id=1, topic_tokens=topic_tokens, dominant_tone="negative", created_at=datetime(2026, 6, 1))
    assert detect_contradictions(topic_tokens, "neutral", datetime(2026, 6, 10), [older]) == []


def test_jaccard_handles_empty_sets():
    assert jaccard(set(), {"a"}) == 0.0
    assert jaccard({"a"}, set()) == 0.0
    assert jaccard({"a", "b"}, {"b", "c"}) == 1 / 3


# ── Japanese reaches the vocabularies (#476) ──────────────────────────────────
#
# Every metric in this module is set membership against a hand-written word
# list, and the tokeniser used to split on whitespace — which Japanese does not
# use between words. '最近不安でつらい' arrived as one token and matched nothing,
# so each of these read 0 for every participant in a Japanese pilot while still
# returning a number. The English cases above all passed throughout; that is why
# nothing surfaced. These tests pair a Japanese case with the English case that
# already worked, so a regression to whitespace splitting fails here rather than
# shipping as a quiet zero.


@requires_dictionary
def test_tokenize_splits_a_japanese_sentence_into_words():
    """The regression itself: one token for a whole sentence is the bug."""
    assert len(tokenize("最近ずっとテストのプレッシャーで不安")) > 1


@pytest.mark.parametrize(
    ("japanese", "expected"),
    [
        ("今日は孤独で悲しい気持ちになった", "negative"),
        ("最近不安でつらい", "negative"),
        ("夜は怖いし眠れない", "negative"),
        ("友達に相談したら安心した", "protective"),
        ("よく休んだら安心した", "protective"),
        ("今日は体育祭だった", "neutral"),
    ],
)
@requires_dictionary
def test_emotional_tone_reads_japanese_like_english(japanese, expected):
    assert emotional_tone(japanese)["dominant"] == expected


@requires_dictionary
def test_tone_terms_match_the_inflection_a_student_writes():
    """`NEGATIVE_TONE_TERMS` lists 疲れ; a student writes 疲れてる.

    UniDic's lemma for 疲れ inside 疲れてる is 疲れる, so matching the lemma
    alone would miss the term the list actually names. Both forms are compared.
    """
    assert emotional_tone("ずっと疲れててしんどい")["negative"] >= 1
    assert emotional_tone("もう疲れた")["negative"] >= 1


@requires_dictionary
def test_tone_intensity_is_not_structurally_zero_for_japanese():
    """The heaviest component of the importance score (0.35) used to be 0."""
    _, breakdown = score_importance([_msg(1, "user", "今日は孤独で悲しい気持ちになった")])
    assert breakdown["components"]["tone_intensity"] > 0.0

    _, calm = score_importance([_msg(1, "user", "今日は体育祭だった")])
    assert calm["components"]["tone_intensity"] == 0.0


@requires_dictionary
def test_japanese_and_english_disclosures_score_comparably():
    """The same disclosure in either language must not score an order apart."""
    japanese, _ = score_importance([_msg(1, "user", "最近ずっと不安でつらい")])
    english, _ = score_importance([_msg(1, "user", "I have been anxious and stressed and tired")])
    assert japanese > 0.0
    assert abs(japanese - english) < 0.35


def test_score_importance_records_whether_japanese_could_be_analysed():
    """Stored as `score_breakdown_json`, so a degraded run is identifiable."""
    _, breakdown = score_importance([_msg(1, "user", "今日は孤独で悲しい気持ちになった")])
    assert isinstance(breakdown["japanese_analysis_available"], bool)


@requires_dictionary
def test_recurrence_sees_the_same_japanese_topic_across_days():
    """Topic Jaccard was 0 unless two segments were character-identical."""
    new_tokens = set(topic_tokens("テストのプレッシャーがきつい"))
    prior = PriorMemoryObject(
        id=1,
        topic_tokens=set(topic_tokens("またテストのプレッシャーで眠れない")),
        embedding=[],
    )
    unrelated = PriorMemoryObject(
        id=2,
        topic_tokens=set(topic_tokens("部活の試合で勝った")),
        embedding=[],
    )

    score, count, matched = score_recurrence(new_tokens, None, [prior, unrelated])
    assert count == 1
    assert matched == [1]
    assert score > 0.0


@requires_dictionary
def test_segment_window_splits_a_japanese_topic_shift():
    messages = [
        _msg(1, "user", "ずっとテストのプレッシャーで不安だった"),
        _msg(2, "assistant", "それはしんどいですね"),
        _msg(3, "user", "ところで、最近は眠れない日が続いている"),
        _msg(4, "assistant", "眠れないのはつらいですね"),
    ]
    segments = segment_window(messages)
    assert len(segments) == 2
    assert [m.id for m in segments[0]] == [1, 2]
    assert [m.id for m in segments[1]] == [3, 4]


# ── the label the student reads (#476) ────────────────────────────────────────
@requires_dictionary
def test_topic_label_is_words_not_the_whole_sentence():
    text = "サッカー部の練習がきつい。コーヒーを飲んで落ち着いた。"
    label = build_topic_label([_msg(1, "user", text)])
    assert label != text
    assert len(label) < len(text)
    assert "サッカー" in label


@requires_dictionary
def test_topic_label_never_prints_a_unidic_gloss():
    """`tokenize` returns lemmas, and UniDic's lemma for サッカー is サッカー-soccer.

    That is the right identity for the Jaccard maths and must not reach the
    memory card, which renders this string verbatim.
    """
    label = build_topic_label([_msg(1, "user", "サッカーとテストとプレッシャーの話")])
    assert "-soccer" not in label
    assert "-test" not in label
    assert "-代名詞" not in label


@requires_dictionary
def test_topic_label_ranks_what_the_segment_repeats():
    """It used to rank a deduplicated set, i.e. three arbitrary words."""
    segment = [
        _msg(1, "user", "テストのことばかり考える"),
        _msg(2, "user", "テストが終わらない"),
        _msg(3, "user", "ずっとテストの話をしている"),
    ]
    assert build_topic_label(segment, max_terms=1) == "テスト"


def test_a_missing_dictionary_is_recorded_rather_than_scored_as_calm(monkeypatch):
    """`tokenize.py` asks callers to record the degradation; this is where.

    With no dictionary the Japanese tone terms are unreachable again and the
    score falls back to what it was before #476. That is not avoidable here —
    but it must not be indistinguishable from a genuinely calm entry, so the
    flag travels with the numbers into `score_breakdown_json`.
    """
    import app.analytics.memory_objects as module

    monkeypatch.setattr(module, "japanese_analysis_available", lambda: False)
    _, breakdown = score_importance([_msg(1, "user", "今日は孤独で悲しい気持ちになった")])
    assert breakdown["japanese_analysis_available"] is False
