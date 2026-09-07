"""C3 — ForecastBundle: predictions about the future, and nothing else.

`inference_mode="forecast"` requires every target time to be strictly after the
cutoff. Same-time and past-time estimates are useful and will get their own mode
in a later version, but mixing them into this bundle would let a smoothing
result be scored as if the model had predicted it. That is the single most
flattering mistake available to this project, so the check is structural.

`forecast_id` is stable by construction: the same participant, cutoff, target
set and model artifact yield the same id on a rerun, and C4 and C5 must pass it
through unchanged. That is what makes the sealed prediction ledger checkable —
an id that changed per run would let a second, better prediction quietly replace
a first.

A non-`ok` status carries no numbers. `not_enough_data` with a plausible mean
would be indistinguishable from a real prediction downstream, and every metric
computed over it would be measuring the fallback.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, List, Mapping, Optional, Sequence

from .capabilities import CapabilityFlags
from .common import (
    check_finite,
    content_hash,
    format_time,
    parse_time,
    require,
    require_enum,
    require_fields,
    require_same_length,
)
from .errors import Code, Reason
from .versions import BUNDLE_STATUSES, DISTRIBUTION_METHODS, FORECAST_SCHEMA_VERSION, INFERENCE_MODES

FORECAST_FIELDS = (
    "schema_version",
    "run_id",
    "forecast_id",
    "model_id",
    "encoder_id",
    "dataset_id",
    "split_id",
    "participant_key",
    "cutoff_at",
    "target_times",
    "target_names",
    "target_units",
    "distribution_method",
    "means",
    "scales_or_samples",
    "inference_mode",
    "source_event_ids",
    "capability_flags",
    "status",
    "reasons",
)


def stable_forecast_id(
    *,
    dataset_id: str,
    split_id: str,
    participant_key: str,
    cutoff_at: datetime,
    target_times: Sequence[datetime],
    target_names: Sequence[str],
    model_hash: str,
) -> str:
    """Derive the id from exactly the things that define the prediction.

    Deliberately *not* including the run id or a timestamp: two runs of the same
    configuration are the same prediction and must collide. Deliberately
    including `model_hash` rather than `model_id`: a retrained model under the
    same name is a different prediction and must not.
    """

    digest = content_hash(
        {
            "dataset_id": dataset_id,
            "split_id": split_id,
            "participant_key": participant_key,
            "cutoff_at": format_time(cutoff_at),
            "target_times": [format_time(time) for time in target_times],
            "target_names": list(target_names),
            "model_hash": model_hash,
        }
    )
    return "forecast-" + digest.split(":", 1)[1][:24]


@dataclass
class ForecastBundle:
    run_id: str
    forecast_id: str
    model_id: str
    encoder_id: Optional[str]
    dataset_id: str
    split_id: str
    participant_key: str
    cutoff_at: datetime
    target_times: Sequence[datetime]
    target_names: Sequence[str]
    target_units: Sequence[str]
    distribution_method: str
    means: Sequence[Sequence[float]]
    scales_or_samples: Optional[Any]
    inference_mode: str
    source_event_ids: Sequence[str]
    capability_flags: CapabilityFlags
    status: str = "ok"
    reasons: Sequence[Reason] = field(default_factory=tuple)
    schema_version: str = FORECAST_SCHEMA_VERSION

    def validate(self, path: str = "forecast") -> None:
        require(
            self.schema_version == FORECAST_SCHEMA_VERSION,
            Code.SCHEMA_VERSION_MISMATCH,
            f"forecast schemaの版が違います: {self.schema_version}",
            f"{path}.schema_version",
        )
        require_enum(self.status, BUNDLE_STATUSES, f"{path}.status")
        require_enum(self.inference_mode, INFERENCE_MODES, f"{path}.inference_mode")
        require_enum(self.distribution_method, DISTRIBUTION_METHODS, f"{path}.distribution_method")
        self.capability_flags.validate(f"{path}.capability_flags")
        for name in ("run_id", "forecast_id", "model_id", "dataset_id", "split_id", "participant_key"):
            require(bool(getattr(self, name)), Code.EMPTY_VALUE, f"{name}は空にできません。", f"{path}.{name}")

        require_same_length(self.target_names, self.target_units, f"{path}.target_names", f"{path}.target_units")

        if self.status != "ok":
            require(
                len(self.means) == 0 and not self.scales_or_samples,
                Code.STATUS_PAYLOAD_MISMATCH,
                f"status={self.status}では数値を返しません。計算していない予測を埋めないでください。",
                f"{path}.means",
            )
            require(
                len(self.reasons) > 0,
                Code.MISSING_FIELD,
                "ok以外のstatusには機械可読なreasonsが必要です。",
                f"{path}.reasons",
            )
            return

        require(
            len(self.target_times) > 0 and len(self.target_names) > 0,
            Code.EMPTY_VALUE,
            "status=okならtarget_timesとtarget_namesが必要です。",
            f"{path}.target_times",
        )
        require_same_length(self.target_times, self.means, f"{path}.target_times", f"{path}.means")

        if self.inference_mode == "forecast":
            for index, target_time in enumerate(self.target_times):
                require(
                    target_time > self.cutoff_at,
                    Code.TARGET_NOT_IN_FUTURE,
                    "inference_mode=forecastではtarget_timeがcutoff_atより後である必要があります。",
                    f"{path}.target_times[{index}]",
                    cutoff_at=format_time(self.cutoff_at),
                    target_time=format_time(target_time),
                )

        for horizon, row in enumerate(self.means):
            require(
                len(row) == len(self.target_names),
                Code.SHAPE_MISMATCH,
                f"meansの幅がtarget_namesと違います: {len(row)} != {len(self.target_names)}",
                f"{path}.means[{horizon}]",
            )
            for column, value in enumerate(row):
                check_finite(value, f"{path}.means[{horizon}][{column}]")

        self._validate_uncertainty(path)

    def _validate_uncertainty(self, path: str) -> None:
        horizons, targets = len(self.target_times), len(self.target_names)
        if self.distribution_method == "deterministic":
            require(
                self.scales_or_samples is None,
                Code.UNCERTAINTY_WITHOUT_METHOD,
                "deterministicは不確実性の数値を作りません。点予測に標準偏差を付けると未推定の較正を主張します。",
                f"{path}.scales_or_samples",
            )
            return

        require(
            self.scales_or_samples is not None,
            Code.MISSING_FIELD,
            f"{self.distribution_method}にはscales_or_samplesが必要です。",
            f"{path}.scales_or_samples",
        )
        if self.distribution_method == "gaussian_diag":
            scales = self.scales_or_samples
            require_same_length(self.means, scales, f"{path}.means", f"{path}.scales_or_samples")
            for horizon, row in enumerate(scales):
                require(
                    len(row) == targets,
                    Code.SHAPE_MISMATCH,
                    "scalesの形がmeansと違います。",
                    f"{path}.scales_or_samples[{horizon}]",
                )
                for column, value in enumerate(row):
                    scale = check_finite(value, f"{path}.scales_or_samples[{horizon}][{column}]")
                    require(
                        scale >= 0.0,
                        Code.WRONG_TYPE,
                        "標準偏差は非負です。",
                        f"{path}.scales_or_samples[{horizon}][{column}]",
                    )
            return

        samples = self.scales_or_samples
        require(
            len(samples) > 0,
            Code.EMPTY_VALUE,
            "empirical_samplesにはsampleが必要です。",
            f"{path}.scales_or_samples",
        )
        for sample_index, sample in enumerate(samples):
            require(
                len(sample) == horizons,
                Code.SHAPE_MISMATCH,
                "samplesの形は[sample, horizon, target]です。",
                f"{path}.scales_or_samples[{sample_index}]",
            )
            for horizon, row in enumerate(sample):
                require(
                    len(row) == targets,
                    Code.SHAPE_MISMATCH,
                    "samplesの形は[sample, horizon, target]です。",
                    f"{path}.scales_or_samples[{sample_index}][{horizon}]",
                )
                for column, value in enumerate(row):
                    check_finite(
                        value, f"{path}.scales_or_samples[{sample_index}][{horizon}][{column}]"
                    )

    def as_dict(self) -> Dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "run_id": self.run_id,
            "forecast_id": self.forecast_id,
            "model_id": self.model_id,
            "encoder_id": self.encoder_id,
            "dataset_id": self.dataset_id,
            "split_id": self.split_id,
            "participant_key": self.participant_key,
            "cutoff_at": format_time(self.cutoff_at),
            "target_times": [format_time(time) for time in self.target_times],
            "target_names": list(self.target_names),
            "target_units": list(self.target_units),
            "distribution_method": self.distribution_method,
            "means": [[float(value) for value in row] for row in self.means],
            "scales_or_samples": self.scales_or_samples,
            "inference_mode": self.inference_mode,
            "source_event_ids": list(self.source_event_ids),
            "capability_flags": self.capability_flags.as_dict(),
            "status": self.status,
            "reasons": Reason.list_as_dicts(self.reasons),
        }

    @staticmethod
    def from_dict(payload: Mapping[str, Any], path: str = "forecast") -> "ForecastBundle":
        require_fields(payload, FORECAST_FIELDS, path)
        bundle = ForecastBundle(
            schema_version=str(payload["schema_version"]),
            run_id=str(payload["run_id"]),
            forecast_id=str(payload["forecast_id"]),
            model_id=str(payload["model_id"]),
            encoder_id=payload.get("encoder_id"),
            dataset_id=str(payload["dataset_id"]),
            split_id=str(payload["split_id"]),
            participant_key=str(payload["participant_key"]),
            cutoff_at=parse_time(payload["cutoff_at"], f"{path}.cutoff_at"),
            target_times=tuple(
                parse_time(value, f"{path}.target_times[{index}]")
                for index, value in enumerate(payload["target_times"])
            ),
            target_names=tuple(str(name) for name in payload["target_names"]),
            target_units=tuple(str(unit) for unit in payload["target_units"]),
            distribution_method=str(payload["distribution_method"]),
            means=tuple(tuple(float(value) for value in row) for row in payload["means"]),
            scales_or_samples=payload["scales_or_samples"],
            inference_mode=str(payload["inference_mode"]),
            source_event_ids=tuple(str(value) for value in payload["source_event_ids"]),
            capability_flags=CapabilityFlags.from_dict(
                payload["capability_flags"], f"{path}.capability_flags"
            ),
            status=str(payload["status"]),
            reasons=tuple(Reason.from_dict(item) for item in payload["reasons"]),
        )
        bundle.validate(path)
        return bundle

    def content_hash(self) -> str:
        return content_hash(self.as_dict())


def failed_forecast(
    *,
    run_id: str,
    forecast_id: str,
    model_id: str,
    dataset_id: str,
    split_id: str,
    participant_key: str,
    cutoff_at: datetime,
    status: str,
    reasons: Sequence[Reason],
    capability_flags: CapabilityFlags,
    encoder_id: Optional[str] = None,
    target_names: Sequence[str] = (),
    target_units: Sequence[str] = (),
) -> ForecastBundle:
    """The shape a producer returns when it will not predict.

    Present as a constructor so that "we could not do this" is as easy to emit
    as a number would have been. The cheapest path has to be the honest one.
    """

    bundle = ForecastBundle(
        run_id=run_id,
        forecast_id=forecast_id,
        model_id=model_id,
        encoder_id=encoder_id,
        dataset_id=dataset_id,
        split_id=split_id,
        participant_key=participant_key,
        cutoff_at=cutoff_at,
        target_times=(),
        target_names=tuple(target_names),
        target_units=tuple(target_units),
        distribution_method="deterministic",
        means=(),
        scales_or_samples=None,
        inference_mode="forecast",
        source_event_ids=(),
        capability_flags=capability_flags,
        status=status,
        reasons=tuple(reasons),
    )
    bundle.validate()
    return bundle
