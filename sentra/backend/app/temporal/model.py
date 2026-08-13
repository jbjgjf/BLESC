"""The participant temporal graph — the L3 data contract (#95).

**This is a data model, not a learned one.** No TGN, no TGAT, no Hawkes
process, no attention, no clinical prediction. Nothing here is trained and
nothing here forecasts. It turns a sequence of day-ordered extraction snapshots
into a typed, directed, provenance-preserving structure that later stages can
traverse (#96), measure (#97) or learn over (#98, #100) — and it exists so that
those stages share one definition of "the same node on two days" instead of
three. `NOT_IMPLEMENTED_HERE` names what this layer deliberately does not do,
and `sentra/docs/participant_temporal_graph.md` says why at length.

Four properties are load-bearing.

**Observation intervals, not spans.** A concept seen on Monday and Friday but
not Wednesday has TWO intervals, not one four-day span. Collapsing them would
erase the gap, and the gap is the phenomenon: recurrence, remission and relapse
are exactly what a temporal graph exists to represent. `ObservationInterval`
carries the days it was actually seen, so a caller can never mistake
interpolation for observation.

**Nothing is overwritten.** Every change is an append-only `TemporalEvent`.
`ParticipantTemporalGraph.at(day)` replays the log to reconstruct the graph as
it stood on any past day. A representation that mutated in place could not
answer "what did we believe last Tuesday", which is the question an audit asks.

**Ambiguity is recorded, never resolved by guessing.** When two observations
might be the same concept but the evidence does not settle it, they stay
separate and an `IDENTITY_AMBIGUOUS` event links them. A silent merge produces a
graph that looks more confident than the data, and this graph feeds a product
shown to people who support children.

**Curated and personal provenance never share a field.** `PersonalObservation`
is evidence about one participant and always carries a `SnapshotRef`.
`CuratedProvenance` is evidence about a population and never carries one. The
two dataclasses have no field in common, so a curated citation cannot end up
where a journal entry belongs by an accident of dict merging — which is the
failure #101 exists to prevent and is cheapest to prevent here.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import date
from enum import Enum
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

CONTRACT_VERSION = "participant-temporal-graph-v1"

#: Deliberately NOT the learning stages. Named here so that a reader arriving
#: from the roadmap can see what this layer does and does not claim, and so
#: that `as_dict()` carries the disclaimer into anything that serialises it.
NOT_IMPLEMENTED_HERE = (
    "temporal graph networks (TGN/TGAT)",
    "Hawkes or other point-process intensity models",
    "learned attention over relations",
    "graph structure learning",
    "any clinical prediction or risk band",
)


class EventKind(str, Enum):
    """What happened. The log is the graph; everything else is a projection."""

    NODE_OBSERVED = "node_observed"
    NODE_ABSENT = "node_absent"
    NODE_REAPPEARED = "node_reappeared"
    EDGE_OBSERVED = "edge_observed"
    EDGE_ABSENT = "edge_absent"
    EDGE_REAPPEARED = "edge_reappeared"
    EDGE_RETYPED = "edge_retyped"
    EDGE_CONFIDENCE_SHIFTED = "edge_confidence_shifted"
    CATEGORY_REASSIGNED = "category_reassigned"
    IDENTITY_AMBIGUOUS = "identity_ambiguous"
    IDENTITY_UNAVAILABLE = "identity_unavailable"
    CONTRADICTION = "contradiction"


class IdentityRule(str, Enum):
    """How a node on one day was matched to a node on another.

    Ordered from strongest to weakest. The rule that fired is stored on the
    node, so a downstream consumer can filter to exact matches if it needs to
    and does not have to trust the whole ladder.
    """

    EXACT_ID = "exact_id"
    DECLARED_ALIAS = "declared_alias"
    NORMALISED_LABEL = "normalised_label"
    #: Reached the bottom of the ladder without a match. A NEW node, not a
    #: merge. Recorded because "we decided these are different" is a decision.
    NO_MATCH = "no_match"
    #: More than one candidate matched and none dominated, or the only
    #: candidate was already claimed by a different id in the same snapshot.
    #: Also a new node, kept separate.
    AMBIGUOUS = "ambiguous"


#: Weakest last. `TemporalNode.identity_rule` reports the weakest rung any of a
#: node's observations needed, because a node is only as trustworthy across days
#: as its loosest match — a node held together by one label match is not an
#: exact-id node just because most of its days were exact.
IDENTITY_RULE_STRENGTH: Dict[str, int] = {
    IdentityRule.EXACT_ID.value: 0,
    IdentityRule.DECLARED_ALIAS.value: 1,
    IdentityRule.NORMALISED_LABEL.value: 2,
    IdentityRule.AMBIGUOUS.value: 3,
    IdentityRule.NO_MATCH.value: 4,
}


class ContradictionKind(str, Enum):
    """Why two assertions were recorded as incompatible.

    The membership of this enum is an engineering choice over the relation
    vocabulary in `app/ontology/schema.py`, not a clinical finding. It is
    deliberately narrow: only assertions that cannot both hold under the
    vocabulary's own scope notes count. Everything else — a state and its
    absence on different days, a confidence that moved — is change, not
    contradiction, and is already represented as such.
    """

    #: `causes`/`escalates` and `buffers`/`avoids` asserted between the same
    #: ordered pair. One says the source raises the target, the other that it
    #: lowers it.
    OPPOSITE_POLARITY = "opposite_polarity"
    #: A→B and B→A both asserted with a raising relation on the same day.
    MUTUAL_CAUSATION = "mutual_causation"


@dataclass(frozen=True)
class SnapshotRef:
    """Where an observation came from. Never optional.

    Carries the extraction metadata alongside the ids because "which model
    said this" is part of the answer to "why does the graph contain this", and
    a reference that omits it sends the reader back to the database.
    """

    snapshot_id: str
    day: date
    entry_id: Optional[str] = None
    extraction_provider: str = "unknown"
    extraction_model: str = "unknown"
    extractor_version: Optional[str] = None

    def as_dict(self) -> Dict[str, Any]:
        return {
            "snapshot_id": self.snapshot_id,
            "day": self.day.isoformat(),
            "entry_id": self.entry_id,
            "extraction_provider": self.extraction_provider,
            "extraction_model": self.extraction_model,
            "extractor_version": self.extractor_version,
        }


@dataclass(frozen=True)
class ObservationInterval:
    """A run of days during which something was continuously present.

    `observed_days` is every day it actually appeared. `first_day`/`last_day`
    are derived from it, so an interval can never claim a span its observations
    do not cover.
    """

    observed_days: Tuple[date, ...]
    snapshot_ids: Tuple[str, ...]

    @property
    def first_day(self) -> date:
        return self.observed_days[0]

    @property
    def last_day(self) -> date:
        return self.observed_days[-1]

    @property
    def observation_count(self) -> int:
        return len(self.observed_days)

    @property
    def span_days(self) -> int:
        return (self.last_day - self.first_day).days + 1

    @property
    def is_dense(self) -> bool:
        """Whether every calendar day in the span carries an observation.

        A sparse interval is normal — students do not write daily — and the
        distinction matters because `span_days` on a sparse interval is not
        evidence of continuous presence.
        """
        return self.observation_count == self.span_days

    def as_dict(self) -> Dict[str, Any]:
        return {
            "first_day": self.first_day.isoformat(),
            "last_day": self.last_day.isoformat(),
            "observed_days": [day.isoformat() for day in self.observed_days],
            "observation_count": self.observation_count,
            "span_days": self.span_days,
            "is_dense": self.is_dense,
            "snapshot_ids": list(self.snapshot_ids),
        }


@dataclass(frozen=True)
class PersonalObservation:
    """One appearance of a node or edge in one participant's own data.

    Always carries a `SnapshotRef`; deliberately carries no `source_refs`. A
    student's journal is evidence about that student, and the only citation it
    supports is a pointer back to what they wrote. See `CuratedProvenance` for
    the other half, and `test_provenance_separation` for the check that the two
    dataclasses share no field name.
    """

    snapshot: SnapshotRef
    confidence: float
    intensity: Optional[float] = None
    label_as_written: str = ""
    category_as_written: str = ""
    #: Relation type exactly as the extractor emitted it, for edges. Empty for
    #: nodes. Kept as-written so a later retyping does not rewrite the record
    #: of what was said on the day.
    relation_type_as_written: str = ""

    def as_dict(self) -> Dict[str, Any]:
        return {
            "snapshot": self.snapshot.as_dict(),
            "confidence": self.confidence,
            "intensity": self.intensity,
            "label_as_written": self.label_as_written,
            "category_as_written": self.category_as_written,
            "relation_type_as_written": self.relation_type_as_written,
        }


@dataclass(frozen=True)
class CuratedProvenance:
    """Population-level evidence attached to a node or edge.

    Populated from the curated-match annotation produced by
    `app/ontology/provenance.py` (#80) — the seed subgraphs and their source
    registry — or from an explicit curator-supplied table. Never from anything
    a participant wrote.

    Deliberately carries no snapshot, day or entry: a guideline is not an
    observation of this person on this date, and giving it those fields would
    make it interchangeable with `PersonalObservation` at the call site.
    """

    source_refs: Tuple[str, ...] = ()
    subgraph_id: Optional[str] = None
    seed_id: Optional[str] = None
    match_rule: Optional[str] = None
    #: The curated edge's own strength (`association`, `expert_judgement`, …).
    #: `None` on nodes and on unmatched edges.
    evidence_strength: Optional[str] = None
    #: The relation type the curation carries for this pair, when it carries
    #: one. Recorded, never applied — a disagreement with what the extractor
    #: produced is a finding, not an error to correct.
    seed_relation_type: Optional[str] = None
    type_matches_seed: Optional[bool] = None

    @property
    def is_matched(self) -> bool:
        return bool(self.source_refs)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "source_refs": list(self.source_refs),
            "subgraph_id": self.subgraph_id,
            "seed_id": self.seed_id,
            "match_rule": self.match_rule,
            "evidence_strength": self.evidence_strength,
            "seed_relation_type": self.seed_relation_type,
            "type_matches_seed": self.type_matches_seed,
            "is_matched": self.is_matched,
        }


#: The empty curated record. An explicit "checked, nothing matched" rather than
#: `None`, matching the convention in `ontology/provenance.py`: an absent field
#: reads as "not checked", which is a different claim.
UNCURATED = CuratedProvenance()


@dataclass(frozen=True)
class TemporalEvent:
    """An append-only record. The log is authoritative; nodes and edges are
    projections of it. Nothing in this module ever mutates or removes one."""

    kind: EventKind
    day: date
    subject: str
    snapshot: Optional[SnapshotRef] = None
    detail: Dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "kind": self.kind.value,
            "day": self.day.isoformat(),
            "subject": self.subject,
            "snapshot": self.snapshot.as_dict() if self.snapshot else None,
            "detail": dict(self.detail),
        }

    def sort_key(self) -> Tuple[str, str, str, str, str]:
        """A total order over events, so assembly order cannot reach the output.

        The detail dict is folded in as canonical JSON rather than left to
        insertion order: two events that agree on day, kind and subject but
        differ in detail must still order deterministically, or the byte-for-byte
        determinism test passes only by luck.
        """
        return (
            self.day.isoformat(),
            self.kind.value,
            self.subject,
            self.snapshot.snapshot_id if self.snapshot else "",
            json.dumps(self.detail, sort_keys=True, ensure_ascii=False, default=str),
        )


@dataclass(frozen=True)
class CategoryAssignment:
    """A category held over a period.

    A node is not "a State" — it is a thing that was called a State on these
    days. The extractor changes its mind, and #95 requires that a category
    change is not silently applied. Categories are therefore a history, not a
    field.
    """

    category: str
    days: Tuple[date, ...]

    def as_dict(self) -> Dict[str, Any]:
        return {"category": self.category, "days": [day.isoformat() for day in self.days]}


@dataclass(frozen=True)
class TemporalNode:
    node_id: str
    canonical_label: str
    #: Every surface form this node was written as, in first-seen order.
    labels_seen: Tuple[str, ...]
    category_history: Tuple[CategoryAssignment, ...]
    intervals: Tuple[ObservationInterval, ...]
    #: This participant's own observations, one per appearance, in day order.
    personal_observations: Tuple[PersonalObservation, ...]
    #: Population-level evidence. A structurally separate field from
    #: `personal_observations`, holding a structurally different type.
    curated_provenance: CuratedProvenance = UNCURATED
    #: Every rung that was ever used to attach an observation to this node.
    #: The rung that MINTED it is excluded unless it was `AMBIGUOUS` — coming
    #: into existence is not a claim about cross-day identity, whereas
    #: "we declined to merge this" is. A node seen exactly once therefore
    #: reports `(NO_MATCH,)`: nothing has ever been matched to it.
    identity_rules: Tuple[IdentityRule, ...] = (IdentityRule.NO_MATCH,)
    #: Node ids this one might be the same as, unresolved. Never merged.
    ambiguous_with: Tuple[str, ...] = ()

    @property
    def identity_rule(self) -> IdentityRule:
        """The weakest rung this node's identity rests on. See `identity_rules`."""
        if not self.identity_rules:
            return IdentityRule.NO_MATCH
        return max(self.identity_rules, key=lambda rule: IDENTITY_RULE_STRENGTH[rule.value])

    @property
    def category(self) -> str:
        """The most recently assigned category.

        A convenience for callers that need one value. It is deliberately a
        property over the history rather than a stored field, so it cannot drift
        from the history it summarises.
        """
        return self.category_history[-1].category if self.category_history else "State"

    @property
    def has_category_conflict(self) -> bool:
        return len({assignment.category for assignment in self.category_history}) > 1

    @property
    def curated_source_refs(self) -> Tuple[str, ...]:
        return self.curated_provenance.source_refs

    @property
    def first_day(self) -> date:
        return self.intervals[0].first_day

    @property
    def last_day(self) -> date:
        return self.intervals[-1].last_day

    @property
    def recurrence_count(self) -> int:
        """How many separate appearances, i.e. gaps + 1.

        1 means it has been continuously present since first observed. 3 means
        it came back twice.
        """
        return len(self.intervals)

    @property
    def total_observations(self) -> int:
        return sum(interval.observation_count for interval in self.intervals)

    @property
    def source_snapshot_ids(self) -> Tuple[str, ...]:
        """Every snapshot that produced this node, in day order.

        The AC-level traceability handle: from a node, the snapshots; from a
        snapshot ref, the entry and the extractor that wrote it.
        """
        return tuple(observation.snapshot.snapshot_id for observation in self.personal_observations)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "node_id": self.node_id,
            "canonical_label": self.canonical_label,
            "labels_seen": list(self.labels_seen),
            "category": self.category,
            "category_history": [assignment.as_dict() for assignment in self.category_history],
            "has_category_conflict": self.has_category_conflict,
            "intervals": [interval.as_dict() for interval in self.intervals],
            "recurrence_count": self.recurrence_count,
            "total_observations": self.total_observations,
            "source_snapshot_ids": list(self.source_snapshot_ids),
            "personal_observations": [observation.as_dict() for observation in self.personal_observations],
            "curated_provenance": self.curated_provenance.as_dict(),
            "identity_rule": self.identity_rule.value,
            "identity_rules": [rule.value for rule in self.identity_rules],
            "ambiguous_with": list(self.ambiguous_with),
        }


