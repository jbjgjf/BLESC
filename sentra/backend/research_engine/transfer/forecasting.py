"""#215 — next-day self-report forecasts by the three baselines, under two splits that are never mixed.

**The models.** Persistence (the last value), the training mean, and a linear
AR(1) per item — the comparators #215 and protocol §7.2 require. They are
re-implemented here rather than taken from `dynamics/baselines.py` because the
next-day task needs two things those do not do: a forecast for *day t+1*, not
for the next row (a participant who skipped day t+1 has no next-day target,
and the row after the gap is a different target); and no zero-filling — the v0
linear AR fits on `nan_to_num` of the inputs, which turns a skipped answer
into a 0 the model then learns from. Both are fine for the S1–S5 scenarios
and wrong for a diary where most gaps are a whole day.

**The model input.** `ObservedPanel` is built from `day_index` and
`self_report` only — the fields the research export carries
(`schema.MODEL_INPUT_FIELDS`). Text and synthetic submission times never
reach a model, so a synthetic score cannot depend on a field the real export
lacks. The panel is built from an `AdmittedData` that went through the consent
gate, so it cannot be built from generated truth either.

**The splits.** `participant` fits on train participants and scores held-out
participants on every day; `temporal` fits on days 1..k and scores targets on
days k+1..28 for the same people. They answer different questions (protocol
§7.2) and are kept apart: results are keyed by split kind, and
`refuse_mixed_split_kinds` refuses any attempt to pool them.

**The evaluation set.** A forecast point is scored only when the target was
observed *and every model in the set answered*. Each exclusion is counted by
reason — target missing, origin missing, no history, below the inclusion
minimum — because #215 asks for the shrinkage of the evaluation set under
missingness to be reported, and a shrinkage that differs between synthetic and
real is itself a reason the ranking might not transfer.

**Leakage checks are executed, not asserted.** `leakage_probes()` perturbs
the future, the text and the timestamps and re-forecasts; it feeds the gate a
truth-bearing object; it tries to pool the two split kinds. Each probe reports
what it examined, and a probe that could not run reports failure.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

import numpy as np

from ..contracts.common import content_hash
from ..contracts.errors import Code, ContractViolation
from ..contracts.evaluation import LeakageCheck
from ..data.splits import participant_split
from ..evaluation.leakage import split_groups_are_disjoint
from .codes import TransferCode
from .consent_gate import OPERATION_EVALUATE, OPERATION_FIT, admit, require_disjoint, to_observation_bundle
from .plan import FIT_MODES, FIT_SYNTHETIC_FROZEN, FIT_TARGET_SPLIT, ORIGIN_REQUIRE_OBSERVED, AnalysisPlan
from .schema import ITEM_BY_ID, ITEM_IDS, SOURCE_SYNTHETIC, DailyRecord, TransferDataset

SPLIT_PARTICIPANT = "participant"
SPLIT_TEMPORAL = "temporal"
SPLIT_KINDS = (SPLIT_PARTICIPANT, SPLIT_TEMPORAL)


# --------------------------------------------------------------------------
# The model input
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class ObservedPanel:
    """participant × day × item, NaN where nothing was observed. Days are 1-based in the API."""

    codes: Tuple[str, ...]
    study_days: int
    values: np.ndarray

    @staticmethod
    def from_dataset(dataset: TransferDataset) -> "ObservedPanel":
        codes = tuple(dataset.participants)
        index = {code: position for position, code in enumerate(codes)}
        values = np.full((len(codes), dataset.study_days, len(ITEM_IDS)), np.nan)
        for record in dataset.records:
            if record.self_report is None or record.research_code not in index:
                continue
            for item_position, value in enumerate(record.self_report):
                if value is not None:
                    values[index[record.research_code], record.day_index - 1, item_position] = float(value)
        return ObservedPanel(codes=codes, study_days=dataset.study_days, values=values)

    def series(self, code: str, item: str) -> np.ndarray:
        return self.values[self.codes.index(code), :, ITEM_IDS.index(item)]

    def submitted_days(self, dataset: TransferDataset, code: str) -> int:
        return len(dataset.records_for(code))


# --------------------------------------------------------------------------
# Models
# --------------------------------------------------------------------------


def _origin_value(history: np.ndarray, rule: str) -> Tuple[Optional[float], Optional[str]]:
    """The value a model starts from at the origin day, or why there is none."""

    if history.size == 0:
        return None, "no_history"
    if rule == ORIGIN_REQUIRE_OBSERVED:
        last = history[-1]
        return (None, "origin_missing") if np.isnan(last) else (float(last), None)
    observed = np.flatnonzero(~np.isnan(history))
    if observed.size == 0:
        return None, "no_history"
    return float(history[observed[-1]]), None


class Forecaster:
    model_id = "abstract"

    def fit(self, series: Sequence[np.ndarray]) -> None:
        raise NotImplementedError

    def predict(self, history: np.ndarray, rule: str) -> Tuple[Optional[float], Optional[str]]:
        raise NotImplementedError

    def state(self) -> Dict[str, Any]:
        return {"model_id": self.model_id}

    def model_hash(self) -> str:
        return content_hash(self.state())


class Persistence(Forecaster):
    model_id = "persistence"

    def fit(self, series: Sequence[np.ndarray]) -> None:
        return None

    def predict(self, history: np.ndarray, rule: str) -> Tuple[Optional[float], Optional[str]]:
        return _origin_value(history, rule)


class TrainMean(Forecaster):
    """The pooled mean of the item over the fit rows."""

    model_id = "train_mean"

    def __init__(self) -> None:
        self.mean: Optional[float] = None
        self.n_values = 0

    def fit(self, series: Sequence[np.ndarray]) -> None:
        values = np.concatenate([s[~np.isnan(s)] for s in series]) if series else np.array([])
        self.n_values = int(values.size)
        self.mean = float(values.mean()) if values.size else None

    def predict(self, history: np.ndarray, rule: str) -> Tuple[Optional[float], Optional[str]]:
        if self.mean is None:
            return None, "not_fitted"
        # Answer only where the others could: the comparison is over one set
        # of points, so the floor model declines where the origin is missing
        # rather than answering a question nobody else was asked.
        _, reason = _origin_value(history, rule)
        if reason is not None:
            return None, reason
        return self.mean, None

    def state(self) -> Dict[str, Any]:
        return {"model_id": self.model_id, "mean": None if self.mean is None else round(self.mean, 9), "n": self.n_values}


class LinearAR(Forecaster):
    """y(t+1) = a + b·y(t), least squares on pairs of *consecutive observed days*.

    A pair across a gap is not a one-day transition and is not used. A small
    ridge keeps the fit defined when the fit series is nearly constant.
    """

    model_id = "linear_ar"
    min_pairs = 3
    ridge = 1e-6

    def __init__(self) -> None:
        self.coefficients: Optional[Tuple[float, float]] = None
        self.n_pairs = 0

    def fit(self, series: Sequence[np.ndarray]) -> None:
        current: List[float] = []
        nxt: List[float] = []
        for s in series:
            for day in range(len(s) - 1):
                if not np.isnan(s[day]) and not np.isnan(s[day + 1]):
                    current.append(float(s[day]))
                    nxt.append(float(s[day + 1]))
        self.n_pairs = len(current)
        if self.n_pairs < self.min_pairs:
            self.coefficients = None
            return
        design = np.column_stack([np.ones(self.n_pairs), np.asarray(current)])
        gram = design.T @ design + self.ridge * np.eye(2)
        solution = np.linalg.solve(gram, design.T @ np.asarray(nxt))
        self.coefficients = (float(solution[0]), float(solution[1]))

    def predict(self, history: np.ndarray, rule: str) -> Tuple[Optional[float], Optional[str]]:
        if self.coefficients is None:
            return None, "not_fitted"
        value, reason = _origin_value(history, rule)
        if value is None:
            return None, reason
        return self.coefficients[0] + self.coefficients[1] * value, None

    def state(self) -> Dict[str, Any]:
        return {
            "model_id": self.model_id,
            "coefficients": None if self.coefficients is None else [round(c, 9) for c in self.coefficients],
            "n_pairs": self.n_pairs,
        }


MODEL_FACTORIES = {"persistence": Persistence, "train_mean": TrainMean, "linear_ar": LinearAR}


# --------------------------------------------------------------------------
# One split, one item
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class ForecastPoint:
    research_code: str
    origin_day: int
    target_day: int
    item: str
    input_max_day: int
    actual: float
    predictions: Mapping[str, float]


@dataclass
class SplitEvaluation:
    split_kind: str
    item: str
    fit_mode: str
    fit_codes: Tuple[str, ...]
    eval_codes: Tuple[str, ...]
    fit_max_day: int
    origin_days: Tuple[int, ...]
    model_ids: Tuple[str, ...]
    model_states: Dict[str, Dict[str, Any]]
    points: List[ForecastPoint] = field(default_factory=list)
    reduction: Dict[str, int] = field(default_factory=dict)
    declined_by_model: Dict[str, Dict[str, int]] = field(default_factory=dict)

    def per_participant_errors(self) -> Dict[str, Dict[str, List[float]]]:
        errors: Dict[str, Dict[str, List[float]]] = {model: {} for model in self.model_ids}
        for point in self.points:
            for model in self.model_ids:
                errors[model].setdefault(point.research_code, []).append(abs(point.predictions[model] - point.actual))
        return errors


def _history(series: np.ndarray, origin: int) -> np.ndarray:
    """Days 1..origin of one participant's series — and nothing after."""

    return series[:origin]


