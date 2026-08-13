"""Filling the layers from what already exists (#101).

Two adapters, and neither of them invents anything:

- `personal_edges_from_graph` reads the participant temporal graph (#95) into
  the personal layer. That graph is already the record of what one participant's
  entries said, with provenance back to the snapshot and the entry, so the
  personal layer is a view of it rather than a second copy.
- `curated_edges_from_seed` reads the curated seed subgraphs
  (`ontology/seed_graph`) into the curated layer, attributing them to the
  curator named in `CURATION_OWNER`.

The seed files carry no reviewer field, which is the honest state of things: they
were written by one person and reviewed by nobody else. Rather than leave
`reviewed_by` blank — which `CuratedEdge` refuses — the loader attributes them
explicitly and `SEED_REVIEW_NOTE` says what that attribution does and does not
mean. A curated layer that claimed a review nobody performed would be worse than
one that admits the review is outstanding.
"""

from __future__ import annotations

from datetime import date
from typing import Any, Dict, List, Optional, Sequence

from ..seed_graph import load_seed_subgraphs
from .layers import (
    GENERAL,
    CuratedEdge,
    ObservationRef,
    PersonalEdge,
)

#: Who the seed subgraphs are attributed to. Not a review — see the module
#: docstring and `SEED_REVIEW_NOTE`.
CURATION_OWNER = "blesc-ontology-seed"

SEED_REVIEW_NOTE = (
    "Attributed to the seed author, not independently reviewed. #101 requires human "
    "review before a CANDIDATE is promoted into this layer; it does not retroactively "
    "supply one for edges that were already here. Clinical review of the seed graph is "
    "tracked separately and this field will name the reviewer when it happens."
)

#: The date the seed files were authored, used as `reviewed_on` so the field is
#: never a stand-in for "now". Reading the clock here would make two loads of the
#: same unchanged file produce two different curated layers.
SEED_AUTHORED_ON = date(2026, 8, 9)


def curated_edges_from_seed(
    subgraph_ids: Optional[Sequence[str]] = None,
) -> List[CuratedEdge]:
    """The curated layer as it stands, from the seed YAML.

    Deterministic: no clock is read and the ordering is by subgraph then by edge,
    so two loads of unchanged files produce identical output.
    """
    subgraphs = load_seed_subgraphs()
    selected = sorted(subgraph_ids) if subgraph_ids else sorted(subgraphs)

    edges: List[CuratedEdge] = []
    for subgraph_id in selected:
        subgraph = subgraphs[subgraph_id]
        for edge in sorted(subgraph.edges, key=lambda item: (item.source, item.target, item.type)):
            edges.append(
                CuratedEdge(
                    edge_key=(edge.source, edge.target, edge.type),
                    evidence_strength=edge.evidence_strength,
                    source_refs=tuple(edge.source_refs),
                    scope_note=edge.scope_note or f"curated in {subgraph_id}",
                    reviewed_by=CURATION_OWNER,
                    reviewed_on=SEED_AUTHORED_ON,
                    subgraph_id=subgraph_id,
                    scope=GENERAL,
                )
            )
    return edges


def personal_edges_from_graph(graph: Any, participant_id: Optional[str] = None) -> List[PersonalEdge]:
    """The personal layer, read out of a `ParticipantTemporalGraph` (#95).

    Takes the graph rather than importing its type, so that this module does not
    make `ontology` depend on `temporal` for a structural reason it does not have.
    Anything exposing `.edges` of temporal edges and `.participant_id` works,
    which is also what makes it testable without assembling a real graph.

    Curated provenance on the temporal edge is deliberately NOT carried across.
    A temporal edge that matched a seed edge is still a record of what one
    participant wrote; the curated claim is a separate object in the curated
    layer, and copying its citations onto the personal edge is precisely the
    merge these layers exist to prevent.
    """
    participant = participant_id or getattr(graph, "participant_id", "unknown")
    edges: List[PersonalEdge] = []

    for key in sorted(graph.edges):
        temporal_edge = graph.edges[key]
        observations = tuple(
            ObservationRef(
                participant_id=participant,
                day=observation.snapshot.day,
                snapshot_id=observation.snapshot.snapshot_id,
                entry_id=observation.snapshot.entry_id,
                note=observation.relation_type_as_written,
            )
            for observation in temporal_edge.personal_observations
        )
        if not observations:
            continue
        edges.append(
            PersonalEdge(
                edge_key=(temporal_edge.source_id, temporal_edge.target_id, temporal_edge.relation_type),
                participant_id=participant,
                observations=observations,
                first_observed=temporal_edge.first_day,
                last_observed=temporal_edge.last_day,
                recurrence_count=temporal_edge.recurrence_count,
            )
        )
    return edges


def seed_attribution() -> Dict[str, Any]:
    """What the curated layer's `reviewed_by` currently means."""
    return {
        "curation_owner": CURATION_OWNER,
        "authored_on": SEED_AUTHORED_ON.isoformat(),
        "review_status": "attributed, not independently reviewed",
        "note": SEED_REVIEW_NOTE,
    }
