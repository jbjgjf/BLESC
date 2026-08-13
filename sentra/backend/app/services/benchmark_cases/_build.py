"""Turning a drafted record into a matched ja/en pair of benchmark cases.

#88 needs ~80 cases. Writing 80 `BenchmarkCase` literals by hand would put the
ja/en balance, the candidate count and the motif notation in 80 places each, and
the first thing to drift would be the balance the matched-pair design exists to
hold. So a family module writes one `CaseDraft` per idea — the query and the
target sentences in both languages, which is the part that has to be written by
a person — and `expand_pair()` does the mechanical half.

Two things this file refuses to let a case author do.

**Invent a motif.** A draft names curated edges by their node ids and
`motif_for()` renders them, raising if the edge is not in
`app/ontology/seed/*.yaml`. The old file asked authors to copy the notation out
of `chain_motifs` and trusted them to; at 6 cases that was reasonable, at 80 it
is not. A case can now only assert a relation the curation already holds, and an
edit to the curation fails here rather than silently invalidating an answer key.
This is also the `#88` scope boundary in practice: evidence labels stay
method-independent, because the chain comes from the ontology rather than from
whatever the retriever happens to traverse.

**Let the two languages drift apart.** `expand_pair()` builds both languages
from one record, so a family cannot end up with 13 English cases and 12 Japanese
ones — which is the state `per_language_comparison_valid` went false for in #87.
The two cases share `pair_id`, and their targets share motif triples, so
`leakage_groups()` already keeps them in one split.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from functools import lru_cache
from typing import Dict, List, Sequence, Tuple

from ...ontology.seed_graph import load_seed_subgraphs
from ._splits import EDGE_POOLS, pool_for
from ._types import BenchmarkCase, EvidenceDay


class CaseDesignError(ValueError):
    """A draft asserts something the curated graph does not contain."""


@lru_cache(maxsize=1)
def _curated_edges() -> Dict[Tuple[str, str], str]:
    """Every (source, target) -> relation across the loaded subgraphs.

    Flattened across files on purpose. The three seed files overlap by design
    and state the shared edges identically (see the header of
    `social_withdrawal.yaml`), so a flat lookup loses nothing — but a
    disagreement between two files about the same pair would be a curation bug,
    and it raises here rather than resolving to whichever loaded last.
    """
    edges: Dict[Tuple[str, str], str] = {}
    for subgraph in load_seed_subgraphs().values():
        for edge in subgraph.edges:
            key = (edge.source, edge.target)
            if key in edges and edges[key] != edge.type:
                raise CaseDesignError(
                    f"seed files disagree about {edge.source} -> {edge.target}: "
                    f"{edges[key]!r} and {edge.type!r}"
                )
            edges[key] = edge.type
    return edges


@lru_cache(maxsize=1)
def _curated_terms() -> Dict[str, str]:
    """node_id -> the `Category:id with spaces` term cases write motifs in."""
    terms: Dict[str, str] = {}
    for subgraph in load_seed_subgraphs().values():
        for node_id in subgraph.nodes:
            terms[node_id] = subgraph.motif_term(node_id)
    return terms


def motif_for(source: str, target: str) -> str:
    """One curated edge, in benchmark motif notation.

    Raises rather than rendering a plausible-looking string for an edge that
    does not exist. A benchmark whose motifs were written to fit its cases would
    be scoring its own answer key, which is the failure mode this whole module
    is arranged against.
    """
    edges, terms = _curated_edges(), _curated_terms()
    if source not in terms:
        raise CaseDesignError(f"{source!r} is not a node in any seed subgraph")
    if target not in terms:
        raise CaseDesignError(f"{target!r} is not a node in any seed subgraph")
    if (source, target) not in edges:
        raise CaseDesignError(
            f"no curated edge {source} -> {target}. Add it to a seed file with a "
            "source_ref and a scope_note, or build the case on an edge that exists."
        )
    return f"{terms[source]} -> {edges[(source, target)]} -> {terms[target]}"


def anchor_term(node_id: str) -> str:
    """A query anchor, spelled the way traversal will look it up."""
    if node_id not in _curated_terms():
        raise CaseDesignError(f"{node_id!r} is not a node in any seed subgraph")
    return node_id.replace("_", " ")


# ---------------------------------------------------------------------------
# Drafts
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Step:
    """One day of evidence, as the two languages plus the edge it stands for.

    `edge` is a curated (source, target) pair. The day's text is a diary entry
    that *instantiates* that relation without naming either end of it — that is
    what makes the case vocabulary-disjoint from a query about the anchor.
    """

    edge: Tuple[str, str]
    text_en: str
    text_ja: str
    day: str
    safety_label: str = "normal"


@dataclass(frozen=True)
class CaseDraft:
    """One benchmark idea, in both languages, before it becomes two cases."""

    slug: str
    family: str
    query_en: str
    query_ja: str
    #: Curated node ids the query is about.
    anchors: Tuple[str, ...]
    #: The days that answer the query. Their ids are c1..cn.
    answer: Tuple[Step, ...]
    expected_safety: str
    expected_policy: str
    note: str
    required_hops: int
    #: Content words lifted from the query, for the decoys to reuse. The design
    #: needs decoys that are *actively misleading*, so these must be the query's
    #: own words and not a generic list.
    decoy_en: Tuple[str, ...]
    decoy_ja: Tuple[str, ...]
    #: Which of train/validation/test this draft belongs to. Authored, not
    #: derived: the split decides which curated edges the draft may use as
    #: targets (see `_splits.py`), so it is settled before the case is written
    #: rather than assigned to it afterwards. No default that means anything —
    #: an unset split raises rather than quietly landing in the training set.
    split: str = ""
    #: A second chain that is present, traversable and WRONG. Ids are f1..fn.
    #: Empty for most cases; a family with none cannot fail.
    foil: Tuple[Step, ...] = ()
    #: Total candidates for the case. The pre-registration fixes the band at
    #: 20-40 and `expand_pair` refuses to leave it.
    candidates: int = 28
    decoy_day_from: int = 1
    #: Every Nth decoy also carries `safety_label`, and 0 disables it.
    #:
    #: `benchmark_retrieval` adds +0.45 when a case expects crisis and a day is
    #: labelled crisis. On the retired `crisis_escalation` case that bonus was
    #: the whole ranking — the targets were the only labelled days, so the flag
    #: WAS the answer key and the case measured nothing. Any family whose
    #: `expected_safety` is crisis therefore has to put the same label on wrong
    #: days too, or it is re-running that mistake.
    decoy_safety_every: int = 0
    decoy_safety_label: str = "crisis"
    #: Decoy sentences for the labelled decoys. They have to carry genuine
    #: distress vocabulary or `assess_safety` will not agree with the label, and
    #: a label the product's own detector disagrees with is not a decoy — it is
    #: a bug in the fixture.
    decoy_safety_text_en: str = "Panicking about all of it again and I feel trapped."
    decoy_safety_text_ja: str = "またぜんぶが苦しくて、どうにもならない。"
    #: Every Nth decoy asserts a junk relation FROM the case's own anchor, and 0
    #: disables it.
    #:
    #: Without this a decoy is only a lexical trap: traversal from the anchor
    #: never reaches it, so the graph conditions get a clean candidate set no
    #: matter how many decoys are added and "heavy decoy" means nothing to them.
    #: With it, breadth-first search from the anchor reaches these days in one
    #: hop and has to rank against them — which is the pressure the family is
    #: named for, applied to the condition under test rather than only to the
    #: baseline.
    decoy_anchor_motif_every: int = 0

    def anchor_terms(self) -> Tuple[str, ...]:
        return tuple(anchor_term(node_id) for node_id in self.anchors)


MIN_CANDIDATES, MAX_CANDIDATES = 20, 40


def _decoy_days(
    words: Sequence[str],
    *,
    japanese: bool,
    count: int,
    day_from: int,
    start: int = 1,
    safety_every: int = 0,
    safety_label: str = "crisis",
    safety_text_en: str = "",
    safety_text_ja: str = "",
    anchor_motif_every: int = 0,
    anchor_motif_term: str = "",
) -> List[EvidenceDay]:
    """Days that reuse the query's vocabulary and are wrong.

    This is the load-bearing half of the design, carried over unchanged from the
    pre-#88 file. Padding with unrelated days would leave a keyword baseline
    merely uninformed; reusing the query's words in the wrong days makes it
    actively misled, which is what drives it to or below chance.

    The motifs are deliberately junk relations. They are not curated edges and
    must not accidentally form one — `test_decoys_assert_no_curated_relation`
    pins that.

    THE CONCEPT TERMS IN THOSE MOTIFS CARRY NO LANGUAGE, and that is load
    bearing. They used to be the decoy *word* itself (`State:feeling` in
    English, `State:感じ` in Japanese), which put a surface form where the
    product puts a canonical concept id. Nothing noticed while no decoy was
    reachable from an anchor. Once `decoy_anchor_motif_every` made a fifth of
    them reachable, traversal had to order them, the deterministic tie-break
    sorts on the concept term, and Japanese sorts after ASCII — so every matched
    pair diverged: `ja` scored 1.000 on cases where `en` scored 0.469, purely
    because of where the two scripts fall in a sort. That is the confound the
    matched-pair design exists to detect, arriving through the graph layer
    rather than through the text, and it was mine.

    Numbering them instead makes the decoy subgraph byte-identical across the
    two languages, which is what the product's graph actually is.
    """
    out: List[EvidenceDay] = []
    for offset in range(count):
        word = words[offset % len(words)]
        second = words[(offset + 3) % len(words)]
        labelled = bool(safety_every) and (offset + 1) % safety_every == 0
        base = (
            f"今日も{word}のことを書いた。{second}のことも少し。"
            if japanese
            else f"Wrote about {word} again today, and about {second} in passing."
        )
        distress = safety_text_ja if japanese else safety_text_en
        reachable = bool(anchor_motif_every) and (offset + 1) % anchor_motif_every == 0
        here, there = f"State:decoy {offset:02d}", f"State:decoy {(offset + 3) % count:02d}"
        motif = (
            f"{anchor_motif_term} -> co_occurs -> {here}"
            if reachable and anchor_motif_term
            else f"{here} -> co_occurs -> {there}"
        )
        out.append(
            EvidenceDay(
                evidence_id=f"d{start + offset}",
                day=f"2026-06-{(day_from + offset) % 28 + 1:02d}",
                # Language-appropriate surface form. A Japanese case padded with
                # "Wrote about 感じ again today" is trivially separable by script
                # alone, which is a cue no real candidate set would offer.
                text=f"{base}{distress}" if labelled else base,
                graph_motifs=(motif,),
                safety_label=safety_label if labelled else "normal",
            )
        )
    return out


def _evidence_days(steps: Sequence[Step], prefix: str, *, japanese: bool) -> List[EvidenceDay]:
    return [
        EvidenceDay(
            evidence_id=f"{prefix}{index}",
            day=step.day,
            text=step.text_ja if japanese else step.text_en,
            graph_motifs=(motif_for(*step.edge),),
            safety_label=step.safety_label,
        )
        for index, step in enumerate(steps, start=1)
    ]


def _check_split(draft: CaseDraft) -> None:
    """A draft may only take targets from its own split's edge pool.

    Enforced here rather than in a test so a violation cannot be committed and
    then explained. Foil edges are exempt: a foil is wrong material the case
    contains, not evidence it asserts, and `leakage_groups()` picks up foil
    *text* overlap separately — which is why a foil copied from another case
    still has to come from the same split, and `test_no_leakage_group_spans_a_split`
    is what catches it.
    """
    if draft.split not in EDGE_POOLS:
        raise CaseDesignError(f"{draft.slug}: unknown split {draft.split!r}")
    pool = EDGE_POOLS[draft.split]
    for step in draft.answer:
        if step.edge not in pool:
            actual = pool_for(step.edge)
            raise CaseDesignError(
                f"{draft.slug} is in {draft.split!r} but targets "
                f"{step.edge[0]} -> {step.edge[1]}, which belongs to "
                f"{actual!r} in _splits.py. Move the case or use an edge from its own pool."
            )


def expand_pair(draft: CaseDraft) -> List[BenchmarkCase]:
    """One draft -> the English case and the Japanese case, in that order."""
    _check_split(draft)
    cases: List[BenchmarkCase] = []
    for lang in ("en", "ja"):
        japanese = lang == "ja"
        answer = _evidence_days(draft.answer, "c", japanese=japanese)
        foil = _evidence_days(draft.foil, "f", japanese=japanese)

        decoy_count = draft.candidates - len(answer) - len(foil)
        if decoy_count < 1:
            raise CaseDesignError(
                f"{draft.slug}: {draft.candidates} candidates leaves no room for decoys "
                f"beside {len(answer)} target(s) and {len(foil)} foil(s)"
            )
        if not MIN_CANDIDATES <= draft.candidates <= MAX_CANDIDATES:
            raise CaseDesignError(
                f"{draft.slug}: {draft.candidates} candidates is outside the 20-40 band "
                "fixed in docs/benchmark_preregistration.md"
            )

        decoys = _decoy_days(
            draft.decoy_ja if japanese else draft.decoy_en,
            japanese=japanese,
            count=decoy_count,
            day_from=draft.decoy_day_from,
            safety_every=draft.decoy_safety_every,
            safety_label=draft.decoy_safety_label,
            safety_text_en=draft.decoy_safety_text_en,
            safety_text_ja=draft.decoy_safety_text_ja,
            anchor_motif_every=draft.decoy_anchor_motif_every,
            anchor_motif_term=_curated_terms()[draft.anchors[0]] if draft.anchors else "",
        )
        cases.append(
            BenchmarkCase(
                case_id=f"{draft.slug}_{lang}",
                query=draft.query_ja if japanese else draft.query_en,
                query_anchors=draft.anchor_terms(),
                evidence=(*answer, *foil, *decoys),
                expected_evidence_ids=tuple(day.evidence_id for day in answer),
                expected_safety=draft.expected_safety,
                expected_policy=draft.expected_policy,
                research_note=draft.note,
                family=draft.family,
                lang=lang,
                required_hops=draft.required_hops,
                # Drafted, not labelled. Flipped to "human" only by
                # `benchmark_labelling.apply_human_labels` reading a rater file.
                labelled_by="draft",
                pair_id=draft.slug,
                split=draft.split,
            )
        )
    return cases


def expand_all(drafts: Sequence[CaseDraft]) -> List[BenchmarkCase]:
    """Every draft, or every reason it could not be built.

    Errors are collected rather than raised on the first one. Forty drafts over
    three edge pools means a pool boundary moves several cases at once, and
    fixing them one traceback at a time hides how many there are — which is the
    number that tells you whether the partition or the drafts are wrong.
    """
    seen: set[str] = set()
    out: List[BenchmarkCase] = []
    problems: List[str] = []
    for draft in drafts:
        if draft.slug in seen:
            problems.append(f"duplicate draft slug {draft.slug!r}")
            continue
        seen.add(draft.slug)
        try:
            out.extend(expand_pair(draft))
        except CaseDesignError as error:
            problems.append(str(error))
    if problems:
        joined = "\n  - ".join(problems)
        raise CaseDesignError(f"{len(problems)} draft(s) could not be built:\n  - {joined}")
    return out
