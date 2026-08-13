"""Mapping entry points into the temporal graph's node identity (#96).

**There are two node identities in this repository and they are not the same.**

`analytics/graph_index.node_key` is `normalize(category):normalize(label)`, where
`_normalize` lowercases and strips anything outside a fixed character class. It
is the key of the `graph_nodes` table, and that table is where the embeddings
live — so it is the only thing that can answer "which node is this query about".

`temporal/assemble.normalise_label` is NFKC + strip + lowercase, and feeds an
identity ladder (exact id → declared alias → normalised label) that records which
rung it used and refuses to merge ambiguous matches. It is the identity of the
graph that has direction, relation types and provenance — so it is the only thing
#96 can traverse.

Traversal therefore needs a bridge, and the bridge can fail. It fails silently if
written as a dict lookup with a `.get`, and a silently dropped seed makes a
traversal look like it found nothing when it was never asked the question. Every
resolution here is recorded with the rule that produced it, and every failure is
recorded with why.

**Ambiguity is not resolved.** When two temporal nodes normalise to the same
label — which happens exactly when the assembler declined to merge an ambiguous
pair — this module declines too, and says so. Picking one would undo the decision
#95 made deliberately.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

from ..temporal.assemble import normalise_label
from ..temporal.model import ParticipantTemporalGraph

SEED_RESOLUTION_VERSION = "seed-resolution-v1"


class SeedRule(str, Enum):
    """How a candidate was matched, strongest first.

    Deliberately parallel to `temporal.model.IdentityRule`: a seed reaches a node
    under the same ladder that decided the node was one node, and the rung is
    recorded either way so a caller that only trusts exact matches can filter.
    """

    EXACT_ID = "exact_node_id"
    CANONICAL_LABEL = "canonical_label"
    LABEL_SEEN = "label_seen"
    #: More than one node normalises to this label. Not resolved — see the
    #: module docstring.
    AMBIGUOUS = "ambiguous"
    UNMATCHED = "unmatched"


@dataclass(frozen=True)
class SeedCandidate:
    """Something we would like to start a walk from.

    `source_id` is whatever the caller knows it by — a `graph_nodes.id`, a query
    term, a benchmark case's anchor. Kept so a report can name the thing that
    failed to map in the caller's own vocabulary.
    """

    source_id: str
    label: str
    category: str = ""


@dataclass(frozen=True)
class SeedMapping:
    candidate: SeedCandidate
    temporal_node_id: Optional[str]
    rule: SeedRule
    #: Populated only for `AMBIGUOUS`: the nodes we declined to choose between.
    collided_with: Tuple[str, ...] = ()

    @property
    def is_resolved(self) -> bool:
        return self.temporal_node_id is not None

    def as_dict(self) -> Dict[str, Any]:
        return {
            "source_id": self.candidate.source_id,
            "label": self.candidate.label,
            "category": self.candidate.category,
            "temporal_node_id": self.temporal_node_id,
            "rule": self.rule.value,
            "collided_with": list(self.collided_with),
        }


@dataclass(frozen=True)
class SeedResolution:
    mappings: Tuple[SeedMapping, ...]
    version: str = SEED_RESOLUTION_VERSION

    @property
    def resolved_node_ids(self) -> Tuple[str, ...]:
        """Deduplicated, sorted — two query terms may name one node."""
        return tuple(sorted({m.temporal_node_id for m in self.mappings if m.temporal_node_id}))

    @property
    def unresolved(self) -> Tuple[SeedMapping, ...]:
        return tuple(m for m in self.mappings if not m.is_resolved)

    @property
    def ambiguous(self) -> Tuple[SeedMapping, ...]:
        """Candidates that matched more than one node and were left unresolved.

        Separated from `unresolved` because the two mean different things: an
        unmatched candidate is absent from this participant's graph, an ambiguous
        one is present more than once and #95 declined to merge the copies.
        """
        return tuple(m for m in self.mappings if m.rule is SeedRule.AMBIGUOUS)

    @property
    def coverage(self) -> float:
        """Fraction of candidates that reached the temporal graph.

        Worth reporting next to a traversal result: a walk seeded from 2 of 8
        candidates is answering a narrower question than the caller asked, and
        the score of what it found says nothing about that.
        """
        if not self.mappings:
            return 0.0
        return round(len(self.resolved_node_ids) / len(self.mappings), 6)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "version": self.version,
            "candidate_count": len(self.mappings),
            "resolved_node_ids": list(self.resolved_node_ids),
            "coverage": self.coverage,
            "unresolved_count": len(self.unresolved),
            "ambiguous_count": len(self.ambiguous),
            "mappings": [mapping.as_dict() for mapping in self.mappings],
        }


def _label_index(graph: ParticipantTemporalGraph) -> Tuple[Dict[str, List[str]], Dict[str, List[str]]]:
    """`normalised label -> node ids`, for canonical labels and for every surface form.

    Two indexes rather than one because a canonical-label match is a stronger
    claim than a match against a form the node was written as once, and the rule
    that fired is recorded.
    """
    canonical: Dict[str, List[str]] = {}
    seen: Dict[str, List[str]] = {}
    for node_id in sorted(graph.nodes):
        node = graph.nodes[node_id]
        canonical.setdefault(normalise_label(node.canonical_label), []).append(node_id)
        for label in node.labels_seen:
            bucket = seen.setdefault(normalise_label(label), [])
            if node_id not in bucket:
                bucket.append(node_id)
    return canonical, seen


def resolve_seeds(
    graph: ParticipantTemporalGraph,
    candidates: Sequence[SeedCandidate],
) -> SeedResolution:
    """Map candidates onto temporal node ids. Never guesses, never drops.

    The ladder mirrors `_IdentityResolver`'s in #95 — exact id, then canonical
    label, then any label the node was written as — so a seed reaches a node
    under the same rules that decided the node was one node.
    """
    canonical, seen = _label_index(graph)
    mappings: List[SeedMapping] = []

    for candidate in candidates:
        if candidate.source_id in graph.nodes:
            mappings.append(
                SeedMapping(candidate=candidate, temporal_node_id=candidate.source_id, rule=SeedRule.EXACT_ID)
            )
            continue

        key = normalise_label(candidate.label)
        for index, rule in ((canonical, SeedRule.CANONICAL_LABEL), (seen, SeedRule.LABEL_SEEN)):
            matches = index.get(key, [])
            if len(matches) == 1:
                mappings.append(
                    SeedMapping(candidate=candidate, temporal_node_id=matches[0], rule=rule)
                )
                break
            if len(matches) > 1:
                mappings.append(
                    SeedMapping(
                        candidate=candidate,
                        temporal_node_id=None,
                        rule=SeedRule.AMBIGUOUS,
                        collided_with=tuple(matches),
                    )
                )
                break
        else:
            mappings.append(
                SeedMapping(candidate=candidate, temporal_node_id=None, rule=SeedRule.UNMATCHED)
            )

    return SeedResolution(mappings=tuple(mappings))


def candidates_from_graph_nodes(rows: Iterable[Any]) -> Tuple[SeedCandidate, ...]:
    """Adapt `graph_nodes` rows (or plain mappings) into candidates.

    The only place the SQL index's shape is known to this package. Accepts
    mappings as well as ORM rows so a test does not need a database to exercise
    the bridge that a test most needs to exercise.
    """
    candidates: List[SeedCandidate] = []
    for row in rows:
        getter = row.get if isinstance(row, Mapping) else lambda name, _row=row: getattr(_row, name, None)
        candidates.append(
            SeedCandidate(
                source_id=str(getter("id") or getter("node_key") or ""),
                label=str(getter("label") or ""),
                category=str(getter("category") or ""),
            )
        )
    return tuple(candidates)
