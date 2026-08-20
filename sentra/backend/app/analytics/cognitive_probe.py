from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence, Set

from app.ontology.sources import resolve

from app.analytics.tokenize import (
    analyze,
    count_matches,
    contains_japanese,
    japanese_analysis_available,
)


#: v4 (2026-08-13): the shared tokeniser stopped counting 動詞-非自立可能 verbs
#: that follow a 接続助詞 as content — the 〜てくる / 〜てしまう / 〜ていく aspect
#: constructions. They are grammar, not vocabulary, and they were inflating
#: token_count, which is the denominator of every density here. Densities from v3
#: and v4 are therefore not comparable and read_negative_self_focus() must keep
#: refusing to convert across versions.
#:
#: Found through the #87 retrieval benchmark rather than here: two Japanese
#: sentences sharing only 「〜てきた」 matched lexically, which is the same class
#: of defect as D-01 and was invisible in the probe's own output.
PIPELINE_VERSION = "cognitive-probe-v5"

#: v5 (2026-08-20): the free recall is elicited BEFORE the journal, not after.
#:
#: No formula changed. The same two texts reach the same code; what changed is
#: which text existed when the other was written, and that decides what
#: `semantic_distance_to_journal` is a distance BETWEEN.
#:
#: `rumination_index_provenance.md` defines the construct as a "30-second free
#: recall" — unplanned, unedited, whatever surfaces. Eliciting it after the
#: journal meant the student had just spent minutes composing an account of the
#: same day, so what surfaced was that account: the distance measured how much
#: they repeated themselves. Under v5 it measures what the dossier says, a
#: spontaneous sample against a considered one.
#:
#: v4 and v5 distances are therefore NOT comparable, and neither are the
#: densities — a rushed unedited sample and a recalled-after-composing one have
#: different lexical statistics. `elicitation_order` is recorded on every row so
#: the boundary is visible in the data rather than inferable only from a date.

@dataclass(frozen=True)
class VocabularyProvenance:
    """Where a word list came from, and what would change it.

    These lists are the entire input to the score. Their contents are as
    load-bearing as the weights were, and had less scrutiny — so each one
    states its basis, its selection rule, and what would take a term out.

    `source_refs` resolve against app/ontology/sources.py. A list with no
    published basis says so via `expert_judgement` rather than leaving the
    field empty, which is the same rule the ontology follows.
    """

    source_refs: List[str]
    inclusion_rule: str
    exclusion_rule: str

    def as_dict(self, terms: Set[str]) -> Dict[str, Any]:
        english = sorted(term for term in terms if term.isascii())
        japanese = sorted(term for term in terms if not term.isascii())
        return {
            "source_refs": list(self.source_refs),
            "kinds": [resolve(ref).kind.value for ref in self.source_refs],
            "inclusion_rule": self.inclusion_rule,
            "exclusion_rule": self.exclusion_rule,
            # Reported per language so a thin list on one side is visible
            # rather than hidden inside a total.
            "size_en": len(english),
            "size_ja": len(japanese),
        }


VOCABULARY_PROVENANCE: Dict[str, VocabularyProvenance] = {
    "negative": VocabularyProvenance(
        source_refs=["rude_2004_pronouns", "liwc_category", "expert_judgement"],
        inclusion_rule=(
            "Negative-valence affect words a secondary-school student would plausibly "
            "write. Rude et al. support elevated negative-valence word use as a marker; "
            "the specific membership is hand-written and is not a LIWC category."
        ),
        exclusion_rule=(
            "Out if it only reads negative in one register (dark slang used as a joke), "
            "or if it names a diagnosis rather than an experience."
        ),
    ),
    "positive": VocabularyProvenance(
        source_refs=["liwc_category", "expert_judgement"],
        inclusion_rule="Positive-valence counterpart to the negative list, same register.",
        exclusion_rule="Out if its positivity depends on context ('fine', 'whatever').",
    ),
    "self_reference": VocabularyProvenance(
        source_refs=["rude_2004_pronouns", "liwc_category"],
        inclusion_rule=(
            "First-person SINGULAR only — the scope Rude et al. actually support. "
            "The English list is exactly i/me/my/mine/myself; plural forms are "
            "deliberately absent because the finding does not extend to them."
        ),
        exclusion_rule=(
            "Out if plural, or if the source's scope does not reach it. The Japanese "
            "entries are NOT covered by that source: Japanese drops pronouns freely, so "
            "density measures something different, and no Japanese lexicon was consulted."
        ),
    ),
    "recency": VocabularyProvenance(
        source_refs=["expert_judgement"],
        inclusion_rule="Words placing an event close to now. No source; a design choice.",
        exclusion_rule="Out if it can refer to any point in time ('then', 'once').",
    ),
    "reflection": VocabularyProvenance(
        source_refs=["expert_judgement"],
        inclusion_rule=(
            "Problem-solving, future orientation, reappraisal, plan-making — the "
            "reflection side the RRS keeps separate from brooding. Author's judgement "
            "of what that language looks like, not items from an instrument."
        ),
        exclusion_rule="Out if it marks intention without any action or reappraisal.",
    ),
}

#: Japanese lexicons were investigated, exist, and are NOT used. Recorded here
#: because 'we looked and found nothing' would have been the easier claim and
#: is not the true one — see the j_liwc2015_not_used source entry.
JAPANESE_LEXICON_STATUS = "suitable_resources_exist_but_unused"

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


#: What `field_order` has to look like for the recall to be a free recall.
RECALL_FIRST = ("first_recall_30", "journal_entry")


def elicitation_order(field_order: Optional[Sequence[str]]) -> str:
    """Which prompt the student actually answered first.

    Derived from telemetry rather than assumed from the UI, because the UI does
    not force the order — it defaults to it. A session that went the other way
    is a v4-shaped observation wearing a v5 version string, and an analysis that
    cannot tell them apart would pool two different constructs.

    `unknown` when no field order was recorded: absent telemetry is not evidence
    that the default was followed.
    """
    if not field_order:
        return "unknown"
    ordered = [name for name in field_order if name in RECALL_FIRST]
    if not ordered:
        return "unknown"
    if len(ordered) == 1:
        # Only one prompt was ever touched, so nothing was ordered against
        # anything. Named rather than folded into recall_first.
        return f"only_{ordered[0]}"
    return "recall_first" if tuple(ordered[:2]) == RECALL_FIRST else "journal_first"


def cognitive_probe_features(
    journal_text: str,
    recall_text: str,
    field_order: Optional[Sequence[str]] = None,
) -> Dict[str, Any]:
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
        # Which text existed when the other was written. Under v5 the UI
        # defaults to recall-first but does not force it, so this is measured,
        # not assumed — and it is what tells a later analysis whether a row is
        # the construct the dossier describes.
        "elicitation_order": elicitation_order(field_order),
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
        "vocabulary_provenance": {
            "negative": VOCABULARY_PROVENANCE["negative"].as_dict(NEGATIVE_TERMS),
            "positive": VOCABULARY_PROVENANCE["positive"].as_dict(POSITIVE_TERMS),
            "self_reference": VOCABULARY_PROVENANCE["self_reference"].as_dict(SELF_REFERENCE_TERMS),
            "recency": VOCABULARY_PROVENANCE["recency"].as_dict(RECENCY_TERMS),
            "reflection": VOCABULARY_PROVENANCE["reflection"].as_dict(REFLECTION_TERMS),
            "japanese_lexicon_status": JAPANESE_LEXICON_STATUS,
        },
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
