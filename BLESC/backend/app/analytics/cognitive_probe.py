from __future__ import annotations

import re
from typing import Any, Dict, Set


PIPELINE_VERSION = "cognitive-probe-v1"

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
    "良い",
}
SELF_REFERENCE_TERMS = {"i", "me", "my", "mine", "myself", "私", "自分", "僕", "俺"}
RECENCY_TERMS = {"first", "immediately", "just", "now", "today", "最初", "すぐ", "今", "今日"}


def _tokens(text: str) -> list[str]:
    normalized = re.sub(r"[^a-zA-Z0-9ぁ-んァ-ン一-龥]+", " ", text.lower())
    return [part for part in normalized.split() if part]


def _jaccard_distance(left: Set[str], right: Set[str]) -> float:
    if not left and not right:
        return 0.0
    union = left.union(right)
    if not union:
        return 0.0
    return round(1 - (len(left.intersection(right)) / len(union)), 6)


def cognitive_probe_features(journal_text: str, recall_text: str) -> Dict[str, Any]:
    recall_tokens = _tokens(recall_text)
    journal_tokens = _tokens(journal_text)
    recall_set = set(recall_tokens)
    journal_set = set(journal_tokens)
    token_count = len(recall_tokens)
    negative_count = sum(1 for token in recall_tokens if token in NEGATIVE_TERMS)
    positive_count = sum(1 for token in recall_tokens if token in POSITIVE_TERMS)
    self_ref_count = sum(1 for token in recall_tokens if token in SELF_REFERENCE_TERMS)
    recency_count = sum(1 for token in recall_tokens if token in RECENCY_TERMS)
    repeated_count = token_count - len(recall_set)
    negative_density = negative_count / token_count if token_count else 0.0
    positive_density = positive_count / token_count if token_count else 0.0
    self_ref_density = self_ref_count / token_count if token_count else 0.0
    perseveration = repeated_count / token_count if token_count else 0.0
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
        "empty_probe": token_count == 0,
    }
