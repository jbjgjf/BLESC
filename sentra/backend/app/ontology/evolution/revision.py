"""Revision operations and the append-only log they are recorded in (#101).

The log is the ontology; the three layers are a projection of it. Every change
is an event, no event is ever edited or removed, and `RevisionLog.state_at(n)`
replays the first `n` events to reconstruct exactly what the layers held at that
point. That is what "an audit log can reconstruct every graph version" has to
mean to be worth anything: not a record of what changed, but a record from which
the state is recomputable, so a disagreement about what the ontology said last
March is settled by replay rather than by memory.

The operations are the five #101 names, plus two:

| operation | layer | effect |
| --- | --- | --- |
| `observe` | personal | append what a participant's entry said |
| `add_candidate` | candidate | a model proposes an edge |
| `weaken` | candidate | lower confidence, or attach counterevidence, without rejecting |
| `supersede` | candidate | a different claim now covers this one |
| `reject` | candidate | a reviewer or a rule rules it out |
| `restore` | candidate | undo a rejection or a supersession |
| `promote` | curated | a **reviewed** candidate enters curated knowledge |
| `record_contradiction` | any | two claims disagree; neither is changed |

`promote` is the only one that writes to the curated layer, it is the only one
that requires a named reviewer, and `Actor.MODEL` cannot perform it at any
confidence. `record_contradiction` deliberately changes nothing: a curated edge
and a participant's entry pointing opposite ways is not an error to resolve, and
a system that resolved it would be picking between a guideline and a student
without being told how.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field, replace
from datetime import date
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

from .layers import (
    CONTRACT_VERSION,
    Actor,
    CandidateEdge,
    CandidateStatus,
    CuratedEdge,
    EdgeKey,
    Layer,
    LayerViolation,
    ObservationRef,
    PersonalEdge,
    RevisionOperation,
    check_permitted,
)


@dataclass(frozen=True)
class RevisionEvent:
    """One recorded change. Never edited, never removed.

    `index` is its position in the log and doubles as the version number: "the
    ontology at version 12" is `state_at(12)`, which is defined for every 12
    that exists.
    """

    index: int
    operation: RevisionOperation
    actor: Actor
    layer: Layer
    edge_key: EdgeKey
    at: date
    #: Why. Required for every operation that removes or downgrades a claim —
    #: a rejection with no recorded reason cannot be argued with later.
    reason: str = ""
    #: The object the operation carried, where it carried one.
    payload: Optional[Any] = None
    detail: Dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "index": self.index,
            "operation": self.operation.value,
            "actor": self.actor.value,
            "layer": self.layer.value,
            "edge_key": list(self.edge_key),
            "at": self.at.isoformat(),
            "reason": self.reason,
            "payload": self.payload.as_dict() if hasattr(self.payload, "as_dict") else self.payload,
            "detail": dict(self.detail),
        }


@dataclass(frozen=True)
class KnowledgeState:
    """The three layers as they stood after some prefix of the log."""

    version: int
    curated: Mapping[EdgeKey, CuratedEdge]
    personal: Mapping[Tuple[str, EdgeKey], PersonalEdge]
    candidates: Mapping[EdgeKey, CandidateEdge]

    def live_candidates(self) -> List[CandidateEdge]:
        return [self.candidates[key] for key in sorted(self.candidates) if self.candidates[key].status.is_live]

    def personal_for(self, participant_id: str) -> List[PersonalEdge]:
        return [
            self.personal[key]
            for key in sorted(self.personal)
            if key[0] == participant_id
        ]

    def as_dict(self) -> Dict[str, Any]:
        return {
            "version": self.version,
            "curated": [self.curated[key].as_dict() for key in sorted(self.curated)],
            "personal": [self.personal[key].as_dict() for key in sorted(self.personal)],
            "candidates": [self.candidates[key].as_dict() for key in sorted(self.candidates)],
        }


class ReviewRequired(Exception):
    """A promotion arrived without a human decision attached.

    Separate from `LayerViolation` because the actor may be entirely legitimate
    — a curator promoting an edge they forgot to sign is a different mistake
    from a model trying to promote one, and collapsing the two would make the
    error message wrong for both.
    """


class RevisionLog:
    """Append-only. The only way to change what the layers hold.

    Not a database. Instances are built from stored events by `load.py` or from
    nothing, exactly as `temporal.assemble` builds a graph — deriving the state
    on read keeps one copy of the history rather than a log and a table that can
    disagree about it.
    """

    def __init__(self, events: Iterable[RevisionEvent] = ()) -> None:
        self._events: List[RevisionEvent] = list(events)

    # ---- reading ---------------------------------------------------------

    @property
    def events(self) -> Tuple[RevisionEvent, ...]:
        return tuple(self._events)

    @property
    def version(self) -> int:
        return len(self._events)

    def events_for(self, edge_key: EdgeKey) -> List[RevisionEvent]:
        return [event for event in self._events if event.edge_key == edge_key]

    def state(self) -> KnowledgeState:
        return self.state_at(self.version)

    def state_at(self, version: int) -> KnowledgeState:
        """The layers as they stood after the first `version` events.

        Replays from the start every time rather than keeping a running copy. A
        cached projection that drifted from the log would make the log a
        description of the state instead of its source, and this is not on a hot
        path — `state_at` exists to answer audit questions, not to serve reads.
        """
        if version < 0 or version > self.version:
            raise IndexError(f"version {version} is outside the log (0..{self.version})")

        curated: Dict[EdgeKey, CuratedEdge] = {}
        personal: Dict[Tuple[str, EdgeKey], PersonalEdge] = {}
        candidates: Dict[EdgeKey, CandidateEdge] = {}

        for event in self._events[:version]:
            _apply_to_state(event, curated, personal, candidates)

        return KnowledgeState(version=version, curated=curated, personal=personal, candidates=candidates)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "contract_version": CONTRACT_VERSION,
            "version": self.version,
            "events": [event.as_dict() for event in self._events],
        }

    def as_json(self) -> str:
        return json.dumps(self.as_dict(), ensure_ascii=False, sort_keys=True, indent=2)

    # ---- writing ---------------------------------------------------------

    def _append(
        self,
        operation: RevisionOperation,
        actor: Actor,
        layer: Layer,
        edge_key: EdgeKey,
        at: date,
        reason: str = "",
        payload: Optional[Any] = None,
        detail: Optional[Dict[str, Any]] = None,
    ) -> RevisionEvent:
        check_permitted(actor, operation, layer)
        event = RevisionEvent(
            index=len(self._events),
            operation=operation,
            actor=actor,
            layer=layer,
            edge_key=edge_key,
            at=at,
            reason=reason,
            payload=payload,
            detail=dict(detail or {}),
        )
        self._events.append(event)
        return event

    def observe(self, edge: PersonalEdge, at: date) -> RevisionEvent:
        """Record what a participant's entry said. Append-only by construction."""
        return self._append(
            RevisionOperation.OBSERVE,
            Actor.PARTICIPANT,
            Layer.PERSONAL,
            edge.edge_key,
            at,
            payload=edge,
            detail={"participant_id": edge.participant_id},
        )

    def add_candidate(self, edge: CandidateEdge, at: date, actor: Actor = Actor.MODEL) -> RevisionEvent:
        if edge.status is not CandidateStatus.PROPOSED:
            raise ValueError(
                f"{edge.edge_key}: a candidate enters the log as `proposed`; "
                f"got `{edge.status.value}`. Later states are reached by revision, "
                "so that the transition is in the log rather than in the object."
            )
        return self._append(
            RevisionOperation.ADD_CANDIDATE,
            actor,
            Layer.CANDIDATE,
            edge.edge_key,
            at,
            reason=edge.rationale,
            payload=edge,
        )

    def weaken(
        self,
        edge_key: EdgeKey,
        at: date,
        reason: str,
        confidence: Optional[float] = None,
        counterevidence: Sequence[ObservationRef] = (),
        actor: Actor = Actor.MODEL,
    ) -> RevisionEvent:
        """Lower a candidate's standing without ruling it out.

        The operation #101 asks for that has no obvious database analogue: a
        claim can lose support without becoming false, and a system whose only
        options were "keep" and "delete" would force one of those two.
        """
        _require_reason(RevisionOperation.WEAKEN, reason)
        if confidence is not None and not 0.0 <= confidence <= 1.0:
            raise ValueError(f"{edge_key}: confidence must be in [0, 1], got {confidence}")
        return self._append(
            RevisionOperation.WEAKEN,
            actor,
            Layer.CANDIDATE,
            edge_key,
            at,
            reason=reason,
            detail={
                "confidence": confidence,
                "counterevidence": [observation.as_dict() for observation in counterevidence],
            },
            payload=tuple(counterevidence),
        )

    def supersede(
        self, edge_key: EdgeKey, replacement: EdgeKey, at: date, reason: str, actor: Actor = Actor.MODEL
    ) -> RevisionEvent:
        _require_reason(RevisionOperation.SUPERSEDE, reason)
        return self._append(
            RevisionOperation.SUPERSEDE,
            actor,
            Layer.CANDIDATE,
            edge_key,
            at,
            reason=reason,
            detail={"replacement": list(replacement)},
        )

    def reject(self, edge_key: EdgeKey, at: date, reason: str, actor: Actor = Actor.CURATOR) -> RevisionEvent:
        _require_reason(RevisionOperation.REJECT, reason)
        return self._append(
            RevisionOperation.REJECT, actor, Layer.CANDIDATE, edge_key, at, reason=reason
        )

    def restore(self, edge_key: EdgeKey, at: date, reason: str, actor: Actor = Actor.CURATOR) -> RevisionEvent:
        """Bring a rejected or superseded candidate back into play.

        Restores to `proposed`, not to whatever it held before. A restore is a
        fresh decision to reconsider, and reinstating an earlier confidence
        would carry forward a number nobody has re-examined.
        """
        _require_reason(RevisionOperation.RESTORE, reason)
        return self._append(
            RevisionOperation.RESTORE, actor, Layer.CANDIDATE, edge_key, at, reason=reason
        )

    def promote(
        self,
        edge_key: EdgeKey,
        curated: CuratedEdge,
        at: date,
        reviewer: str,
        reason: str,
        actor: Actor = Actor.CURATOR,
    ) -> RevisionEvent:
        """Copy a reviewed candidate into the curated layer.

        The only operation that writes to curated knowledge. Three guards, and
        none of them is about the model's confidence:

        1. `Actor.MODEL` is not in the curated layer's writers, so a model
           cannot reach this at all — `check_permitted` raises first.
        2. A reviewer must be named. #101 requires human review before
           promotion, and a review with no reviewer is not one.
        3. The curated edge must carry `source_refs` and a `scope_note`, which
           `CuratedEdge` enforces on construction.

        The candidate is marked `promoted` rather than consumed: the proposal
        and the decision both stay in the log.
        """
        _require_reason(RevisionOperation.PROMOTE, reason)
        if not reviewer.strip():
            raise ReviewRequired(
                f"{edge_key}: promotion into the curated layer needs a named reviewer. "
                "A promotion on model confidence alone is what #101's non-goals rule out."
            )
        if curated.reviewed_by.strip() != reviewer.strip():
            raise ReviewRequired(
                f"{edge_key}: the promoted edge is signed by `{curated.reviewed_by}` but the "
                f"promotion is attributed to `{reviewer}`. They must be the same person."
            )
        return self._append(
            RevisionOperation.PROMOTE,
            actor,
            Layer.CURATED,
            edge_key,
            at,
            reason=reason,
            payload=curated,
            detail={"reviewer": reviewer},
        )

    def record_contradiction(
        self,
        edge_key: EdgeKey,
        at: date,
        layers: Sequence[Layer],
        detail: Mapping[str, Any],
        actor: Actor = Actor.CURATOR,
        reason: str = "",
    ) -> RevisionEvent:
        """Two claims about one edge disagree. Nothing is changed.

        Recorded against the CANDIDATE layer whatever the claims involved,
        because a contradiction is not itself knowledge and writing it against
        the curated layer would make "we noticed a disagreement" a curated fact.
        The layers in conflict are named in the detail.
        """
        return self._append(
            RevisionOperation.RECORD_CONTRADICTION,
            actor,
            Layer.CANDIDATE,
            edge_key,
            at,
            reason=reason,
            detail={**dict(detail), "layers_in_conflict": [layer.value for layer in layers]},
        )


