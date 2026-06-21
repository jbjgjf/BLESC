"""Unit tests for the dependency-free conversation-memory-object scorer."""

from datetime import datetime

from app.analytics.memory_objects import (
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
