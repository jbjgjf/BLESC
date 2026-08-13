"""Retrieval conditions and chance level for the research benchmark.

Split out of hf_research_benchmark.py during the #86 rebuild, because the
scoring is now the part of the benchmark most worth reading on its own.

Three things changed in the rebuild, and all three change the numbers:

1. `hf_reranker_candidate` no longer adds a bonus for being in
   `expected_evidence_ids`. It was reading the answer key. Whatever that
   condition scored before was not retrieval performance.
2. `graph_pattern` does real traversal over parsed motif triples rather than
   token Jaccard on the motif string. Jaccard over "Trigger:deadline ->
   escalates -> State:anxious" is a lexical method wearing a graph's clothes,
   and could not test the hypothesis it exists to test.
3. Chance level is computed per case, so "better than nothing" is visible
   instead of assumed.

#96 adds a fourth change. `relation_aware` walks the motif triples **directed
and typed**, applying the fixed per-relation parameters in
`app/traversal/relations.py` — the same table the production traversal uses, so
the benchmark measures the rule the product runs rather than a re-implementation
of it. It is reported under the `fixed_rule_traversal` family, separately from
anything learned, which is what #96 requires and what `METHOD_FAMILIES` exists
to make structural rather than a matter of how the reader groups the columns.

`graph_pattern` stays undirected and untyped. It is the baseline `relation_aware`
has to beat, and a baseline that gets upgraded alongside the thing it measures
is not a baseline.
"""

from __future__ import annotations

import math
import random
import re
from collections import deque
from dataclasses import dataclass
from typing import Dict, Iterable, List, Optional, Sequence, Set, Tuple

from ..traversal.relations import TraversalDirection, is_known, rule_for

METHODS = (
    "keyword",
    "semantic_proxy",
    "graph_pattern",
    "relation_aware",
    "hf_reranker_candidate",
)

#: Which family each condition belongs to. #96: 'Benchmark output reports
#: fixed-rule traversal separately from learned methods.' Encoded here so the
#: separation survives someone reading the summary table quickly, and so a new
#: condition has to declare which kind it is.
METHOD_FAMILIES: Dict[str, str] = {
    "keyword": "lexical",
    "semantic_proxy": "lexical",
    "graph_pattern": "untyped_traversal",
    "relation_aware": "fixed_rule_traversal",
    # Named `candidate` because it is a deterministic stand-in, not a trained
    # model. It sits here so that when a real cross-encoder replaces it, the
    # family it reports under does not have to be renegotiated.
    "hf_reranker_candidate": "learned_candidate",
}

#: Fixed so a run is reproducible. Chance is estimated by sampling rather than
#: derived in closed form: nDCG@k under a random permutation has an awkward
#: expectation, and an empirical estimate is easier to check than an algebraic
#: one nobody re-derives.
CHANCE_TRIALS = 2000
CHANCE_SEED = 20260813

_TOKEN = re.compile(r"[a-z0-9]+")
#: "Trigger:exam pressure -> causes -> State:insomnia"
_TRIPLE = re.compile(r"^\s*([^:]+):([^-]+?)\s*->\s*([a-z_]+)\s*->\s*([^:]+):(.+?)\s*$")


#: English closed-class words, removed for RETRIEVAL only.
#:
#: This does not belong in app.analytics.tokenize, and the reason is the point:
#: cognitive_probe's primary signal IS first-person pronoun density (Rude et al.
#: 2004). Stripping "i", "me", "my" there would delete the measurement. Retrieval
#: wants the opposite — a day matching a query on "it" and "and" is noise.
#:
#: Without this, the two languages were filtered asymmetrically: UniDic drops
#: Japanese particles by part of speech and nothing dropped the English
#: equivalents, so `keyword` matched on "it"/"and"/"this" in every English case
#: while the Japanese cases had their function words removed. Any ja/en
#: comparison would have been measuring that asymmetry.
#:
#: Closed-class only — determiners, pronouns, prepositions, conjunctions,
#: copulas, auxiliaries. No content words, no frequency cutoff: a frequency list
#: would be fitted to these cases.
_ENGLISH_FUNCTION_WORDS = frozenset(
    """
    a an the this that these those there here
    i me my mine myself you your yours we us our ours they them their theirs
    he him his she her hers it its
    is am are was were be been being do does did done have has had having
    can could will would shall should may might must
    of in on at to from by for with without into onto over under about
    and or but so if then than as because while when where which who whom whose
    what how why not no nor too very just also again still yet
    """.split()
)


