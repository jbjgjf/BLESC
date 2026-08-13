"""The three knowledge layers, and who is allowed to write to each (#101).

"Self-changing ontology" was one phrase covering three different operations:
preserving published knowledge, accumulating what one participant reported, and
proposing structure a model inferred. They have different owners, different
evidence, different lifetimes, and different consequences when wrong — so they
are three types here, not one table with a `kind` column.

| layer | owner | evidence | may be written by | reversible |
| --- | --- | --- | --- | --- |
| curated | a human curator | published sources, or declared judgement | curator only | by revision, with review |
| personal | the participant | their own entries, via extraction | the extraction pipeline | never — it is a record of what was said |
| candidate | a model | inference over the other two | a model, as a proposal | freely; nothing depends on it |

**The rule this module exists to enforce is one-directional.** A personal
observation can never overwrite the curated layer, and a candidate can never
enter it without a human review that is recorded. The reverse is unrestricted:
curated knowledge freely informs how a personal observation is read.

Enforcement is structural rather than conventional. The three edge types share
no field that would let one be passed where another is expected, `MUTATION_POLICY`
names exactly which actor may perform which operation on which layer, and
`revision.apply` refuses anything the table does not permit. A convention would
have been a comment; this fails a test.

This module defines no learning. Where a candidate edge comes from is out of
scope here and gated by `gate.py` — see `docs/ontology_evolution.md` for the
distinction between ontology evolution, belief revision, and graph structure
learning, which are three separate things this issue is careful not to conflate.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from enum import Enum
from typing import Any, Dict, Optional, Tuple

from ..schema import EvidenceStrength

CONTRACT_VERSION = "ontology-evolution-v1"

#: Named so a reader arriving from the roadmap sees the boundary without
#: finding the doc. #99/#100 are the learning stages; they consume this layer
#: and are gated by `gate.evaluate_proposals`.
NOT_IMPLEMENTED_HERE = (
    "graph structure learning of any kind",
    "automatic promotion of a candidate on model confidence",
    "autonomous rewriting of curated or clinical knowledge",
    "inference of causation from an association",
)


class Layer(str, Enum):
    CURATED = "curated"
    PERSONAL = "personal"
    CANDIDATE = "candidate"


class Actor(str, Enum):
    """Who is performing a revision.

    `PARTICIPANT` is not a person operating the system — it is the extraction
    pipeline acting on what a participant wrote. It is named for the source of
    the evidence rather than for the process, because the question the policy
    table answers is "whose claim is this", not "which code path ran".
    """

    CURATOR = "curator"
    PARTICIPANT = "participant"
    MODEL = "model"


class ScopeKind(str, Enum):
    """Who a claim is about.

    The distinction #101 calls "user-specific scope". A claim about adolescents
    in general and a claim about one participant are not competing versions of
    one fact; they answer different questions, and precedence has to keep them
    apart rather than pick between them.
    """

    GENERAL = "general"
    PARTICIPANT = "participant"


@dataclass(frozen=True)
class Scope:
    kind: ScopeKind
    participant_id: Optional[str] = None

    def __post_init__(self) -> None:
        if self.kind is ScopeKind.PARTICIPANT and not self.participant_id:
            raise ValueError("a participant-scoped claim needs a participant_id")
        if self.kind is ScopeKind.GENERAL and self.participant_id:
            raise ValueError("a general claim cannot name a participant")

    @property
    def is_general(self) -> bool:
        return self.kind is ScopeKind.GENERAL

    def covers(self, participant_id: Optional[str]) -> bool:
        """Whether this claim says anything about `participant_id`.

        A general claim covers everyone. A participant claim covers exactly one
        person — asking a general question of it would be generalising from n=1.
        """
        if self.is_general:
            return True
        return participant_id is not None and self.participant_id == participant_id

    def as_dict(self) -> Dict[str, Any]:
        return {"kind": self.kind.value, "participant_id": self.participant_id}


GENERAL = Scope(ScopeKind.GENERAL)


def participant_scope(participant_id: str) -> Scope:
    return Scope(ScopeKind.PARTICIPANT, participant_id)


#: `(source_id, target_id, relation_type)` — the same key the temporal graph
#: uses (#95). Relation type is part of the identity, so `causes` and `buffers`
#: between one pair are two claims that can disagree, not one claim that changed.
EdgeKey = Tuple[str, str, str]


class CandidateStatus(str, Enum):
    """Where a proposal stands. Every transition is a recorded revision.

    `REJECTED` and `SUPERSEDED` are terminal only in the sense that the
    candidate is no longer in play — `RESTORE` can bring either back, because a
    rejection that could not be revisited would make the log a record of
    decisions nobody is allowed to have been wrong about.
    """

    PROPOSED = "proposed"
    #: Confidence lowered, or counterevidence recorded, without rejecting it.
    WEAKENED = "weakened"
    #: A different candidate now covers this claim.
    SUPERSEDED = "superseded"
    REJECTED = "rejected"
    #: Reviewed by a human and copied into the curated layer. The candidate
    #: itself stays in the log; promotion does not consume it.
    PROMOTED = "promoted"

    @property
    def is_live(self) -> bool:
        return self in (CandidateStatus.PROPOSED, CandidateStatus.WEAKENED)


@dataclass(frozen=True)
class ObservationRef:
    """A pointer to something that was actually recorded.

    Used for both support and counterevidence, because the two are the same kind
    of thing pointing in opposite directions, and a candidate that could cite its
    support in more detail than its counterevidence would be built to look
    stronger than it is.
    """

    participant_id: str
    day: date
    snapshot_id: str
    entry_id: Optional[str] = None
    note: str = ""

    def as_dict(self) -> Dict[str, Any]:
        return {
            "participant_id": self.participant_id,
            "day": self.day.isoformat(),
            "snapshot_id": self.snapshot_id,
            "entry_id": self.entry_id,
            "note": self.note,
        }


@dataclass(frozen=True)
class CuratedEdge:
    """Published or explicitly-declared knowledge. The layer with the longest
    lifetime and the highest cost of being wrong.

    Mirrors `ontology.seed_graph.SeedEdge` — this is that edge once it is under
    revision control, with the reviewer decision attached. `source_refs` resolve
    against `ontology.sources`; an edge cannot exist without at least one, and
    `expert_judgement` is a legitimate value precisely so that an unsourced
    choice is recorded as unsourced rather than left blank.
    """

    edge_key: EdgeKey
    evidence_strength: EvidenceStrength
    source_refs: Tuple[str, ...]
    scope_note: str
    #: Who accepted it into the curated layer, and when. Populated on promotion
    #: and on any curator revision; a seed edge carries its curator here too.
    reviewed_by: str
    reviewed_on: date
    subgraph_id: Optional[str] = None
    #: Set when this edge replaced an earlier curated one, so the chain is
    #: followable without reading the whole log.
    supersedes: Optional[EdgeKey] = None
    scope: Scope = GENERAL

    def __post_init__(self) -> None:
        if not self.source_refs:
            raise ValueError(
                f"{self.edge_key}: a curated edge needs source_refs — "
                "use 'expert_judgement' rather than leaving it empty"
            )
        if not self.scope_note.strip():
            raise ValueError(f"{self.edge_key}: scope_note is required")
        if not self.reviewed_by.strip():
            raise ValueError(f"{self.edge_key}: curated knowledge names its reviewer")

    @property
    def layer(self) -> Layer:
        return Layer.CURATED

    @property
    def asserts_causation(self) -> bool:
        """Whether the SUPPORT is causal — never whether the relation type is.

        `causes` + ASSOCIATION is the common and legitimate case: the graph
        models a direction, the literature reports a correlation. Reading the
        relation type as the answer here is the single mistake #101 names.
        """
        return self.evidence_strength is EvidenceStrength.CAUSAL

    def as_dict(self) -> Dict[str, Any]:
        return {
            "layer": self.layer.value,
            "edge_key": list(self.edge_key),
            "evidence_strength": self.evidence_strength.value,
            "asserts_causation": self.asserts_causation,
            "source_refs": list(self.source_refs),
            "scope_note": self.scope_note,
            "reviewed_by": self.reviewed_by,
            "reviewed_on": self.reviewed_on.isoformat(),
            "subgraph_id": self.subgraph_id,
            "supersedes": list(self.supersedes) if self.supersedes else None,
            "scope": self.scope.as_dict(),
        }


@dataclass(frozen=True)
class PersonalEdge:
    """What one participant's own entries said, and when.

    Always participant-scoped and always carries observations. Deliberately has
    NO `source_refs` and no `evidence_strength`: a journal entry is not a
    citation and grading it on the scale used for published material would put
    a student's Tuesday on the same axis as a guideline. That separation is the
    same one `temporal.model` enforces between `PersonalObservation` and
    `CuratedProvenance`, and this type is the ontology-layer view of the edges
    that module assembles.

    Never revised. An observation is a record of something that was said; a
    later entry that disagrees is another observation, and the disagreement is a
    contradiction event rather than an edit.
    """

    edge_key: EdgeKey
    participant_id: str
    observations: Tuple[ObservationRef, ...]
    first_observed: date
    last_observed: date
    #: How many separate appearances — the recurrence count from the temporal
    #: graph. One appearance and ten are different amounts of evidence about
    #: this person, and the number travels so a reader can tell.
    recurrence_count: int = 1

    def __post_init__(self) -> None:
        if not self.observations:
            raise ValueError(f"{self.edge_key}: a personal edge without an observation is not an observation")

    @property
    def layer(self) -> Layer:
        return Layer.PERSONAL

    @property
    def scope(self) -> Scope:
        return participant_scope(self.participant_id)

    @property
    def asserts_causation(self) -> bool:
        """Never. A participant reporting a link is not evidence of one.

        Present so that precedence can ask every claim the same question and get
        an honest answer, rather than having to know which types can be asked.
        """
        return False

    def as_dict(self) -> Dict[str, Any]:
        return {
            "layer": self.layer.value,
            "edge_key": list(self.edge_key),
            "participant_id": self.participant_id,
            "observations": [observation.as_dict() for observation in self.observations],
            "observation_count": len(self.observations),
            "first_observed": self.first_observed.isoformat(),
            "last_observed": self.last_observed.isoformat(),
            "recurrence_count": self.recurrence_count,
            "asserts_causation": self.asserts_causation,
            "scope": self.scope.as_dict(),
        }


@dataclass(frozen=True)
class CandidateEdge:
    """A model's proposal. Carries everything needed to argue against it.

    #101 requires model version, data version, confidence, supporting
    observations, counterevidence, and status. Counterevidence is mandatory in
    the sense that it is a field rather than an option: a proposal that has not
    looked for disconfirming evidence records an empty tuple, and
    `searched_for_counterevidence` says whether the emptiness means "none found"
    or "not looked for". Those are different claims and a reviewer needs to know
    which one they are reading.

    Nothing in the product may read this layer as knowledge. It is a queue of
    things a human might look at.
    """

    edge_key: EdgeKey
    model_version: str
    data_version: str
    confidence: float
    supporting_observations: Tuple[ObservationRef, ...]
    counterevidence: Tuple[ObservationRef, ...]
    status: CandidateStatus
    proposed_on: date
    scope: Scope
    #: False means the emptiness of `counterevidence` carries no information.
    searched_for_counterevidence: bool = False
    rationale: str = ""
    #: Set by SUPERSEDE, so the chain is followable.
    superseded_by: Optional[EdgeKey] = None

    def __post_init__(self) -> None:
        if not 0.0 <= self.confidence <= 1.0:
            raise ValueError(f"{self.edge_key}: confidence must be in [0, 1], got {self.confidence}")
        if not self.model_version or not self.data_version:
            raise ValueError(
                f"{self.edge_key}: a candidate names the model and the data that produced it, "
                "or it cannot be reproduced or retracted by version"
            )

    @property
    def layer(self) -> Layer:
        return Layer.CANDIDATE

    @property
    def asserts_causation(self) -> bool:
        """Never, at any confidence. Confidence is not evidence strength."""
        return False

    @property
    def counterevidence_is_informative(self) -> bool:
        return self.searched_for_counterevidence

    def as_dict(self) -> Dict[str, Any]:
        return {
            "layer": self.layer.value,
            "edge_key": list(self.edge_key),
            "model_version": self.model_version,
            "data_version": self.data_version,
            "confidence": self.confidence,
            "supporting_observations": [o.as_dict() for o in self.supporting_observations],
            "counterevidence": [o.as_dict() for o in self.counterevidence],
            "searched_for_counterevidence": self.searched_for_counterevidence,
            "counterevidence_is_informative": self.counterevidence_is_informative,
            "status": self.status.value,
            "proposed_on": self.proposed_on.isoformat(),
            "rationale": self.rationale,
            "superseded_by": list(self.superseded_by) if self.superseded_by else None,
            "asserts_causation": self.asserts_causation,
            "scope": self.scope.as_dict(),
        }


class RevisionOperation(str, Enum):
    """The operations #101 requires be defined, plus the one that crosses layers.

    `PROMOTE` is listed with the rest rather than hidden behind a different name
    because it is the dangerous one, and a reader scanning this enum should see
    it next to the others and find `requires_human_review` beside it.
    """

    ADD_CANDIDATE = "add_candidate"
    WEAKEN = "weaken"
    SUPERSEDE = "supersede"
    REJECT = "reject"
    RESTORE = "restore"
    PROMOTE = "promote"
    #: Not a change to a claim: a record that two claims disagree. Emitted
    #: rather than resolved, and it is what keeps a curated/personal conflict
    #: from being silently settled.
    RECORD_CONTRADICTION = "record_contradiction"
    #: An observation arriving in the personal layer. Append-only by definition.
    OBSERVE = "observe"


@dataclass(frozen=True)
class MutationPolicy:
    """Who may do what to one layer. The table is the enforcement."""

    layer: Layer
    owner: str
    writers: Tuple[Actor, ...]
    operations: Tuple[RevisionOperation, ...]
    requires_human_review: bool
    requires_source_refs: bool
    is_participant_scoped: bool
    note: str

    def permits(self, actor: Actor, operation: RevisionOperation) -> bool:
        return actor in self.writers and operation in self.operations

    def as_dict(self) -> Dict[str, Any]:
        return {
            "layer": self.layer.value,
            "owner": self.owner,
            "writers": [actor.value for actor in self.writers],
            "operations": [operation.value for operation in self.operations],
            "requires_human_review": self.requires_human_review,
            "requires_source_refs": self.requires_source_refs,
            "is_participant_scoped": self.is_participant_scoped,
            "note": self.note,
        }


MUTATION_POLICY: Dict[Layer, MutationPolicy] = {
    Layer.CURATED: MutationPolicy(
        layer=Layer.CURATED,
        owner="ontology curator",
        writers=(Actor.CURATOR,),
        operations=(
            RevisionOperation.PROMOTE,
            RevisionOperation.SUPERSEDE,
            RevisionOperation.WEAKEN,
            RevisionOperation.REJECT,
            RevisionOperation.RESTORE,
            RevisionOperation.RECORD_CONTRADICTION,
        ),
        requires_human_review=True,
        requires_source_refs=True,
        is_participant_scoped=False,
        note=(
            "Neither a participant nor a model appears in `writers`. That is the "
            "one-directional rule: published knowledge is not edited by what one "
            "student wrote or by what a model inferred from them."
        ),
    ),
    Layer.PERSONAL: MutationPolicy(
        layer=Layer.PERSONAL,
        owner="the participant",
        writers=(Actor.PARTICIPANT,),
        operations=(RevisionOperation.OBSERVE, RevisionOperation.RECORD_CONTRADICTION),
        requires_human_review=False,
        requires_source_refs=False,
        is_participant_scoped=True,
        note=(
            "Append-only and never revised. An observation records that something "
            "was said; a later entry disagreeing is another observation, and the "
            "disagreement is a contradiction event rather than an edit. A curator "
            "cannot correct it either — it is not theirs to correct."
        ),
    ),
    Layer.CANDIDATE: MutationPolicy(
        layer=Layer.CANDIDATE,
        owner="the proposing model",
        writers=(Actor.MODEL, Actor.CURATOR),
        operations=(
            RevisionOperation.ADD_CANDIDATE,
            RevisionOperation.WEAKEN,
            RevisionOperation.SUPERSEDE,
            RevisionOperation.REJECT,
            RevisionOperation.RESTORE,
            RevisionOperation.RECORD_CONTRADICTION,
        ),
        requires_human_review=False,
        requires_source_refs=False,
        is_participant_scoped=False,
        note=(
            "Freely mutable because nothing in the product reads it as knowledge. "
            "A curator may also write here — rejecting a proposal is review work, "
            "and it must not require the model's cooperation."
        ),
    ),
}


class LayerViolation(Exception):
    """An operation the mutation policy does not permit.

    Raised rather than logged. A refused write that returned quietly would leave
    the caller believing the curated layer had been changed, which is the exact
    failure the policy exists to prevent.
    """

    def __init__(self, actor: Actor, operation: RevisionOperation, layer: Layer, detail: str = "") -> None:
        self.actor, self.operation, self.layer = actor, operation, layer
        policy = MUTATION_POLICY[layer]
        super().__init__(
            f"{actor.value} may not {operation.value} in the {layer.value} layer. "
            f"{policy.note}{' ' + detail if detail else ''}"
        )


def check_permitted(actor: Actor, operation: RevisionOperation, layer: Layer) -> None:
    if not MUTATION_POLICY[layer].permits(actor, operation):
        raise LayerViolation(actor, operation, layer)


def policy_table() -> Dict[str, Any]:
    """The whole table, for serialisation into a response or a doc test."""
    return {
        "contract_version": CONTRACT_VERSION,
        "not_implemented_here": list(NOT_IMPLEMENTED_HERE),
        "layers": {layer.value: policy.as_dict() for layer, policy in sorted(MUTATION_POLICY.items())},
    }
