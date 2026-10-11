"""#214 — participant-level audit of the measurement and input process.

Whether synthetic data "looks like" the pilot is not the question here. The
question is whether the two differ in ways that could change how models are
*scored*: how often people submit, how long their gaps are, how much their
answers move from day to day, how much they write and when. Each of those can
change which model wins, independently of the models.

**The unit is the participant.** The pilot has at most 1,400 records, but they
are 50 people's records, not 1,400 independent draws. Every metric here is
computed once per participant first; the summaries (median, quartiles, mean)
are over participants, and the interval for the mean resamples participants.
A participant who submitted every day does not count 28 times.

**Every metric is checked against the data dictionary.** `AUDIT_METRICS`
names the dictionary field each metric is computed from and says whether that
field is in the research export at all. `check_against_dictionary()` resolves
each reference in `docs/pilot/data-dictionary.json` and fails if the stated
availability disagrees with what the dictionary says — for example, the
dictionary exports `submitted_at` only as a relative day, so the time-of-day
and weekday metrics are marked *not in the research export*: they can be
computed on synthetic data, and on real data only if someone decides to export
more (and weighs the re-identification risk `researchExport.ts` describes).
Input duration does not exist under that name in the code (`not_implemented`),
and pauses/rewrites are not adopted until their collection rate and definition
are confirmed (#214), so those are listed and not computed.

**Comparisons are fixed in advance and kept apart.** `compare_audits()`
refuses two reports computed with different metric sets, and refuses to put a
generator that was adjusted after seeing real data next to the pre-registered
one: such a comparison is reported in a separate, exploratory list. Which of
these metrics are secondary and which exploratory is P8, so every comparison
carries that label rather than a verdict.

**Nothing identifying leaves.** `public_view()` drops participant-level values,
the minimum and maximum (each is one person's value), and any summary over
fewer participants than the publication threshold (G7 in the consent matrix
— the default here is a placeholder). It never contains text or research codes.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import timedelta, timezone
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

import numpy as np

from ..contracts.common import content_hash
from ..contracts.errors import ContractViolation
from . import CANDIDATE_STATUS, CANDIDATE_STATUS_JA, TRANSFER_STUDY_VERSION
from .codes import TransferCode
from .consent_gate import OPERATION_AUDIT, OPERATION_READ_TEXT, admit
from .schema import DATA_DICTIONARY_PATH, ITEM_IDS, TransferDataset

AUDIT_VERSION = "transfer-audit-v0"

AVAILABLE_IN_EXPORT = "research_export"
REQUIRES_RETENTION = "requires_raw_text_retention"
NOT_IN_EXPORT = "not_in_research_export"
NOT_IMPLEMENTED = "not_implemented"
NOT_ADOPTED = "not_adopted"
AVAILABILITY_VALUES = (AVAILABLE_IN_EXPORT, REQUIRES_RETENTION, NOT_IN_EXPORT, NOT_IMPLEMENTED, NOT_ADOPTED)

WEEKDAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
JST = timezone(timedelta(hours=9))

#: Lag-1 autocorrelation needs enough consecutive observed pairs to mean
#: anything. Below this a participant's value is undefined, not zero.
MIN_AUTOCORRELATION_PAIRS = 5
MIN_TREND_POINTS = 3

#: Publication threshold for a summary. Placeholder: the real threshold is a
#: disclosure decision (consent matrix G7).
DEFAULT_MIN_PARTICIPANTS_FOR_PUBLIC = 5


@dataclass(frozen=True)
class AuditMetric:
    metric_id: str
    label_ja: str
    definition_ja: str
    unit: str
    dictionary_ref: str
    availability: str
    per: str = "participant"  # "participant", "participant×item", "participant×weekday"

    def as_dict(self) -> Dict[str, Any]:
        return {
            "metric_id": self.metric_id,
            "label_ja": self.label_ja,
            "definition_ja": self.definition_ja,
            "unit": self.unit,
            "dictionary_ref": self.dictionary_ref,
            "availability": self.availability,
            "per": self.per,
        }


AUDIT_METRICS: Tuple[AuditMetric, ...] = (
    AuditMetric(
        "submission_rate",
        "提出率",
        "提出のあった相対日の数 ÷ 期間の日数（28）。撤回者は gate で除かれている。",
        "ratio",
        "identity.relative_day",
        AVAILABLE_IN_EXPORT,
    ),
    AuditMetric(
        "self_report_answered_rate",
        "自己評定の回答率",
        "提出した日のうち、5項目のどれか1つ以上に答えた日の割合。",
        "ratio",
        "daily_self_report.items[mood]",
        AVAILABLE_IN_EXPORT,
    ),
    AuditMetric(
        "item_response_rate",
        "項目ごとの回答率",
        "提出した日のうち、その項目に値がある日の割合。",
        "ratio",
        "daily_self_report.items[{item}]",
        AVAILABLE_IN_EXPORT,
        per="participant×item",
    ),
    AuditMetric(
        "longest_missing_run",
        "最長の連続欠測",
        "相対日1〜28のうち、提出の無い日が続いた最長の日数（期間末尾の欠測を含む）。",
        "days",
        "identity.relative_day",
        AVAILABLE_IN_EXPORT,
    ),
    AuditMetric(
        "n_missing_runs",
        "欠測の連続の回数",
        "提出の無い日の連続が何回あったか。",
        "count",
        "identity.relative_day",
        AVAILABLE_IN_EXPORT,
    ),
    AuditMetric(
        "within_person_sd",
        "個人内のばらつき",
        "その項目の観測値の標本標準偏差（ddof=1）。観測が2点未満なら未定義。",
        "item_unit",
        "daily_self_report.items[{item}]",
        AVAILABLE_IN_EXPORT,
        per="participant×item",
    ),
    AuditMetric(
        "lag1_autocorrelation",
        "個人内の1日自己相関",
        f"連続する2日がともに観測された組の Pearson 相関。組が{MIN_AUTOCORRELATION_PAIRS}未満、または値が一定なら未定義。",
        "correlation",
        "daily_self_report.items[{item}]",
        AVAILABLE_IN_EXPORT,
        per="participant×item",
    ),
    AuditMetric(
        "text_char_count_mean",
        "文字数",
        "本文のある日の文字数（Unicode のコードポイント数）の平均。本文は原文保持の同意者だけにある。",
        "characters",
        "journal.text",
        REQUIRES_RETENTION,
    ),
    AuditMetric(
        "submission_hour_median",
        "提出時刻",
        "提出時刻（日本時間、時）の中央値。",
        "hour_of_day",
        "journal.submitted_at",
        NOT_IN_EXPORT,
    ),
    AuditMetric(
        "weekday_submission_rate",
        "曜日ごとの提出率",
        "曜日ごとの提出率。28日なので各曜日は4回ずつ。曜日は収集開始日から導くが、開始日は研究 export に無い。",
        "ratio",
        "journal.submitted_at",
        NOT_IN_EXPORT,
        per="participant×weekday",
    ),
    AuditMetric(
        "submission_trend_slope",
        "提出の日数に伴う変化",
        "提出（0/1）を相対日に回帰した最小二乗の傾き（1日あたり）。変化を介入効果と呼ばない。",
        "ratio_per_day",
        "identity.relative_day",
        AVAILABLE_IN_EXPORT,
    ),
    AuditMetric(
        "char_count_trend_slope",
        "文字数の日数に伴う変化",
        f"本文のある日の文字数を相対日に回帰した傾き。{MIN_TREND_POINTS}点未満なら未定義。",
        "characters_per_day",
        "journal.text",
        REQUIRES_RETENTION,
    ),
    AuditMetric(
        "compose_duration",
        "入力時間",
        "この名前のフィールドはコードに無い（data dictionary が DECISION REQUIRED としている）。計算しない。",
        "ms",
        "process_telemetry.fields[compose_duration_ms]",
        NOT_IMPLEMENTED,
    ),
    AuditMetric(
        "pause_count",
        "書き止まり",
        "取得はしているが、取得率と定義が確認できるまで採用しない（#214）。計算しない。",
        "count",
        "process_telemetry.fields[pause_count]",
        NOT_ADOPTED,
    ),
    AuditMetric(
        "revision_count",
        "書き直し",
        "取得はしているが、取得率と定義が確認できるまで採用しない（#214）。計算しない。",
        "count",
        "process_telemetry.fields[revision_count]",
        NOT_ADOPTED,
    ),
)
METRIC_BY_ID = {metric.metric_id: metric for metric in AUDIT_METRICS}


def metric_set_hash() -> str:
    return content_hash([metric.as_dict() for metric in AUDIT_METRICS])


def metric_keys(metric: AuditMetric) -> List[Tuple[str, Optional[str]]]:
    if metric.per == "participant×item":
        return [(f"{metric.metric_id}.{item}", item) for item in ITEM_IDS]
    if metric.per == "participant×weekday":
        return [(f"{metric.metric_id}.{day}", day) for day in WEEKDAYS]
    return [(metric.metric_id, None)]


# --------------------------------------------------------------------------
# The data dictionary cross-check
# --------------------------------------------------------------------------


def _resolve(dictionary: Mapping[str, Any], reference: str) -> Optional[Mapping[str, Any]]:
    node: Any = dictionary
    for part in reference.split("."):
        name, _, selector = part.partition("[")
        node = node.get(name) if isinstance(node, Mapping) else None
        if node is None:
            return None
        if selector:
            wanted = selector.rstrip("]")
            if isinstance(node, Mapping) and "items" in node and name != "items":
                node = node["items"]
            if not isinstance(node, list):
                return None
            node = next((entry for entry in node if entry.get("id") == wanted), None)
            if node is None:
                return None
    return node if isinstance(node, Mapping) else None


def _expected_availability(field: Mapping[str, Any]) -> Tuple[str, ...]:
    if field.get("implementation") == "not_implemented":
        return (NOT_IMPLEMENTED,)
    in_export = field.get("in_export")
    if in_export is True:
        # Implemented and exported: computable, or deliberately not adopted.
        return (AVAILABLE_IN_EXPORT, NOT_ADOPTED)
    if in_export == "pseudonymised_only":
        return (REQUIRES_RETENTION,)
    if in_export == "as_relative_day":
        return (NOT_IN_EXPORT,)
    return (NOT_IN_EXPORT,)


def check_against_dictionary(dictionary: Optional[Mapping[str, Any]] = None) -> List[Dict[str, Any]]:
    """One row per metric (and item): the field it reads and whether availability agrees."""

    if dictionary is None:
        dictionary = json.loads(DATA_DICTIONARY_PATH.read_text(encoding="utf-8"))
    rows: List[Dict[str, Any]] = []
    for metric in AUDIT_METRICS:
        references = (
            [metric.dictionary_ref.format(item=item) for item in ITEM_IDS]
            if "{item}" in metric.dictionary_ref
            else [metric.dictionary_ref]
        )
        for reference in references:
            field = _resolve(dictionary, reference)
            expected = _expected_availability(field) if field is not None else ()
            rows.append(
                {
                    "metric_id": metric.metric_id,
                    "dictionary_ref": reference,
                    "resolved": field is not None,
                    "dictionary_in_export": None if field is None else field.get("in_export"),
                    "dictionary_implementation": None if field is None else field.get("implementation"),
                    "stated_availability": metric.availability,
                    "agrees": field is not None and metric.availability in expected,
                }
            )
    return rows


# --------------------------------------------------------------------------
# Participant-level values
# --------------------------------------------------------------------------


def _runs(flags: Sequence[bool]) -> List[int]:
    """Lengths of consecutive False runs."""

    runs: List[int] = []
    current = 0
    for flag in flags:
        if flag:
            if current:
                runs.append(current)
            current = 0
        else:
            current += 1
    if current:
        runs.append(current)
    return runs


def _slope(days: Sequence[float], values: Sequence[float]) -> Optional[float]:
    if len(days) < MIN_TREND_POINTS:
        return None
    x = np.asarray(days, dtype=float)
    y = np.asarray(values, dtype=float)
    spread = float(np.sum((x - x.mean()) ** 2))
    if spread == 0.0:
        return None
    return float(np.sum((x - x.mean()) * (y - y.mean())) / spread)


def _autocorrelation(series: Mapping[int, float]) -> Optional[float]:
    pairs = [(series[day], series[day + 1]) for day in sorted(series) if day + 1 in series]
    if len(pairs) < MIN_AUTOCORRELATION_PAIRS:
        return None
    left = np.asarray([pair[0] for pair in pairs])
    right = np.asarray([pair[1] for pair in pairs])
    if float(np.std(left)) == 0.0 or float(np.std(right)) == 0.0:
        return None
    return float(np.corrcoef(left, right)[0, 1])


def participant_values(
    dataset: TransferDataset, text_dataset: Optional[TransferDataset] = None
) -> Dict[str, Dict[str, Optional[float]]]:
    """metric key → research code → value (None where undefined or not computable)."""

    study_days = dataset.study_days
    values: Dict[str, Dict[str, Optional[float]]] = {}
    for metric in AUDIT_METRICS:
        for key, _ in metric_keys(metric):
            values[key] = {}

    texts: Dict[Tuple[str, int], str] = {}
    if text_dataset is not None:
        texts = {(r.research_code, r.day_index): r.text for r in text_dataset.records if r.text is not None}

    for enrollment in dataset.enrollments:
        code = enrollment.research_code
        records = dataset.records_for(code)
        by_day = {record.day_index: record for record in records}
        submitted = [day in by_day for day in range(1, study_days + 1)]
        n_submitted = len(records)

        values["submission_rate"][code] = n_submitted / study_days
        answered = [r for r in records if r.self_report is not None and any(v is not None for v in r.self_report)]
        values["self_report_answered_rate"][code] = None if n_submitted == 0 else len(answered) / n_submitted
        missing_runs = _runs(submitted)
        values["longest_missing_run"][code] = float(max(missing_runs)) if missing_runs else 0.0
        values["n_missing_runs"][code] = float(len(missing_runs))

        for item in ITEM_IDS:
            observed = {r.day_index: r.value(item) for r in records if r.value(item) is not None}
            values[f"item_response_rate.{item}"][code] = None if n_submitted == 0 else len(observed) / n_submitted
            series = list(observed.values())
            values[f"within_person_sd.{item}"][code] = float(np.std(series, ddof=1)) if len(series) >= 2 else None
            values[f"lag1_autocorrelation.{item}"][code] = _autocorrelation(observed)

        values["submission_trend_slope"][code] = _slope(
            list(range(1, study_days + 1)), [1.0 if flag else 0.0 for flag in submitted]
        )

        own_texts = [(day, texts[(code, day)]) for day in sorted(by_day) if (code, day) in texts]
        if text_dataset is not None and enrollment.raw_text_retention and own_texts:
            values["text_char_count_mean"][code] = float(np.mean([len(text) for _, text in own_texts]))
            values["char_count_trend_slope"][code] = _slope(
                [day for day, _ in own_texts], [float(len(text)) for _, text in own_texts]
            )
        else:
            values["text_char_count_mean"][code] = None
            values["char_count_trend_slope"][code] = None

        times = [r.submitted_at for r in records if r.submitted_at is not None]
        if times:
            hours = [t.astimezone(JST).hour + t.astimezone(JST).minute / 60.0 for t in times]
            values["submission_hour_median"][code] = float(np.median(hours))
        else:
            values["submission_hour_median"][code] = None

        for index, weekday in enumerate(WEEKDAYS):
            if times and enrollment.start_weekday is not None:
                days = [d for d in range(1, study_days + 1) if (enrollment.start_weekday + d - 1) % 7 == index]
                values[f"weekday_submission_rate.{weekday}"][code] = (
                    sum(1 for d in days if d in by_day) / len(days) if days else None
                )
            else:
                values[f"weekday_submission_rate.{weekday}"][code] = None

        for unsupported in ("compose_duration", "pause_count", "revision_count"):
            values[unsupported][code] = None
    return values


# --------------------------------------------------------------------------
# Summaries over participants
# --------------------------------------------------------------------------


def participant_bootstrap_mean_interval(
    values: Sequence[float], rounds: int, level: float, seed: int
) -> Optional[Tuple[float, float]]:
    """Percentile interval for the mean, resampling participants (one value each)."""

    if len(values) < 3:
        return None
    rng = np.random.default_rng(seed)
    data = np.asarray(values, dtype=float)
    picks = rng.integers(0, len(data), size=(rounds, len(data)))
    means = data[picks].mean(axis=1)
    tail = (1.0 - level) / 2.0
    return float(np.quantile(means, tail)), float(np.quantile(means, 1.0 - tail))


def summarise(values: Mapping[str, Optional[float]], rounds: int, level: float, seed: int) -> Dict[str, Any]:
    defined = [float(value) for _, value in sorted(values.items()) if value is not None]
    undefined = sum(1 for value in values.values() if value is None)
    if not defined:
        return {"n_participants": 0, "n_undefined": undefined}
    array = np.asarray(defined)
    interval = participant_bootstrap_mean_interval(defined, rounds, level, seed)
    return {
        "n_participants": len(defined),
        "n_undefined": undefined,
        "mean": float(array.mean()),
        "median": float(np.median(array)),
        "q1": float(np.quantile(array, 0.25)),
        "q3": float(np.quantile(array, 0.75)),
        "min": float(array.min()),
        "max": float(array.max()),
        "mean_interval": None if interval is None else list(interval),
        "interval_method": None if interval is None else f"participant_bootstrap_percentile_{level:g}",
    }


def run_audit(
    dataset: TransferDataset,
    *,
    manifest: Optional[Mapping[str, Any]] = None,
    bootstrap_rounds: int = 1000,
    interval_level: float = 0.90,
    seed: int = 0,
    **gate_kwargs: Any,
) -> Dict[str, Any]:
    """Admit, compute per participant, summarise over participants."""

    audit_input = admit(dataset, OPERATION_AUDIT, **gate_kwargs)
    text_input = admit(dataset, OPERATION_READ_TEXT, **gate_kwargs)
    per_participant = participant_values(audit_input.dataset, text_input.dataset)
    # Fields the research export lacks are computed only when the input really
    # carries them (the synthetic generator's timestamps and start weekdays).
    # Real data arrives through the export and has neither.
    has_timestamps = any(record.submitted_at is not None for record in audit_input.dataset.records)

    metrics: List[Dict[str, Any]] = []
    for metric in AUDIT_METRICS:
        for key, qualifier in metric_keys(metric):
            if metric.availability in (NOT_IMPLEMENTED, NOT_ADOPTED):
                status = "unsupported"
                summary: Dict[str, Any] = {}
            elif metric.availability == NOT_IN_EXPORT and not has_timestamps:
                status = "unavailable_in_export"
                summary = {}
            else:
                summary = summarise(per_participant[key], bootstrap_rounds, interval_level, seed)
                status = "ok" if summary.get("n_participants") else "not_enough_data"
            metrics.append(
                {
                    "metric_key": key,
                    "metric_id": metric.metric_id,
                    "qualifier": qualifier,
                    "label_ja": metric.label_ja,
                    "unit": metric.unit,
                    "availability": metric.availability,
                    "computable_on": "synthetic_only" if metric.availability == NOT_IN_EXPORT else "synthetic_and_real",
                    "status": status,
                    "summary": summary,
                }
            )

    generator = None
    if manifest is not None:
        generator = {
            "manifest_hash": content_hash(dict(manifest)),
            "dataset_hash": manifest.get("hashes", {}).get("dataset_hash"),
            "post_hoc_adjusted": bool(manifest.get("post_hoc_adjusted", False)),
        }
    return {
        "audit_version": AUDIT_VERSION,
        "transfer_study_version": TRANSFER_STUDY_VERSION,
        "status": CANDIDATE_STATUS,
        "status_ja": CANDIDATE_STATUS_JA,
        "unit_of_analysis": "participant",
        "records_are_not_independent_ja": (
            "記録（最大1,400件）を独立な標本として扱わない。指標は参加者ごとに1つ計算し、"
            "要約と区間は参加者単位で出す。"
        ),
        "dataset_id": audit_input.dataset.dataset_id,
        "dataset_hash": dataset.content_hash(),
        "source_kind": audit_input.dataset.source_kind,
        "generator": generator,
        "metric_set_hash": metric_set_hash(),
        "settings": {
            "bootstrap_rounds": bootstrap_rounds,
            "interval_level": interval_level,
            "seed": seed,
            "min_autocorrelation_pairs": MIN_AUTOCORRELATION_PAIRS,
            "min_trend_points": MIN_TREND_POINTS,
            "note_ja": "区間の設定は事前登録（P3・P8）で決めるまでの仮置き。",
        },
        "n_participants": len(audit_input.dataset.enrollments),
        "n_records": len(audit_input.dataset.records),
        "admission": audit_input.summary(),
        "metrics": metrics,
        "participant_level": {key: dict(sorted(values.items())) for key, values in per_participant.items()},
    }


def public_view(report: Mapping[str, Any], min_participants: int = DEFAULT_MIN_PARTICIPANTS_FOR_PUBLIC) -> Dict[str, Any]:
    """Aggregates only. No participant values, no single-person extremes, no small cells."""

    metrics = []
    for metric in report["metrics"]:
        summary = dict(metric.get("summary") or {})
        summary.pop("min", None)
        summary.pop("max", None)
        suppressed = bool(summary) and summary.get("n_participants", 0) < min_participants
        metrics.append(
            {
                **{key: value for key, value in metric.items() if key != "summary"},
                "summary": {"n_participants": summary.get("n_participants", 0)} if suppressed else summary,
                "suppressed": suppressed,
            }
        )
    public = {key: value for key, value in report.items() if key not in ("participant_level", "metrics")}
    public["metrics"] = metrics
    public["public_threshold"] = {
        "min_participants": min_participants,
        "note_ja": "公開の最小集計単位は未決定（同意表 G7）。この値は仮置き。",
    }
    return public


# --------------------------------------------------------------------------
# Synthetic vs real
# --------------------------------------------------------------------------


def _difference_interval(
    left: Sequence[float], right: Sequence[float], rounds: int, level: float, seed: int
) -> Optional[Tuple[float, float]]:
    if len(left) < 3 or len(right) < 3:
        return None
    rng = np.random.default_rng(seed)
    a = np.asarray(left, dtype=float)
    b = np.asarray(right, dtype=float)
    diffs = a[rng.integers(0, len(a), size=(rounds, len(a)))].mean(axis=1) - b[
        rng.integers(0, len(b), size=(rounds, len(b)))
    ].mean(axis=1)
    tail = (1.0 - level) / 2.0
    return float(np.quantile(diffs, tail)), float(np.quantile(diffs, 1.0 - tail))


def compare_audits(
    synthetic: Mapping[str, Any],
    real: Mapping[str, Any],
    *,
    bootstrap_rounds: int = 1000,
    interval_level: float = 0.90,
    seed: int = 0,
) -> Dict[str, Any]:
    """Real minus synthetic, per pre-fixed metric, at the participant level."""

    if synthetic["metric_set_hash"] != real["metric_set_hash"]:
        raise ContractViolation(
            TransferCode.AUDIT_METRIC_SET_MISMATCH,
            "指標の定義が違う監査どうしは比較しません。指標は事前に固定したものだけを使います。",
            "metric_set_hash",
            {"synthetic": synthetic["metric_set_hash"], "real": real["metric_set_hash"]},
        )
    post_hoc = bool((synthetic.get("generator") or {}).get("post_hoc_adjusted"))
    rows = []
    for metric in synthetic["metrics"]:
        key = metric["metric_key"]
        real_metric = next(m for m in real["metrics"] if m["metric_key"] == key)
        if metric["status"] != "ok" or real_metric["status"] != "ok":
            rows.append(
                {
                    "metric_key": key,
                    "status": "not_comparable",
                    "synthetic_status": metric["status"],
                    "real_status": real_metric["status"],
                }
            )
            continue
        left = [v for v in synthetic["participant_level"][key].values() if v is not None]
        right = [v for v in real["participant_level"][key].values() if v is not None]
        interval = _difference_interval(right, left, bootstrap_rounds, interval_level, seed)
        rows.append(
            {
                "metric_key": key,
                "status": "ok",
                "synthetic_median": metric["summary"]["median"],
                "real_median": real_metric["summary"]["median"],
                "mean_difference_real_minus_synthetic": float(np.mean(right) - np.mean(left)),
                "difference_interval": None if interval is None else list(interval),
                "n_participants": {"synthetic": len(left), "real": len(right)},
            }
        )
    return {
        "comparison": "real_minus_synthetic",
        "unit_of_analysis": "participant",
        "metric_set_hash": synthetic["metric_set_hash"],
        "synthetic_dataset_hash": synthetic["dataset_hash"],
        "real_dataset_hash": real["dataset_hash"],
        "classification": "exploratory_post_hoc_generator" if post_hoc else "pre_fixed_metrics",
        "role_ja": (
            "後から生成器を合わせ直した合成との比較。事前固定の比較と混ぜない。"
            if post_hoc
            else "事前固定の指標による比較。副次か探索かは事前登録 P8 で決める（未決定）。"
        ),
        "rows": rows,
    }


def collect_comparisons(comparisons: Iterable[Mapping[str, Any]]) -> Dict[str, List[Mapping[str, Any]]]:
    """Keep pre-fixed and post-hoc comparisons in separate lists — never one table."""

    grouped: Dict[str, List[Mapping[str, Any]]] = {"pre_fixed_metrics": [], "exploratory_post_hoc_generator": []}
    for comparison in comparisons:
        classification = comparison["classification"]
        if classification not in grouped:
            raise ContractViolation(
                TransferCode.POST_HOC_GENERATOR_MIXED,
                f"未知の比較の種類です: {classification}",
                "classification",
            )
        grouped[classification].append(comparison)
    return grouped
