"""Precision and recall of graph extraction against a labelled gold set.

#7 named "measurable extraction quality" as its first expected outcome, and its
closing comment recorded that nothing measured it: the validator reports how
much of a graph was coerced, and provenance coverage reports how much matched
a seed graph, but neither says whether the nodes and relations are *right*.

`sentra/shared/extraction_gold/gold.json` holds synthetic diary entries with
the nodes and relations a reader would extract, in the ontology's own
vocabulary (`app/ontology/schema.py`, read here and never changed). This module
scores an extractor against it.

**Drafted labels are never confirmatory.** #88 fixed the principle for the
retrieval benchmark: a model that writes both the question and the answer key
produces a benchmark shaped like that model. The gold items were drafted by a
model, so each carries `labelled_by: "draft"` until a person labels it, and
`evaluate()` keeps two sets of numbers apart:

- `confirmatory` — human-labelled items only. `None` while there are none,
  which is reported as "not measured", never as 0.
- `preliminary` — drafted items only, for checking that the tooling works and
  for seeing large effects. Not a quality claim.

Only extractors that call no model are wired in (`EXTRACTORS`): the mock that
runs when there is no API key, and the empty fallback stored when extraction
fails. The mock refuses to run if the adapter is configured for a real model,
so this module cannot make a paid call by accident.
"""

from __future__ import annotations

import json
import unicodedata
from collections import Counter
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

from app.ontology.schema import VALID_CATEGORIES, VALID_RELATIONS

GOLD_DIR = Path(__file__).resolve().parents[3] / "shared" / "extraction_gold"
GOLD_PATH = GOLD_DIR / "gold.json"

LABELLED_BY = ("draft", "human")
#: Undirected in the schema ("Undirected co-occurrence in the same account").
UNDIRECTED = frozenset({"co_occurs"})

Extraction = Mapping[str, Any]
Extractor = Callable[[str], Extraction]


# ── loading and validation ───────────────────────────────────────────────────


def load_gold(path: Path = GOLD_PATH) -> Dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def validate_gold(gold: Mapping[str, Any]) -> List[str]:
    """Problems that would make a score from this file mean something else."""
    errors: List[str] = []
    if gold.get("synthetic") is not True:
        errors.append("gold set must declare synthetic: true")
    seen: set = set()
    for item in gold.get("items", []):
        item_id = item.get("id", "<no id>")
        if item_id in seen:
            errors.append(f"{item_id}: duplicate id")
        seen.add(item_id)
        text = item.get("text", "")
        if not str(text).strip():
            errors.append(f"{item_id}: empty text")
        if not item.get("author"):
            errors.append(f"{item_id}: missing author")
        labelled_by = item.get("labelled_by")
        if labelled_by not in LABELLED_BY:
            errors.append(f"{item_id}: labelled_by must be one of {LABELLED_BY}, got {labelled_by!r}")
        if labelled_by == "human":
            labeller = str(item.get("labeller") or "")
            if not labeller or not item.get("labelled_on"):
                errors.append(f"{item_id}: labelled_by: human needs labeller and labelled_on")
            if labeller.startswith("model:"):
                # The #88 rule, checked rather than trusted: a model's label is a
                # draft whatever field it is written into.
                errors.append(f"{item_id}: a model cannot be the labeller of a human label")
        node_ids: set = set()
        for node in item.get("nodes", []):
            node_id = node.get("id")
            if not node_id or node_id in node_ids:
                errors.append(f"{item_id}: node id {node_id!r} missing or repeated")
            node_ids.add(node_id)
            if node.get("category") not in VALID_CATEGORIES:
                errors.append(f"{item_id}.{node_id}: category {node.get('category')!r} is not in the ontology")
            if not str(node.get("label", "")).strip():
                errors.append(f"{item_id}.{node_id}: empty label")
            evidence = node.get("evidence", "")
            if not evidence or evidence not in text:
                errors.append(f"{item_id}.{node_id}: evidence must be a verbatim span of the text")
            terms = node.get("match_terms", [])
            if not isinstance(terms, list) or any(not str(term).strip() for term in terms):
                errors.append(f"{item_id}.{node_id}: match_terms must be a list of non-empty strings")
        for relation in item.get("relations", []):
            where = f"{item_id}: {relation.get('source')}->{relation.get('target')}"
            if relation.get("source") not in node_ids or relation.get("target") not in node_ids:
                errors.append(f"{where}: endpoint is not a node of this item")
            if relation.get("source") == relation.get("target"):
                errors.append(f"{where}: self-loop")
            if relation.get("type") not in VALID_RELATIONS:
                errors.append(f"{where}: type {relation.get('type')!r} is not in the ontology")
    return errors


# ── matching ─────────────────────────────────────────────────────────────────


def normalize(value: Any) -> str:
    """Width, case and whitespace folded; nothing about meaning."""
    return "".join(unicodedata.normalize("NFKC", str(value or "")).casefold().split())


