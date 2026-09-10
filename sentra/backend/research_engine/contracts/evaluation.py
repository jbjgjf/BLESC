"""C5 — EvaluationReport and the sealed prediction ledger.

The report is written by the evaluator, not by the model author, and its shape
encodes that separation.

**Hashes, not just names.** `artifact_hashes` must carry `dataset_hash`,
`split_hash`, `config_hash` and `model_hash`. An id is what a human calls the
thing; a hash is what was actually used. A rerun that changed the split but kept
its name is the failure this catches. The report says in its own `limitations`
that a hash confirms content identity and is not a tamper proof — the write
permissions on the ledger are what has to be checked for that.

**A metric may be null, but never unlabelled.** Every metric carries `status`
and a unit and the counts it was computed over. Edge-F1 on data with no defined
true structure is `status="unsupported"` with a reason, not a number that looks
like performance.

**Usage is measured, not estimated.** `provider_calls: 0` is a fact worth
recording — it is the evidence that the pilot's collection-only promise held.
`null` means it could not be measured. The two are different and the type keeps
them different.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, List, Mapping, Optional, Sequence

from .common import (
    check_optional_finite,
    content_hash,
    format_time,
    parse_time,
    require,
    require_enum,
    require_fields,
)
from .errors import Code
from .versions import EVALUATION_MODES, EVALUATION_REPORT_VERSION, LEDGER_SCHEMA_VERSION

REQUIRED_ARTIFACT_HASHES = ("dataset_hash", "split_hash", "config_hash", "model_hash")

METRIC_STATUSES = ("ok", "unsupported", "not_enough_data", "failed")

REPORT_FIELDS = (
    "report_version",
    "run_id",
    "artifact_hashes",
    "dataset_id",
    "split_id",
    "seed_list",
    "baselines",
    "metrics",
    "metrics_by_scenario",
    "unsupported_metrics",
    "leakage_checks",
    "predictions_ref",
    "limitations",
    "measured_usage",
    "reproducibility_command",
    "status",
)


@dataclass(frozen=True)
class Metric:
    name: str
    target: str
    value: Optional[float]
    unit: str
    n_participants: Optional[int]
    n_predictions: Optional[int]
    status: str = "ok"
    uncertainty_method: Optional[str] = None
    interval: Optional[Sequence[float]] = None
    model_id: Optional[str] = None
    reason_ja: Optional[str] = None

    def validate(self, path: str = "metric") -> None:
        require(bool(self.name), Code.EMPTY_VALUE, "metric nameは空にできません。", f"{path}.name")
        require_enum(self.status, METRIC_STATUSES, f"{path}.status")
        check_optional_finite(self.value, f"{path}.value")
        if self.status == "ok":
            require(
                self.value is not None,
                Code.STATUS_PAYLOAD_MISMATCH,
                "status=okのmetricに値がありません。",
                f"{path}.value",
            )
        else:
            require(
                self.value is None,
                Code.STATUS_PAYLOAD_MISMATCH,
                "算出できないmetricはnullと理由で表します。",
                f"{path}.value",
            )
            require(
                bool(self.reason_ja),
                Code.MISSING_FIELD,
                "ok以外のmetricには理由が必要です。",
                f"{path}.reason_ja",
            )
        if self.interval is not None:
            require(
                len(self.interval) == 2,
                Code.SHAPE_MISMATCH,
                "intervalは下限と上限の2要素です。",
                f"{path}.interval",
            )
            lower = check_optional_finite(self.interval[0], f"{path}.interval[0]")
            upper = check_optional_finite(self.interval[1], f"{path}.interval[1]")
            if lower is not None and upper is not None:
                require(lower <= upper, Code.SHAPE_MISMATCH, "intervalの上下が逆です。", f"{path}.interval")
            require(
                bool(self.uncertainty_method),
                Code.UNCERTAINTY_WITHOUT_METHOD,
                "intervalには推定方法が必要です。",
                f"{path}.uncertainty_method",
            )

    def as_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "target": self.target,
            "value": None if self.value is None else float(self.value),
            "unit": self.unit,
            "n_participants": self.n_participants,
            "n_predictions": self.n_predictions,
            "uncertainty_method": self.uncertainty_method,
            "interval": None if self.interval is None else [float(bound) for bound in self.interval],
            "status": self.status,
            "model_id": self.model_id,
            "reason_ja": self.reason_ja,
        }

    @staticmethod
    def from_dict(payload: Mapping[str, Any], path: str = "metric") -> "Metric":
        require_fields(payload, ("name", "target", "value", "unit", "status"), path)
        metric = Metric(
            name=str(payload["name"]),
            target=str(payload["target"]),
            value=payload["value"],
            unit=str(payload["unit"]),
            n_participants=payload.get("n_participants"),
            n_predictions=payload.get("n_predictions"),
            uncertainty_method=payload.get("uncertainty_method"),
            interval=payload.get("interval"),
            status=str(payload["status"]),
            model_id=payload.get("model_id"),
            reason_ja=payload.get("reason_ja"),
        )
        metric.validate(path)
        return metric


@dataclass(frozen=True)
class MeasuredUsage:
    """What the run actually cost. Unmeasured is null; not-used is 0."""

    provider_calls: Optional[int]
    input_tokens: Optional[int]
    output_tokens: Optional[int]
    cached_tokens: Optional[int]
    elapsed_seconds: Optional[float]
    compute_environment: str

    def as_dict(self) -> Dict[str, Any]:
        return {
            "provider_calls": self.provider_calls,
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "cached_tokens": self.cached_tokens,
            "elapsed_seconds": None if self.elapsed_seconds is None else float(self.elapsed_seconds),
            "compute_environment": self.compute_environment,
        }

    @staticmethod
    def from_dict(payload: Mapping[str, Any]) -> "MeasuredUsage":
        return MeasuredUsage(
            provider_calls=payload.get("provider_calls"),
            input_tokens=payload.get("input_tokens"),
            output_tokens=payload.get("output_tokens"),
            cached_tokens=payload.get("cached_tokens"),
            elapsed_seconds=payload.get("elapsed_seconds"),
            compute_environment=str(payload.get("compute_environment", "unknown")),
        )


@dataclass(frozen=True)
class LeakageCheck:
    """One executed check, with its outcome. A check that did not run is not a pass."""

    name: str
    passed: bool
    detail_ja: str
    checked_items: Optional[int] = None

    def as_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "passed": bool(self.passed),
            "detail_ja": self.detail_ja,
            "checked_items": self.checked_items,
        }

    @staticmethod
    def from_dict(payload: Mapping[str, Any]) -> "LeakageCheck":
        return LeakageCheck(
            name=str(payload["name"]),
            passed=bool(payload["passed"]),
            detail_ja=str(payload["detail_ja"]),
            checked_items=payload.get("checked_items"),
        )


@dataclass(frozen=True)
class LedgerEntry:
    """One sealed prediction, appended before any outcome is scored.

    `payload_hash` covers the forecast content; `input_hash` covers what the
    model was given. Recording both is what makes "the prediction did not change
    after we saw the answer" a checkable claim rather than a promise.
    """

    forecast_id: str
    run_id: str
    cutoff_at: datetime
    issued_at: datetime
    target_times: Sequence[datetime]
    model_hash: str
    input_hash: str
    payload_hash: str
    evaluation_mode: str
    schema_version: str = LEDGER_SCHEMA_VERSION

    def validate(self, path: str = "ledger_entry") -> None:
        require_enum(self.evaluation_mode, EVALUATION_MODES, f"{path}.evaluation_mode")
        for name in ("forecast_id", "run_id", "model_hash", "input_hash", "payload_hash"):
            require(bool(getattr(self, name)), Code.EMPTY_VALUE, f"{name}は空にできません。", f"{path}.{name}")

    def as_dict(self) -> Dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "forecast_id": self.forecast_id,
            "run_id": self.run_id,
            "cutoff_at": format_time(self.cutoff_at),
            "issued_at": format_time(self.issued_at),
            "target_times": [format_time(time) for time in self.target_times],
            "model_hash": self.model_hash,
            "input_hash": self.input_hash,
            "payload_hash": self.payload_hash,
            "evaluation_mode": self.evaluation_mode,
        }

    @staticmethod
    def from_dict(payload: Mapping[str, Any], path: str = "ledger_entry") -> "LedgerEntry":
        require_fields(
            payload,
            (
                "forecast_id",
                "run_id",
                "cutoff_at",
                "issued_at",
                "target_times",
                "model_hash",
                "input_hash",
                "payload_hash",
                "evaluation_mode",
            ),
            path,
        )
        entry = LedgerEntry(
            schema_version=str(payload.get("schema_version", LEDGER_SCHEMA_VERSION)),
            forecast_id=str(payload["forecast_id"]),
            run_id=str(payload["run_id"]),
            cutoff_at=parse_time(payload["cutoff_at"], f"{path}.cutoff_at"),
            issued_at=parse_time(payload["issued_at"], f"{path}.issued_at"),
            target_times=tuple(
                parse_time(value, f"{path}.target_times[{index}]")
                for index, value in enumerate(payload["target_times"])
            ),
            model_hash=str(payload["model_hash"]),
            input_hash=str(payload["input_hash"]),
            payload_hash=str(payload["payload_hash"]),
            evaluation_mode=str(payload["evaluation_mode"]),
        )
        entry.validate(path)
        return entry


@dataclass
class EvaluationReport:
    run_id: str
    dataset_id: str
    split_id: str
    artifact_hashes: Mapping[str, str]
    seed_list: Sequence[int]
    baselines: Sequence[str]
    metrics: Sequence[Metric]
    metrics_by_scenario: Mapping[str, Sequence[Metric]]
    unsupported_metrics: Sequence[Metric]
    leakage_checks: Sequence[LeakageCheck]
    predictions_ref: str
    limitations: Sequence[str]
    measured_usage: MeasuredUsage
    reproducibility_command: str
    status: str = "ok"
    report_version: str = EVALUATION_REPORT_VERSION
    generated_at: Optional[datetime] = None

    def validate(self, path: str = "report") -> None:
        require(
            self.report_version == EVALUATION_REPORT_VERSION,
            Code.SCHEMA_VERSION_MISMATCH,
            f"report versionが違います: {self.report_version}",
            f"{path}.report_version",
        )
        missing = [key for key in REQUIRED_ARTIFACT_HASHES if key not in self.artifact_hashes]
        require(
            not missing,
            Code.MISSING_FIELD,
            f"artifact_hashesに必須キーがありません: {', '.join(missing)}",
            f"{path}.artifact_hashes",
            missing=missing,
        )
        require(
            len(self.seed_list) > 0,
            Code.EMPTY_VALUE,
            "seed_listが空です。再現性の初期点検には最低3seedを保存します。",
            f"{path}.seed_list",
        )
        require(
            bool(self.reproducibility_command),
            Code.EMPTY_VALUE,
            "再現コマンドのないreportは受け取りません。",
            f"{path}.reproducibility_command",
        )
        for index, metric in enumerate(self.metrics):
            metric.validate(f"{path}.metrics[{index}]")
        for scenario, metrics in self.metrics_by_scenario.items():
            for index, metric in enumerate(metrics):
                metric.validate(f"{path}.metrics_by_scenario.{scenario}[{index}]")
        for index, metric in enumerate(self.unsupported_metrics):
            metric.validate(f"{path}.unsupported_metrics[{index}]")
            require(
                metric.status != "ok",
                Code.STATUS_PAYLOAD_MISMATCH,
                "unsupported_metricsにstatus=okは入りません。",
                f"{path}.unsupported_metrics[{index}].status",
            )

    @property
    def failed_leakage_checks(self) -> List[LeakageCheck]:
        return [check for check in self.leakage_checks if not check.passed]

    def as_dict(self) -> Dict[str, Any]:
        return {
            "report_version": self.report_version,
            "run_id": self.run_id,
            "dataset_id": self.dataset_id,
            "split_id": self.split_id,
            "artifact_hashes": dict(self.artifact_hashes),
            "seed_list": [int(seed) for seed in self.seed_list],
            "baselines": list(self.baselines),
            "metrics": [metric.as_dict() for metric in self.metrics],
            "metrics_by_scenario": {
                scenario: [metric.as_dict() for metric in metrics]
                for scenario, metrics in self.metrics_by_scenario.items()
            },
            "unsupported_metrics": [metric.as_dict() for metric in self.unsupported_metrics],
            "leakage_checks": [check.as_dict() for check in self.leakage_checks],
            "predictions_ref": self.predictions_ref,
            "limitations": list(self.limitations),
            "measured_usage": self.measured_usage.as_dict(),
            "reproducibility_command": self.reproducibility_command,
            "status": self.status,
            "generated_at": format_time(self.generated_at),
        }

    @staticmethod
    def from_dict(payload: Mapping[str, Any], path: str = "report") -> "EvaluationReport":
        require_fields(payload, REPORT_FIELDS, path)
        report = EvaluationReport(
            report_version=str(payload["report_version"]),
            run_id=str(payload["run_id"]),
            dataset_id=str(payload["dataset_id"]),
            split_id=str(payload["split_id"]),
            artifact_hashes=dict(payload["artifact_hashes"]),
            seed_list=tuple(int(seed) for seed in payload["seed_list"]),
            baselines=tuple(str(name) for name in payload["baselines"]),
            metrics=tuple(
                Metric.from_dict(item, f"{path}.metrics[{index}]")
                for index, item in enumerate(payload["metrics"])
            ),
            metrics_by_scenario={
                scenario: tuple(
                    Metric.from_dict(item, f"{path}.metrics_by_scenario.{scenario}[{index}]")
                    for index, item in enumerate(items)
                )
                for scenario, items in payload["metrics_by_scenario"].items()
            },
            unsupported_metrics=tuple(
                Metric.from_dict(item, f"{path}.unsupported_metrics[{index}]")
                for index, item in enumerate(payload["unsupported_metrics"])
            ),
            leakage_checks=tuple(LeakageCheck.from_dict(item) for item in payload["leakage_checks"]),
            predictions_ref=str(payload["predictions_ref"]),
            limitations=tuple(str(item) for item in payload["limitations"]),
            measured_usage=MeasuredUsage.from_dict(payload["measured_usage"]),
            reproducibility_command=str(payload["reproducibility_command"]),
            status=str(payload["status"]),
            generated_at=(
                parse_time(payload["generated_at"], f"{path}.generated_at")
                if payload.get("generated_at")
                else None
            ),
        )
        report.validate(path)
        return report

    def content_hash(self) -> str:
        return content_hash(self.as_dict())