def _fit_models(model_ids: Sequence[str], panel: ObservedPanel, codes: Sequence[str], item: str, fit_max_day: int) -> Dict[str, Forecaster]:
    series = [panel.series(code, item)[:fit_max_day] for code in codes]
    models: Dict[str, Forecaster] = {}
    for model_id in model_ids:
        model = MODEL_FACTORIES[model_id]()
        model.fit(series)
        models[model_id] = model
    return models


def evaluate_split(
    *,
    split_kind: str,
    item: str,
    fit_mode: str,
    fit_panel: ObservedPanel,
    fit_codes: Sequence[str],
    fit_max_day: int,
    eval_dataset: TransferDataset,
    eval_codes: Sequence[str],
    origin_days: Sequence[int],
    plan: AnalysisPlan,
) -> SplitEvaluation:
    if split_kind not in SPLIT_KINDS:
        raise ContractViolation(Code.UNKNOWN_ENUM_VALUE, f"未知の分割です: {split_kind}", "split_kind")
    eval_panel = ObservedPanel.from_dataset(eval_dataset)
    models = _fit_models(plan.model_ids, fit_panel, fit_codes, item, fit_max_day)
    evaluation = SplitEvaluation(
        split_kind=split_kind,
        item=item,
        fit_mode=fit_mode,
        fit_codes=tuple(sorted(fit_codes)),
        eval_codes=tuple(sorted(eval_codes)),
        fit_max_day=fit_max_day,
        origin_days=tuple(origin_days),
        model_ids=tuple(plan.model_ids),
        model_states={model_id: model.state() for model_id, model in models.items()},
    )
    reduction: Dict[str, int] = {
        "candidate_points": 0,
        "below_inclusion_minimum": 0,
        "target_missing": 0,
        "declined_by_a_model": 0,
        "scored": 0,
    }
    declined: Dict[str, Dict[str, int]] = {model_id: {} for model_id in plan.model_ids}
    for code in sorted(eval_codes):
        series = eval_panel.series(code, item)
        below_minimum = eval_panel.submitted_days(eval_dataset, code) < plan.inclusion_min_submitted_days
        for origin in origin_days:
            reduction["candidate_points"] += 1
            if below_minimum:
                reduction["below_inclusion_minimum"] += 1
                continue
            target_day = origin + plan.horizon_days
            actual = series[target_day - 1]
            if np.isnan(actual):
                reduction["target_missing"] += 1
                continue
            history = _history(series, origin)
            predictions: Dict[str, float] = {}
            missing_reason: Optional[str] = None
            for model_id, model in models.items():
                value, reason = model.predict(history, plan.origin_rule)
                if value is None:
                    declined[model_id][reason or "declined"] = declined[model_id].get(reason or "declined", 0) + 1
                    missing_reason = missing_reason or reason
                else:
                    predictions[model_id] = value
            if len(predictions) != len(models):
                reduction["declined_by_a_model"] += 1
                reduction[f"declined:{missing_reason}"] = reduction.get(f"declined:{missing_reason}", 0) + 1
                continue
            reduction["scored"] += 1
            evaluation.points.append(
                ForecastPoint(
                    research_code=code,
                    origin_day=origin,
                    target_day=target_day,
                    item=item,
                    # What the models were actually handed, measured rather
                    # than assumed: the leakage probe compares it with the origin.
                    input_max_day=int(history.size),
                    actual=float(actual),
                    predictions=predictions,
                )
            )
    evaluation.reduction = reduction
    evaluation.declined_by_model = declined
    return evaluation