def node_matches(predicted: Mapping[str, Any], gold_node: Mapping[str, Any]) -> bool:
    """Same category, and the same concept by label or by evidence.

    The label test is containment of a `match_term` — a core word of the
    concept, written by the labeller from the text — because an extractor's
    labels are free text: 「眠れない」 may come back as 「睡眠の乱れ」 or
    「寝つきの悪さ」. The evidence test is overlap of the quoted spans, for an
    extractor that grounds its nodes. Category must match exactly: a test
    extracted as an Event when the labeller saw a Trigger is a miss, which is
    the kind of error this set exists to count.
    """
    if predicted.get("category") != gold_node["category"]:
        return False
    label = normalize(predicted.get("label"))
    if label and (label == normalize(gold_node["label"]) or any(
        normalize(term) in label for term in gold_node.get("match_terms", [])
    )):
        return True
    evidence = normalize(predicted.get("evidence_text"))
    gold_evidence = normalize(gold_node.get("evidence"))
    return bool(evidence and gold_evidence and (evidence in gold_evidence or gold_evidence in evidence))


def align(predicted: Sequence[Mapping[str, Any]], gold_nodes: Sequence[Mapping[str, Any]]) -> Dict[str, str]:
    """A one-to-one predicted→gold node alignment of maximum size.

    One-to-one so that an extractor cannot score twice by emitting the same
    node twice, and maximum so that the score does not depend on the order the
    extractor happened to emit nodes in. Kuhn's augmenting paths; inputs are a
    handful of nodes, so the quadratic cost does not matter.
    """
    candidates = [
        [g for g, gold_node in enumerate(gold_nodes) if node_matches(node, gold_node)]
        for node in predicted
    ]
    owner: Dict[int, int] = {}

    def augment(p: int, visited: set) -> bool:
        for g in candidates[p]:
            if g in visited:
                continue
            visited.add(g)
            if g not in owner or augment(owner[g], visited):
                owner[g] = p
                return True
        return False

    for p in range(len(predicted)):
        augment(p, set())
    return {str(predicted[p]["id"]): str(gold_nodes[g]["id"]) for g, p in owner.items()}


def _relation_key(source: str, target: str, rel_type: Optional[str]) -> Tuple[Any, ...]:
    if rel_type is None or rel_type in UNDIRECTED:
        source, target = sorted((source, target))
    return (source, target, rel_type)


def score_item(item: Mapping[str, Any], extraction: Extraction) -> Dict[str, Any]:
    """Counts for one item. Rates are computed only after summing (micro)."""
    gold_nodes = item.get("nodes", [])
    predicted_nodes = list(extraction.get("nodes", []))
    alignment = align(predicted_nodes, gold_nodes)

    by_category: Dict[str, Counter] = {category: Counter() for category in sorted(VALID_CATEGORIES)}
    for node in gold_nodes:
        by_category[node["category"]]["gold"] += 1
    for node in predicted_nodes:
        if node.get("category") in by_category:
            by_category[node["category"]]["predicted"] += 1
    gold_category = {node["id"]: node["category"] for node in gold_nodes}
    for gold_id in alignment.values():
        by_category[gold_category[gold_id]]["tp"] += 1

    gold_typed = Counter(_relation_key(r["source"], r["target"], r["type"]) for r in item.get("relations", []))
    gold_untyped = Counter(_relation_key(r["source"], r["target"], None) for r in item.get("relations", []))
    typed_tp = untyped_tp = 0
    predicted_relations = list(extraction.get("relations", []))
    for relation in predicted_relations:
        source = alignment.get(str(relation.get("source_id")))
        target = alignment.get(str(relation.get("target_id")))
        if source is None or target is None:
            continue
        typed = _relation_key(source, target, relation.get("type"))
        if gold_typed[typed] > 0:
            gold_typed[typed] -= 1
            typed_tp += 1
        untyped = _relation_key(source, target, None)
        if gold_untyped[untyped] > 0:
            gold_untyped[untyped] -= 1
            untyped_tp += 1

    return {
        "id": item["id"],
        "labelled_by": item["labelled_by"],
        "nodes": {"tp": len(alignment), "predicted": len(predicted_nodes), "gold": len(gold_nodes)},
        "relations": {"tp": typed_tp, "predicted": len(predicted_relations), "gold": len(item.get("relations", []))},
        "relations_untyped": {
            "tp": untyped_tp, "predicted": len(predicted_relations), "gold": len(item.get("relations", [])),
        },
        "by_category": {category: dict(counts) for category, counts in by_category.items()},
    }


# ── aggregation ──────────────────────────────────────────────────────────────


