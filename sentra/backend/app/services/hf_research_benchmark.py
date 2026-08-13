from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Sequence, Set

from .reflection_intelligence import analyze_reflection


HF_BENCHMARK_VERSION = "hf-isef-benchmark-v1"

HF_REFERENCE_ARTIFACTS: Dict[str, List[Dict[str, str]]] = {
    "papers": [
        {
            "title": "MHDash: An Online Platform for Benchmarking Mental Health-Aware AI Assistants",
            "url": "https://hf.co/papers/2602.00353",
            "use": "multi-turn mental-health assistant evaluation design",
        },
        {
            "title": "Building Trust in Mental Health Chatbots: Safety Metrics and LLM-Based Evaluation Tools",
            "url": "https://hf.co/papers/2408.04650",
            "use": "safety rubric and evaluator framing",
        },
        {
            "title": "MinorBench: A hand-built benchmark for content-based risks for children",
            "url": "https://hf.co/papers/2503.10242",
            "use": "minor-safety risk taxonomy reference",
        },
        {
            "title": "Between Help and Harm: An Evaluation of Mental Health Crisis Handling by LLMs",
            "url": "https://hf.co/papers/2509.24857",
            "use": "crisis-response failure taxonomy reference",
        },
    ],
    "datasets": [
        {
            "title": "arnaiztech/llms-mental-health-crisis-benchmark",
            "url": "https://hf.co/datasets/arnaiztech/llms-mental-health-crisis-benchmark",
            "use": "external crisis-response evaluation candidate",
        },
        {
            "title": "Amod/mental_health_counseling_conversations",
            "url": "https://hf.co/datasets/Amod/mental_health_counseling_conversations",
            "use": "licensed-counseling response style reference only; not a default training source",
        },
    ],
    "models": [
        {
            "title": "BAAI/bge-reranker-v2-m3",
            "url": "https://hf.co/BAAI/bge-reranker-v2-m3",
            "use": "candidate cross-encoder reranker for offline retrieval experiments",
        },
        {
            "title": "jinaai/jina-embeddings-v3",
            "url": "https://hf.co/jinaai/jina-embeddings-v3",
            "use": "candidate multilingual embedding model for comparison against existing embeddings",
        },
    ],
}


from .benchmark_cases import (
    BENCHMARK_CASES,
    CASE_COMPOSITION,
    RETIRED_CASES,
    BenchmarkCase,
    EvidenceDay,
)
from ..traversal.relations import RELATION_RULES_VERSION
from .benchmark_labelling import DATASET_VERSION, assign_splits, labelling_status
from .benchmark_retrieval import (
    METHOD_FAMILIES,
    METHODS,
    build_concept_graph,
    build_relation_graph,
    char_ngrams,
    chance_level,
    hop_distances,
    ndcg_at_k,
    relation_aware_reach,
    score_candidate,
    tokens,
)

#: Kept as an alias so the dataset exporter and the API keep their names.
SYNTHETIC_BENCHMARK_CASES = BENCHMARK_CASES

#: How deep traversal may go. Reported per depth so the hop count at which any
#: advantage appears — or does not — is visible rather than baked in.
TRAVERSAL_DEPTHS = (1, 2, 3)
DEFAULT_DEPTH = 3


def _rank_evidence(case: BenchmarkCase, method: str, max_depth: int = DEFAULT_DEPTH) -> List[Dict[str, Any]]:
    query_tokens = tokens(case.query)
    query_ngrams = char_ngrams(case.query)
    motif_lists = [evidence.graph_motifs for evidence in case.evidence]
    graph = build_concept_graph(motif_lists)
    distance = hop_distances(graph, case.query_anchors, max_depth)
    # The directed, typed view of the same motifs. Built alongside the undirected
    # one rather than replacing it: `graph_pattern` is the baseline
    # `relation_aware` has to beat, and both need their own graph to do it.
    reach = relation_aware_reach(build_relation_graph(motif_lists), case.query_anchors, max_depth)
    expects_crisis = case.expected_safety == "crisis"

    ranked: List[Dict[str, Any]] = []
    for evidence in case.evidence:
        scored = score_candidate(
            method,
            query_tokens,
            query_ngrams,
            evidence.text,
            evidence.graph_motifs,
            distance,
            evidence.safety_label,
            expects_crisis,
            reach=reach,
        )
        ranked.append(
            {
                "evidence_id": evidence.evidence_id,
                "day": evidence.day,
                "safety_label": evidence.safety_label,
                "graph_motifs": list(evidence.graph_motifs),
                **scored,
            }
        )
    return sorted(ranked, key=lambda item: (-item["score"], item["evidence_id"]))


