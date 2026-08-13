"""Matching a generated graph against the curated seed graphs.

Annotation only. This module never rewrites what the model produced.

The temptation it exists to resist: using the seed graph to "correct" the
extraction would make the output look better and make the benchmark
meaningless, because the graph condition would be scoring against its own
answer key. So a match adds `source_refs` and `evidence_strength` to an element
and changes nothing else — not the category, not the relation type, not the
label.

Unmatched elements are marked `unmatched`, never left without the key. An
absent field reads as "not checked", which is a different claim from "checked
and not found", and the coverage number depends on telling them apart.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Tuple

from .seed_graph import SeedSubgraph, load_seed_subgraphs

#: How a generated element is matched to a curated one.
#:
#: Exact id and normalised label only. Embedding similarity was considered and
#: rejected for now: it needs a stated threshold to be falsifiable, and a
#: threshold chosen without a distribution to look at is a number picked to
#: produce a coverage figure. Deterministic matching under-counts, which is the
#: safer direction for a number being reported as evidence.
MATCH_RULES = ("exact_id", "normalised_label")

_NORMALISE = re.compile(r"[\s　_\-・,.、。]+")


def _normalise(label: str) -> str:
    return _NORMALISE.sub("", label.strip().lower())


def _label_index(subgraphs: Dict[str, SeedSubgraph]) -> Dict[str, Tuple[str, str]]:
    """normalised label or id -> (subgraph_id, node_id)."""
    index: Dict[str, Tuple[str, str]] = {}
    for subgraph_id, subgraph in subgraphs.items():
        for node in subgraph.nodes.values():
            for key in (node.id, node.label_ja, node.label_en):
                normalised = _normalise(key)
                # First writer wins, so a later subgraph cannot silently
                # reassign a label an earlier one already claims.
                index.setdefault(normalised, (subgraph_id, node.id))
    return index


def _match_node(node: Dict[str, Any], index, subgraphs) -> Optional[Dict[str, Any]]:
    for candidate, rule in ((node.get("id", ""), "exact_id"), (node.get("label", ""), "normalised_label")):
        hit = index.get(_normalise(str(candidate)))
        if not hit:
            continue
        subgraph_id, seed_node_id = hit
        seed_node = subgraphs[subgraph_id].nodes[seed_node_id]
        return {
            "matched": True,
            "match_rule": rule,
            "subgraph_id": subgraph_id,
            "seed_id": seed_node_id,
            "source_refs": list(seed_node.source_refs),
        }
    return None


def annotate(nodes: List[Dict[str, Any]], relations: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Attach provenance to whatever matches, and say so where nothing does.

    Mutates the dicts in place by adding a `provenance` key — and only that key.
    Returns the coverage summary.
    """
    subgraphs = load_seed_subgraphs()
    index = _label_index(subgraphs)

    node_matches: Dict[str, Tuple[str, str]] = {}
    for node in nodes:
        match = _match_node(node, index, subgraphs)
        if match:
            node_matches[node["id"]] = (match["subgraph_id"], match["seed_id"])
            node["provenance"] = match
        else:
            node["provenance"] = {"matched": False, "match_rule": None, "source_refs": []}

    for relation in relations:
        source_hit = node_matches.get(relation["source_id"])
        target_hit = node_matches.get(relation["target_id"])
        seed_edge = None
        if source_hit and target_hit and source_hit[0] == target_hit[0]:
            subgraph = subgraphs[source_hit[0]]
            seed_edge = next(
                (
                    edge
                    for edge in subgraph.edges
                    if edge.source == source_hit[1] and edge.target == target_hit[1]
                ),
                None,
            )
        if seed_edge is None:
            # Both endpoints can be curated while the edge between them is not.
            # That is a distinct state from "unknown nodes", and worth seeing:
            # it is the model asserting a relation the curation does not carry.
            relation["provenance"] = {
                "matched": False,
                "endpoints_matched": bool(source_hit and target_hit),
                "source_refs": [],
                "evidence_strength": None,
            }
            continue
        relation["provenance"] = {
            "matched": True,
            "endpoints_matched": True,
            "subgraph_id": source_hit[0],
            "source_refs": list(seed_edge.source_refs),
            # Recorded, never applied. The relation's own `type` stays exactly
            # as the model produced it, including where the curated edge
            # disagrees — that disagreement is a finding, not an error to fix.
            "evidence_strength": seed_edge.evidence_strength.value,
            "seed_relation_type": seed_edge.type,
            "type_matches_seed": seed_edge.type == relation.get("type"),
        }

    return coverage(nodes, relations)


def coverage(nodes: List[Dict[str, Any]], relations: List[Dict[str, Any]]) -> Dict[str, Any]:
    """What share of this graph can be tied back to a published source.

    Coverage is NOT accuracy. A fully sourced graph can still be wrong about a
    student, and an unsourced one can be right. This measures how much of the
    structure the curation recognises, nothing more.
    """
    matched_nodes = [node for node in nodes if node.get("provenance", {}).get("matched")]
    matched_edges = [rel for rel in relations if rel.get("provenance", {}).get("matched")]

    by_strength: Dict[str, int] = {}
    for relation in matched_edges:
        strength = relation["provenance"]["evidence_strength"]
        by_strength[strength] = by_strength.get(strength, 0) + 1

    total = len(nodes) + len(relations)
    return {
        "match_rules": list(MATCH_RULES),
        "nodes_with_source": round(len(matched_nodes) / len(nodes), 6) if nodes else 0.0,
        "edges_with_source": round(len(matched_edges) / len(relations), 6) if relations else 0.0,
        "edges_by_strength": by_strength,
        "unsourced_rate": round(1 - (len(matched_nodes) + len(matched_edges)) / total, 6) if total else 0.0,
        "matched_seed_subgraphs": sorted(
            {node["provenance"]["subgraph_id"] for node in matched_nodes}
        ),
        # Edges the model asserted between two curated nodes that the curation
        # does not carry. Neither an error nor a success — the interesting set.
        "edges_between_curated_nodes_not_in_seed": sum(
            1
            for rel in relations
            if not rel.get("provenance", {}).get("matched")
            and rel.get("provenance", {}).get("endpoints_matched")
        ),
    }
