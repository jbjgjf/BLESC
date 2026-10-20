"""
Conversation memory object extraction and scoring.

30-turn recall used to collapse an entire window of chat turns into one summary
blob (see the old `_conversation_summary_from_messages` in research_pipeline.py).
This module turns a window into multiple discrete, reusable memory objects, each
with its own explainable importance/recurrence/confidence score, plus the merge
and contradiction logic needed to keep memories from duplicating or going stale
across overlapping windows.

Everything here is deterministic by default, following the same convention as
pattern_mining.py: no numpy, no LLM-trusted numbers. An LLM may optionally
propose segment boundaries / topic / summary text upstream (behind the caller's
`_has_openai_key()` gate), but every *score* in this module is always computed
from the segmented text itself, never blended from a model output, so every
score stays inspectable via its breakdown dict.

The one dependency is `analytics/tokenize.py`, and through it the optional
fugashi/unidic-lite pair. It is not optional in effect: without a dictionary
Japanese text has no word boundaries to read, so every vocabulary metric below
reads 0 (#476). That degradation is deterministic, logged by `tokenize.py`, and
recorded in `score_importance`'s breakdown rather than left to look like calm.

This module has no DB/session dependency on purpose: it takes plain dataclasses
and dicts in, returns plain dicts out, so it is trivial to unit test and safe to
call from inside the request path.
"""

from __future__ import annotations

import math
import re
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple

from ..clock import utcnow
from ..services.safety import fold_writing, spellings
from .tokenize import Token, analyze, contains_japanese, japanese_analysis_available

# v2: the tone and topic metrics are read off the shared morphological
# tokeniser rather than off whitespace (#476), so a score from before this
# change and one from after are not the same measurement. Stored per row as
# `pipeline_version`, which is what lets the two be told apart; re-scoring the
# rows already written is #452's question, not this module's.
MEMORY_OBJECT_VERSION = "conversation-memory-object-v2"

# ── thresholds ───────────────────────────────────────────────────────────────
SEGMENT_TOPIC_JACCARD_THRESHOLD = 0.25   # below this, a new turn starts a new segment
MERGE_COSINE_THRESHOLD = 0.92            # embedding similarity required to consider two objects duplicates
MERGE_TOPIC_JACCARD_THRESHOLD = 0.6      # topic overlap required (in addition to cosine) to merge
RECURRENCE_COSINE_THRESHOLD = 0.85       # embedding similarity required to count as a recurrence
# Topic-overlap fallback for recurrence/contradiction matching when no embedding is
# available: segments are short (often 1-2 turns), so only 1-2 specific words may
# overlap out of ~8-15 unique tokens once generic conversational filler is mixed in.
# A strict Jaccard ratio would miss those real recurrences, so the bar is low —
# this is intentionally a looser, "topic-adjacent" signal than the embedding path.
RECURRENCE_TOPIC_JACCARD_THRESHOLD = 0.2
RECURRENCE_TOPIC_MIN_OVERLAP = 2
RECURRENCE_CAP = 8                       # recurrence_score saturates around this many matches
DECAY_HALF_LIFE_DAYS = 21.0
CONTRADICTION_TOPIC_JACCARD_THRESHOLD = 0.2

