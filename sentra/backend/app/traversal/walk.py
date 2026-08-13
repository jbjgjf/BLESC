"""Directed, relation-aware traversal with an attributable evidence trace (#96).

**Stage 0: no training, no learning, no attention.** Every parameter is a fixed
constant from `relations.py` or this module's header. A result produced here is
the output of a rule, and the rule travels with the result so a reader can check
it. Nothing here may be described as learned attention — that is #100, and it has
an entry gate this layer does not.

**What this replaces, and what it does not.**

`analytics/graph_index.traverse_graph` builds its adjacency in both directions
for every edge and returns `{node_id: hop_distance}`. It is honest about being a
hop-distance helper; it is simply not a relation-aware traversal, and its return
type cannot carry a path. It is left exactly as it is, because #96 requires the
undirected walk as a named comparison baseline — replacing it would delete the
baseline.

This module is therefore additive. It walks `ParticipantTemporalGraph` (#95) —
the only representation with direction, relation type, observation intervals and
provenance on the same object — and returns paths.

**One question per walk.** `TraversalMode` fixes whether the walk follows
influence forward from the seed or backward into it, and a single walk never
mixes the two. Mixing is the failure this design exists to prevent: with A→B and
C→B, a walk that reverses mid-path reports A and C as connected and a reader sees
"A leads to C". They are not connected; they share a consequence.

**Weakest link, except damping.** Every scalar component of a path's score is the
minimum over its steps — confidence, recency, recurrence. A chain is exactly as
good as its worst edge, and averaging would let a strong recent edge carry a
stale one. The single exception is `relation_path`, which is the product of the
per-step dampings, because relation weakness compounds along a chain rather than
being bounded by its worst member. `curated_support` is a mean, because it is a
coverage measure and is labelled as one.

**Absence is never a number.** A component that cannot be computed — an edge with
no recorded confidence, say — is dropped and the remaining weights are
renormalised, with the dropped component named in the breakdown. Substituting
0.0 would report missing evidence as bad evidence, and substituting 1.0 would
report it as perfect.

**Reportability is checked, not assumed.** `filter_reportable` implements the
issue's invariant: a result without attributable observations and a score
breakdown does not reach an educator-facing consumer. Withheld paths are returned
with their reasons rather than dropped, because a consumer that cannot see what
was withheld will report what it received as complete.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from enum import Enum
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from ..analytics.graph_index import recency_score, recurrence_score
from ..temporal.model import ParticipantTemporalGraph, TemporalEdge
from .relations import (
    RELATION_RULES_VERSION,
    RelationRule,
    TraversalDirection,
    UnknownRelationType,
    rule_for,
    rules_as_dict,
)

GRAPH_TRAVERSAL_VERSION = "relation-aware-traversal-v1"

#: Three, because the discriminating benchmark family (#87) is two-hop chains and
#: a limit equal to the answer length cannot show the walk declining to go
#: further. Engineering choice.
DEFAULT_MAX_HOPS = 3
DEFAULT_MAX_PATHS = 50
DEFAULT_MAX_PATHS_PER_TARGET = 3

#: Fixed, documented, and echoed into every breakdown. Deliberately not
#: environment-configurable: see the note on `step_damping` in `relations.py`.
SCORE_WEIGHTS: Dict[str, float] = {
    "relation_path": 0.40,
    "edge_confidence": 0.25,
    "recency": 0.15,
    "recurrence": 0.10,
    "curated_support": 0.10,
}


class TraversalMode(str, Enum):
    """Which question the walk is answering.

    `DOWNSTREAM` — what does the seed lead to. Directed relations are walked
    source→target.

    `UPSTREAM` — what leads to the seed. Directed relations are walked
    target→source. This is not a reversal of the relation's meaning: the walk
    still follows the asserted direction of influence, it simply starts at the
    consequence. `PathStep.walked_against_arrow` records it either way.

    Symmetric relations (`co_occurs` alone) are walked in both modes in whichever
    orientation reaches a new node.
    """

    DOWNSTREAM = "downstream"
    UPSTREAM = "upstream"


@dataclass(frozen=True)
class PathStep:
    """One edge traversal, with everything needed to attribute it.

    Carries the evidence rather than a pointer to it: a step that stored only an
    edge key would send every consumer back to the graph to answer "why", and the
    UI ones will not.
    """

    from_node_id: str
    to_node_id: str
    relation_type: str
    #: The edge's own orientation, which is not the walk's. `("A","B","causes")`
    #: reached from B in UPSTREAM mode has `from_node_id="B"` and this is
    #: `("A","B","causes")` — the assertion is unchanged by the direction of
    #: reading.
    edge_key: Tuple[str, str, str]
    walked_against_arrow: bool
    step_damping: float
    influence: Optional[str]
    evidence_strength: Optional[str]
    #: From the relation vocabulary — why this relation type is worth what it is.
    relation_source_refs: Tuple[str, ...]
    #: From the curated subgraphs — whether THIS pair is backed by seed material.
    curated_source_refs: Tuple[str, ...]
    curated_subgraph_id: Optional[str]
    #: What the curated material types this pair as, when it types it at all, and
    #: whether that agrees with what the extractor produced. Recorded and never
    #: applied: the walk crosses the edge the participant's data produced. A
    #: disagreement is a finding for a curator, not an error for the traversal to
    #: silently correct — see #101, where revising the curated layer gets its own
    #: review path.
    curated_relation_type: Optional[str]
    curated_agrees_with_extraction: Optional[bool]
    source_snapshot_ids: Tuple[str, ...]
    observed_days: Tuple[date, ...]
    last_day: date
    recurrence_count: int
    latest_confidence: Optional[float]

    @property
    def has_attribution(self) -> bool:
        """Whether this step can be traced to something the participant wrote."""
        return bool(self.source_snapshot_ids)

    @property
    def is_curated(self) -> bool:
        return bool(self.curated_source_refs)

    @property
    def curation_disagrees(self) -> bool:
        """The curated layer types this pair differently from the extraction."""
        return self.curated_agrees_with_extraction is False

    def as_dict(self) -> Dict[str, Any]:
        return {
            "from_node_id": self.from_node_id,
            "to_node_id": self.to_node_id,
            "relation_type": self.relation_type,
            "edge_key": list(self.edge_key),
            "walked_against_arrow": self.walked_against_arrow,
            "step_damping": self.step_damping,
            "influence": self.influence,
            "evidence_strength": self.evidence_strength,
            "relation_source_refs": list(self.relation_source_refs),
            "curated_source_refs": list(self.curated_source_refs),
            "curated_subgraph_id": self.curated_subgraph_id,
            "curated_relation_type": self.curated_relation_type,
            "curated_agrees_with_extraction": self.curated_agrees_with_extraction,
            "curation_disagrees": self.curation_disagrees,
            "source_snapshot_ids": list(self.source_snapshot_ids),
            "observed_days": [day.isoformat() for day in self.observed_days],
            "last_day": self.last_day.isoformat(),
            "recurrence_count": self.recurrence_count,
            "latest_confidence": self.latest_confidence,
            "has_attribution": self.has_attribution,
            "is_curated": self.is_curated,
        }


@dataclass(frozen=True)
class EvidencePath:
    """A complete walk from a seed to a reached node, and its score.

    This is the object #96's central acceptance criterion describes: path, hop
    count, relation types, component scores, source snapshot ids, source refs and
    evidence strength, all present or explicitly absent.
    """

    seed_node_id: str
    target_node_id: str
    mode: str
    steps: Tuple[PathStep, ...]
    score: float
    components: Mapping[str, float]
    weights_applied: Mapping[str, float]
    components_unavailable: Tuple[str, ...]
    labels: Mapping[str, str] = field(default_factory=dict)

    @property
    def hop_count(self) -> int:
        return len(self.steps)

    @property
    def relation_types(self) -> Tuple[str, ...]:
        return tuple(step.relation_type for step in self.steps)

    @property
    def node_ids(self) -> Tuple[str, ...]:
        return (self.seed_node_id,) + tuple(step.to_node_id for step in self.steps)

    @property
    def source_snapshot_ids(self) -> Tuple[str, ...]:
        """Every snapshot behind the path, deduplicated, in first-seen order."""
        seen: List[str] = []
        for step in self.steps:
            for snapshot_id in step.source_snapshot_ids:
                if snapshot_id not in seen:
                    seen.append(snapshot_id)
        return tuple(seen)

    @property
    def curated_source_refs(self) -> Tuple[str, ...]:
        seen: List[str] = []
        for step in self.steps:
            for ref in step.curated_source_refs:
                if ref not in seen:
                    seen.append(ref)
        return tuple(seen)

    @property
    def influence_summary(self) -> str:
        """`raises`, `lowers`, `mixed`, or `none` — never a computed sign.

        Deliberately NOT the product of the step polarities. Multiplying signs
        along a chain ("a buffer of a cause lowers the outcome") is a causal
        inference, and this layer does not make one. When the influence-bearing
        steps disagree, the answer is `mixed` and the reader resolves it.
        """
        influences = {step.influence for step in self.steps if step.influence}
        if not influences:
            return "none"
        if len(influences) == 1:
            return influences.pop()
        return "mixed"

    @property
    def weakest_relation_type(self) -> Optional[str]:
        """The relation the path most depends on being right."""
        if not self.steps:
            return None
        return min(self.steps, key=lambda step: step.step_damping).relation_type

    @property
    def spans_days(self) -> int:
        """Calendar days between the earliest and latest observation on the path.

        The #87 chain family exists because a two-hop answer can span weeks and no
        single day contains it. A path that spans time is the finding, so the span
        is reported rather than left to be derived from the steps.
        """
        days = [day for step in self.steps for day in step.observed_days]
        return (max(days) - min(days)).days + 1 if days else 0

    @property
    def is_fully_attributed(self) -> bool:
        return bool(self.steps) and all(step.has_attribution for step in self.steps)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "seed_node_id": self.seed_node_id,
            "target_node_id": self.target_node_id,
            "mode": self.mode,
            "hop_count": self.hop_count,
            "node_ids": list(self.node_ids),
            "node_labels": [self.labels.get(node_id, node_id) for node_id in self.node_ids],
            "relation_types": list(self.relation_types),
            "influence_summary": self.influence_summary,
            "weakest_relation_type": self.weakest_relation_type,
            "spans_days": self.spans_days,
            "score": self.score,
            "score_breakdown": {
                "components": dict(self.components),
                "weights_applied": dict(self.weights_applied),
                "components_unavailable": list(self.components_unavailable),
                "declared_weights": dict(SCORE_WEIGHTS),
            },
            "source_snapshot_ids": list(self.source_snapshot_ids),
            "curated_source_refs": list(self.curated_source_refs),
            "is_fully_attributed": self.is_fully_attributed,
            "steps": [step.as_dict() for step in self.steps],
        }


@dataclass(frozen=True)
class TraversalReport:
    """What the walk could and could not do. Reported, never logged away.

    Mirrors `AssemblyReport`'s posture from #95: a caller that cannot see what was
    refused will treat what it received as the whole answer.
    """

    seeds_requested: Tuple[str, ...] = ()
    seeds_resolved: Tuple[str, ...] = ()
    seeds_not_in_graph: Tuple[str, ...] = ()
    #: `(edge_key, reason)` for every edge the walk declined to cross.
    skipped_edges: Tuple[Tuple[Tuple[str, str, str], str], ...] = ()
    paths_found: int = 0
    #: How many paths and nodes the caps removed. Counted rather than flagged: a
    #: bare `truncated: true` reads as "a few extra", and a result that dropped
    #: forty paths is a different result from one that dropped two.
    paths_dropped_by_cap: int = 0
    nodes_dropped_by_cap: int = 0
    max_hops: int = DEFAULT_MAX_HOPS
    identity_is_usable: bool = True
    warnings: Tuple[str, ...] = ()

    @property
    def was_truncated(self) -> bool:
        return bool(self.paths_dropped_by_cap or self.nodes_dropped_by_cap)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "seeds_requested": list(self.seeds_requested),
            "seeds_resolved": list(self.seeds_resolved),
            "seeds_not_in_graph": list(self.seeds_not_in_graph),
            "skipped_edges": [
                {"edge_key": list(edge_key), "reason": reason} for edge_key, reason in self.skipped_edges
            ],
            "paths_found": self.paths_found,
            "paths_dropped_by_cap": self.paths_dropped_by_cap,
            "nodes_dropped_by_cap": self.nodes_dropped_by_cap,
            "was_truncated": self.was_truncated,
            "max_hops": self.max_hops,
            "identity_is_usable": self.identity_is_usable,
            "warnings": list(self.warnings),
        }


@dataclass(frozen=True)
class NodeResult:
    """A reached node, with every path that reached it.

    The node's score is the best of its paths, not a blend: a strong path and a
    weak one to the same place is a strong answer that also has a weak route, and
    averaging them would report a worse answer than the evidence supports.
    """

    node_id: str
    label: str
    category: str
    best_score: float
    paths: Tuple[EvidencePath, ...]

    @property
    def min_hops(self) -> int:
        return min(path.hop_count for path in self.paths)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "node_id": self.node_id,
            "label": self.label,
            "category": self.category,
            "best_score": self.best_score,
            "min_hops": self.min_hops,
            "path_count": len(self.paths),
            "paths": [path.as_dict() for path in self.paths],
        }


@dataclass(frozen=True)
class TraversalResult:
    participant_id: str
    mode: str
    nodes: Tuple[NodeResult, ...]
    report: TraversalReport
    traversal_version: str = GRAPH_TRAVERSAL_VERSION
    relation_rules_version: str = RELATION_RULES_VERSION

    @property
    def paths(self) -> Tuple[EvidencePath, ...]:
        return tuple(path for node in self.nodes for path in node.paths)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "participant_id": self.participant_id,
            "mode": self.mode,
            "traversal_version": self.traversal_version,
            "relation_rules_version": self.relation_rules_version,
            "not_learned": (
                "Fixed relation parameters applied by a deterministic rule. Not attention, "
                "not trained, not fitted. See app/traversal/relations.py."
            ),
            "nodes": [node.as_dict() for node in self.nodes],
            "relation_rules": rules_as_dict(),
            "report": self.report.as_dict(),
        }


# ── the walk ──────────────────────────────────────────────────────────────────
def _traversable(
    edge: TemporalEdge,
    current_node_id: str,
    rule: RelationRule,
    mode: TraversalMode,
) -> Optional[str]:
    """The node this edge reaches from `current_node_id`, or None if it does not.

    The reverse-direction rejection lives here. In `DOWNSTREAM` mode a directed
    edge is only crossable from its source; standing on its target, the edge does
    not lead anywhere and returning its source would assert the opposite of what
    the edge says.
    """
    if rule.direction is TraversalDirection.SYMMETRIC:
        if edge.source_id == current_node_id:
            return edge.target_id
        if edge.target_id == current_node_id:
            return edge.source_id
        return None

    if mode is TraversalMode.DOWNSTREAM:
        return edge.target_id if edge.source_id == current_node_id else None
    return edge.source_id if edge.target_id == current_node_id else None


def _step_from_edge(
    edge: TemporalEdge,
    current_node_id: str,
    next_node_id: str,
    rule: RelationRule,
) -> PathStep:
    observed_days = tuple(
        day for interval in edge.intervals for day in interval.observed_days
    )
    return PathStep(
        from_node_id=current_node_id,
        to_node_id=next_node_id,
        relation_type=edge.relation_type,
        edge_key=edge.edge_key,
        walked_against_arrow=edge.source_id != current_node_id,
        step_damping=rule.step_damping,
        influence=rule.influence,
        # The edge's own curated strength when it has one, else the relation
        # vocabulary's. Two different claims: "this pair is backed" and "this
        # kind of claim is backed". The edge's is preferred because it is the
        # narrower one.
        evidence_strength=edge.evidence_strength or rule.evidence_strength,
        relation_source_refs=rule.source_refs,
        curated_source_refs=edge.curated_source_refs,
        curated_subgraph_id=edge.curated_provenance.subgraph_id,
        curated_relation_type=edge.curated_provenance.seed_relation_type,
        curated_agrees_with_extraction=edge.curated_provenance.type_matches_seed,
        source_snapshot_ids=edge.source_snapshot_ids,
        observed_days=observed_days,
        last_day=edge.last_day,
        recurrence_count=edge.recurrence_count,
        latest_confidence=edge.latest_confidence,
    )


def score_path(steps: Sequence[PathStep], as_of: date) -> Tuple[float, Dict[str, float], Dict[str, float], Tuple[str, ...]]:
    """Score a path from its steps. Pure, and the only place a number is invented.

    Returns `(score, components, weights_applied, components_unavailable)`.
    Components that cannot be computed are dropped and the remaining weights are
    renormalised over what survived — see the module docstring on absence.
    """
    if not steps:
        return 0.0, {}, {}, tuple(sorted(SCORE_WEIGHTS))

    components: Dict[str, float] = {}
    unavailable: List[str] = []

    damping = 1.0
    for step in steps:
        damping *= step.step_damping
    components["relation_path"] = round(damping, 6)

    confidences = [step.latest_confidence for step in steps if step.latest_confidence is not None]
    if len(confidences) == len(steps):
        components["edge_confidence"] = round(min(confidences), 6)
    else:
        # Partial confidence is still absence: a min over the subset would report
        # the path as being as confident as its best-documented edge.
        unavailable.append("edge_confidence")

    components["recency"] = round(
        min(recency_score((as_of - step.last_day).days) for step in steps), 6
    )
    components["recurrence"] = round(
        min(recurrence_score(step.recurrence_count) for step in steps), 6
    )
    components["curated_support"] = round(
        sum(1 for step in steps if step.is_curated) / len(steps), 6
    )

    available_weight = sum(SCORE_WEIGHTS[name] for name in components)
    weights_applied = {
        name: round(SCORE_WEIGHTS[name] / available_weight, 6) for name in sorted(components)
    }
    score = sum(components[name] * weights_applied[name] for name in components)
    return round(score, 6), components, weights_applied, tuple(sorted(unavailable))


def traverse(
    graph: ParticipantTemporalGraph,
    seed_node_ids: Sequence[str],
    mode: TraversalMode = TraversalMode.DOWNSTREAM,
    max_hops: int = DEFAULT_MAX_HOPS,
    max_paths: int = DEFAULT_MAX_PATHS,
    max_paths_per_target: int = DEFAULT_MAX_PATHS_PER_TARGET,
    as_of: Optional[date] = None,
) -> TraversalResult:
    """Walk `graph` from `seed_node_ids`, returning scored, attributed paths.

    Deterministic: every iteration is over a sorted sequence and `as_of` must be
    passed by a caller that needs reproducibility — it defaults to the graph's
    last observed day rather than to `date.today()`, so a test run in December
    scores a September fixture the way September did.
    """
    requested = tuple(seed_node_ids)
    resolved = tuple(sorted({node_id for node_id in requested if node_id in graph.nodes}))
    missing = tuple(sorted({node_id for node_id in requested if node_id not in graph.nodes}))

    if as_of is None:
        all_days = [node.last_day for node in graph.nodes.values()]
        as_of = max(all_days) if all_days else date(1970, 1, 1)

    # Sorted once; the walk indexes into this rather than re-sorting per node, and
    # sorting by key keeps sibling expansion order independent of dict insertion.
    edges_sorted = [graph.edges[key] for key in sorted(graph.edges)]
    incident: Dict[str, List[TemporalEdge]] = {}
    skipped: List[Tuple[Tuple[str, str, str], str]] = []
    for edge in edges_sorted:
        try:
            rule_for(edge.relation_type)
        except UnknownRelationType:
            skipped.append(
                (
                    edge.edge_key,
                    f"relation type {edge.relation_type!r} is not in the ontology vocabulary; "
                    "no traversal parameter exists for it and none was invented",
                )
            )
            continue
        incident.setdefault(edge.source_id, []).append(edge)
        incident.setdefault(edge.target_id, []).append(edge)

    paths: List[EvidencePath] = []
    paths_dropped = 0
    nodes_dropped = 0

    for seed_node_id in resolved:
        # (current_node, steps_so_far, visited). Breadth-first so shorter paths to
        # a target are found first, which is what `max_paths_per_target` should
        # keep when it truncates.
        frontier: List[Tuple[str, Tuple[PathStep, ...], Tuple[str, ...]]] = [
            (seed_node_id, (), (seed_node_id,))
        ]
        for _hop in range(max_hops):
            next_frontier: List[Tuple[str, Tuple[PathStep, ...], Tuple[str, ...]]] = []
            for current_node_id, steps_so_far, visited in frontier:
                for edge in incident.get(current_node_id, []):
                    rule = rule_for(edge.relation_type)
                    next_node_id = _traversable(edge, current_node_id, rule, mode)
                    if next_node_id is None:
                        continue
                    if next_node_id in visited:
                        # A simple path. A cycle adds no evidence — it revisits
                        # observations already on the path — and would let a
                        # tight loop generate paths until max_paths.
                        continue
                    step = _step_from_edge(edge, current_node_id, next_node_id, rule)
                    steps = steps_so_far + (step,)
                    score, components, weights_applied, unavailable = score_path(steps, as_of)
                    paths.append(
                        EvidencePath(
                            seed_node_id=seed_node_id,
                            target_node_id=next_node_id,
                            mode=mode.value,
                            steps=steps,
                            score=score,
                            components=components,
                            weights_applied=weights_applied,
                            components_unavailable=unavailable,
                            labels={
                                node_id: graph.nodes[node_id].canonical_label
                                for node_id in visited + (next_node_id,)
                                if node_id in graph.nodes
                            },
                        )
                    )
                    next_frontier.append((next_node_id, steps, visited + (next_node_id,)))
            frontier = next_frontier
            if not frontier:
                break

    # Group by target, then rank. Sorting by (-score, hop_count, node_id, relation
    # types) rather than score alone so two paths that tie score cannot swap order
    # between runs.
    by_target: Dict[str, List[EvidencePath]] = {}
    for path in paths:
        by_target.setdefault(path.target_node_id, []).append(path)

    node_results: List[NodeResult] = []
    for node_id in sorted(by_target):
        ranked = sorted(
            by_target[node_id],
            key=lambda p: (-p.score, p.hop_count, p.node_ids, p.relation_types),
        )
        if len(ranked) > max_paths_per_target:
            paths_dropped += len(ranked) - max_paths_per_target
            ranked = ranked[:max_paths_per_target]
        node = graph.nodes[node_id]
        node_results.append(
            NodeResult(
                node_id=node_id,
                label=node.canonical_label,
                category=node.category,
                best_score=ranked[0].score,
                paths=tuple(ranked),
            )
        )

    node_results.sort(key=lambda n: (-n.best_score, n.min_hops, n.node_id))
    if len(node_results) > max_paths:
        nodes_dropped = len(node_results) - max_paths
        paths_dropped += sum(len(n.paths) for n in node_results[max_paths:])
        node_results = node_results[:max_paths]

    warnings: List[str] = []
    if not requested:
        warnings.append(
            "no seeds were given, so nothing was walked; an empty result here is not a "
            "finding about the participant. Check SeedResolution.coverage upstream."
        )
    if not graph.report.identity_is_usable:
        warnings.append(
            "identity_is_usable is false for this participant: at least one snapshot "
            "predates label-derived node ids, so cross-day identity is meaningless and "
            "every path here is void. See AssemblyReport.legacy_identity_snapshots."
        )
    if missing:
        warnings.append(f"{len(missing)} seed(s) are not nodes in this graph and were dropped")
    if skipped:
        warnings.append(f"{len(skipped)} edge(s) were not traversable; see skipped_edges")
    if paths_dropped or nodes_dropped:
        warnings.append(
            f"caps removed {paths_dropped} path(s) and {nodes_dropped} node(s); this result "
            "is the top of a longer list, not the whole of a short one"
        )

    return TraversalResult(
        participant_id=graph.participant_id,
        mode=mode.value,
        nodes=tuple(node_results),
        report=TraversalReport(
            seeds_requested=requested,
            seeds_resolved=resolved,
            seeds_not_in_graph=missing,
            skipped_edges=tuple(skipped),
            paths_found=len(paths),
            paths_dropped_by_cap=paths_dropped,
            nodes_dropped_by_cap=nodes_dropped,
            max_hops=max_hops,
            identity_is_usable=graph.report.identity_is_usable,
            warnings=tuple(warnings),
        ),
    )


# ── the invariant ─────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class WithheldPath:
    path: EvidencePath
    reasons: Tuple[str, ...]

    def as_dict(self) -> Dict[str, Any]:
        return {
            "target_node_id": self.path.target_node_id,
            "relation_types": list(self.path.relation_types),
            "reasons": list(self.reasons),
        }


def reportability_reasons(path: EvidencePath, identity_is_usable: bool) -> Tuple[str, ...]:
    """Why `path` may not be shown to an educator-facing consumer. Empty means it may.

    #96's invariant, as a function rather than a convention, so the check is in
    one place and can be tested directly.
    """
    reasons: List[str] = []
    if not identity_is_usable:
        reasons.append(
            "cross-day identity is unusable for this participant, so no temporal path is a claim"
        )
    if not path.steps:
        reasons.append("empty path")
    for step in path.steps:
        if not step.has_attribution:
            reasons.append(
                f"step {step.from_node_id}->{step.to_node_id} ({step.relation_type}) "
                "has no source snapshot and cannot be traced to anything the participant wrote"
            )
    if not path.components:
        reasons.append("no score breakdown; a bare number is not an explanation")
    return tuple(reasons)


def filter_reportable(
    result: TraversalResult,
) -> Tuple[Tuple[NodeResult, ...], Tuple[WithheldPath, ...]]:
    """Split a result into what an educator-facing consumer may see and what it may not.

    Returns `(allowed_nodes, withheld)`. A node whose every path is withheld does
    not appear in `allowed_nodes` at all — a node shown without a route to it is
    the failure mode the invariant exists to prevent. Nothing is dropped silently:
    every withheld path is returned with its reasons.
    """
    identity_is_usable = result.report.identity_is_usable
    allowed: List[NodeResult] = []
    withheld: List[WithheldPath] = []

    for node in result.nodes:
        kept: List[EvidencePath] = []
        for path in node.paths:
            reasons = reportability_reasons(path, identity_is_usable)
            if reasons:
                withheld.append(WithheldPath(path=path, reasons=reasons))
            else:
                kept.append(path)
        if kept:
            allowed.append(
                NodeResult(
                    node_id=node.node_id,
                    label=node.label,
                    category=node.category,
                    best_score=max(path.score for path in kept),
                    paths=tuple(kept),
                )
            )

    return tuple(allowed), tuple(withheld)