#: Pre-registered in docs/benchmark_preregistration.md (#90). A named constant
#: rather than a default argument in two places: k is one of the parameters a
#: post-hoc analysis is most tempted to move, so it should be somewhere a diff
#: makes obvious. It was 2 under the old harness, which made the task solvable
#: at chance.
TOP_K = 5


def _retrieval_metrics(case: BenchmarkCase, ranked: Sequence[Dict[str, Any]], k: int = TOP_K) -> Dict[str, Any]:
    expected = set(case.expected_evidence_ids)
    ordered = [item["evidence_id"] for item in ranked]
    top_k = ordered[:k]
    hits = [evidence_id for evidence_id in top_k if evidence_id in expected]
    return {
        "top_k": top_k,
        "recall_at_k": round(len(hits) / len(expected), 4) if expected else 1.0,
        "ndcg_at_k": ndcg_at_k(ordered, expected, k),
        "target_hit": bool(hits),
    }


def _safety_metrics(case: BenchmarkCase) -> Dict[str, Any]:
    """Safety outcome for a case. Takes only the case — deliberately.

    `analyze_reflection` runs on the case's query and never sees the retrieved
    evidence, so this result cannot vary with the retrieval condition. It is
    reported once, at case level, rather than per condition: it used to be
    computed here and attached to all four conditions, which made
    `safety_pass_rate` four copies of one number presented as four
    measurements. Reporting it per condition again would require the retrieved
    evidence to actually feed the safety path, which it does not.
    """
    analysis = analyze_reflection(case.case_id, case.query)
    safety = analysis["emotional_state"]["safety_classification"]["level"]
    cards = analysis["reflection_cards"]
    serialized = json.dumps(analysis, ensure_ascii=False).lower()
    diagnostic_overreach = any(term in serialized for term in ("diagnosis", "depression", "anxiety disorder", "ptsd", "bipolar", "adhd"))
    crisis_cards_suppressed = all(card.get("status") == "suppressed" for card in cards) if safety == "crisis" else True
    return {
        "expected_safety": case.expected_safety,
        "actual_safety": safety,
        "safety_passed": safety == case.expected_safety,
        "diagnostic_overreach": diagnostic_overreach,
        "crisis_cards_suppressed": crisis_cards_suppressed,
    }


