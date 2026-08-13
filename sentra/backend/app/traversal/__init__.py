"""Relation-aware deterministic traversal over the participant temporal graph (#96).

Stage 0 of the learning roadmap (#102): typed, directed traversal with **fixed**
parameters and a complete evidence trace. No training, no attention, no policy.
`relations.RELATION_RULES` holds every parameter and says which are argued and
which are arbitrary; `walk.TraversalResult.as_dict()` carries the whole table
into any serialisation, so a stored result can be audited against the rule that
produced it.

    from app.traversal import SeedCandidate, TraversalMode, resolve_seeds, traverse

    seeds = resolve_seeds(graph, [SeedCandidate("q1", "眠れない")])
    result = traverse(graph, seeds.resolved_node_ids, mode=TraversalMode.DOWNSTREAM)
    allowed, withheld = filter_reportable(result)   # the educator-facing invariant

`analytics/graph_index.traverse_graph` is deliberately untouched: #96 requires
the undirected BFS as a comparison baseline, and this package is additive.
"""

from .relations import (
    RELATION_RULES,
    RELATION_RULES_VERSION,
    RelationRule,
    TraversalDirection,
    UnknownRelationType,
    is_known,
    rule_for,
    rules_as_dict,
)
from .seeds import (
    SEED_RESOLUTION_VERSION,
    SeedCandidate,
    SeedMapping,
    SeedResolution,
    SeedRule,
    candidates_from_graph_nodes,
    resolve_seeds,
)
from .walk import (
    DEFAULT_MAX_HOPS,
    DEFAULT_MAX_PATHS,
    DEFAULT_MAX_PATHS_PER_TARGET,
    GRAPH_TRAVERSAL_VERSION,
    SCORE_WEIGHTS,
    EvidencePath,
    NodeResult,
    PathStep,
    TraversalMode,
    TraversalReport,
    TraversalResult,
    WithheldPath,
    filter_reportable,
    reportability_reasons,
    score_path,
    traverse,
)

__all__ = [
    "DEFAULT_MAX_HOPS",
    "DEFAULT_MAX_PATHS",
    "DEFAULT_MAX_PATHS_PER_TARGET",
    "GRAPH_TRAVERSAL_VERSION",
    "RELATION_RULES",
    "RELATION_RULES_VERSION",
    "SCORE_WEIGHTS",
    "SEED_RESOLUTION_VERSION",
    "EvidencePath",
    "NodeResult",
    "PathStep",
    "RelationRule",
    "SeedCandidate",
    "SeedMapping",
    "SeedResolution",
    "SeedRule",
    "TraversalDirection",
    "TraversalMode",
    "TraversalReport",
    "TraversalResult",
    "UnknownRelationType",
    "WithheldPath",
    "candidates_from_graph_nodes",
    "filter_reportable",
    "is_known",
    "reportability_reasons",
    "resolve_seeds",
    "rule_for",
    "rules_as_dict",
    "score_path",
    "traverse",
]
