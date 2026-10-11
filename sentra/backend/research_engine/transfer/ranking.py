"""#215 — participant-level MAE, model differences, ties, and the synthetic-vs-real ranking comparison.

**MAE per participant first.** Each participant's MAE is the mean absolute
error over their own scored points; a model's MAE is the mean over
participants. A participant with 27 scored days and one with 5 count once
each (protocol §7.2: 参加者単位で平均).

**Differences are paired.** The interval for "model A minus model B" resamples
participants once and evaluates both models on the same resample. Two
separate intervals that overlap say much less than one paired interval that
excludes zero, and the tie rule (P3) is about the paired difference.

**Ties are a rule, not an impression.** Two models are in the tie zone when
the plan's `tie_rule` says so — by default here, when the paired interval
contains zero. That rule is a placeholder for P3, and every output says so.

**The comparison reports everything.** For each split kind and target item,
`compare_rankings` classifies every model pair as agreeing, reversed, or in a
tie zone on either side; says whether the synthetic winner is the real winner;
records when the synthetic winner loses to a simple baseline on real data;
and puts the evaluation-set shrinkage of both sides next to each other. It
does not decide which of those is the primary outcome or what counts as
failure — those are P3 and P7, and the output says they are open.
"""

from __future__ import annotations

from itertools import combinations
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

import numpy as np

from ..contracts.errors import ContractViolation
from . import CANDIDATE_STATUS, CANDIDATE_STATUS_JA, TRANSFER_STUDY_VERSION
from .codes import TransferCode
from .forecasting import SPLIT_KINDS, SplitEvaluation
from .plan import TIE_INTERVAL, TIE_MARGIN, TIE_MARGIN_OR_INTERVAL, AnalysisPlan

RANKING_VERSION = "transfer-ranking-v0"
SIMPLE_BASELINES = ("persistence", "train_mean", "linear_ar")

RELATION_FIRST_BETTER = "first_better"
RELATION_SECOND_BETTER = "second_better"
RELATION_TIE = "tie"


def _participant_mae(evaluation: SplitEvaluation) -> Tuple[List[str], np.ndarray]:
    """codes, matrix [participant, model] of per-participant MAE."""

    errors = evaluation.per_participant_errors()
    codes = sorted({code for model in evaluation.model_ids for code in errors[model]})
    matrix = np.asarray(
        [[float(np.mean(errors[model][code])) for model in evaluation.model_ids] for code in codes], dtype=float
    ).reshape(len(codes), len(evaluation.model_ids))
    return codes, matrix


def _interval(samples: np.ndarray, level: float) -> List[float]:
    tail = (1.0 - level) / 2.0
    return [float(np.quantile(samples, tail)), float(np.quantile(samples, 1.0 - tail))]


def _relation(mean_difference: float, interval: Optional[List[float]], plan: AnalysisPlan) -> str:
    within_margin = abs(mean_difference) < plan.tie_margin
    straddles = interval is None or (interval[0] <= 0.0 <= interval[1])
    if plan.tie_rule == TIE_INTERVAL:
        tie = straddles
    elif plan.tie_rule == TIE_MARGIN:
        tie = within_margin
    else:
        tie = straddles or within_margin
    if tie:
        return RELATION_TIE
    return RELATION_FIRST_BETTER if mean_difference < 0 else RELATION_SECOND_BETTER