# --------------------------------------------------------------------------
# Splits over a dataset
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class ParticipantSplitAssignment:
    train: Tuple[str, ...]
    validation: Tuple[str, ...]
    heldout: Tuple[str, ...]
    split_hash: str
    check: LeakageCheck


def split_participants(dataset: TransferDataset, plan: AnalysisPlan) -> ParticipantSplitAssignment:
    """Reuses `data.splits.participant_split`: whole participants, seeded, order-independent."""

    bundle = to_observation_bundle(dataset)
    assignment = participant_split(
        bundle,
        fractions=plan.participant_split_fractions,
        seed=plan.participant_split_seed,
        split_id=f"transfer-participant-split-seed{plan.participant_split_seed}",
    )
    return ParticipantSplitAssignment(
        train=tuple(assignment.participants_in("train")),
        validation=tuple(assignment.participants_in("validation")),
        heldout=tuple(assignment.participants_in("heldout")),
        split_hash=assignment.content_hash(),
        check=split_groups_are_disjoint(assignment),
    )


def evaluate_dataset(
    target: TransferDataset,
    plan: AnalysisPlan,
    *,
    fit_mode: str,
    selection: Optional[TransferDataset] = None,
    gate_kwargs: Optional[Mapping[str, Any]] = None,
    selection_gate_kwargs: Optional[Mapping[str, Any]] = None,
) -> Dict[str, Any]:
    """Every split kind × target item for one dataset and one fit mode.

    `fit_mode="target_split"` fits on the target's own train side (on real
    data, training on real data — the gate admits only `model_training_use`
    participants to the fit). `fit_mode="synthetic_frozen"` fits on the
    `selection` cohort's train side and only *scores* the target.
    """

    gate_kwargs = dict(gate_kwargs or {})
    evaluation_input = admit(target, OPERATION_EVALUATE, **gate_kwargs)
    split = split_participants(evaluation_input.dataset, plan)

    if fit_mode not in FIT_MODES:
        raise ContractViolation(Code.UNKNOWN_ENUM_VALUE, f"未知の当てはめ方です: {fit_mode}", "fit_mode")
    if fit_mode == FIT_SYNTHETIC_FROZEN:
        if selection is None:
            raise ContractViolation(Code.MISSING_FIELD, "凍結評価には選択用の合成データが要ります。", "selection")
        fit_input = admit(selection, OPERATION_FIT, **dict(selection_gate_kwargs or {}))
        if fit_input.dataset.source_kind != SOURCE_SYNTHETIC:
            raise ContractViolation(Code.REAL_DATA_REFUSED, "凍結評価の当てはめは合成データだけで行います。", "selection")
        fit_split = split_participants(admit(selection, OPERATION_EVALUATE, **dict(selection_gate_kwargs or {})).dataset, plan)
        participant_fit_codes = [code for code in fit_split.train if code in set(fit_input.participants)]
        temporal_fit_codes = list(fit_input.participants)
    else:
        fit_input = admit(target, OPERATION_FIT, **gate_kwargs)
        participant_fit_codes = [code for code in split.train if code in set(fit_input.participants)]
        temporal_fit_codes = list(fit_input.participants)
        require_disjoint(participant_fit_codes, split.heldout, "participant_split")
    fit_panel = ObservedPanel.from_dataset(fit_input.dataset)

    k = plan.temporal_fit_last_day
    study_days = evaluation_input.dataset.study_days
    results: Dict[str, Dict[str, SplitEvaluation]] = {SPLIT_PARTICIPANT: {}, SPLIT_TEMPORAL: {}}
    for item in plan.target_items:
        results[SPLIT_PARTICIPANT][item] = evaluate_split(
            split_kind=SPLIT_PARTICIPANT,
            item=item,
            fit_mode=fit_mode,
            fit_panel=fit_panel,
            fit_codes=participant_fit_codes,
            fit_max_day=fit_panel.study_days,
            eval_dataset=evaluation_input.dataset,
            eval_codes=split.heldout,
            origin_days=range(1, study_days),
            plan=plan,
        )
        results[SPLIT_TEMPORAL][item] = evaluate_split(
            split_kind=SPLIT_TEMPORAL,
            item=item,
            fit_mode=fit_mode,
            fit_panel=fit_panel,
            fit_codes=temporal_fit_codes,
            fit_max_day=k,
            eval_dataset=evaluation_input.dataset,
            eval_codes=evaluation_input.participants,
            origin_days=range(k, study_days),
            plan=plan,
        )
    return {
        "fit_mode": fit_mode,
        "dataset_id": evaluation_input.dataset.dataset_id,
        "dataset_hash": target.content_hash(),
        "source_kind": target.source_kind,
        "participant_split": {
            "split_hash": split.split_hash,
            "n_train": len(split.train),
            "n_validation": len(split.validation),
            "n_heldout": len(split.heldout),
            "validation_note_ja": "validation 側は使っていない。チューニング予算（P2）が決まっていないため。",
            "check": split.check.as_dict(),
        },
        "n_fit_participants": {SPLIT_PARTICIPANT: len(participant_fit_codes), SPLIT_TEMPORAL: len(temporal_fit_codes)},
        "admission": {"evaluate": evaluation_input.summary(), "fit": fit_input.summary()},
        "evaluations": results,
        "heldout_codes": split.heldout,
        "participant_fit_codes": tuple(participant_fit_codes),
    }