def tokens(text: str) -> Set[str]:
    """Content tokens, via the shared analytics tokeniser.

    This used to be `re.findall(r"[a-z0-9ぁ-んァ-ン一-龥]+")`, which is the exact
    defect D-01 fixed in cognitive_probe: Japanese has no spaces, so a whole
    Japanese query came back as ONE token, overlapped with nothing, and every
    candidate scored 0.0. The ranking then fell through to the id tiebreak,
    which put the targets first because they are named c1..c3 — so `keyword`
    scored a perfect 1.0 on both Japanese cases while measuring nothing at all.

    A lexical baseline that cannot read the language is not a baseline. The
    same bug, in the same repository, in the component whose job is to be the
    honest floor.
    """
    from app.analytics.tokenize import tokens as analyse

    return {
        token
        for token in analyse(text)
        if len(token) > 1 and token not in _ENGLISH_FUNCTION_WORDS
    }


CHAR_NGRAM_N = 3


def char_ngrams(text: str, n: int = CHAR_NGRAM_N) -> Set[str]:
    """Character n-grams, script-agnostic.

    The cheap stand-in for embedding similarity when no model is available: it
    catches morphological variants and partial matches that exact token
    matching misses ("転校し" / "転校して"), and it works the same way in
    Japanese and English without a tokeniser or a dictionary.

    It is NOT semantic. It cannot match a paraphrase that shares no characters,
    which is precisely what the target days are built to be. That limit is the
    reason this condition exists: it marks how far a lexical method can be
    pushed before traversal is the only thing left.
    """
    cleaned = "".join(text.lower().split())
    if len(cleaned) < n:
        return {cleaned} if cleaned else set()
    return {cleaned[index : index + n] for index in range(len(cleaned) - n + 1)}


def jaccard(left: Iterable[str], right: Iterable[str]) -> float:
    left_set, right_set = set(left), set(right)
    if not left_set or not right_set:
        return 0.0
    return len(left_set & right_set) / len(left_set | right_set)


@dataclass(frozen=True)
class Triple:
    subject: str
    relation: str
    object: str
    #: The `Category:` half of each endpoint, which the retrieval conditions do
    #: not use and #79's provenance coverage does — a node has to carry its
    #: category to be a node the ontology recognises. Defaulted so the reversed
    #: construction in `build_relation_graph` and any other positional caller
    #: keep working, and kept on the triple rather than re-parsed downstream so
    #: the motif notation stays defined in exactly one place.
    subject_category: str = ""
    object_category: str = ""


def parse_motifs(motifs: Sequence[str]) -> List[Triple]:
    """Parse "Category:label -> relation -> Category:label" into triples.

    A motif that does not parse is dropped rather than silently treated as
    text — a malformed motif contributing lexical overlap is how the previous
    implementation let a graph condition score on wording.
    """
    parsed: List[Triple] = []
    for motif in motifs:
        match = _TRIPLE.match(motif)
        if not match:
            continue
        subject_category, subject, relation, object_category, object_ = match.groups()
        parsed.append(
            Triple(
                subject.strip().lower(),
                relation.strip(),
                object_.strip().lower(),
                subject_category.strip(),
                object_category.strip(),
            )
        )
    return parsed


def _adjacency(cases_motifs: Sequence[Sequence[str]]) -> Dict[str, Set[str]]:
    """Undirected concept graph over every motif in the case.

    Undirected on purpose: retrieval asks "is this day connected to what the
    student is describing", not "does it cause it". Direction matters for the
    ontology's claims and not for this hop count.
    """
    graph: Dict[str, Set[str]] = {}
    for motifs in cases_motifs:
        for triple in parse_motifs(motifs):
            graph.setdefault(triple.subject, set()).add(triple.object)
            graph.setdefault(triple.object, set()).add(triple.subject)
    return graph


def hop_distances(graph: Dict[str, Set[str]], anchors: Sequence[str], max_depth: int) -> Dict[str, int]:
    """Breadth-first hop count from the query's anchor concepts."""
    distance: Dict[str, int] = {}
    queue: deque[Tuple[str, int]] = deque()
    for anchor in anchors:
        key = anchor.strip().lower()
        if key in graph:
            distance[key] = 0
            queue.append((key, 0))
    while queue:
        node, depth = queue.popleft()
        if depth >= max_depth:
            continue
        for neighbour in graph.get(node, ()):
            if neighbour not in distance:
                distance[neighbour] = depth + 1
                queue.append((neighbour, depth + 1))
    return distance