@dataclass(frozen=True)
class TemporalEdge:
    """A typed, DIRECTED edge.

    Direction is preserved because `causes` and `buffers` are not symmetric and
    #96 traverses on it. The existing `traverse_graph` in `analytics/graph_index`
    deliberately discards direction — that is a hop-distance helper, not this.
    """

    source_id: str
    target_id: str
    relation_type: str
    intervals: Tuple[ObservationInterval, ...]
    personal_observations: Tuple[PersonalObservation, ...]
    curated_provenance: CuratedProvenance = UNCURATED
    #: Confidence as observed per day, so a shift is visible rather than
    #: averaged away.
    confidence_by_day: Tuple[Tuple[date, float], ...] = ()

    @property
    def edge_key(self) -> Tuple[str, str, str]:
        return (self.source_id, self.target_id, self.relation_type)

    @property
    def curated_source_refs(self) -> Tuple[str, ...]:
        return self.curated_provenance.source_refs

    @property
    def evidence_strength(self) -> Optional[str]:
        return self.curated_provenance.evidence_strength

    @property
    def recurrence_count(self) -> int:
        return len(self.intervals)

    @property
    def first_day(self) -> date:
        return self.intervals[0].first_day

    @property
    def last_day(self) -> date:
        return self.intervals[-1].last_day

    @property
    def latest_confidence(self) -> Optional[float]:
        return self.confidence_by_day[-1][1] if self.confidence_by_day else None

    @property
    def source_snapshot_ids(self) -> Tuple[str, ...]:
        return tuple(observation.snapshot.snapshot_id for observation in self.personal_observations)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "source_id": self.source_id,
            "target_id": self.target_id,
            "relation_type": self.relation_type,
            "directed": True,
            "intervals": [interval.as_dict() for interval in self.intervals],
            "recurrence_count": self.recurrence_count,
            "confidence_by_day": [[day.isoformat(), value] for day, value in self.confidence_by_day],
            "latest_confidence": self.latest_confidence,
            "evidence_strength": self.evidence_strength,
            "source_snapshot_ids": list(self.source_snapshot_ids),
            "personal_observations": [observation.as_dict() for observation in self.personal_observations],
            "curated_provenance": self.curated_provenance.as_dict(),
        }