def refuse_mixed_split_kinds(evaluations: Iterable[SplitEvaluation]) -> str:
    """The guard against averaging participant and temporal results into one number."""

    kinds = {evaluation.split_kind for evaluation in evaluations}
    if len(kinds) != 1:
        raise ContractViolation(
            TransferCode.SPLIT_KINDS_MIXED,
            "参加者分割と時間分割の結果を1つにまとめません。別のレポートにします（protocol §7.2）。",
            "split_kind",
            {"kinds": sorted(kinds)},
        )
    return kinds.pop()


# --------------------------------------------------------------------------
# Executed leakage checks
# --------------------------------------------------------------------------


def _replace_records(dataset: TransferDataset, change) -> TransferDataset:
    return dataset.replace(records=[change(record) for record in dataset.records])


def _flip_after(dataset: TransferDataset, day: int, codes: Optional[set] = None) -> TransferDataset:
    """Mirror every observed value after `day` within its scale (v → max − v)."""

    def change(record: DailyRecord) -> DailyRecord:
        if record.day_index <= day or record.self_report is None or (codes is not None and record.research_code not in codes):
            return record
        flipped = tuple(
            None if value is None else ITEM_BY_ID[item].maximum - value for item, value in zip(ITEM_IDS, record.self_report)
        )
        return DailyRecord(record.research_code, record.day_index, flipped, record.text, record.model_training_use, record.submitted_at)

    return _replace_records(dataset, change)