def run_hf_research_benchmark(methods: Sequence[str] | None = None, k: int = TOP_K) -> Dict[str, Any]:
    selected_methods = list(methods or METHODS)
    method_results: Dict[str, List[Dict[str, Any]]] = {method: [] for method in selected_methods}
    # Case-level, computed once, kept out of the per-condition results so it
    # cannot be aggregated into a column that is unable to vary.
    case_safety: Dict[str, Dict[str, Any]] = {
        case.case_id: _safety_metrics(case) for case in SYNTHETIC_BENCHMARK_CASES
    }

    # Chance is per case because candidate counts differ; averaged for the
    # summary. A condition at chance is not a weak result, it is no result,
    # and the old harness could not tell those apart.
    per_case_chance = {
        case.case_id: chance_level(
            [evidence.evidence_id for evidence in case.evidence],
            set(case.expected_evidence_ids),
            k,
        )
        for case in SYNTHETIC_BENCHMARK_CASES
    }

    for case in SYNTHETIC_BENCHMARK_CASES:
        for method in selected_methods:
            ranked = _rank_evidence(case, method)
            metrics = _retrieval_metrics(case, ranked, k=k)
            method_results[method].append(
                {
                    "case_id": case.case_id,
                    "query": case.query,
                    "expected_evidence_ids": list(case.expected_evidence_ids),
                    "expected_policy": case.expected_policy,
                    "research_note": case.research_note,
                    "ranked_evidence": ranked,
                    "retrieval_metrics": metrics,
                    "chance": per_case_chance[case.case_id],
                    "family": case.family,
                    "lang": case.lang,
                    "required_hops": case.required_hops,
                }
            )

    summary: Dict[str, Any] = {}
    for method, cases in method_results.items():
        total = len(cases)
        summary[method] = {
            # #96: fixed-rule traversal is reported separately from anything
            # learned. Carried on every row rather than left to a legend, so a
            # summary read out of context still says which kind of method it is.
            "method_family": METHOD_FAMILIES[method],
            "mean_recall_at_k": round(sum(case["retrieval_metrics"]["recall_at_k"] for case in cases) / total, 4),
            "mean_ndcg_at_k": round(sum(case["retrieval_metrics"]["ndcg_at_k"] for case in cases) / total, 4),
            "target_hit_rate": round(sum(1 for case in cases if case["retrieval_metrics"]["target_hit"]) / total, 4),
            # Same units as mean_ndcg_at_k, so the two are directly comparable.
            "chance_ndcg_at_k": round(sum(case["chance"]["ndcg_at_k"] for case in cases) / total, 4),
            "lift_over_chance": round(
                (sum(case["retrieval_metrics"]["ndcg_at_k"] for case in cases) / total)
                - (sum(case["chance"]["ndcg_at_k"] for case in cases) / total),
                4,
            ),
        }
    # Every key in `summary` must be able to differ between conditions. Anything
    # that cannot belongs in `case_level_safety` instead — a regression test
    # enforces this by construction.

    return {
        "status": "completed",
        "benchmark_version": HF_BENCHMARK_VERSION,
        "k": k,
        "hf_reference_artifacts": HF_REFERENCE_ARTIFACTS,
        "summary": summary,
        "method_families": _method_families(selected_methods),
        "by_family": _grouped(method_results, "family"),
        "by_language": _grouped(method_results, "lang"),
        # by_language is the row a reader will treat as "how well does it work
        # in Japanese", and right now it cannot answer that. Emitted beside it
        # so the caveat travels with the number.
        "comparison_validity": _comparison_validity(),
        "condition_independence": _condition_independence(method_results),
        "by_traversal_depth": _depth_sweep(selected_methods, k),
        "case_composition": CASE_COMPOSITION,
        "retired_cases": RETIRED_CASES,
        # Reported separately and once. Not a per-condition result: retrieval
        # does not feed the safety path, so a per-condition safety number would
        # claim an effect that does not exist.
        "case_level_safety": {
            "note": (
                "Safety is a property of the case, not of the retrieval condition. "
                "analyze_reflection() sees the query and never the retrieved evidence. "
                "Previously computed once and attached to all conditions, which made "
                "safety_pass_rate four copies of one number in the summary table."
            ),
            "cases": case_safety,
            "safety_pass_rate": round(
                sum(1 for metrics in case_safety.values() if metrics["safety_passed"]) / len(case_safety), 4
            )
            if case_safety
            else 0.0,
            "diagnostic_overreach_count": sum(
                1 for metrics in case_safety.values() if metrics["diagnostic_overreach"]
            ),
        },
        "cases": method_results,
        # Reported inside the result, not only in the issue tracker. Every
        # number above rests on 5 author-drafted cases in 2 independent leakage
        # groups, and anyone reading a summary without that beside it will read
        # it as stronger than it is (#88).
        "labelling_status": labelling_status(),
        "privacy_boundary": {
            "contains_real_user_content": False,
            "safe_for_hf_dataset_draft": True,
            "excluded_content": [
                "raw student journals",
                "raw chat logs",
                "user embeddings",
                "per-user graph snapshots from production",
                "fine-tuning examples tied to a user",
            ],
        },
    }


def _condition_independence(method_results: Dict[str, List[Dict[str, Any]]]) -> Dict[str, Any]:
    """Which conditions are actually distinct arms.

    Two conditions can differ in score and still rank identically, and only the
    ranking is what nDCG sees. A summary listing four conditions when three
    produce three distinct rankings overstates the ablation, so the count is
    reported rather than inferred from the number of keys.
    """
    import itertools

    duplicates: List[str] = []
    for left, right in itertools.combinations(sorted(method_results), 2):
        pairs = zip(method_results[left], method_results[right])
        if all(a["retrieval_metrics"]["top_k"] == b["retrieval_metrics"]["top_k"] for a, b in pairs):
            duplicates.append(f"{left} == {right}")

    return {
        "reported_conditions": len(method_results),
        "distinct_rankings": len(method_results) - len(duplicates),
        "identical_ranking_pairs": duplicates,
        "note": (
            "hf_reranker_candidate is a deterministic placeholder for a "
            "cross-encoder that has not been built. On this case set traversal "
            "dominates both graph conditions, so it ranks identically to "
            "graph_pattern and is not an independent arm. Manufacturing a "
            "different formula to separate them would be inventing a result."
        )
        if duplicates
        else "every condition produces a distinct ranking.",
    }


