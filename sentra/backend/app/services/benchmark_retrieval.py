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
"""

from __future__ import annotations

import math
import random
import re
from collections import deque
from dataclasses import dataclass
from typing import Dict, Iterable, List, Sequence, Set, Tuple

METHODS = ("keyword", "semantic_proxy", "graph_pattern", "hf_reranker_candidate")

#: Fixed so a run is reproducible. Chance is estimated by sampling rather than
#: derived in closed form: nDCG@k under a random permutation has an awkward
#: expectation, and an empirical estimate is easier to check than an algebraic
#: one nobody re-derives.
CHANCE_TRIALS = 2000
CHANCE_SEED = 20260813

_TOKEN = re.compile(r"[a-z0-9]+")
#: "Trigger:exam pressure -> causes -> State:insomnia"
_TRIPLE = re.compile(r"^\s*([^:]+):([^-]+?)\s*->\s*([a-z_]+)\s*->\s*([^:]+):(.+?)\s*$")


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

    return {token for token in analyse(text) if len(token) > 1}


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
        _, subject, relation, _, object_ = match.groups()
        parsed.append(Triple(subject.strip().lower(), relation.strip(), object_.strip().lower()))
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
    text: str,
    motifs: Sequence[str],
    distance: Dict[str, int],
    safety_label: str,
    expects_crisis: bool,
) -> Dict[str, float | int | None]:
    text_score = jaccard(query_tokens, tokens(text))
    motif_lexical = jaccard(query_tokens, tokens(" ".join(motifs)))
    graph_score, hops = traversal_score(motifs, distance)
    safety_bonus = 0.45 if expects_crisis and safety_label == "crisis" else 0.0

    if method == "keyword":
        score = text_score
    elif method == "semantic_proxy":
        # Still lexical. Included as the honest middle: it sees the motif
        # strings but does not traverse them.
        score = (0.75 * text_score) + (0.25 * motif_lexical)
    elif method == "graph_pattern":
        score = (0.20 * text_score) + (0.80 * graph_score) + safety_bonus
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
        "motif_lexical_score": round(motif_lexical, 4),
        "graph_score": round(graph_score, 4),
        "hops_from_anchor": hops,
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
