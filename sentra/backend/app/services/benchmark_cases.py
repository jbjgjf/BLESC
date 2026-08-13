"""Benchmark cases, rebuilt for #86 and #87.

The old shape saturated by construction: 3 candidates, 2 correct, k=2, and
distractors sharing no vocabulary with the query. Random selection scored
recall@2 = 0.67 and Jaccard separated the rest perfectly, so `keyword` was not
a weak baseline — it was a sufficient one, and every condition was a near
monotone transform of the same lexical signal.

The arrangement is inverted here:

- **targets** are paraphrases with no content-word overlap with the query
- **distractors** are lexical decoys that deliberately reuse the query's words

So a lexical method is actively misled rather than merely uninformative, which
is what it takes to drive a keyword baseline to or below chance.

Two families:

- `vocab_disjoint` — the answer is in one day, but not findable by wording
- `two_hop_chain` (#87) — the answer exists in NO single day. The chain runs
  across weeks and only a method that traverses the motif graph can recover it.
  Chains are drawn from the curated sleep subgraph
  (`app/ontology/seed/sleep.yaml`), not invented here — a benchmark whose
  chains were written for it would be scoring its own answer key.

One case is a red herring: the path exists and the correct answer is elsewhere.
A benchmark where the graph method can only win is as uninformative as one
where everything wins.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Sequence

RETIRED_CASES = {
    # Kept as a record rather than deleted. All four were answerable from a
    # single day's wording and cannot be migrated to the new shape without
    # being rewritten into different cases — which is what the new families
    # are. Their case_ids are retained so a historical result set can still be
    # matched against something.
    "deadline_pressure_returns": "single-day, distractor shared no vocabulary with the query",
    "protective_decline": "single-day, distractor shared no vocabulary with the query",
    "crisis_escalation": "single-day; the safety-label bonus dominated the ranking",
    "study_overload_recovery": "single-day, distractor shared no vocabulary with the query",
}


@dataclass(frozen=True)
class EvidenceDay:
    evidence_id: str
    day: str
    text: str
    graph_motifs: Sequence[str]
    safety_label: str = "normal"


@dataclass(frozen=True)
class BenchmarkCase:
    case_id: str
    query: str
    #: Concepts the query is about. In the product these come from running the
    #: extraction over the query itself, so supplying them here is the input
    #: representation, not the answer — which days are relevant is still hidden.
    query_anchors: Sequence[str]
    evidence: Sequence[EvidenceDay]
    expected_evidence_ids: Sequence[str]
    expected_safety: str
    expected_policy: str
    research_note: str
    family: str
    lang: str = "en"
    #: Longest hop count needed to reach a target from an anchor. 0 means the
    #: answer is lexically present; 2 means no single day contains it.
    required_hops: int = 0
    labelled_by: str = "author"


def _is_japanese(word: str) -> bool:
    return any("\u3040" <= char <= "\u30ff" or "\u4e00" <= char <= "\u9fff" for char in word)


def _decoys(prefix: str, words: Sequence[str], start: int, count: int, day_from: int) -> list[EvidenceDay]:
    """Lexical decoys: days that reuse the query's vocabulary and are wrong.

    This is the load-bearing half of the design. Padding with unrelated days
    would leave a keyword baseline merely uninformed; reusing the query's words
    in the wrong days makes it actively misled, which is what drives it below
    chance.
    """
    out: list[EvidenceDay] = []
    for offset in range(count):
        word = words[offset % len(words)]
        second = words[(offset + 3) % len(words)]
        out.append(
            EvidenceDay(
                evidence_id=f"{prefix}{start + offset}",
                day=f"2026-06-{(day_from + offset) % 28 + 1:02d}",
                # Language-appropriate surface form. A Japanese case padded with
                # "Wrote about 感じ again today" is trivially separable by script
                # alone, which is a cue no real candidate set would offer.
                text=(
                    f"今日も{word}のことを書いた。{second}のことも少し。"
                    if _is_japanese(word)
                    else f"Wrote about {word} again today, and about {second} in passing."
                ),
                graph_motifs=(f"State:{word} -> co_occurs -> State:{second}",),
            )
        )
    return out


_SLEEP_CHAIN_EN = (
    # sleep_deprivation -> cognitive_impairment -> depressed_mood,
    # from app/ontology/seed/sleep.yaml.
    EvidenceDay(
        "c1", "2026-05-04",
        "Lay awake until it got light again before the exam.",
        ("Trigger:sleep deprivation -> causes -> State:cognitive impairment",),
    ),
    EvidenceDay(
        "c2", "2026-05-11",
        "Read the same paragraph four times and none of it stayed.",
        ("State:cognitive impairment -> causes -> State:depressed mood",),
    ),
    EvidenceDay(
        "c3", "2026-05-19",
        "Could not be bothered with any of it, even the parts I used to like.",
        ("State:depressed mood -> causes -> Behavior:social withdrawal",),
    ),
)

_SLEEP_CHAIN_JA = (
    EvidenceDay(
        "c1", "2026-05-04",
        "テスト前、気づいたら空が明るくなってた。",
        ("Trigger:sleep deprivation -> causes -> State:cognitive impairment",),
    ),
    EvidenceDay(
        "c2", "2026-05-11",
        "同じところを何回も読んでるのに、頭に入ってこない。",
        ("State:cognitive impairment -> causes -> State:depressed mood",),
    ),
    EvidenceDay(
        "c3", "2026-05-19",
        "好きだったことも、どうでもよくなってきた。",
        ("State:depressed mood -> causes -> Behavior:social withdrawal",),
    ),
)

DECOY_WORDS_EN = ("feeling", "again", "back", "same", "lately", "started", "coming", "sense")
DECOY_WORDS_JA = ("感じ", "また", "戻って", "最近", "ずっと", "きた", "そんな", "ちょっと")


BENCHMARK_CASES: Sequence[BenchmarkCase] = [
    # ---- two-hop chains (#87) ------------------------------------------
    BenchmarkCase(
        case_id="sleep_chain_en",
        query="That whole thing is creeping back in again.",
        query_anchors=("sleep deprivation",),
        evidence=(*_SLEEP_CHAIN_EN, *_decoys("d", DECOY_WORDS_EN, 1, 25, 1)),
        expected_evidence_ids=("c1", "c2", "c3"),
        expected_safety="normal",
        expected_policy="surface the multi-week pattern without asserting cause",
        research_note=(
            "The query shares no content word with any target. Answer exists in no "
            "single day; only traversal of the curated chain recovers it."
        ),
        family="two_hop_chain",
        lang="en",
        required_hops=2,
    ),
    BenchmarkCase(
        case_id="sleep_chain_ja",
        query="またあの感じが戻ってきた。",
        query_anchors=("sleep deprivation",),
        evidence=(*_SLEEP_CHAIN_JA, *_decoys("d", DECOY_WORDS_JA, 1, 25, 1)),
        expected_evidence_ids=("c1", "c2", "c3"),
        expected_safety="normal",
        expected_policy="surface the multi-week pattern without asserting cause",
        research_note="Matched pair with sleep_chain_en so language is not confounded with difficulty.",
        family="two_hop_chain",
        lang="ja",
        required_hops=2,
    ),
    # ---- red herring ----------------------------------------------------
    BenchmarkCase(
        case_id="chain_red_herring_en",
        query="Something shifted this week and I cannot place it.",
        query_anchors=("sleep deprivation",),
        evidence=(
            *_SLEEP_CHAIN_EN,
            EvidenceDay(
                "t1", "2026-05-26",
                "My closest friend moved away at the end of term.",
                ("Event:friend leaving -> causes -> State:loneliness",),
            ),
            EvidenceDay(
                "t2", "2026-05-27",
                "The house is quieter than it used to be on weekends.",
                ("State:loneliness -> co_occurs -> Behavior:staying in",),
            ),
            *_decoys("d", DECOY_WORDS_EN, 1, 22, 1),
        ),
        expected_evidence_ids=("t1", "t2"),
        expected_safety="normal",
        expected_policy="describe the recent change, not the older pattern",
        research_note=(
            "The sleep chain is present and traversable, and is the WRONG answer. "
            "A graph method that always follows the longest available path fails "
            "here. Without a case like this the hypothesis cannot fail."
        ),
        family="two_hop_chain",
        lang="en",
        required_hops=1,
    ),
    BenchmarkCase(
        case_id="chain_red_herring_ja",
        query="今週なにかが変わった気がするけど、うまく言えない。",
        query_anchors=("sleep deprivation",),
        evidence=(
            *_SLEEP_CHAIN_JA,
            EvidenceDay(
                "t1", "2026-05-26",
                "仲の良かった子が学期末で転校していった。",
                ("Event:friend leaving -> causes -> State:loneliness",),
            ),
            EvidenceDay(
                "t2", "2026-05-27",
                "週末の家がいつもより静かだ。",
                ("State:loneliness -> co_occurs -> Behavior:staying in",),
            ),
            *_decoys("d", DECOY_WORDS_JA, 1, 22, 1),
        ),
        expected_evidence_ids=("t1", "t2"),
        expected_safety="normal",
        expected_policy="describe the recent change, not the older pattern",
        research_note=(
            "Matched pair with chain_red_herring_en. Without it the red-herring "
            "case is English-only, so English carries a case built to be failed "
            "and the per-language split measures that instead of language."
        ),
        family="two_hop_chain",
        lang="ja",
        required_hops=1,
    ),
    # ---- vocabulary-disjoint single day ---------------------------------
    BenchmarkCase(
        case_id="vocab_disjoint_en",
        query="The pressure before a deadline is doing it again.",
        query_anchors=("exam pressure",),
        evidence=(
            EvidenceDay(
                "c1", "2026-06-02",
                "Froze at my desk once the science hand-in date moved closer.",
                ("Trigger:exam pressure -> escalates -> State:anxious",),
            ),
            EvidenceDay(
                "c2", "2026-06-09",
                "Chest went tight before the presentation even started.",
                ("Trigger:exam pressure -> escalates -> State:anxious",),
            ),
            *_decoys("d", ("pressure", "deadline", "again", "doing", "before"), 1, 26, 3),
        ),
        expected_evidence_ids=("c1", "c2"),
        expected_safety="elevated",
        expected_policy="surface recurring Trigger->State pattern without diagnosis",
        research_note="Targets paraphrase the query; 26 decoys reuse its exact words.",
        family="vocab_disjoint",
        lang="en",
        required_hops=1,
    ),
    BenchmarkCase(
        case_id="vocab_disjoint_ja",
        query="締め切り前のあの感じ、また来てる。",
        query_anchors=("exam pressure",),
        evidence=(
            EvidenceDay(
                "c1", "2026-06-02",
                "理科の提出日が近づいたら、机の前で固まってしまった。",
                ("Trigger:exam pressure -> escalates -> State:anxious",),
            ),
            EvidenceDay(
                "c2", "2026-06-09",
                "発表が始まる前から胸が苦しかった。",
                ("Trigger:exam pressure -> escalates -> State:anxious",),
            ),
            *_decoys("d", ("締め切り", "感じ", "また", "来てる", "前"), 1, 26, 3),
        ),
        expected_evidence_ids=("c1", "c2"),
        expected_safety="elevated",
        expected_policy="surface recurring Trigger->State pattern without diagnosis",
        research_note="Matched pair with vocab_disjoint_en.",
        family="vocab_disjoint",
        lang="ja",
        required_hops=1,
    ),
]

#: Composition, so a thin family is visible rather than implicit. #88 grows
#: these toward 60-100 with human-labelled expected_evidence_ids.
CASE_COMPOSITION = {
    "two_hop_chain": len([case for case in BENCHMARK_CASES if case.family == "two_hop_chain"]),
    "vocab_disjoint": len([case for case in BENCHMARK_CASES if case.family == "vocab_disjoint"]),
    "ja": len([case for case in BENCHMARK_CASES if case.lang == "ja"]),
    "en": len([case for case in BENCHMARK_CASES if case.lang == "en"]),
    "human_labelled": len([case for case in BENCHMARK_CASES if case.labelled_by == "human"]),
}