def _prf(tp: int, predicted: int, gold: int) -> Dict[str, Any]:
    # None for an empty denominator. An extractor that emits nothing has no
    # precision; reporting 0 would say it emitted only wrong things.
    precision = round(tp / predicted, 4) if predicted else None
    recall = round(tp / gold, 4) if gold else None
    if precision is None or recall is None:
        f1 = None
    elif precision + recall == 0:
        f1 = 0.0
    else:
        f1 = round(2 * precision * recall / (precision + recall), 4)
    return {"tp": tp, "predicted": predicted, "gold": gold, "precision": precision, "recall": recall, "f1": f1}


def aggregate(scores: Iterable[Mapping[str, Any]]) -> Optional[Dict[str, Any]]:
    scores = list(scores)
    if not scores:
        return None
    totals = {key: Counter() for key in ("nodes", "relations", "relations_untyped")}
    categories: Dict[str, Counter] = {category: Counter() for category in sorted(VALID_CATEGORIES)}
    for score in scores:
        for key in totals:
            totals[key].update(score[key])
        for category, counts in score["by_category"].items():
            categories[category].update(counts)
    return {
        "items": len(scores),
        **{key: _prf(c["tp"], c["predicted"], c["gold"]) for key, c in totals.items()},
        "by_category": {key: _prf(c["tp"], c["predicted"], c["gold"]) for key, c in categories.items()},
    }


def labelling_state(human: int, total: int) -> str:
    """Derived from the items, so it cannot keep saying "drafted" after labelling."""
    if human == 0:
        return "drafted, not human-labelled; no confirmatory number exists (#88)"
    if human < total:
        return (
            f"partially human-labelled: {human}/{total} items. Only those are confirmatory; "
            "the rest are drafts and are reported separately (#88)"
        )
    return f"human-labelled: {total}/{total} items (#88)"


def evaluate(gold: Mapping[str, Any], extractor: Extractor) -> Dict[str, Any]:
    scores = [score_item(item, extractor(item["text"])) for item in gold["items"]]
    human = [score for score in scores if score["labelled_by"] == "human"]
    drafts = [score for score in scores if score["labelled_by"] == "draft"]
    warnings: List[str] = []
    if not human:
        warnings.append(
            "No item is human-labelled. confirmatory is None: extraction quality has not been "
            "measured. preliminary is agreement with a model's draft, not quality (#88)."
        )
    elif len(human) < 30:
        warnings.append(
            f"Only {len(human)} human-labelled items; read the confirmatory numbers as an "
            "early estimate with wide uncertainty."
        )
    return {
        "labelling_status": labelling_state(len(human), len(scores)),
        "human_labelled_count": len(human),
        "drafted_count": len(drafts),
        "confirmatory": aggregate(human),
        "preliminary": aggregate(drafts),
        "per_item": scores,
        "warnings": warnings,
    }


# ── extractors that call no model ────────────────────────────────────────────


def mock_extraction(text: str) -> Extraction:
    """What `/entries` stores when no API key is configured: mock, then validated."""
    from app.ontology.validator import validate_extraction
    from app.services.llm_adapter import llm_adapter

    if not llm_adapter.use_mock:
        raise RuntimeError(
            f"refusing to evaluate: the LLM adapter is configured for provider={llm_adapter.provider!r}. "
            "This evaluator scores the no-model paths only and must never make a paid call. "
            "Set USE_MOCK_LLM=true."
        )
    return validate_extraction(llm_adapter.extract_structure(text))


def fallback_extraction(text: str) -> Extraction:
    """What is stored when extraction fails: an empty graph."""
    from app.ontology.repair import get_fallback_extraction

    return get_fallback_extraction()


EXTRACTORS: Dict[str, Extractor] = {
    "mock": mock_extraction,
    "fallback": fallback_extraction,
}


def _cell(value: Optional[float]) -> str:
    return "—" if value is None else f"{value:.2f}"


def format_report(name: str, result: Mapping[str, Any]) -> str:
    lines = [f"## {name}", "", f"labelling: {result['labelling_status']}", ""]
    for heading, block in (("confirmatory (human-labelled only)", result["confirmatory"]),
                           ("preliminary (drafts only — not a quality claim)", result["preliminary"])):
        lines.append(f"### {heading}")
        if block is None:
            lines += ["", "not measured: no items in this group", ""]
            continue
        lines += [
            "",
            f"items: {block['items']}",
            "",
            "| 対象 | 正解 | 予測 | 一致 | 適合率 | 再現率 | F1 |",
            "| :-- | --: | --: | --: | --: | --: | --: |",
        ]
        rows = [("ノード", block["nodes"]), ("関係（種類まで一致）", block["relations"]),
                ("関係（端点のみ）", block["relations_untyped"])]
        rows += [(f"ノード: {category}", counts) for category, counts in block["by_category"].items()]
        for label, m in rows:
            lines.append(
                f"| {label} | {m['gold']} | {m['predicted']} | {m['tp']} "
                f"| {_cell(m['precision'])} | {_cell(m['recall'])} | {_cell(m['f1'])} |"
            )
        lines.append("")
    lines += [f"- {warning}" for warning in result["warnings"]]
    return "\n".join(lines)
