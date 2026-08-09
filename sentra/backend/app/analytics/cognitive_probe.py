from __future__ import annotations

from typing import Any, Dict, Set

from app.analytics.tokenize import (
    analyze,
    count_matches,
    contains_japanese,
    japanese_analysis_available,
)


PIPELINE_VERSION = "cognitive-probe-v3"

# Where each word list came from. Recorded in the payload so a consumer can see
# that these are hand-written, not derived from a validated instrument — and so
# adding a sourced list later is a change of value rather than a new field.
VOCABULARY_PROVENANCE = {
    "negative": "author_judgement_unsourced",
    "positive": "author_judgement_unsourced",
    "self_reference": "closed_class_pronouns",
    "recency": "author_judgement_unsourced",
    "reflection": "author_judgement_unsourced",
}

# Vocabularies are matched against both the surface form and the UniDic lemma,
# so an inflected occurrence reaches the same entry: 疲れてる and 疲れた both
# reduce to 疲れる. Where UniDic's lemma differs from the everyday citation form
# (助け -> 助ける, すぐ -> 直ぐ, 私 -> 私-代名詞) both spellings are listed rather
# than relying on one of them winning.

NEGATIVE_TERMS = {
    "alone",
    "anxious",
    "bad",
    "failed",
    "fear",
    "hopeless",
    "lonely",
    "panic",
    "sad",
    "scared",
    "stuck",
    "tired",
    "worried",
    "不安",
    "孤独",
    "怖い",
    "悲しい",
    "疲れ",
    "疲れる",
    "しんどい",
    "つらい",
    "辛い",
    "苦しい",
    "消える",
    "死にたい",
    "無理",
    "焦る",
    "落ち込む",
}
POSITIVE_TERMS = {
    "better",
    "calm",
    "friend",
    "good",
    "helped",
    "hope",
    "okay",
    "relieved",
    "safe",
    "support",
    "安心",
    "友達",
    "助け",
    "助ける",
    "良い",
    "嬉しい",
    "楽しい",
    "大丈夫",
    "落ち着く",
    "支え",
    "支える",
}
SELF_REFERENCE_TERMS = {"i", "me", "my", "mine", "myself", "私", "私-代名詞", "自分", "僕", "俺", "わたし", "ぼく"}
RECENCY_TERMS = {"first", "immediately", "just", "now", "today", "最初", "すぐ", "直ぐ", "今", "今日", "さっき", "最近"}

# Reflection-side vocabulary: problem-solving, future orientation, reappraisal,
# plan-making. The RRS separates reflection from brooding because they carry
# different clinical significance — brooding is the component associated with
# depressive outcomes, reflection is not — and the previous implementation had
# no reflection-side input at all. All three of its components were
# brooding-side, so the scalar was brooding-only under a name covering both.
#
# UNSOURCED, like the lists above: these are the author's judgement of what
# problem-solving language looks like, not items drawn from an instrument.
# VOCABULARY_PROVENANCE says so in the payload.
REFLECTION_TERMS = {
    "plan", "planned", "try", "trying", "next", "tomorrow", "solve", "figure",
    "instead", "maybe", "could", "decide", "decided", "start", "started",
    "ask", "asked", "talk", "understand", "realize", "realized", "change",
    "計画", "予定", "next", "やってみる", "試す", "考える", "整理",
    "解決", "相談", "話す", "聞く", "決める", "決めた", "変える",
    "気づく", "気づいた", "分かる", "分かった", "次は", "明日", "これから",
}


def _jaccard_distance(left: Set[str], right: Set[str]) -> float:
    if not left and not right:
        return 0.0
    union = left.union(right)
    if not union:
        return 0.0
    return round(1 - (len(left.intersection(right)) / len(union)), 6)


