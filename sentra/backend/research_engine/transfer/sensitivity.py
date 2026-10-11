"""#216 — how much the ranking and the MAE differences move when the missingness assumption moves.

The true state on a day nobody reported is not identifiable from the data.
On real data, no analysis can recover it; what an analysis can do is show how
far the conclusion depends on what one assumes about it. Four views, each
labelled with what it can and cannot say:

1. **Missingness scenarios (synthetic only).** The same latent cohort under
   `none`, `independent` and `state_dependent` at several strengths (the
   scenarios share their random draws, so only the missingness rule differs),
   for every seed run. The shift of rank and MAE difference relative to the
   complete-data reference is the quantity of interest.
2. **Observed vs truth scoring (synthetic only).** The *same* forecasts scored
   twice: against the observed next-day values, and against the generating
   truth on every next day, observed or not. The gap is what selective
   missingness does to the evaluation itself. It needs the truth, so it
   exists only for synthetic data and is never computed for the pilot.
3. **Analysis rules (synthetic and real).** The ranking under each origin rule
   (P6) and under a grid of inclusion minimums (P5). The grid is a sensitivity
   grid, **not a set of proposals** for P5.
4. **Delta adjustment (synthetic and real, exploratory).** Unobserved
   next-day targets are filled with the participant's observed mean of that
   item shifted by δ of their observed SD, and all forecasts are re-scored.
   δ = 0 is "missing days look like the person's average day"; δ < 0 for
   mood is "missing days were worse days". This is a pattern-mixture style
   sensitivity analysis: the δ values are assumptions to vary, not estimates.

Model inputs never change in any of the four — only what the forecasts are
scored against, or which cohort/rule produced them. Everything here is
secondary or exploratory; which is which is P8.
"""

from __future__ import annotations

import dataclasses
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

import numpy as np

from .consent_gate import OPERATION_EVALUATE, admit
from .forecasting import SPLIT_KINDS, evaluate_dataset
from .generator import GeneratedCohort, SyntheticCohortConfig, generate
from .plan import FIT_TARGET_SPLIT, ORIGIN_RULES, AnalysisPlan
from .ranking import compare_one, rank_evaluations
from .schema import ITEM_IDS, TransferDataset

SENSITIVITY_VERSION = "transfer-sensitivity-v0"

#: (scenario, strength). `none` is the reference every other scenario is
#: measured against.
DEFAULT_MISSINGNESS_GRID: Tuple[Tuple[str, float], ...] = (
    ("none", 0.0),
    ("independent", 0.0),
    ("state_dependent", 0.5),
    ("state_dependent", 1.0),
    ("state_dependent", 2.0),
)
#: Fractions of the study period, so the grid follows `study_days`.
DEFAULT_INCLUSION_FRACTIONS: Tuple[float, ...] = (0.0, 0.25, 0.5, 0.75)
DEFAULT_DELTAS: Tuple[float, ...] = (-1.0, -0.5, 0.0, 0.5, 1.0)

NOT_IDENTIFIABLE_JA = "未観測日の真の状態は、観測データからは識別できない。ここで動かしているのは仮定であり、推定ではない。"


def _scenario_label(scenario: str, strength: float) -> str:
    return f"{scenario}-k{strength:g}" if scenario == "state_dependent" else scenario


def _shift(reference: Mapping[str, Any], variant: Mapping[str, Any]) -> Dict[str, Dict[str, Any]]:
    """Per split × item: how the variant's ranking differs from the reference's."""

    shifts: Dict[str, Dict[str, Any]] = {kind: {} for kind in SPLIT_KINDS}
    for kind in SPLIT_KINDS:
        for item, ref in reference["rankings"][kind].items():
            var = variant["rankings"][kind].get(item)
            if var is None:
                continue
            compared = compare_one(ref, var)
            row: Dict[str, Any] = {
                "status": compared["status"],
                "n_participants_scored": compared["n_participants_scored"],
                "points_scored": {"reference": ref["n_points_scored"], "variant": var["n_points_scored"]},
            }
            if compared["status"] == "ok":
                row.update(
                    {
                        "reference_order": compared["synthetic_order"],
                        "variant_order": compared["real_order"],
                        "winner_changed": not compared["winner_agrees"],
                        # A change of winner between two models whose
                        # difference is inside the tie zone is not the same
                        # finding as a clear change; both are reported.
                        "winner_changed_within_tie_zone": (not compared["winner_agrees"])
                        and compared["synthetic_winner_in_real_tie_zone"],
                        "pair_counts": compared["pair_counts"],
                        "difference_shift": [
                            {
                                "first": pair["first"],
                                "second": pair["second"],
                                "reference": pair["synthetic_difference"],
                                "variant": pair["real_difference"],
                                "shift": pair["real_difference"]["mean_difference"] - pair["synthetic_difference"]["mean_difference"],
                            }
                            for pair in compared["pairs"]
                        ],
                    }
                )
            shifts[kind][item] = row
    return shifts