@dataclass(frozen=True)
class DiffCrossCheck:
    """What the stored `temporal_diff_json` said, next to what we recomputed.

    The assembler does not consume the stored diff as truth (see the module
    docstring in `assemble.py`). It recomputes and compares, so a disagreement
    surfaces as data instead of as a silent preference for one side.
    """

    snapshot_id: str
    day: date
    diff_basis: Optional[str]
    #: `agreed` | `disagreed` | `not_comparable` | `absent`
    status: str
    reason: str
    disagreements: Tuple[str, ...] = ()

    def as_dict(self) -> Dict[str, Any]:
        return {
            "snapshot_id": self.snapshot_id,
            "day": self.day.isoformat(),
            "diff_basis": self.diff_basis,
            "status": self.status,
            "reason": self.reason,
            "disagreements": list(self.disagreements),
        }


@dataclass(frozen=True)
class AssemblyReport:
    """What the assembler could and could not do.

    Reported rather than logged. A snapshot the assembler had to treat as
    unusable is a hole in every downstream measurement, and a caller that never
    sees the hole will report the measurement as complete.
    """

    snapshots_seen: int = 0
    snapshots_usable: int = 0
    days_covered: Tuple[date, ...] = ()
    legacy_identity_snapshots: Tuple[str, ...] = ()
    dangling_relations: int = 0
    ambiguous_identities: int = 0
    category_conflicts: int = 0
    contradictions: int = 0
    diff_cross_checks: Tuple[DiffCrossCheck, ...] = ()
    warnings: Tuple[str, ...] = ()

    @property
    def identity_is_usable(self) -> bool:
        """Whether cross-day identity means anything for this participant.

        False when any snapshot predates label-derived node ids: those ids are
        array positions, so `node_1` on two days are unrelated observations that
        happened to be listed first. Every temporal claim over such a
        participant is void, and this is the flag that says so.
        """
        return not self.legacy_identity_snapshots

    @property
    def diff_disagreements(self) -> Tuple[DiffCrossCheck, ...]:
        return tuple(check for check in self.diff_cross_checks if check.status == "disagreed")

    def as_dict(self) -> Dict[str, Any]:
        return {
            "snapshots_seen": self.snapshots_seen,
            "snapshots_usable": self.snapshots_usable,
            "days_covered": [day.isoformat() for day in self.days_covered],
            "legacy_identity_snapshots": list(self.legacy_identity_snapshots),
            "identity_is_usable": self.identity_is_usable,
            "dangling_relations": self.dangling_relations,
            "ambiguous_identities": self.ambiguous_identities,
            "category_conflicts": self.category_conflicts,
            "contradictions": self.contradictions,
            "diff_cross_checks": [check.as_dict() for check in self.diff_cross_checks],
            "warnings": list(self.warnings),
        }