TOPIC_STOPWORDS = {
    "about", "after", "again", "also", "and", "are", "because", "before", "but", "can", "could", "does",
    "from", "have", "how", "into", "just", "like", "maybe", "more", "not", "please", "that", "the",
    "then", "there", "this", "what", "when", "with", "would", "your", "you", "yourself", "です", "ます",
    "した", "して", "こと", "それ", "これ", "ある", "いる", "ない", "よう", "から", "ですか",
}
NEGATIVE_TONE_TERMS = {
    "anxious", "anxiety", "bad", "deadline", "fear", "hard", "hopeless", "lonely", "panic", "sad",
    "scared", "stress", "stuck", "tired", "worried", "不安", "怖い", "悲しい", "孤独", "疲れ", "つらい",
}
PROTECTIVE_TONE_TERMS = {
    "better", "calm", "friend", "help", "helped", "plan", "safe", "sleep", "support", "walk",
    "安心", "友達", "助け", "相談", "休む", "安全", "睡眠",
}
# Ported from frontend/src/app/recall/page.tsx `crisisTerms` so the same safety
# signal that gates the chat UI also feeds the importance score server-side.
CRISIS_TERMS = {
    "自殺", "死にたい", "消えたい", "殺したい", "傷つけたい",
    "suicide", "kill myself", "want to die", "self-harm", "hurt myself",
}
# The two terms above that the safety lexicons do not carry. Every other
# reading comes from `app.services.safety.KANA_SPELLINGS`, so 「しにたい」 is
# spelled out once for both the chat gate and this score (#392).
_CRISIS_READINGS = {"殺したい": ("ころしたい",), "傷つけたい": ("きずつけたい",)}
_CRISIS_SPELLINGS = spellings(tuple(sorted(CRISIS_TERMS)), _CRISIS_READINGS)

IMPORTANCE_WEIGHTS = {
    "tone_intensity": 0.35,
    "has_open_loop": 0.25,
    "specificity": 0.20,
    "crisis_or_safety_flag": 0.20,
}


@dataclass
class RecallMessage:
    """Minimal, DB-independent view of a chat turn used for segmentation/scoring."""

    id: int
    role: str
    text: str
    created_at: datetime


@dataclass
class PriorMemoryObject:
    """Minimal view of an already-persisted memory object, used for recurrence,
    duplicate-merge, and contradiction lookups against new candidates."""

    id: int
    topic_tokens: Set[str] = field(default_factory=set)
    embedding: List[float] = field(default_factory=list)
    dominant_tone: str = "neutral"
    created_at: datetime = field(default_factory=utcnow)


# ── text helpers ──────────────────────────────────────────────────────────────
# `analytics/tokenize.py` is "the one place that decides what a token is", and
# this module ignored it: it split on whitespace, which is not where Japanese
# puts its word boundaries. 「最近不安でつらい」 arrived as one token, matched
# nothing in `NEGATIVE_TONE_TERMS`, and every metric below built on set
# membership read 0 for every Japanese participant — with a number still
# returned, so nothing surfaced as a failure (#476). #68 moved
# `cognitive_probe.py` and `scoring.py` onto the shared tokeniser and left this
# module, `pattern_mining.py` and `graph_index.py` behind.
#
# The arithmetic underneath is unchanged, deliberately. Every count keeps the
# unit it had — distinct tokens, distinct vocabulary terms — so ASCII text
# scores exactly what it scored before and only the segmentation of Japanese
# moves. `pattern_mining.py`, `graph_index.py` and `research_pipeline._tokenize`
# still split on whitespace and still drop ー / ヴ / 々 from the character
# class; that is #476's remainder and #477.


def _words(value: Any) -> List[Token]:
    """The analysed words of one text, filtered the way this module always has.

    `analyze` already drops Japanese particles and auxiliaries, so the length
    floor is left doing the only job it did here: dropping ASCII fragments too
    short to be a topic (`me`, `ok`) while keeping two-character Japanese
    content words (`不安`, `友達`).
    """
    return [
        word
        for word in analyze(str(value or ""))
        if len(word.canonical) >= 3 or contains_japanese(word.canonical)
    ]


def tokenize(value: Any) -> Set[str]:
    """One canonical form per distinct word — the set the Jaccard maths uses."""
    return {word.canonical for word in _words(value)}


def _is_stopword(word: Token) -> bool:
    """`TOPIC_STOPWORDS` is written in surface forms, so both forms are checked.

    UniDic's lemma for ある is 有る and for した is する, so filtering the
    canonical form alone would let the words the list names back in.
    """
    return bool({word.surface, word.canonical} & TOPIC_STOPWORDS)


def topic_tokens(text: str) -> List[str]:
    """Distinct content words. Deduplicated, as every caller reads it as a set."""
    return sorted({
        word.canonical
        for word in _words(text)
        if not _is_stopword(word) and not word.canonical.isdigit()
    })