def _rank(dataset: TransferDataset, plan: AnalysisPlan, **kwargs: Any) -> Dict[str, Any]:
    return rank_evaluations(evaluate_dataset(dataset, plan, fit_mode=FIT_TARGET_SPLIT, **kwargs), plan)


def _summary(ranking: Mapping[str, Any]) -> Dict[str, Dict[str, Any]]:
    """Order, winner and MAE per split × item — what a table in the report shows."""

    rows: Dict[str, Dict[str, Any]] = {kind: {} for kind in SPLIT_KINDS}
    for kind in SPLIT_KINDS:
        for item, ranked in ranking["rankings"][kind].items():
            rows[kind][item] = {
                "status": ranked["status"],
                "order": ranked.get("order"),
                "winner": ranked.get("winner"),
                "tied_with_winner": ranked.get("tied_with_winner"),
                "mae": {model: values["mae"] for model, values in ranked.get("models", {}).items()},
                "n_participants_scored": ranked["n_participants_scored"],
                "n_points_scored": ranked["n_points_scored"],
                "reduction": ranked["reduction"],
            }
    return rows


# --------------------------------------------------------------------------
# 1 and 2: synthetic only
# --------------------------------------------------------------------------


def missingness_scenarios(
    seeds: Sequence[int],
    plan: AnalysisPlan,
    grid: Sequence[Tuple[str, float]] = DEFAULT_MISSINGNESS_GRID,
    base_config: Optional[Mapping[str, Any]] = None,
) -> Dict[str, Any]:
    """Every seed × scenario, each against that seed's complete-data reference."""

    base = dict(base_config or {})
    per_seed: Dict[str, Any] = {}
    for seed in seeds:
        rankings: Dict[str, Any] = {}
        cohorts: Dict[str, GeneratedCohort] = {}
        for scenario, strength in grid:
            label = _scenario_label(scenario, strength)
            cohort = generate(SyntheticCohortConfig(seed=seed, missingness=scenario, mnar_strength=strength, **base))
            cohorts[label] = cohort
            rankings[label] = _rank(cohort.dataset, plan)
        reference_label = _scenario_label(*grid[0])
        per_seed[str(seed)] = {
            "reference": reference_label,
            "scenarios": {
                label: {
                    "dataset_hash": cohorts[label].dataset.content_hash(),
                    "summary": _summary(ranking),
                    "shift_from_reference": None if label == reference_label else _shift(rankings[reference_label], ranking),
                }
                for label, ranking in rankings.items()
            },
        }
    return {
        "analysis": "missingness_scenarios",
        "scope": "synthetic_only",
        "role": "sensitivity",
        "seeds": list(seeds),
        "grid": [{"scenario": s, "strength": k, "label": _scenario_label(s, k)} for s, k in grid],
        "note_ja": (
            "同じ潜在の軌跡に、欠測の規則だけを変えて当てた。基準は欠測なし。"
            "状態依存欠測の真値は合成の設定であり、実データの事実ではない（#213）。"
        ),
        "results": per_seed,
    }


def observed_vs_truth(cohort: GeneratedCohort, plan: AnalysisPlan) -> Dict[str, Any]:
    """The same forecasts, scored on observed next days and on every next day's truth."""

    observed = _rank(cohort.dataset, plan)
    truth = cohort.truth

    def truth_target(code: str, day: int, item: str, observed_value: Optional[float]) -> Optional[float]:
        return truth.complete_value(code, day, item)

    against_truth = _rank(cohort.dataset, plan, target_value=truth_target)
    return {
        "analysis": "observed_vs_truth_scoring",
        "scope": "synthetic_only",
        "role": "sensitivity",
        "dataset_hash": cohort.dataset.content_hash(),
        "observed_targets": _summary(observed),
        "truth_targets": _summary(against_truth),
        "shift_truth_from_observed": _shift(observed, against_truth),
        "note_ja": (
            "予測は同じ（入力は観測だけ）。採点の相手を、観測された翌日の値から、生成真値の翌日の値（欠測日を含む）に替えた。"
            "生成真値が要るので合成データにしか計算できず、実データでは計算しない。"
        ),
    }


# --------------------------------------------------------------------------
# 3 and 4: also defined for real data
# --------------------------------------------------------------------------