@dataclass(frozen=True)
class GraphSlice:
    """The graph as believed at the end of one day, reconstructed from the log.

    Distinct from `nodes_present_on(day)`, which reports only what was literally
    observed on that day. On a day with no entry, `nodes_present_on` is empty and
    a slice still holds whatever was last believed — those are different
    questions and conflating them is how "the student stopped writing" becomes
    "the student got better".
    """

    day: date
    present_node_ids: Tuple[str, ...]
    absent_node_ids: Tuple[str, ...]
    present_edge_keys: Tuple[Tuple[str, str, str], ...]
    absent_edge_keys: Tuple[Tuple[str, str, str], ...]
    #: Label and category as they stood on `day`, not as they stand now. A node
    #: relabelled later must read here as it read then.
    labels: Mapping[str, str] = field(default_factory=dict)
    categories: Mapping[str, str] = field(default_factory=dict)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "day": self.day.isoformat(),
            "present_node_ids": list(self.present_node_ids),
            "absent_node_ids": list(self.absent_node_ids),
            "present_edge_keys": [list(key) for key in self.present_edge_keys],
            "absent_edge_keys": [list(key) for key in self.absent_edge_keys],
            "labels": {key: self.labels[key] for key in sorted(self.labels)},
            "categories": {key: self.categories[key] for key in sorted(self.categories)},
        }