def rank(evaluation: SplitEvaluation, plan: AnalysisPlan) -> Dict[str, Any]:
    """Per-model MAE with participant intervals, paired differences, relations, order."""

    codes, matrix = _participant_mae(evaluation)
    models = list(evaluation.model_ids)
    result: Dict[str, Any] = {
        "split_kind": evaluation.split_kind,
        "item": evaluation.item,
        "fit_mode": evaluation.fit_mode,
        "n_participants_scored": len(codes),
        "n_points_scored": len(evaluation.points),
        "reduction": dict(evaluation.reduction),
        "declined_by_model": {model: dict(reasons) for model, reasons in evaluation.declined_by_model.items()},
        "model_states": dict(evaluation.model_states),
        "fit_max_day": evaluation.fit_max_day,
        "n_fit_participants": len(evaluation.fit_codes),
    }
    if len(codes) < 3:
        result.update(
            {
                "status": "not_enough_data",
                "reason_ja": f"採点できた参加者が{len(codes)}名で、参加者単位の区間を出せません。",
                "models": {},
                "pairs": [],
                "order": [],
                "winner": None,
                "tied_with_winner": [],
            }
        )
        return result

    rng = np.random.default_rng(plan.bootstrap_seed)
    picks = rng.integers(0, len(codes), size=(plan.bootstrap_rounds, len(codes)))
    resampled = matrix[picks].mean(axis=1)  # [round, model]
    means = matrix.mean(axis=0)

    model_rows = {
        model: {
            "mae": float(means[index]),
            "interval": _interval(resampled[:, index], plan.interval_level),
            "unit": "item_scale",
        }
        for index, model in enumerate(models)
    }
    pairs = []
    for first, second in combinations(range(len(models)), 2):
        per_participant = matrix[:, first] - matrix[:, second]
        mean_difference = float(per_participant.mean())
        interval = _interval(resampled[:, first] - resampled[:, second], plan.interval_level)
        pairs.append(
            {
                "first": models[first],
                "second": models[second],
                "mean_difference_first_minus_second": mean_difference,
                "interval": interval,
                "relation": _relation(mean_difference, interval, plan),
            }
        )
    order = [models[index] for index in np.argsort(means, kind="stable")]
    winner = order[0]
    tied = sorted(
        {
            pair["second"] if pair["first"] == winner else pair["first"]
            for pair in pairs
            if pair["relation"] == RELATION_TIE and winner in (pair["first"], pair["second"])
        }
    )
    result.update(
        {
            "status": "ok",
            "models": model_rows,
            "pairs": pairs,
            "order": order,
            "winner": winner,
            "tied_with_winner": tied,
            "uncertainty_method": f"participant_bootstrap_paired_percentile_{plan.interval_level:g}",
        }
    )
    return result


def rank_evaluations(evaluated: Mapping[str, Any], plan: AnalysisPlan) -> Dict[str, Any]:
    """Rank every (split kind, item) of one `evaluate_dataset` output. Split kinds stay separate."""

    rankings: Dict[str, Dict[str, Any]] = {kind: {} for kind in SPLIT_KINDS}
    for kind in SPLIT_KINDS:
        for item, evaluation in evaluated["evaluations"][kind].items():
            rankings[kind][item] = rank(evaluation, plan)
    return {
        "ranking_version": RANKING_VERSION,
        "transfer_study_version": TRANSFER_STUDY_VERSION,
        "status": CANDIDATE_STATUS,
        "status_ja": CANDIDATE_STATUS_JA,
        "plan_id": plan.plan_id,
        "plan_status": plan.status,
        "plan_hash": plan.content_hash(),
        "fit_mode": evaluated["fit_mode"],
        "dataset_id": evaluated["dataset_id"],
        "dataset_hash": evaluated["dataset_hash"],
        "source_kind": evaluated["source_kind"],
        "participant_split": evaluated["participant_split"],
        "n_fit_participants": evaluated["n_fit_participants"],
        "admission": evaluated["admission"],
        "rankings": rankings,
        "split_kinds_reported_separately": True,
    }


# --------------------------------------------------------------------------
# Synthetic vs real
# --------------------------------------------------------------------------


def _relation_between(ranking: Mapping[str, Any], first: str, second: str) -> Optional[str]:
    for pair in ranking.get("pairs", []):
        if pair["first"] == first and pair["second"] == second:
            return pair["relation"]
        if pair["first"] == second and pair["second"] == first:
            flipped = {RELATION_FIRST_BETTER: RELATION_SECOND_BETTER, RELATION_SECOND_BETTER: RELATION_FIRST_BETTER}
            return flipped.get(pair["relation"], pair["relation"])
    return None


def _pair_difference(ranking: Mapping[str, Any], first: str, second: str) -> Optional[Dict[str, Any]]:
    for pair in ranking.get("pairs", []):
        if pair["first"] == first and pair["second"] == second:
            return {"mean_difference": pair["mean_difference_first_minus_second"], "interval": pair["interval"]}
        if pair["first"] == second and pair["second"] == first:
            low, high = pair["interval"]
            return {"mean_difference": -pair["mean_difference_first_minus_second"], "interval": [-high, -low]}
    return None