def _predictions_at(evaluation: SplitEvaluation) -> Dict[Tuple[str, int], Mapping[str, float]]:
    return {(p.research_code, p.origin_day): dict(p.predictions) for p in evaluation.points}


def leakage_probes(dataset: TransferDataset, plan: AnalysisPlan, truth_bearing: Any = None) -> List[LeakageCheck]:
    """Run the checks #215 asks for on this dataset, executing every one."""

    checks: List[LeakageCheck] = []
    item = plan.target_items[0]
    base = evaluate_dataset(dataset, plan, fit_mode=FIT_TARGET_SPLIT)
    participant_eval: SplitEvaluation = base["evaluations"][SPLIT_PARTICIPANT][item]
    temporal_eval: SplitEvaluation = base["evaluations"][SPLIT_TEMPORAL][item]

    # 1. Same participant on both sides of the participant split.
    overlap = set(participant_eval.fit_codes) & set(participant_eval.eval_codes)
    checks.append(
        LeakageCheck(
            name="participant_split_disjoint",
            passed=not overlap and base["participant_split"]["check"]["passed"],
            detail_ja=f"当てはめ{len(participant_eval.fit_codes)}名と評価{len(participant_eval.eval_codes)}名に重なりがない。",
            checked_items=len(participant_eval.eval_codes),
        )
    )

    # 2. Temporal split: fitted on days ≤ k, scored on days > k.
    targets = [p.target_day for p in temporal_eval.points]
    checks.append(
        LeakageCheck(
            name="temporal_fit_before_scored_targets",
            passed=bool(targets) and temporal_eval.fit_max_day == plan.temporal_fit_last_day and min(targets) > temporal_eval.fit_max_day,
            detail_ja=f"当てはめは{temporal_eval.fit_max_day}日目まで、採点する目標は{min(targets) if targets else '—'}日目から。",
            checked_items=len(targets),
        )
    )

    # 3. Every forecast uses only days up to its origin, and targets the next day.
    points = participant_eval.points + temporal_eval.points
    bad = [p for p in points if not (p.input_max_day <= p.origin_day < p.target_day == p.origin_day + plan.horizon_days)]
    checks.append(
        LeakageCheck(
            name="inputs_precede_targets",
            passed=bool(points) and not bad,
            detail_ja=f"{len(points)}点の予測すべてで、入力の最終日 ≤ 起点 < 目標（翌日）。",
            checked_items=len(points),
        )
    )

    # 4. Change every value after day P and re-forecast. Forecasts from origins
    #    up to P must not move — for every model, not only the parameter-free
    #    one. Temporal split: the fit uses days ≤ k < P, so the whole cohort's
    #    future can be flipped. Participant split: only the held-out people's
    #    future is flipped, because the train side's later days are legitimate
    #    fit input (other people, not the forecast's own future).
    probe_day = plan.temporal_fit_last_day + max(1, (dataset.study_days - plan.temporal_fit_last_day) // 2)
    temporal_after = evaluate_dataset(_flip_after(dataset, probe_day), plan, fit_mode=FIT_TARGET_SPLIT)
    heldout_after = evaluate_dataset(
        _flip_after(dataset, probe_day, set(participant_eval.eval_codes)), plan, fit_mode=FIT_TARGET_SPLIT
    )
    compared = 0
    moved = 0
    for before_eval, after_eval in (
        (temporal_eval, temporal_after["evaluations"][SPLIT_TEMPORAL][item]),
        (participant_eval, heldout_after["evaluations"][SPLIT_PARTICIPANT][item]),
    ):
        before = {key: value for key, value in _predictions_at(before_eval).items() if key[1] <= probe_day}
        after = {key: value for key, value in _predictions_at(after_eval).items() if key[1] <= probe_day}
        for key in set(before) & set(after):
            compared += 1
            if before[key] != after[key]:
                moved += 1
    checks.append(
        LeakageCheck(
            name="future_values_do_not_move_earlier_forecasts",
            passed=compared > 0 and moved == 0,
            detail_ja=(
                f"{probe_day}日目より後の値をすべて変えても、それ以前を起点とする{compared}点の予測"
                f"（全モデル）は変わらない。" if moved == 0 else f"未来の値を変えると{moved}点の予測が動いた。"
            ),
            checked_items=compared,
        )
    )

    # 5. Text and synthetic timestamps are not model inputs.
    stripped = _replace_records(
        dataset, lambda r: DailyRecord(r.research_code, r.day_index, r.self_report, None if r.text is None else "（置換）", r.model_training_use, None)
    )
    stripped_eval = evaluate_dataset(stripped, plan, fit_mode=FIT_TARGET_SPLIT)["evaluations"][SPLIT_PARTICIPANT][item]
    checks.append(
        LeakageCheck(
            name="text_and_timestamps_are_not_inputs",
            passed=_predictions_at(stripped_eval) == _predictions_at(participant_eval) and bool(participant_eval.points),
            detail_ja="本文を置き換え、提出時刻を消しても、予測はすべて同じ。",
            checked_items=len(participant_eval.points),
        )
    )

    # 6. Generated truth cannot be the input.
    if truth_bearing is not None:
        try:
            evaluate_dataset(truth_bearing, plan, fit_mode=FIT_TARGET_SPLIT)
            refused = False
        except ContractViolation as violation:
            refused = violation.code == TransferCode.TRUTH_IN_MODEL_INPUT
        checks.append(
            LeakageCheck(
                name="generation_truth_refused_as_input",
                passed=refused,
                detail_ja="生成真値を含むオブジェクトを入力に渡すと拒否された。" if refused else "生成真値が入力として受け付けられた。",
                checked_items=1,
            )
        )
    else:
        checks.append(
            LeakageCheck(
                name="generation_truth_refused_as_input",
                passed=False,
                detail_ja="真値を含むオブジェクトが渡されなかったため、この検査は実行していない。",
                checked_items=0,
            )
        )

    # 7. The two split kinds cannot be pooled.
    try:
        refuse_mixed_split_kinds([participant_eval, temporal_eval])
        pooled_refused = False
    except ContractViolation:
        pooled_refused = True
    checks.append(
        LeakageCheck(
            name="split_kinds_not_pooled",
            passed=pooled_refused,
            detail_ja="参加者分割と時間分割をまとめようとすると拒否された。",
            checked_items=2,
        )
    )
    return checks