@dataclass(frozen=True)
class ParticipantTemporalGraph:
    participant_id: str
    contract_version: str
    nodes: Dict[str, TemporalNode]
    edges: Dict[Tuple[str, str, str], TemporalEdge]
    events: Tuple[TemporalEvent, ...]
    report: AssemblyReport

    # ---- projections -----------------------------------------------------

    def nodes_present_on(self, day: date) -> List[TemporalNode]:
        """Nodes literally observed on `day`. Empty on a day with no entry."""
        return [
            node
            for node in self._sorted_nodes()
            if any(day in interval.observed_days for interval in node.intervals)
        ]

    def edges_present_on(self, day: date) -> List[TemporalEdge]:
        return [
            edge
            for edge in self._sorted_edges()
            if any(day in interval.observed_days for interval in edge.intervals)
        ]

    def at(self, day: date) -> GraphSlice:
        """The graph as it stood at the end of `day`.

        Replays the log rather than filtering the projection, so this answers
        "what did we believe on this date" including nodes that had already
        disappeared by then and labels that have since changed. A representation
        that could not answer that would not be a temporal graph — it would be a
        current graph with dates on it.
        """
        known_nodes: Dict[str, date] = {}
        known_edges: Dict[Tuple[str, str, str], date] = {}
        absent_nodes: Dict[str, date] = {}
        absent_edges: Dict[Tuple[str, str, str], date] = {}
        labels: Dict[str, str] = {}
        categories: Dict[str, str] = {}

        for event in self.events:
            if event.day > day:
                break
            if event.kind in (EventKind.NODE_OBSERVED, EventKind.NODE_REAPPEARED):
                known_nodes[event.subject] = event.day
                absent_nodes.pop(event.subject, None)
                if event.detail.get("label"):
                    labels[event.subject] = str(event.detail["label"])
                if event.detail.get("category"):
                    categories[event.subject] = str(event.detail["category"])
            elif event.kind is EventKind.NODE_ABSENT:
                absent_nodes[event.subject] = event.day
            elif event.kind is EventKind.CATEGORY_REASSIGNED:
                categories[event.subject] = str(event.detail.get("current_category", ""))
            elif event.kind in (EventKind.EDGE_OBSERVED, EventKind.EDGE_REAPPEARED):
                key = edge_key_from_subject(event.subject)
                known_edges[key] = event.day
                absent_edges.pop(key, None)
            elif event.kind is EventKind.EDGE_ABSENT:
                absent_edges[edge_key_from_subject(event.subject)] = event.day

        return GraphSlice(
            day=day,
            present_node_ids=tuple(sorted(node_id for node_id in known_nodes if node_id not in absent_nodes)),
            absent_node_ids=tuple(sorted(absent_nodes)),
            present_edge_keys=tuple(sorted(key for key in known_edges if key not in absent_edges)),
            absent_edge_keys=tuple(sorted(absent_edges)),
            labels=dict(sorted(labels.items())),
            categories=dict(sorted(categories.items())),
        )

    def recurring_nodes(self, minimum_recurrences: int = 2) -> List[TemporalNode]:
        """Nodes that went away and came back at least `minimum_recurrences` times."""
        return [node for node in self._sorted_nodes() if node.recurrence_count >= minimum_recurrences]

    def outgoing(self, node_id: str, relation_types: Optional[Sequence[str]] = None) -> List[TemporalEdge]:
        allowed = set(relation_types) if relation_types else None
        return [
            edge
            for edge in self._sorted_edges()
            if edge.source_id == node_id and (allowed is None or edge.relation_type in allowed)
        ]

    def incoming(self, node_id: str, relation_types: Optional[Sequence[str]] = None) -> List[TemporalEdge]:
        allowed = set(relation_types) if relation_types else None
        return [
            edge
            for edge in self._sorted_edges()
            if edge.target_id == node_id and (allowed is None or edge.relation_type in allowed)
        ]

    def events_for(self, subject: str) -> List[TemporalEvent]:
        return [event for event in self.events if event.subject == subject]

    def events_of_kind(self, kind: EventKind) -> List[TemporalEvent]:
        return [event for event in self.events if event.kind is kind]

    def provenance_chain(self, subject: str) -> List[Dict[str, Any]]:
        """Every (day, snapshot, entry, extractor) that produced `subject`.

        `subject` is a node id or an `edge_subject(...)`. This is the traceability
        handle #95 asks for: from any element of the graph back to the snapshot
        row and the entry the participant wrote.
        """
        element: Optional[Any] = self.nodes.get(subject)
        if element is None:
            element = self.edges.get(edge_key_from_subject(subject))
        if element is None:
            return []
        return [
            {
                "day": observation.snapshot.day.isoformat(),
                "snapshot_id": observation.snapshot.snapshot_id,
                "entry_id": observation.snapshot.entry_id,
                "extraction_provider": observation.snapshot.extraction_provider,
                "extraction_model": observation.snapshot.extraction_model,
                "extractor_version": observation.snapshot.extractor_version,
            }
            for observation in element.personal_observations
        ]

    # ---- helpers ---------------------------------------------------------

    def _sorted_nodes(self) -> List[TemporalNode]:
        return [self.nodes[key] for key in sorted(self.nodes)]

    def _sorted_edges(self) -> List[TemporalEdge]:
        return [self.edges[key] for key in sorted(self.edges)]

    def as_dict(self) -> Dict[str, Any]:
        """Fully ordered, so two identical inputs serialise byte-identically."""
        return {
            "participant_id": self.participant_id,
            "contract_version": self.contract_version,
            "not_implemented_here": list(NOT_IMPLEMENTED_HERE),
            "nodes": [node.as_dict() for node in self._sorted_nodes()],
            "edges": [edge.as_dict() for edge in self._sorted_edges()],
            "events": [event.as_dict() for event in self.events],
            "report": self.report.as_dict(),
        }

    def as_json(self) -> str:
        """The canonical serialisation the determinism test compares."""
        return json.dumps(self.as_dict(), ensure_ascii=False, sort_keys=True, indent=2)