def _terms_present(words: Sequence[Token], vocabulary: Set[str]) -> Set[str]:
    """Which vocabulary terms the text uses, matching surface *or* lemma.

    Both forms, for the reason `tokenize.py` gives: UniDic's lemma for 疲れ
    inside 疲れてる is 疲れる, so matching the lemma alone would leave the
    「疲れ」 that `NEGATIVE_TONE_TERMS` actually lists unreachable. For ASCII
    the two forms are the same string, which is why this is identical to the
    set intersection it replaces.
    """
    forms = {form for word in words for form in word.forms}
    return vocabulary & forms


def message_tone(text: str) -> Dict[str, int]:
    """How many distinct tone terms the text uses, per polarity.

    Distinct terms rather than positions: the unit this returned before, and
    the one `score_importance` divides by a distinct-token count.
    """
    words = _words(text)
    return {
        "negative": len(_terms_present(words, NEGATIVE_TONE_TERMS)),
        "protective": len(_terms_present(words, PROTECTIVE_TONE_TERMS)),
    }


def emotional_tone(text: str) -> Dict[str, Any]:
    tone = message_tone(text)
    negative, protective = tone["negative"], tone["protective"]
    if negative > protective:
        dominant = "negative"
    elif protective > negative:
        dominant = "protective"
    else:
        dominant = "neutral"
    return {"negative": negative, "protective": protective, "valence": protective - negative, "dominant": dominant}


def has_crisis_language(text: str) -> bool:
    # Folded the way the safety assessment folds, and compared against folded
    # spellings: 「しにたい」「シニタイ」「ｼﾆﾀｲ」 are the same disclosure as 「死にたい」.
    folded = fold_writing(str(text or ""))
    return any(term in folded for term in _CRISIS_SPELLINGS)


def jaccard(left: Set[str], right: Set[str]) -> float:
    if not left or not right:
        return 0.0
    intersection = len(left & right)
    if intersection == 0:
        return 0.0
    return intersection / len(left | right)


def cosine_similarity(left: Sequence[float], right: Sequence[float]) -> float:
    if not left or not right or len(left) != len(right):
        return 0.0
    dot = sum(a * b for a, b in zip(left, right))
    left_norm = math.sqrt(sum(a * a for a in left))
    right_norm = math.sqrt(sum(b * b for b in right))
    if left_norm == 0 or right_norm == 0:
        return 0.0
    return dot / (left_norm * right_norm)


# ── segmentation ──────────────────────────────────────────────────────────────
def segment_window(
    messages: Sequence[RecallMessage],
    jaccard_threshold: float = SEGMENT_TOPIC_JACCARD_THRESHOLD,
) -> List[List[RecallMessage]]:
    """
    Greedily group consecutive turns into coherent segments.

    A new segment starts on a ``user`` turn whose topic-token overlap with the
    running segment drops below ``jaccard_threshold`` (a new disclosure topic).
    Non-user turns (assistant replies) and turns with no topic tokens always
    attach to the current segment — a reply belongs with the user turn it
    responds to, it shouldn't fragment the window into its own memory object.
    """
    if not messages:
        return []
    segments: List[List[RecallMessage]] = [[messages[0]]]
    current_tokens: Set[str] = set(topic_tokens(messages[0].text))
    for message in messages[1:]:
        message_tokens = set(topic_tokens(message.text))
        overlap = jaccard(current_tokens, message_tokens)
        if message.role != "user" or not message_tokens or overlap >= jaccard_threshold:
            segments[-1].append(message)
            current_tokens |= message_tokens
        else:
            segments.append([message])
            current_tokens = message_tokens
    return segments


def build_topic_label(segment: Sequence[RecallMessage], max_terms: int = 3) -> str:
    """The heading the student reads on the memory card, so it prints surfaces.

    Not `topic_tokens`, for two reasons. A UniDic lemma carries a
    disambiguating gloss — サッカー comes back as `サッカー-soccer` and 私 as
    `私-代名詞` — which is the right identity for the Jaccard maths above and
    the wrong thing to show anyone. And `topic_tokens` is deduplicated, so the
    `most_common` here was ranking a set: three arbitrary words rather than the
    three the segment actually repeats.
    """
    combined = " ".join(message.text for message in segment)
    counts = Counter(
        word.surface
        for word in _words(combined)
        if not _is_stopword(word) and not word.canonical.isdigit()
    )
    top_terms = [term for term, _ in counts.most_common(max_terms)]
    return ", ".join(top_terms) if top_terms else "general reflection"


