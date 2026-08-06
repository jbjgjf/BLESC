from __future__ import annotations

from typing import Any, Dict, Set

from app.analytics.tokenize import (
    analyze,
    count_matches,
    contains_japanese,
    japanese_analysis_available,
)


PIPELINE_VERSION = "cognitive-probe-v2"

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
    # UNSOURCED WEIGHTS — see docs/rumination_index_provenance.md (D-03).
    #
    # 0.45/0.30/0.25 appear in no commit, comment or document. They were chosen,
    # not derived. The name refers to a clinical construct whose reference
    # instrument (RRS; Treynor et al., 2003) is a self-report questionnaire
    # scored as an unweighted mean of items and reported as two separate
    # factors — none of which this resembles. The correspondence is nominal.
    #
    # Pending clinical review, treat this as exploratory. Do not present it to
    # educators as a clinical measure and do not cite a source for it.
    rumination_index = min(1.0, (negative_density * 0.45) + (self_ref_density * 0.30) + (perseveration * 0.25))
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
        "rumination_index": round(rumination_index, 6),
        # Travels with the value so a consumer cannot mistake it for a
        # validated measure. See docs/rumination_index_provenance.md.
        "rumination_index_status": "exploratory_unsourced_weights",
        "empty_probe": token_count == 0,
        # Whether this reading can be trusted. Japanese text analysed without a
        # dictionary falls back to whitespace splitting and under-counts every
        # lexicon metric — the original defect. Recording it means a degraded
        # environment shows up in the data instead of looking like a calm week.
        "contains_japanese": contains_japanese(recall_text) or contains_japanese(journal_text),
        "japanese_analysis_available": japanese_analysis_available(),
    }