def _require_reason(operation: RevisionOperation, reason: str) -> None:
    if not reason.strip():
        raise ValueError(
            f"{operation.value} needs a recorded reason. An operation that lowers or removes a "
            "claim without one leaves nothing to argue with when it is revisited."
        )


def _apply_to_state(
    event: RevisionEvent,
    curated: Dict[EdgeKey, CuratedEdge],
    personal: Dict[Tuple[str, EdgeKey], PersonalEdge],
    candidates: Dict[EdgeKey, CandidateEdge],
) -> None:
    """Fold one event into the running projection. Pure bookkeeping.

    An operation naming an edge the projection has never seen is ignored rather
    than raising: a log loaded from a longer history may legitimately begin
    mid-story, and refusing to replay it would make partial audits impossible.
    """
    operation = event.operation

    if operation is RevisionOperation.OBSERVE:
        edge: PersonalEdge = event.payload
        personal[(edge.participant_id, edge.edge_key)] = edge
        return

    if operation is RevisionOperation.ADD_CANDIDATE:
        candidates[event.edge_key] = event.payload
        return

    if operation is RevisionOperation.PROMOTE:
        curated[event.edge_key] = event.payload
        existing = candidates.get(event.edge_key)
        if existing is not None:
            candidates[event.edge_key] = replace(existing, status=CandidateStatus.PROMOTED)
        return

    existing = candidates.get(event.edge_key)
    if existing is None:
        return

    if operation is RevisionOperation.WEAKEN:
        confidence = event.detail.get("confidence")
        candidates[event.edge_key] = replace(
            existing,
            status=CandidateStatus.WEAKENED,
            confidence=existing.confidence if confidence is None else float(confidence),
            counterevidence=existing.counterevidence + tuple(event.payload or ()),
            searched_for_counterevidence=True,
        )
    elif operation is RevisionOperation.SUPERSEDE:
        replacement = event.detail.get("replacement")
        candidates[event.edge_key] = replace(
            existing,
            status=CandidateStatus.SUPERSEDED,
            superseded_by=tuple(replacement) if replacement else None,
        )
    elif operation is RevisionOperation.REJECT:
        candidates[event.edge_key] = replace(existing, status=CandidateStatus.REJECTED)
    elif operation is RevisionOperation.RESTORE:
        candidates[event.edge_key] = replace(
            existing, status=CandidateStatus.PROPOSED, superseded_by=None
        )


__all__ = [
    "KnowledgeState",
    "ReviewRequired",
    "RevisionEvent",
    "RevisionLog",
    "LayerViolation",
]