def build_summary(segment: Sequence[RecallMessage], limit: int = 240) -> str:
    user_texts = [message.text for message in segment if message.role == "user"]
    combined = " ".join(user_texts) if user_texts else " ".join(message.text for message in segment)
    combined = re.sub(r"\s+", " ", combined).strip()
    return combined[:limit]


# ── scoring ───────────────────────────────────────────────────────────────────
def score_importance(segment: Sequence[RecallMessage]) -> Tuple[float, Dict[str, Any]]:
    """
    Explainable importance score in [0, 1]. Every weighted component is returned
    in the breakdown dict alongside the weights, so the stored score is always
    traceable to *why* — no blended/opaque number.
    """
    combined_text = " ".join(message.text for message in segment)
    tokens = tokenize(combined_text)
    tone = message_tone(combined_text)
    tone_hits = tone["negative"] + tone["protective"]
    tone_intensity = min(1.0, (tone_hits / max(1, len(tokens))) * 5.0)

    has_open_loop = 1.0 if any(
        message.role == "user" and ("?" in message.text or "？" in message.text)
        for message in segment
    ) else 0.0

    topic_toks = topic_tokens(combined_text)
    # Still not comparable across languages, and left that way on purpose.
    # This is (distinct content words / distinct words), so what it measures is
    # how much of the text `TOPIC_STOPWORDS` removed. `analyze` already drops
    # Japanese particles and auxiliaries before the list is consulted, so a
    # Japanese segment has almost nothing left to remove and sits near 1.0
    # while an English one of the same substance sits near 0.8. Correcting it
    # means dividing by every word including the function words, which changes
    # what the 0.20 component means for text already scored — a decision about
    # the measurement rather than a bug. Recorded on #476 rather than taken
    # here.
    specificity = (len(set(topic_toks)) / len(tokens)) if tokens else 0.0
    crisis_flag = 1.0 if any(has_crisis_language(message.text) for message in segment) else 0.0

    components = {
        "tone_intensity": round(tone_intensity, 4),
        "has_open_loop": has_open_loop,
        "specificity": round(min(1.0, specificity), 4),
        "crisis_or_safety_flag": crisis_flag,
    }
    score = sum(IMPORTANCE_WEIGHTS[key] * value for key, value in components.items())
    # Recorded alongside the numbers, as `tokenize.py` asks callers to do: with
    # no dictionary installed, Japanese falls back to whitespace splitting and
    # `tone_intensity` is under-counted the way #476 describes. The breakdown is
    # stored as `score_breakdown_json`, so a deployment that was missing
    # fugashi/unidic-lite is identifiable in the research data afterwards
    # instead of being indistinguishable from a quiet zero.
    breakdown = {
        "components": components,
        "weights": dict(IMPORTANCE_WEIGHTS),
        "japanese_analysis_available": japanese_analysis_available(),
    }
    return round(min(1.0, score), 4), breakdown


def score_recurrence(
    new_topic_tokens: Set[str],
    new_embedding: Optional[Sequence[float]],
    prior_objects: Sequence[PriorMemoryObject],
    cap: int = RECURRENCE_CAP,
) -> Tuple[float, int, List[int]]:
    """
    Count prior memory objects that recur with this one (topic overlap OR
    embedding similarity above threshold), then log-normalize the count into a
    bounded [0, 1] score so frequent topics saturate instead of growing unbounded.
    """
    matched_ids: List[int] = []
    for prior in prior_objects:
        topic_overlap = len(new_topic_tokens & prior.topic_tokens)
        topic_match = (
            topic_overlap >= RECURRENCE_TOPIC_MIN_OVERLAP
            or jaccard(new_topic_tokens, prior.topic_tokens) >= RECURRENCE_TOPIC_JACCARD_THRESHOLD
        )
        embedding_match = (
            bool(new_embedding) and bool(prior.embedding)
            and cosine_similarity(new_embedding, prior.embedding) >= RECURRENCE_COSINE_THRESHOLD
        )
        if topic_match or embedding_match:
            matched_ids.append(prior.id)
    count = len(matched_ids)
    score = (math.log(1 + count) / math.log(1 + cap)) if count else 0.0
    return round(min(1.0, score), 4), count, matched_ids


