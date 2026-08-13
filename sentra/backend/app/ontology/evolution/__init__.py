"""Ontology evolution: three layers, their revision operations, and the gate (#101).

Three distinct operations that "self-changing ontology" used to name at once:

- **Curated** — published or explicitly declared knowledge. A human curator owns
  it; nothing else may write to it.
- **Personal** — what one participant's own entries said. Append-only, never
  revised, never promoted to general knowledge automatically.
- **Candidate** — a model's proposal, carrying its model and data version, its
  confidence, its supporting observations and its counterevidence. Nothing in
  the product reads it as knowledge.

`docs/ontology_evolution.md` separates ontology evolution, belief revision and
graph structure learning, which are three different things this package is
careful not to conflate. **No learning happens here** — see
`layers.NOT_IMPLEMENTED_HERE`.

    from app.ontology.evolution import RevisionLog, resolve, evaluate_proposals

    log = RevisionLog()
    log.add_candidate(candidate, at=today)          # a model proposes
    log.reject(candidate.edge_key, today, "…")      # a curator declines
    log.state_at(1)                                 # the ontology at version 1
    resolve(claims, "exam_pressure", "眠れない", participant_id="p1")
"""

from .bridge import (
    CURATION_OWNER,
    SEED_AUTHORED_ON,
    SEED_REVIEW_NOTE,
    curated_edges_from_seed,
    personal_edges_from_graph,
    seed_attribution,
)
from .gate import (
    CASES_PATH,
    EdgeLabel,
    GateResult,
    GateThresholds,
    LabelledEdge,
    evaluate_proposals,
    gate_summary,
    load_cases,
)
from .layers import (
    CONTRACT_VERSION,
    GENERAL,
    MUTATION_POLICY,
    NOT_IMPLEMENTED_HERE,
    Actor,
    CandidateEdge,
    CandidateStatus,
    CuratedEdge,
    EdgeKey,
    Layer,
    LayerViolation,
    MutationPolicy,
    ObservationRef,
    PersonalEdge,
    RevisionOperation,
    Scope,
    ScopeKind,
    check_permitted,
    participant_scope,
    policy_table,
)
from .precedence import (
    Claim,
    Contradiction,
    Resolution,
    claim_date,
    find_contradictions,
    precedence_rules,
    rank_reason,
    resolve,
)
from .revision import KnowledgeState, ReviewRequired, RevisionEvent, RevisionLog

__all__ = [
    "Actor",
    "CASES_PATH",
    "CONTRACT_VERSION",
    "CURATION_OWNER",
    "CandidateEdge",
    "CandidateStatus",
    "Claim",
    "Contradiction",
    "CuratedEdge",
    "EdgeKey",
    "EdgeLabel",
    "GENERAL",
    "GateResult",
    "GateThresholds",
    "KnowledgeState",
    "LabelledEdge",
    "Layer",
    "LayerViolation",
    "MUTATION_POLICY",
    "MutationPolicy",
    "NOT_IMPLEMENTED_HERE",
    "ObservationRef",
    "PersonalEdge",
    "Resolution",
    "ReviewRequired",
    "RevisionEvent",
    "RevisionLog",
    "RevisionOperation",
    "SEED_AUTHORED_ON",
    "SEED_REVIEW_NOTE",
    "Scope",
    "ScopeKind",
    "check_permitted",
    "claim_date",
    "curated_edges_from_seed",
    "evaluate_proposals",
    "find_contradictions",
    "gate_summary",
    "load_cases",
    "participant_scope",
    "personal_edges_from_graph",
    "policy_table",
    "precedence_rules",
    "rank_reason",
    "resolve",
    "seed_attribution",
]