def analysis_rules(
    dataset: TransferDataset,
    plan: AnalysisPlan,
    inclusion_fractions: Sequence[float] = DEFAULT_INCLUSION_FRACTIONS,
    **gate_kwargs: Any,
) -> Dict[str, Any]:
    reference = _rank(dataset, plan, gate_kwargs=gate_kwargs)
    variants: Dict[str, Any] = {}
    for rule in ORIGIN_RULES:
        if rule == plan.origin_rule:
            continue
        variant_plan = dataclasses.replace(plan, origin_rule=rule)
        ranking = _rank(dataset, variant_plan, gate_kwargs=gate_kwargs)
        variants[f"origin_rule={rule}"] = {"summary": _summary(ranking), "shift_from_plan": _shift(reference, ranking)}
    for fraction in inclusion_fractions:
        minimum = int(round(fraction * dataset.study_days))
        if minimum == plan.inclusion_min_submitted_days:
            continue
        variant_plan = dataclasses.replace(plan, inclusion_min_submitted_days=minimum)
        ranking = _rank(dataset, variant_plan, gate_kwargs=gate_kwargs)
        variants[f"inclusion_min_submitted_days={minimum}"] = {
            "summary": _summary(ranking),
            "shift_from_plan": _shift(reference, ranking),
        }
    return {
        "analysis": "analysis_rules",
        "scope": "synthetic_and_real",
        "role": "sensitivity",
        "plan_setting": {"origin_rule": plan.origin_rule, "inclusion_min_submitted_days": plan.inclusion_min_submitted_days},
        "reference": _summary(reference),
        "variants": variants,
        "note_ja": "起点が欠測の日の扱い（P6）と解析対象の最低条件（P5）を動かした。格子は感度分析のためのもので、P5・P6 の候補の提案ではない。",
    }


def delta_adjustment(
    dataset: TransferDataset,
    plan: AnalysisPlan,
    deltas: Sequence[float] = DEFAULT_DELTAS,
    **gate_kwargs: Any,
) -> Dict[str, Any]:
    admitted = admit(dataset, OPERATION_EVALUATE, **gate_kwargs).dataset
    stats: Dict[Tuple[str, str], Tuple[float, float]] = {}
    for code in admitted.participants:
        records = admitted.records_for(code)
        for item in ITEM_IDS:
            values = [r.value(item) for r in records if r.value(item) is not None]
            if len(values) >= 2:
                stats[(code, item)] = (float(np.mean(values)), float(np.std(values, ddof=1)))

    reference = _rank(dataset, plan, gate_kwargs=gate_kwargs)
    variants: Dict[str, Any] = {}
    for delta in deltas:

        def adjusted(code: str, day: int, item: str, observed_value: Optional[float], delta: float = delta) -> Optional[float]:
            if observed_value is not None:
                return observed_value
            moments = stats.get((code, item))
            if moments is None:
                return None
            mean, sd = moments
            return mean + delta * sd

        ranking = _rank(dataset, plan, gate_kwargs=gate_kwargs, target_value=adjusted)
        variants[f"delta={delta:g}"] = {"summary": _summary(ranking), "shift_from_observed_only": _shift(reference, ranking)}
    return {
        "analysis": "delta_adjustment",
        "scope": "synthetic_and_real",
        "role": "exploratory",
        "deltas": list(deltas),
        "observed_only": _summary(reference),
        "variants": variants,
        "note_ja": (
            "観測されなかった翌日の値を、その参加者の観測平均＋δ×観測標準偏差で置いて採点し直した（予測の入力は変えない）。"
            + NOT_IDENTIFIABLE_JA
        ),
    }


def run_sensitivity(
    selection: GeneratedCohort,
    plan: AnalysisPlan,
    seeds: Sequence[int],
    grid: Sequence[Tuple[str, float]] = DEFAULT_MISSINGNESS_GRID,
) -> Dict[str, Any]:
    return {
        "sensitivity_version": SENSITIVITY_VERSION,
        "status": "candidate_not_frozen",
        "plan_id": plan.plan_id,
        "plan_status": plan.status,
        "not_identifiable_ja": NOT_IDENTIFIABLE_JA,
        "missingness_scenarios": missingness_scenarios(seeds, plan, grid),
        "observed_vs_truth": observed_vs_truth(selection, plan),
        "analysis_rules": analysis_rules(selection.dataset, plan),
        "delta_adjustment": delta_adjustment(selection.dataset, plan),
        "classification_note_ja": "すべて副次または探索。どれを副次・探索とするかは事前登録 P8（未決定）。",
    }
