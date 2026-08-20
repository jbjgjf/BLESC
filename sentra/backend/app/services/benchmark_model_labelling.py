"""GPT-5.6 Sol case drafting and model adjudication for issue #88.

This is deliberately *model* labelling, never human labelling.  The three
independent judgements share a model family but no response context.  A fourth
call sees only disagreement data and adjudicates it.  The resulting dataset can
support a synthetic feasibility result; it must not open the human-label gate
used by the graph-walk training experiment.
"""

from __future__ import annotations

import json
import math
import os
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from statistics import fmean
from typing import Any, Callable, Dict, Iterable, List, Mapping, Sequence

from openai import OpenAI


MODEL = "gpt-5.6-sol"
REASONING_EFFORT = "max"
PROMPT_VERSION = "model-labelling-v1"
DATASET_VERSION = "1.0.0-model"
LABELLED_BY = f"model:{MODEL}"
HARD_STOP_USD = 27.0
DECLARED_BUDGET_USD = 30.0
INPUT_USD_PER_MILLION = 5.0
CACHED_INPUT_USD_PER_MILLION = 0.5
OUTPUT_USD_PER_MILLION = 30.0
JUDGEMENT_RUNS = 3

BACKEND_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_ARTIFACT = BACKEND_ROOT / "app" / "services" / "data" / "benchmark_model_cases.json"
DEFAULT_LEDGER = BACKEND_ROOT / "test_exports" / "benchmark_model_cost.json"
DEFAULT_CHECKPOINT = BACKEND_ROOT / "test_exports" / "benchmark_model_checkpoint.json"

FAMILY_QUOTAS = {
    "multi_day_chain": 24,
    "vocabulary_disjoint": 24,
    "low_frequency_high_severity": 16,
    "heavy_decoy": 16,
}

PAIR_SPECS = (
    ("multi_day_chain", 12),
    ("vocabulary_disjoint", 12),
    ("low_frequency_high_severity", 8),
    ("heavy_decoy", 8),
)

RELATIONS = frozenset({"causes", "escalates", "precedes", "co_occurs", "buffers", "avoids"})
LANGUAGES = frozenset({"ja", "en"})


CASE_BLUEPRINT_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "pairs": {
            "type": "array",
            "minItems": 2,
            "maxItems": 2,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "pair_id": {"type": "string"},
                    "family": {"type": "string", "enum": list(FAMILY_QUOTAS)},
                    "anchor": {"type": "string"},
                    "required_hops": {"type": "integer", "minimum": 0, "maximum": 3},
                    "expected_safety": {"type": "string", "enum": ["normal", "elevated", "crisis"]},
                    "cases": {
                        "type": "array",
                        "minItems": 2,
                        "maxItems": 2,
                        "items": {
                            "type": "object",
                            "additionalProperties": False,
                            "properties": {
                                "lang": {"type": "string", "enum": ["ja", "en"]},
                                "query": {"type": "string"},
                                "evidence": {
                                    "type": "array",
                                    "minItems": 6,
                                    "maxItems": 8,
                                    "items": {
                                        "type": "object",
                                        "additionalProperties": False,
                                        "properties": {
                                            "text": {"type": "string"},
                                            "motif": {"type": "string"},
                                            "intended_role": {"type": "string", "enum": ["target", "decoy"]},
                                        },
                                        "required": ["text", "motif", "intended_role"],
                                    },
                                },
                            },
                            "required": ["lang", "query", "evidence"],
                        },
                    },
                },
                "required": ["pair_id", "family", "anchor", "required_hops", "expected_safety", "cases"],
            },
        }
    },
    "required": ["pairs"],
}


JUDGEMENT_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "judgements": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "case_id": {"type": "string"},
                    "selected_evidence_ids": {"type": "array", "items": {"type": "string"}},
                    "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                    "reason": {"type": "string", "maxLength": 240},
                },
                "required": ["case_id", "selected_evidence_ids", "confidence", "reason"],
            },
        }
    },
    "required": ["judgements"],
}


@dataclass(frozen=True)
class Usage:
    input_tokens: int
    cached_input_tokens: int
    output_tokens: int

    @property
    def cost_usd(self) -> float:
        uncached = max(0, self.input_tokens - self.cached_input_tokens)
        return (
            uncached * INPUT_USD_PER_MILLION
            + self.cached_input_tokens * CACHED_INPUT_USD_PER_MILLION
            + self.output_tokens * OUTPUT_USD_PER_MILLION
        ) / 1_000_000