def score_confidence(extraction_mode: str, embedding_status: str) -> float:
    """
    Tiered, not blended: the number is always traceable to which pipeline path
    actually ran, recorded alongside it in `extraction_mode`/`embedding_status`.
    """
    if extraction_mode == "llm_assisted" and embedding_status == "generated":
        return 0.9
    if embedding_status == "generated":
        return 0.5
    return 0.3


def decay_factor(now: datetime, last_reinforced_at: datetime, half_life_days: float = DECAY_HALF_LIFE_DAYS) -> float:
    if half_life_days <= 0:
        return 1.0
    age_days = max(0.0, (now - last_reinforced_at).total_seconds() / 86400.0)
    return 0.5 ** (age_days / half_life_days)


def effective_importance(
    importance_score: float,
    now: datetime,
    last_reinforced_at: datetime,
    half_life_days: float = DECAY_HALF_LIFE_DAYS,
) -> float:
    """
    Computed at read time, never mutated in storage: decay is fully reproducible
    from `importance_score` + `last_reinforced_at`, and reinforcement (a
    duplicate/recurrence match) resets the clock without overwriting the
    original explainable score.
    """
    return round(importance_score * decay_factor(now, last_reinforced_at, half_life_days), 4)


# ── duplicate merging ─────────────────────────────────────────────────────────
def find_duplicate(
    new_topic_tokens: Set[str],
    new_embedding: Optional[Sequence[float]],
    candidates: Sequence[PriorMemoryObject],
) -> Optional[Tuple[int, str]]:
    """
    Returns ``(existing_id, merge_reason)`` for the closest duplicate above both
    the cosine and topic-overlap thresholds, or ``None`` if no candidate qualifies.
    """
    if not new_embedding:
        return None
    best: Optional[Tuple[int, str, float]] = None
    for candidate in candidates:
        if not candidate.embedding:
            continue
        cosine = cosine_similarity(new_embedding, candidate.embedding)
        topic_overlap = jaccard(new_topic_tokens, candidate.topic_tokens)
        if cosine >= MERGE_COSINE_THRESHOLD and topic_overlap >= MERGE_TOPIC_JACCARD_THRESHOLD:
            if best is None or cosine > best[2]:
                best = (candidate.id, f"cosine={cosine:.2f},topic_jaccard={topic_overlap:.2f}", cosine)
    return (best[0], best[1]) if best else None


# ── contradiction detection ────────────────────────────────────────────────────
def detect_contradictions(
    new_topic_tokens: Set[str],
    new_dominant_tone: str,
    new_created_at: datetime,
    candidates: Sequence[PriorMemoryObject],
) -> List[Dict[str, Any]]:
    """
    Deterministic tone-polarity-flip heuristic: for prior objects sharing a topic
    signature whose dominant tone is the opposite polarity, mark the
    chronologically older one as superseded (the newer statement is taken as
    more current) when ordering is unambiguous, otherwise flag both without
    auto-superseding. Never auto-resolves "neutral" tone objects.
    """
    if new_dominant_tone == "neutral":
        return []
    results: List[Dict[str, Any]] = []
    for candidate in candidates:
        if jaccard(new_topic_tokens, candidate.topic_tokens) < CONTRADICTION_TOPIC_JACCARD_THRESHOLD:
            continue
        if candidate.dominant_tone in ("neutral", new_dominant_tone):
            continue
        detail = {"previous_tone": candidate.dominant_tone, "new_tone": new_dominant_tone}
        if new_created_at >= candidate.created_at:
            results.append({"id": candidate.id, "status": "superseded", "detail": detail})
        else:
            results.append({"id": candidate.id, "status": "flagged", "detail": detail})
    return results