def build_relation_graph(motif_lists: Sequence[Sequence[str]]) -> Dict[str, List[Triple]]:
    """Directed, typed adjacency: `subject -> [triples leaving it]`.

    The counterpart to `_adjacency`, and the difference is the whole point of the
    condition it feeds. `_adjacency` records that two concepts are connected;
    this records which way and by what, so `causes` and `buffers` stop being the
    same edge.

    A triple whose relation is outside the ontology vocabulary is dropped rather
    than given a default parameter — the same refusal `app/traversal/walk.py`
    makes, for the same reason.
    """
    graph: Dict[str, List[Triple]] = {}
    for motifs in motif_lists:
        for triple in parse_motifs(motifs):
            if not is_known(triple.relation):
                continue
            graph.setdefault(triple.subject, []).append(triple)
            if rule_for(triple.relation).direction is TraversalDirection.SYMMETRIC:
                graph.setdefault(triple.object, []).append(
                    Triple(
                        triple.object,
                        triple.relation,
                        triple.subject,
                        triple.object_category,
                        triple.subject_category,
                    )
                )
    for concept in graph:
        graph[concept].sort(key=lambda t: (t.relation, t.object))
    return graph


@dataclass(frozen=True)
class Reach:
    """How well a concept is reached from the anchors, and by what."""

    damping: float
    hops: int
    relations: Tuple[str, ...]


def relation_aware_reach(
    graph: Dict[str, List[Triple]],
    anchors: Sequence[str],
    max_depth: int,
) -> Dict[str, Reach]:
    """Best directed path from any anchor to each reachable concept.

    "Best" is the highest compounded damping, not the fewest hops: a two-hop
    `causes` chain (0.81) is stronger evidence than a one-hop `co_occurs` (0.50),
    and a hop count cannot express that. Ties break on fewer hops so the
    shortest of two equally-damped routes is the one reported.

    Directed and downstream-only. Walking the anchors backwards as well would
    reach everything the undirected baseline reaches, which would make this
    condition a slower `graph_pattern`.
    """
    reach: Dict[str, Reach] = {}
    frontier: List[Tuple[str, Reach]] = []
    for anchor in anchors:
        key = anchor.strip().lower()
        if key in graph or any(t.object == key for triples in graph.values() for t in triples):
            reach[key] = Reach(damping=1.0, hops=0, relations=())
            frontier.append((key, reach[key]))

    for _depth in range(max_depth):
        next_frontier: List[Tuple[str, Reach]] = []
        for concept, current in sorted(frontier, key=lambda item: item[0]):
            for triple in graph.get(concept, []):
                candidate = Reach(
                    damping=current.damping * rule_for(triple.relation).step_damping,
                    hops=current.hops + 1,
                    relations=current.relations + (triple.relation,),
                )
                existing = reach.get(triple.object)
                if existing is not None and (existing.damping, -existing.hops) >= (
                    candidate.damping,
                    -candidate.hops,
                ):
                    continue
                reach[triple.object] = candidate
                next_frontier.append((triple.object, candidate))
        frontier = next_frontier
        if not frontier:
            break
    return reach


def relation_aware_score(
    motifs: Sequence[str], reach: Dict[str, Reach]
) -> Tuple[float, Optional[int], Optional[str]]:
    """This day's best damped reachability, its hop count, and its weakest relation.

    The weakest relation travels with the score for the same reason it does on an
    `EvidencePath`: a reader is entitled to know which link the number depends on
    without reconstructing the walk.
    """
    best: Optional[Reach] = None
    for triple in parse_motifs(motifs):
        for concept in (triple.subject, triple.object):
            found = reach.get(concept)
            if found is None or found.hops == 0:
                continue
            if best is None or (found.damping, -found.hops) > (best.damping, -best.hops):
                best = found
    if best is None:
        return 0.0, None, None
    weakest = min(best.relations, key=lambda name: rule_for(name).step_damping)
    return round(best.damping, 4), best.hops, weakest


def traversal_score(motifs: Sequence[str], distance: Dict[str, int]) -> Tuple[float, int | None]:
    """How close this day's concepts sit to the query's anchors.

    Returns the score and the hop count that produced it, so 1-hop and 2-hop
    contributions can be reported separately rather than collapsed — the depth
    at which any advantage appears is the interesting quantity.
    """
    best: int | None = None
    for triple in parse_motifs(motifs):
        for concept in (triple.subject, triple.object):
            hops = distance.get(concept)
            if hops is not None and (best is None or hops < best):
                best = hops
    if best is None:
        return 0.0, None
    return 1.0 / (1.0 + best), best