EDGE_SUBJECT_SEPARATOR = "\u001f"


def edge_subject(source_id: str, target_id: str, relation_type: str) -> str:
    """Flatten an edge key for the event log's `subject` field.

    U+001F is a control character that cannot appear in a label-derived id, so
    this cannot collide the way a printable separator could against a label
    that happens to contain one. Matches the key scheme in
    `frontend/src/lib/temporalDiff.ts`.
    """
    return EDGE_SUBJECT_SEPARATOR.join((source_id, target_id, relation_type))


def edge_key_from_subject(subject: str) -> Tuple[str, str, str]:
    parts = subject.split(EDGE_SUBJECT_SEPARATOR)
    if len(parts) != 3:
        return (subject, "", "")
    return (parts[0], parts[1], parts[2])


def merge_intervals(
    snapshots_by_day: Mapping[date, Sequence[str]],
    all_days: Sequence[date],
    max_gap_days: int = 0,
) -> Tuple[ObservationInterval, ...]:
    """Group an element's observation days into runs, splitting on a gap.

    `snapshots_by_day` is the element's own observations: day -> the snapshot
    ids that carried it that day (more than one when a participant wrote twice).
    `all_days` is every day the assembled window covers, in order.

    `max_gap_days` counts MISSING ENTRY DAYS tolerated inside one interval, not
    calendar days. A student who writes on Monday and Wednesday has no gap in
    their own series even though a calendar day passed; treating calendar
    absence as disappearance would make every weekend look like a remission.

    The default of 0 means consecutive entries continue an interval and one
    skipped entry starts a new one.
    """
    ordered = sorted(snapshots_by_day)
    if not ordered:
        return ()

    position = {day: index for index, day in enumerate(all_days)}

    runs: List[List[date]] = [[ordered[0]]]
    for previous, current in zip(ordered, ordered[1:]):
        missing = position[current] - position[previous] - 1
        if missing > max_gap_days:
            runs.append([current])
        else:
            runs[-1].append(current)

    return tuple(
        ObservationInterval(
            observed_days=tuple(run),
            snapshot_ids=tuple(
                snapshot_id for day in run for snapshot_id in sorted(snapshots_by_day[day])
            ),
        )
        for run in runs
    )