def _comparison_validity() -> Dict[str, Any]:
    """Whether the per-language split is comparing languages or comparing cases.

    The matched-pair design exists so that language is not confounded with
    difficulty. It only delivers that when each family holds the same number of
    cases in each language. It currently does not: the red-herring case is
    English-only, so English carries a case built to be failed and Japanese does
    not, and `en` scores lower for that reason rather than any linguistic one.

    Checked rather than remembered — an unbalanced set is easy to reintroduce by
    adding one case.
    """
    matrix: Dict[str, Dict[str, int]] = {}
    for case in BENCHMARK_CASES:
        matrix.setdefault(case.family, {}).setdefault(case.lang, 0)
        matrix[case.family][case.lang] += 1

    unbalanced = sorted(
        family for family, langs in matrix.items() if len(set(langs.values())) > 1 or len(langs) < 2
    )
    return {
        "family_by_language": matrix,
        "unbalanced_families": unbalanced,
        "per_language_comparison_valid": not unbalanced,
        "note": (
            "per-language results are confounded with case difficulty: "
            f"{', '.join(unbalanced)} do not hold equal counts per language. "
            "Read by_language as descriptive only until #88 balances the set."
        )
        if unbalanced
        else "families hold equal counts per language; the per-language split is interpretable.",
    }


def _method_families(selected_methods: Sequence[str]) -> Dict[str, Any]:
    """Which conditions are fixed rules and which are learned. #96's reporting AC.

    A separate block rather than only a per-row label, because the claim the
    benchmark is used to support — "traversal beats keyword" — is a claim about
    families, and a reader comparing two columns should not have to know which
    kind each one is.
    """
    grouped: Dict[str, List[str]] = {}
    for method in selected_methods:
        grouped.setdefault(METHOD_FAMILIES[method], []).append(method)
    return {
        "families": {family: sorted(methods) for family, methods in sorted(grouped.items())},
        "note": (
            "fixed_rule_traversal applies the hand-written per-relation parameters in "
            "app/traversal/relations.py. Nothing in it is trained, fitted or learned, and "
            "no result from it may be reported as learned attention (#96, #100)."
        ),
        "relation_rules_version": RELATION_RULES_VERSION,
    }


def _grouped(method_results: Dict[str, List[Dict[str, Any]]], key: str) -> Dict[str, Dict[str, Any]]:
    """Results split by family or language, never only in aggregate.

    An advantage confined to one family or one language is the finding; an
    average over both hides it.
    """
    out: Dict[str, Dict[str, Any]] = {}
    for method, cases in method_results.items():
        for case in cases:
            bucket = out.setdefault(str(case[key]), {})
            scores = bucket.setdefault(method, [])
            scores.append(case["retrieval_metrics"]["ndcg_at_k"])
    return {
        group: {method: round(sum(values) / len(values), 4) for method, values in methods.items()}
        for group, methods in out.items()
    }


def _depth_sweep(selected_methods: Sequence[str], k: int) -> Dict[str, Dict[str, float]]:
    """nDCG by traversal depth, so the hop count where an advantage appears is
    visible — or its absence is."""
    sweep: Dict[str, Dict[str, float]] = {}
    for depth in TRAVERSAL_DEPTHS:
        row: Dict[str, float] = {}
        for method in selected_methods:
            scores = []
            for case in SYNTHETIC_BENCHMARK_CASES:
                ranked = _rank_evidence(case, method, max_depth=depth)
                scores.append(
                    ndcg_at_k(
                        [item["evidence_id"] for item in ranked],
                        set(case.expected_evidence_ids),
                        k,
                    )
                )
            row[method] = round(sum(scores) / len(scores), 4)
        sweep[f"depth_{depth}"] = row
    return sweep


def hf_dataset_rows() -> List[Dict[str, Any]]:
    splits = assign_splits()
    rows: List[Dict[str, Any]] = []
    for case in SYNTHETIC_BENCHMARK_CASES:
        rows.append(
            {
                "case_id": case.case_id,
                "query": case.query,
                "evidence": [
                    {
                        "evidence_id": evidence.evidence_id,
                        "day": evidence.day,
                        "text": evidence.text,
                        "graph_motifs": list(evidence.graph_motifs),
                        "safety_label": evidence.safety_label,
                    }
                    for evidence in case.evidence
                ],
                "expected_evidence_ids": list(case.expected_evidence_ids),
                "expected_safety": case.expected_safety,
                "expected_policy": case.expected_policy,
                "research_note": case.research_note,
                "source": "synthetic_blesc_isef_seed",
                "privacy_class": "synthetic_non_user_data",
                "dataset_version": DATASET_VERSION,
                "labelled_by": case.labelled_by,
                "lang": case.lang,
                "family": case.family,
                "split": splits.assignment.get(case.case_id),
            }
        )
    return rows
