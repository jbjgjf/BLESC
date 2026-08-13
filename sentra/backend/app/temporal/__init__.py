"""The participant temporal graph (#95) — the L3 data contract.

A **data model**, not a learned one: no TGN, no TGAT, no Hawkes process, no
learned attention, no clinical prediction. `model.NOT_IMPLEMENTED_HERE` names
what this layer deliberately does not do, and
`sentra/docs/participant_temporal_graph.md` explains why.

    from app.temporal import assemble_participant_graph, snapshot_inputs

    graph = assemble_participant_graph("participant-1", snapshot_inputs(rows))
    graph.at(date(2026, 8, 3))          # what we believed that day
    graph.provenance_chain("眠れない")   # back to the snapshots and entries
"""

from .assemble import (
    CONFIDENCE_SHIFT_THRESHOLD,
    RELATION_POLARITY,
    TRUSTED_DIFF_BASES,
    UNTRUSTED_DIFF_BASES,
    SnapshotInput,
    assemble_participant_graph,
    normalise_label,
)
from .load import snapshot_input_from_mapping, snapshot_input_from_row, snapshot_inputs
from .model import (
    CONTRACT_VERSION,
    NOT_IMPLEMENTED_HERE,
    UNCURATED,
    AssemblyReport,
    CategoryAssignment,
    ContradictionKind,
    CuratedProvenance,
    DiffCrossCheck,
    EventKind,
    GraphSlice,
    IdentityRule,
    ObservationInterval,
    ParticipantTemporalGraph,
    PersonalObservation,
    SnapshotRef,
    TemporalEdge,
    TemporalEvent,
    TemporalNode,
    edge_key_from_subject,
    edge_subject,
    merge_intervals,
)

__all__ = [
    "AssemblyReport",
    "CONFIDENCE_SHIFT_THRESHOLD",
    "CONTRACT_VERSION",
    "CategoryAssignment",
    "ContradictionKind",
    "CuratedProvenance",
    "DiffCrossCheck",
    "EventKind",
    "GraphSlice",
    "IdentityRule",
    "NOT_IMPLEMENTED_HERE",
    "ObservationInterval",
    "ParticipantTemporalGraph",
    "PersonalObservation",
    "RELATION_POLARITY",
    "SnapshotInput",
    "SnapshotRef",
    "TRUSTED_DIFF_BASES",
    "TemporalEdge",
    "TemporalEvent",
    "TemporalNode",
    "UNCURATED",
    "UNTRUSTED_DIFF_BASES",
    "assemble_participant_graph",
    "edge_key_from_subject",
    "edge_subject",
    "merge_intervals",
    "normalise_label",
    "snapshot_input_from_mapping",
    "snapshot_input_from_row",
    "snapshot_inputs",
]
