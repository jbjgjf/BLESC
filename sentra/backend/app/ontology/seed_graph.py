"""Loader for the curated seed subgraphs.

Every `source_ref` is resolved against the registry at load time and an unknown
id is an error, not a warning. A seed file that silently referenced a source
that does not exist would be worse than no seed file: the graph would look
sourced and would not be.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Dict, List

import yaml

from .schema import CATEGORIES, RELATIONS, EvidenceStrength
from .sources import resolve

SEED_DIR = Path(__file__).parent / "seed"


@dataclass(frozen=True)
class SeedNode:
    id: str
    category: str
    label_ja: str
    label_en: str
    source_refs: List[str]


@dataclass(frozen=True)
class SeedEdge:
    source: str
    target: str
    type: str
    evidence_strength: EvidenceStrength
    source_refs: List[str]
    scope_note: str


@dataclass(frozen=True)
class SeedSubgraph:
    subgraph_id: str
    description_en: str
    description_ja: str
    nodes: Dict[str, SeedNode]
    edges: List[SeedEdge]

    @property
    def unsourced_edge_rate(self) -> float:
        """Share of edges resting on judgement rather than cited material.

        Reported rather than minimised. A curated subgraph that quietly padded
        itself with plausible-sounding edges would defeat the point of curating
        one.
        """
        if not self.edges:
            return 0.0
        judged = sum(1 for edge in self.edges if edge.evidence_strength is EvidenceStrength.EXPERT_JUDGEMENT)
        return round(judged / len(self.edges), 6)


class SeedGraphError(ValueError):
    pass


def _load_file(path: Path) -> SeedSubgraph:
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))

    nodes: Dict[str, SeedNode] = {}
    for entry in raw.get("nodes", []):
        if entry["category"] not in CATEGORIES:
            raise SeedGraphError(f"{path.name}: node {entry['id']} has unknown category {entry['category']!r}")
        for source_id in entry["source_refs"]:
            resolve(source_id)
        nodes[entry["id"]] = SeedNode(
            id=entry["id"],
            category=entry["category"],
            label_ja=entry["label_ja"],
            label_en=entry["label_en"],
            source_refs=list(entry["source_refs"]),
        )

    edges: List[SeedEdge] = []
    for entry in raw.get("edges", []):
        if entry["type"] not in RELATIONS:
            raise SeedGraphError(f"{path.name}: edge has unknown relation type {entry['type']!r}")
        for endpoint in ("source", "target"):
            if entry[endpoint] not in nodes:
                raise SeedGraphError(f"{path.name}: edge {endpoint} {entry[endpoint]!r} is not a node in this file")
        for source_id in entry["source_refs"]:
            resolve(source_id)
        if not entry.get("scope_note", "").strip():
            raise SeedGraphError(f"{path.name}: edge {entry['source']}->{entry['target']} has no scope_note")
        edges.append(
            SeedEdge(
                source=entry["source"],
                target=entry["target"],
                type=entry["type"],
                evidence_strength=EvidenceStrength(entry["evidence_strength"]),
                source_refs=list(entry["source_refs"]),
                scope_note=entry["scope_note"],
            )
        )

    return SeedSubgraph(
        subgraph_id=raw["subgraph_id"],
        description_en=raw.get("description_en", ""),
        description_ja=raw.get("description_ja", ""),
        nodes=nodes,
        edges=edges,
    )


@lru_cache(maxsize=1)
def load_seed_subgraphs() -> Dict[str, SeedSubgraph]:
    """Every curated subgraph, keyed by subgraph_id."""
    return {
        subgraph.subgraph_id: subgraph
        for subgraph in (_load_file(path) for path in sorted(SEED_DIR.glob("*.yaml")))
    }