class BudgetExceeded(RuntimeError):
    pass


class CostLedger:
    def __init__(self, path: Path = DEFAULT_LEDGER, hard_stop_usd: float = HARD_STOP_USD):
        self.path = path
        self.hard_stop_usd = hard_stop_usd
        self.calls: List[Dict[str, Any]] = []
        if path.exists():
            payload = json.loads(path.read_text())
            self.calls = list(payload.get("calls", []))

    @property
    def total_usd(self) -> float:
        return sum(float(call["cost_usd"]) for call in self.calls)

    def reserve(self, *, estimated_input_tokens: int, max_output_tokens: int) -> None:
        projected = (
            estimated_input_tokens * INPUT_USD_PER_MILLION
            + max_output_tokens * OUTPUT_USD_PER_MILLION
        ) / 1_000_000
        if self.total_usd + projected > self.hard_stop_usd:
            raise BudgetExceeded(
                f"projected total ${self.total_usd + projected:.4f} exceeds "
                f"the ${self.hard_stop_usd:.2f} local hard stop"
            )

    def record(self, *, purpose: str, usage: Usage, response_id: str | None) -> None:
        self.calls.append(
            {
                "purpose": purpose,
                "response_id": response_id,
                "model": MODEL,
                "input_tokens": usage.input_tokens,
                "cached_input_tokens": usage.cached_input_tokens,
                "output_tokens": usage.output_tokens,
                "cost_usd": round(usage.cost_usd, 8),
                "recorded_at": datetime.now(timezone.utc).isoformat(),
            }
        )
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(
            json.dumps(
                {
                    "hard_stop_usd": self.hard_stop_usd,
                    "declared_budget_usd": DECLARED_BUDGET_USD,
                    "total_usd": round(self.total_usd, 8),
                    "calls": self.calls,
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n"
        )


def _usage(response: Any) -> Usage:
    usage = getattr(response, "usage", None)
    details = getattr(usage, "input_tokens_details", None)
    return Usage(
        input_tokens=int(getattr(usage, "input_tokens", 0) or 0),
        cached_input_tokens=int(getattr(details, "cached_tokens", 0) or 0),
        output_tokens=int(getattr(usage, "output_tokens", 0) or 0),
    )


def _estimate_tokens(text: str) -> int:
    # Conservative for mixed Japanese/English input; used only to fail closed
    # before a request. The API's returned usage is the billing record.
    return max(1, math.ceil(len(text) / 2))


def structured_response(
    client: OpenAI,
    ledger: CostLedger,
    *,
    purpose: str,
    instructions: str,
    input_text: str,
    schema_name: str,
    schema: Mapping[str, Any],
    max_output_tokens: int,
) -> Dict[str, Any]:
    ledger.reserve(
        estimated_input_tokens=_estimate_tokens(instructions + input_text),
        max_output_tokens=max_output_tokens,
    )
    response = client.responses.create(
        model=MODEL,
        reasoning={"effort": REASONING_EFFORT},
        instructions=instructions,
        input=input_text,
        max_output_tokens=max_output_tokens,
        store=False,
        text={
            "format": {
                "type": "json_schema",
                "name": schema_name,
                "strict": True,
                "schema": dict(schema),
            }
        },
    )
    ledger.record(purpose=purpose, usage=_usage(response), response_id=getattr(response, "id", None))
    if getattr(response, "status", None) != "completed":
        details = getattr(response, "incomplete_details", None)
        raise RuntimeError(f"{purpose}: response was not completed ({details})")
    raw = getattr(response, "output_text", None)
    if not raw:
        raise RuntimeError(f"{purpose}: model returned no output_text")
    return json.loads(raw)


def generation_prompt(family: str, pair_indexes: Sequence[int]) -> str:
    return json.dumps(
        {
            "task": "Draft matched Japanese/English synthetic retrieval benchmark pairs.",
            "family": family,
            "pair_indexes": list(pair_indexes),
            "requirements": [
                "Return exactly two pairs and exactly ja/en cases in each pair.",
                "Use 6-8 seed candidates per case, with 2-4 intended targets and at least 4 decoys.",
                "Never use or imitate real student content; every sentence is synthetic.",
                "Use natural adolescent language, not translationese.",
                "The ja/en cases must express the same facts and graph motifs at matched difficulty.",
                "Targets must answer the query by paraphrase or graph chain; decoys must be plausible and lexically tempting.",
                "Use motif form Category:label -> relation -> Category:label.",
                f"Relations must be one of {sorted(RELATIONS)}.",
                "Do not put target/decoy hints into text or motif labels.",
                "Avoid diagnosis and causal certainty in natural-language text.",
            ],
            "family_rules": {
                "multi_day_chain": "Targets collectively form a 2-3 hop chain; no single target answers alone.",
                "vocabulary_disjoint": "Targets paraphrase the query without sharing its content words.",
                "low_frequency_high_severity": "Use a rare, safety-relevant pattern; do not provide crisis advice or diagnoses.",
                "heavy_decoy": "Every decoy should reuse query wording while targets are paraphrases or graph-linked.",
            }[family],
        },
        ensure_ascii=False,
    )


GENERATION_INSTRUCTIONS = """You design adversarial synthetic retrieval evals for a Japanese school-support product.
Never use real people or real user data. Produce only the requested schema. `intended_role` is authoring metadata and
will be removed before judging. It is not accepted as ground truth: three blind model judgements determine labels."""

JUDGE_INSTRUCTIONS = """You are an independent evidence relevance annotator. For each case, select every candidate
that helps answer its query. A candidate may help by paraphrase or by forming a meaningful graph chain. Select none
when appropriate. You cannot see author intent, family, expected labels, or other judges. Return only schema-valid data."""

ADJUDICATOR_INSTRUCTIONS = """You adjudicate disagreements between three independent evidence annotations.
Use the case text and graph motifs as primary evidence. The prior selections are votes, not an answer key. Return the
best final evidence set, a confidence, and a short rationale. Return only schema-valid data."""


def _neutral_id(pair_number: int, lang: str, item_number: int) -> str:
    return f"p{pair_number:02d}-{lang}-e{item_number:02d}"


def _expanded_decoy_text(text: str, lang: str, variant: int) -> str:
    if lang == "ja":
        wrappers = (
            lambda value: f"放課後、{value}",
            lambda value: f"今日も{value}",
            lambda value: f"{value}という一日だった。",
        )
    else:
        wrappers = (
            lambda value: f"After school, {value[0].lower() + value[1:]}",
            lambda value: f"Again today, {value[0].lower() + value[1:]}",
            lambda value: f"It was one of those days: {value[0].lower() + value[1:]}",
        )
    return wrappers[variant % len(wrappers)](text)


def normalise_pair(raw: Mapping[str, Any], *, pair_number: int, family: str) -> List[Dict[str, Any]]:
    if raw.get("family") != family:
        raise ValueError(f"pair {pair_number}: expected family {family!r}")
    cases = list(raw.get("cases", []))
    if {case.get("lang") for case in cases} != LANGUAGES:
        raise ValueError(f"pair {pair_number}: must contain one ja and one en case")
    normalised: List[Dict[str, Any]] = []
    for case in cases:
        lang = str(case["lang"])
        evidence = []
        intended = []
        seed_items = list(case["evidence"])
        targets = [item for item in seed_items if item["intended_role"] == "target"]
        decoys = [item for item in seed_items if item["intended_role"] == "decoy"]
        if not 2 <= len(targets) <= 4 or len(decoys) < 4:
            raise ValueError(f"pair {pair_number} {lang}: requires 2-4 targets and at least 4 decoys")
        expanded = list(seed_items)
        variant = 0
        while len(expanded) < 20:
            source = decoys[variant % len(decoys)]
            expanded.append(
                {
                    **source,
                    "text": _expanded_decoy_text(str(source["text"]).strip(), lang, variant),
                }
            )
            variant += 1
        for index, item in enumerate(expanded, start=1):
            evidence_id = _neutral_id(pair_number, lang, index)
            role = str(item["intended_role"])
            if role == "target":
                intended.append(evidence_id)
            evidence.append(
                {
                    "evidence_id": evidence_id,
                    "day": f"2026-06-{((pair_number * 3 + index) % 28) + 1:02d}",
                    "text": str(item["text"]).strip(),
                    "graph_motifs": [str(item["motif"]).strip()],
                    "safety_label": "normal",
                }
            )
        case_id = f"confirmatory-{pair_number:02d}-{lang}"
        normalised.append(
            {
                "case_id": case_id,
                "pair_id": f"pair-{pair_number:02d}",
                "query": str(case["query"]).strip(),
                "query_anchors": [str(raw["anchor"]).strip()],
                "evidence": evidence,
                "author_intended_evidence_ids": intended,
                "expected_evidence_ids": [],
                "expected_safety": str(raw["expected_safety"]),
                "expected_policy": "surface relevant observations without diagnosis or causal assertion",
                "research_note": "GPT-5.6 Sol drafted synthetic case; blind model adjudication supplies labels.",
                "family": family,
                "lang": lang,
                "required_hops": int(raw["required_hops"]),
                "labelled_by": LABELLED_BY,
            }
        )
    return sorted(normalised, key=lambda case: case["lang"])


def validate_cases(cases: Sequence[Mapping[str, Any]], *, expected_count: int | None = None) -> None:
    if expected_count is not None and len(cases) != expected_count:
        raise ValueError(f"expected {expected_count} cases, found {len(cases)}")
    ids = [str(case["case_id"]) for case in cases]
    if len(ids) != len(set(ids)):
        raise ValueError("case ids are not unique")
    evidence_ids: set[str] = set()
    for case in cases:
        if case["lang"] not in LANGUAGES:
            raise ValueError(f"{case['case_id']}: invalid language")
        if case["family"] not in FAMILY_QUOTAS:
            raise ValueError(f"{case['case_id']}: invalid family")
        count = len(case["evidence"])
        if not 20 <= count <= 40:
            raise ValueError(f"{case['case_id']}: {count} candidates outside 20-40")
        local_ids = {item["evidence_id"] for item in case["evidence"]}
        if len(local_ids) != count:
            raise ValueError(f"{case['case_id']}: duplicate evidence ids")
        if evidence_ids & local_ids:
            raise ValueError(f"{case['case_id']}: evidence ids reused across cases")
        evidence_ids |= local_ids
        for item in case["evidence"]:
            motif = item["graph_motifs"][0]
            if not any(f" -> {relation} -> " in motif for relation in RELATIONS):
                raise ValueError(f"{case['case_id']}: malformed or unknown motif {motif!r}")


def blind_case(case: Mapping[str, Any]) -> Dict[str, Any]:
    return {
        "case_id": case["case_id"],
        "lang": case["lang"],
        "query": case["query"],
        "query_anchors": case["query_anchors"],
        "instruction": "Select every candidate that helps answer the query, including links in a graph chain.",
        "candidates": [
            {
                "evidence_id": item["evidence_id"],
                "day": item["day"],
                "text": item["text"],
                "graph_motifs": item["graph_motifs"],
            }
            for item in case["evidence"]
        ],
    }


def validate_judgements(cases: Sequence[Mapping[str, Any]], result: Mapping[str, Any]) -> Dict[str, Dict[str, Any]]:
    expected = {str(case["case_id"]): {item["evidence_id"] for item in case["evidence"]} for case in cases}
    rows = {str(row["case_id"]): dict(row) for row in result.get("judgements", [])}
    if set(rows) != set(expected):
        raise ValueError(f"judgement case ids differ: expected {sorted(expected)}, found {sorted(rows)}")
    for case_id, row in rows.items():
        selected = list(row["selected_evidence_ids"])
        if len(selected) != len(set(selected)) or not set(selected) <= expected[case_id]:
            raise ValueError(f"{case_id}: invalid selected evidence ids")
    return rows


def _jaccard(left: Iterable[str], right: Iterable[str]) -> float:
    a, b = set(left), set(right)
    return len(a & b) / len(a | b) if a or b else 1.0


def agreement_report(cases: Sequence[Mapping[str, Any]], runs: Sequence[Mapping[str, Mapping[str, Any]]]) -> Dict[str, Any]:
    unanimous = 0
    candidate_agreements: List[float] = []
    case_jaccards: List[float] = []
    disagreements: List[str] = []
    for case in cases:
        case_id = str(case["case_id"])
        picks = [set(run[case_id]["selected_evidence_ids"]) for run in runs]
        if picks[0] == picks[1] == picks[2]:
            unanimous += 1
        else:
            disagreements.append(case_id)
        universe = [item["evidence_id"] for item in case["evidence"]]
        for evidence_id in universe:
            votes = [evidence_id in selected for selected in picks]
            candidate_agreements.append(max(votes.count(True), votes.count(False)) / len(votes))
        case_jaccards.extend((_jaccard(picks[0], picks[1]), _jaccard(picks[0], picks[2]), _jaccard(picks[1], picks[2])))
    return {
        "same_model_repeated_judgement": True,
        "judge_model": MODEL,
        "judge_runs": len(runs),
        "case_count": len(cases),
        "unanimous_case_count": unanimous,
        "unanimous_case_rate": round(unanimous / len(cases), 4) if cases else 0.0,
        "candidate_level_majority_agreement": round(fmean(candidate_agreements), 4) if candidate_agreements else 0.0,
        "mean_pairwise_case_jaccard": round(fmean(case_jaccards), 4) if case_jaccards else 0.0,
        "disagreement_case_ids": disagreements,
        "adjudication_count": len(disagreements),
        "cohens_kappa": None,
        "note": "Not inter-rater reliability: all judgements use the same model and prompt version.",
    }


def load_artifact(path: Path = DEFAULT_ARTIFACT) -> Dict[str, Any]:
    return json.loads(path.read_text())


def artifact_cases(path: Path = DEFAULT_ARTIFACT) -> List[Dict[str, Any]]:
    if not path.exists():
        return []
    return list(load_artifact(path).get("cases", []))


def build_client() -> OpenAI:
    if not os.getenv("OPENAI_API_KEY"):
        raise RuntimeError("OPENAI_API_KEY is required; load .env.benchmark.local without printing it")
    return OpenAI(api_key=os.environ["OPENAI_API_KEY"])


def generate_cases(
    client: OpenAI,
    ledger: CostLedger,
    *,
    pair_limit: int = 40,
    initial_cases: Sequence[Mapping[str, Any]] = (),
    on_progress: Callable[[List[Dict[str, Any]]], None] | None = None,
) -> List[Dict[str, Any]]:
    cases: List[Dict[str, Any]] = [dict(case) for case in initial_cases]
    completed_pairs = {str(case["pair_id"]) for case in cases}
    pair_number = 1
    for family, family_pairs in PAIR_SPECS:
        for start in range(0, family_pairs, 2):
            if pair_number > pair_limit:
                break
            indexes = [pair_number, min(pair_number + 1, pair_limit)]
            indexes = sorted(set(indexes))
            if len(indexes) < 2:
                break
            pair_ids = {f"pair-{index:02d}" for index in indexes}
            if pair_ids <= completed_pairs:
                pair_number += 2
                continue
            payload = structured_response(
                client,
                ledger,
                purpose=f"generate:{family}:{indexes[0]}-{indexes[-1]}",
                instructions=GENERATION_INSTRUCTIONS,
                input_text=generation_prompt(family, indexes),
                schema_name="blesc_benchmark_pairs",
                schema=CASE_BLUEPRINT_SCHEMA,
                max_output_tokens=18000,
            )
            pairs = list(payload["pairs"])
            if len(pairs) != 2:
                raise ValueError("generation call did not return exactly two pairs")
            for raw, index in zip(pairs, indexes):
                cases.extend(normalise_pair(raw, pair_number=index, family=family))
                completed_pairs.add(f"pair-{index:02d}")
            if on_progress:
                on_progress(cases)
            pair_number += 2
        if pair_number > pair_limit:
            break
    validate_cases(cases, expected_count=pair_limit * 2)
    return cases


def judge_cases(
    client: OpenAI,
    ledger: CostLedger,
    cases: Sequence[Mapping[str, Any]],
    *,
    batch_size: int = 5,
    initial_runs: Sequence[Mapping[str, Mapping[str, Any]]] = (),
    on_progress: Callable[[List[Dict[str, Dict[str, Any]]]], None] | None = None,
) -> List[Dict[str, Dict[str, Any]]]:
    runs: List[Dict[str, Dict[str, Any]]] = [
        {str(case_id): dict(row) for case_id, row in run.items()} for run in initial_runs
    ]
    while len(runs) < JUDGEMENT_RUNS:
        runs.append({})
    for run_number in range(1, JUDGEMENT_RUNS + 1):
        run = runs[run_number - 1]
        for start in range(0, len(cases), batch_size):
            batch = cases[start : start + batch_size]
            if all(str(case["case_id"]) in run for case in batch):
                continue
            payload = structured_response(
                client,
                ledger,
                purpose=f"judge:{run_number}:{start}-{start + len(batch) - 1}",
                instructions=JUDGE_INSTRUCTIONS,
                input_text=json.dumps({"cases": [blind_case(case) for case in batch]}, ensure_ascii=False),
                schema_name="blesc_evidence_judgements",
                schema=JUDGEMENT_SCHEMA,
                max_output_tokens=6000,
            )
            run.update(validate_judgements(batch, payload))
            if on_progress:
                on_progress(runs)
    return runs


def adjudicate(
    client: OpenAI,
    ledger: CostLedger,
    cases: Sequence[Mapping[str, Any]],
    runs: Sequence[Mapping[str, Mapping[str, Any]]],
) -> tuple[Dict[str, Dict[str, Any]], Dict[str, Any]]:
    report = agreement_report(cases, runs)
    by_id = {str(case["case_id"]): case for case in cases}
    final: Dict[str, Dict[str, Any]] = {}
    for case_id in by_id:
        picks = [tuple(run[case_id]["selected_evidence_ids"]) for run in runs]
        if picks[0] == picks[1] == picks[2]:
            final[case_id] = dict(runs[0][case_id])

    disagreements = [by_id[case_id] for case_id in report["disagreement_case_ids"]]
    for start in range(0, len(disagreements), 5):
        batch = disagreements[start : start + 5]
        input_rows = []
        for case in batch:
            case_id = str(case["case_id"])
            input_rows.append(
                {
                    "case": blind_case(case),
                    "independent_selections": [list(run[case_id]["selected_evidence_ids"]) for run in runs],
                }
            )
        payload = structured_response(
            client,
            ledger,
            purpose=f"adjudicate:{start}-{start + len(batch) - 1}",
            instructions=ADJUDICATOR_INSTRUCTIONS,
            input_text=json.dumps({"disagreements": input_rows}, ensure_ascii=False),
            schema_name="blesc_adjudicated_judgements",
            schema=JUDGEMENT_SCHEMA,
            max_output_tokens=6000,
        )
        final.update(validate_judgements(batch, payload))
    return final, report


def build_artifact(
    cases: Sequence[Mapping[str, Any]],
    runs: Sequence[Mapping[str, Mapping[str, Any]]],
    final: Mapping[str, Mapping[str, Any]],
    report: Mapping[str, Any],
    ledger: CostLedger,
) -> Dict[str, Any]:
    labelled = []
    for case in cases:
        row = dict(case)
        case_id = str(case["case_id"])
        row["expected_evidence_ids"] = list(final[case_id]["selected_evidence_ids"])
        row["model_labelling"] = {
            "model": MODEL,
            "reasoning_effort": REASONING_EFFORT,
            "prompt_version": PROMPT_VERSION,
            "independent_judgements": [dict(run[case_id]) for run in runs],
            "final_judgement": dict(final[case_id]),
            "adjudicated": case_id in report["disagreement_case_ids"],
        }
        labelled.append(row)
    validate_cases(labelled, expected_count=80)
    for row in labelled:
        candidates = {item["evidence_id"] for item in row["evidence"]}
        if not row["expected_evidence_ids"] or not set(row["expected_evidence_ids"]) <= candidates:
            raise ValueError(f"{row['case_id']}: final label is empty or invalid")
    return {
        "metadata": {
            "name": "blesc-synthetic-retrieval-benchmark",
            "version": DATASET_VERSION,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "licence": "CC BY 4.0",
            "author": "BLESC / Sentra research with GPT-5.6 Sol drafting",
            "reviewer": f"same-model repeated judgement and adjudication: {MODEL}",
            "privacy_class": "synthetic_non_user_data",
            "contains_real_user_content": False,
            "labelling_status": "model-adjudicated; not human-labelled",
            "labelled_by": LABELLED_BY,
            "model": MODEL,
            "reasoning_effort": REASONING_EFFORT,
            "prompt_version": PROMPT_VERSION,
            "cost_usd": round(ledger.total_usd, 6),
            "cost_hard_stop_usd": HARD_STOP_USD,
        },
        "composition": {**FAMILY_QUOTAS, "ja": 40, "en": 40, "total": 80},
        "agreement": dict(report),
        "cases": labelled,
    }


def save_artifact(payload: Mapping[str, Any], path: Path = DEFAULT_ARTIFACT) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