def compare_one(synthetic: Mapping[str, Any], real: Mapping[str, Any]) -> Dict[str, Any]:
    if synthetic["split_kind"] != real["split_kind"]:
        raise ContractViolation(
            TransferCode.SPLIT_KINDS_MIXED,
            "異なる分割の順位どうしは比べません。",
            "split_kind",
        )
    base = {
        "split_kind": synthetic["split_kind"],
        "item": synthetic["item"],
        "reduction": {"synthetic": synthetic["reduction"], "real": real["reduction"]},
        "n_participants_scored": {"synthetic": synthetic["n_participants_scored"], "real": real["n_participants_scored"]},
    }
    if synthetic["status"] != "ok" or real["status"] != "ok":
        return {**base, "status": "not_comparable", "synthetic_status": synthetic["status"], "real_status": real["status"]}

    models = sorted(set(synthetic["models"]) & set(real["models"]))
    pairs = []
    counts = {"agree": 0, "reversal": 0, "tie_both": 0, "tie_synthetic_only": 0, "tie_real_only": 0}
    for first, second in combinations(models, 2):
        left = _relation_between(synthetic, first, second)
        right = _relation_between(real, first, second)
        if left == RELATION_TIE and right == RELATION_TIE:
            category = "tie_both"
        elif left == RELATION_TIE:
            category = "tie_synthetic_only"
        elif right == RELATION_TIE:
            category = "tie_real_only"
        elif left == right:
            category = "agree"
        else:
            category = "reversal"
        counts[category] += 1
        pairs.append(
            {
                "first": first,
                "second": second,
                "synthetic_relation": left,
                "real_relation": right,
                "category": category,
                "synthetic_difference": _pair_difference(synthetic, first, second),
                "real_difference": _pair_difference(real, first, second),
            }
        )
    strict = counts["agree"] + counts["reversal"]
    winner = synthetic["winner"]
    beaten_by_simple = [
        baseline
        for baseline in SIMPLE_BASELINES
        if baseline != winner and baseline in models and _relation_between(real, baseline, winner) == RELATION_FIRST_BETTER
    ]
    return {
        **base,
        "status": "ok",
        "pairs": pairs,
        "pair_counts": counts,
        "concordance_among_strict_pairs": None if strict == 0 else (counts["agree"] - counts["reversal"]) / strict,
        "synthetic_order": synthetic["order"],
        "real_order": real["order"],
        "synthetic_winner": winner,
        "real_winner": real["winner"],
        "winner_agrees": winner == real["winner"],
        "synthetic_winner_in_real_tie_zone": winner in real["tied_with_winner"] or (
            winner != real["winner"] and _relation_between(real, winner, real["winner"]) == RELATION_TIE
        ),
        "synthetic_winner_beaten_on_real_by": beaten_by_simple,
        "mae": {
            model: {"synthetic": synthetic["models"][model], "real": real["models"][model]} for model in models
        },
    }


def compare_rankings(synthetic: Mapping[str, Any], real: Mapping[str, Any]) -> Dict[str, Any]:
    """Every split kind × item present on both sides, each reported on its own."""

    if synthetic["plan_hash"] != real["plan_hash"]:
        raise ContractViolation(
            TransferCode.PLAN_MISMATCH,
            "合成側と実側で解析計画が違います。同じ計画（同じ目標・同じ分割）で採点した結果だけを比べます。",
            "plan_hash",
        )
    comparisons: Dict[str, Dict[str, Any]] = {kind: {} for kind in SPLIT_KINDS}
    for kind in SPLIT_KINDS:
        for item, synthetic_ranking in synthetic["rankings"][kind].items():
            real_ranking = real["rankings"][kind].get(item)
            if real_ranking is not None:
                comparisons[kind][item] = compare_one(synthetic_ranking, real_ranking)
    return {
        "comparison_version": RANKING_VERSION,
        "status": CANDIDATE_STATUS,
        "plan_status": synthetic["plan_status"],
        "synthetic": {"dataset_hash": synthetic["dataset_hash"], "fit_mode": synthetic["fit_mode"]},
        "real": {"dataset_hash": real["dataset_hash"], "fit_mode": real["fit_mode"], "source_kind": real["source_kind"]},
        "comparisons": comparisons,
        "primary_outcome": None,
        "primary_outcome_note_ja": "主結果の判定規則（順位一致／逆転・同点域・MAE差）は事前登録 P3 で決める（未決定）。ここではすべての分類を並べる。",
        "failure_conditions": None,
        "failure_conditions_note_ja": "失敗条件は事前登録 P7 で決める（未決定）。",
        "split_kinds_reported_separately": True,
    }
