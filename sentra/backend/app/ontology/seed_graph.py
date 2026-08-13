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
from typing import Dict, List, Tuple

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
    #: Node ids forming a directed path the retrieval benchmark's temporal cases
    #: are built from, or empty where a file declares none.
    #:
    #: Declared in the YAML rather than described in a comment because the
    #: dependency runs the wrong way otherwise: the cases in
    #: `app/services/benchmark_cases.py` assert an answer key that only holds
    #: while these edges exist, and a comment does not fail when they change.
    benchmark_chain: Tuple[str, ...] = ()

    def motif_term(self, node_id: str) -> str:
        """A node in the notation `benchmark_cases.py` writes motifs in.

        The convention is `Category:id-with-spaces`, NOT `Category:label_en` —
        the existing cases already do this (`State:cognitive impairment`, where
        the label is "reduced concentration and memory"), and it is written down
        here because it was previously only inferable by reading both files.
        """
        node = self.nodes[node_id]
        return f"{node.category}:{node.id.replace('_', ' ')}"

    @property
    def chain_motifs(self) -> List[str]:
        """The declared chain rendered as benchmark motif strings, in order.

        So a case author copies the chain rather than retyping it. Empty where
        no chain is declared.
        """
        by_pair = {(edge.source, edge.target): edge for edge in self.edges}
        return [
            f"{self.motif_term(source)} -> {by_pair[(source, target)].type} -> {self.motif_term(target)}"
            for source, target in zip(self.benchmark_chain, self.benchmark_chain[1:])
        ]

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

    chain = tuple(raw.get("benchmark_chain") or ())
    if chain:
        _validate_chain(path, chain, nodes, edges)

    return SeedSubgraph(
        subgraph_id=raw["subgraph_id"],
        description_en=raw.get("description_en", ""),
        description_ja=raw.get("description_ja", ""),
        nodes=nodes,
        edges=edges,
        benchmark_chain=chain,
    )


def _validate_chain(path: Path, chain: Tuple[str, ...], nodes: Dict[str, SeedNode], edges: List[SeedEdge]) -> None:
    """A declared chain must be a real directed path through this file.

    Checked at load time for the same reason source ids are: a chain that named
    a step no edge carries would let the benchmark cases built on it look
    grounded in the curation while resting on nothing.
    """
    if len(chain) < 3:
        raise SeedGraphError(
            f"{path.name}: benchmark_chain has {len(chain)} nodes; a chain shorter than three is not multi-hop"
        )
    pairs = {(edge.source, edge.target) for edge in edges}
    for source, target in zip(chain, chain[1:]):
        for node_id in (source, target):
            if node_id not in nodes:
                raise SeedGraphError(f"{path.name}: benchmark_chain names {node_id!r}, which is not a node in this file")
        if (source, target) not in pairs:
            raise SeedGraphError(
                f"{path.name}: benchmark_chain step {source} -> {target} is not an edge in this file"
            )


@lru_cache(maxsize=1)
def load_seed_subgraphs() -> Dict[str, SeedSubgraph]:
    """Every curated subgraph, keyed by subgraph_id."""
    return {
        subgraph.subgraph_id: subgraph
        for subgraph in (_load_file(path) for path in sorted(SEED_DIR.glob("*.yaml")))
    }