def score_candidate(
    method: str,
    query_tokens: Set[str],
    query_ngrams: Set[str],
    text: str,
    motifs: Sequence[str],
    distance: Dict[str, int],
    safety_label: str,
    expects_crisis: bool,
    reach: Optional[Dict[str, Reach]] = None,
) -> Dict[str, float | int | None | str]:
    text_score = jaccard(query_tokens, tokens(text))
    motif_lexical = jaccard(query_tokens, tokens(" ".join(motifs)))
    fuzzy_score = jaccard(query_ngrams, char_ngrams(text))
    graph_score, hops = traversal_score(motifs, distance)
    relation_score, relation_hops, weakest_relation = relation_aware_score(motifs, reach or {})
    safety_bonus = 0.45 if expects_crisis and safety_label == "crisis" else 0.0

    if method == "keyword":
        score = text_score
    elif method == "semantic_proxy":
        # AMENDED 2026-08-13 (see docs/benchmark_preregistration.md).
        # Was 0.75*text + 0.25*motif_lexical. Because every query in this set is
        # built to share no vocabulary with anything, motif_lexical was 0 on all
        # 6 cases, so the condition reduced to 0.75*text_score — a monotone
        # transform of `keyword` producing an IDENTICAL ranking every time. That
        # is the exact defect the #86 rebuild existed to remove, surviving in
        # one condition.
        #
        # Now character-trigram overlap: a genuinely different lexical signal
        # that tolerates morphological variation, plus a smaller motif term. It
        # still does not traverse.
        score = (0.60 * fuzzy_score) + (0.25 * text_score) + (0.15 * motif_lexical)
    elif method == "graph_pattern":
        score = (0.20 * text_score) + (0.80 * graph_score) + safety_bonus
    elif method == "relation_aware":
        # Same 0.20/0.80 split as graph_pattern, deliberately. The two conditions
        # differ in ONE thing — whether traversal is directed and typed — and a
        # different mixing weight would confound the comparison with a tuning
        # choice. No safety bonus: #85 removed a metric that could not vary, and
        # a crisis bonus here would reintroduce a term that has nothing to do
        # with whether relation-aware traversal retrieves better.
        score = (0.20 * text_score) + (0.80 * relation_score)
    elif method == "hf_reranker_candidate":
        # Deterministic stand-in for the planned cross-encoder. It combines the
        # two signals more aggressively than graph_pattern and NOTHING ELSE —
        # the previous version added a bonus for appearing in
        # expected_evidence_ids, which is the answer key.
        score = (0.35 * text_score) + (0.65 * graph_score) + safety_bonus
    else:
        raise ValueError(f"Unknown benchmark method: {method}")

    return {
        "score": round(score, 4),
        "text_score": round(text_score, 4),
        "fuzzy_score": round(fuzzy_score, 4),
        "motif_lexical_score": round(motif_lexical, 4),
        "graph_score": round(graph_score, 4),
        "hops_from_anchor": hops,
        "relation_aware_score": relation_score,
        "relation_aware_hops": relation_hops,
        # The link the relation-aware number most depends on. Reported per
        # candidate so a condition that wins on chains of `co_occurs` is visibly
        # winning on the vocabulary's weakest claim.
        "relation_aware_weakest_relation": weakest_relation,
        "method_family": METHOD_FAMILIES[method],
    }


def ndcg_at_k(ranked_ids: Sequence[str], expected: Set[str], k: int) -> float:
    top_k = list(ranked_ids[:k])
    dcg = sum(1.0 / math.log2(index + 1) for index, eid in enumerate(top_k, start=1) if eid in expected)
    ideal = sum(1.0 / math.log2(index + 1) for index in range(1, min(len(expected), k) + 1))
    return round(dcg / ideal, 4) if ideal else 1.0


def chance_level(candidate_ids: Sequence[str], expected: Set[str], k: int) -> Dict[str, float]:
    """Expected performance from ranking at random.

    Reported next to every condition so "better than nothing" is visible. A
    condition at chance is not a weak result — it is no result, and the old
    harness could not tell the two apart.
    """
    rng = random.Random(CHANCE_SEED)
    pool = list(candidate_ids)
    ndcg_total = 0.0
    recall_total = 0.0
    for _ in range(CHANCE_TRIALS):
        rng.shuffle(pool)
        ndcg_total += ndcg_at_k(pool, expected, k)
        recall_total += len([eid for eid in pool[:k] if eid in expected]) / len(expected) if expected else 1.0
    return {
        "ndcg_at_k": round(ndcg_total / CHANCE_TRIALS, 4),
        "recall_at_k": round(recall_total / CHANCE_TRIALS, 4),
        "trials": CHANCE_TRIALS,
    }


def build_concept_graph(motif_lists: Sequence[Sequence[str]]) -> Dict[str, Set[str]]:
    return _adjacency(motif_lists)