def cognitive_probe_features(journal_text: str, recall_text: str) -> Dict[str, Any]:
    recall_words = analyze(recall_text)
    journal_words = analyze(journal_text)
    recall_set = {word.canonical for word in recall_words}
    journal_set = {word.canonical for word in journal_words}
    token_count = len(recall_words)
    negative_count = count_matches(recall_words, NEGATIVE_TERMS)
    positive_count = count_matches(recall_words, POSITIVE_TERMS)
    self_ref_count = count_matches(recall_words, SELF_REFERENCE_TERMS)
    recency_count = count_matches(recall_words, RECENCY_TERMS)
    repeated_count = token_count - len(recall_set)
    negative_density = negative_count / token_count if token_count else 0.0
    positive_density = positive_count / token_count if token_count else 0.0
    self_ref_density = self_ref_count / token_count if token_count else 0.0
    perseveration = repeated_count / token_count if token_count else 0.0
    reflection_count = count_matches(recall_words, REFLECTION_TERMS)
    reflection_density = reflection_count / token_count if token_count else 0.0

    # Scored as an UNWEIGHTED MEAN, which is what the RRS actually does — its
    # subscales are the average of their items, with no factor weights of the
    # kind that used to sit here (0.45/0.30/0.25, which appear in no commit,
    # comment or document). Equal weighting is not a placeholder pending
    # review: it is the more faithful rule, and it replaces three numbers that
    # cannot be justified with one that can.
    #
    # Reported as two components rather than one scalar, for the same reason
    # the RRS reports two factors. Both range 0.0-1.0.
    brooding_like = (negative_density + self_ref_density + perseveration) / 3
    reflection_like = reflection_density

    # No combined scalar is emitted. Averaging a brooding-side and a
    # reflection-side signal would reproduce exactly the collapse this split
    # exists to undo — and there is no basis for choosing how to weight them
    # against each other.
    return {
        "pipeline_version": PIPELINE_VERSION,
        "probe_name": "first_recall_30",
        "token_count": token_count,
        "char_count": len(recall_text),
        "negative_term_count": negative_count,
        "positive_term_count": positive_count,
        "recall_valence": round(positive_density - negative_density, 6),
        "self_ref_density": round(self_ref_density, 6),
        "perseveration": round(perseveration, 6),
        "recency_marker_count": recency_count,
        "semantic_distance_to_journal": _jaccard_distance(recall_set, journal_set),
        "reflection_density": round(reflection_density, 6),
        # Renamed from rumination_index. Rumination is a clinical construct
        # with a reference instrument; this is a lexical density that shares
        # nothing with it but the word. The name travelled further than the
        # docstring — into the API, the graph payload, and anything a reviewer
        # or educator reads.
        "negative_self_focus_score": round(brooding_like, 6),
        "reflective_focus_score": round(reflection_like, 6),
        # Travels with the values so a consumer cannot mistake them for a
        # validated measure. See docs/rumination_index_provenance.md.
        "focus_scores_status": "exploratory_equal_weighted_unvalidated",
        "vocabulary_provenance": VOCABULARY_PROVENANCE,
        "empty_probe": token_count == 0,
        # Whether this reading can be trusted. Japanese text analysed without a
        # dictionary falls back to whitespace splitting and under-counts every
        # lexicon metric — the original defect. Recording it means a degraded
        # environment shows up in the data instead of looking like a calm week.
        "contains_japanese": contains_japanese(recall_text) or contains_japanese(journal_text),
        "japanese_analysis_available": japanese_analysis_available(),
    }


def read_negative_self_focus(feature_json: Dict[str, Any]) -> float | None:
    """Read the score from a stored probe row of any pipeline version.

    Rows written before cognitive-probe-v3 carry `rumination_index`, computed
    with the old 0.45/0.30/0.25 weights. They are NOT converted — the two are
    different numbers on different scales, and silently treating one as the
    other would put the unsourced weights back into the data under a name that
    implies they are gone.

    Callers that need to compare across the boundary must check
    `pipeline_version` and decide explicitly. This function only saves them
    from a KeyError.
    """
    if "negative_self_focus_score" in feature_json:
        return float(feature_json["negative_self_focus_score"])
    if "rumination_index" in feature_json:
        return float(feature_json["rumination_index"])
    return None


def is_legacy_probe_row(feature_json: Dict[str, Any]) -> bool:
    """True for rows scored with the old weighted sum."""
    return "rumination_index" in feature_json and "negative_self_focus_score" not in feature_json
