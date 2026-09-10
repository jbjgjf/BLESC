"""C2 — EncodedSequence: the internal state h, and what it is allowed to have seen.

`h_values` has shape `[time, latent_dim]`, one row per surviving observation.
Two rules make it usable by T3 and T4 without either of them re-deriving the
guarantee:

**Each row is built from history only.** Row *t* is a function of observations
with `available_at <= available_times[t]`. A variant that uses later data to
sharpen an earlier state is legitimate and often better, but it is a different
quantity — it is carried as `encoding_mode="smoothing"` and excluded from online
scoring. Both live in the same type so a consumer can check the field instead of
guessing from a filename.

**An empty sequence stays empty.** A participant with nothing visible before the
cutoff yields zero rows, not one row of zeros. A zero vector is a state the
model would then treat as an observation, and "no data" and "all features at
the population mean" are not the same claim.

`quality_flags` carries the honest degradations: short history, heavy masking,
irregular spacing. They travel with the sequence so a metric computed over it
can be reported with the caveat attached rather than discovered later.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, List, Mapping, Optional, Sequence

from .common import (
    check_finite,
    content_hash,
    format_time,
    parse_time,
    require,
    require_enum,
    require_fields,
    require_non_decreasing,
    require_same_length,
)
from .errors import Code
from .versions import ENCODED_SCHEMA_VERSION, ENCODING_MODES, TRAINING_STATUSES

ENCODED_FIELDS = (
    "schema_version",
    "dataset_id",
    "split_id",
    "participant_key",
    "encoder_id",
    "feature_schema_id",
    "normalizer_id",
    "cutoff_at",
    "event_ids",
    "available_times",
    "delta_days",
    "latent_dim",
    "h_values",
    "sequence_mask",
    "quality_flags",
)


@dataclass(frozen=True)
class EncoderDescriptor:
    """The identity of the encoder that produced a sequence.

    Compared field by field before any consumer uses the vectors. Equal
    `latent_dim` alone is not compatibility: the same width can mean a different
    basis after a retrain, and silently accepting it produces a dynamics model
    fitted to coordinates that no longer exist.
    """

    encoder_id: str
    feature_schema_id: str
    normalizer_id: str
    latent_dim: int
    training_status: str = "trained"
    training_data_hash: Optional[str] = None
    config_hash: Optional[str] = None
    seed: Optional[int] = None

    def validate(self, path: str = "encoder") -> None:
        for name in ("encoder_id", "feature_schema_id", "normalizer_id"):
            require(bool(getattr(self, name)), Code.EMPTY_VALUE, f"{name}は空にできません。", f"{path}.{name}")
        require(
            self.latent_dim > 0,
            Code.DIMENSION_MISMATCH,
            "latent_dimは正の整数です。",
            f"{path}.latent_dim",
        )
        require_enum(self.training_status, TRAINING_STATUSES, f"{path}.training_status")

    def require_compatible(self, other: "EncoderDescriptor", path: str = "encoder") -> None:
        for name, code in (
            ("encoder_id", Code.ENCODER_MISMATCH),
            ("feature_schema_id", Code.FEATURE_SCHEMA_MISMATCH),
            ("normalizer_id", Code.NORMALIZER_MISMATCH),
            ("latent_dim", Code.DIMENSION_MISMATCH),
        ):
            mine, theirs = getattr(self, name), getattr(other, name)
            require(
                mine == theirs,
                code,
                f"{name}が一致しません: {mine!r} と {theirs!r}。次元だけの一致は互換と見なしません。",
                f"{path}.{name}",
                expected=mine,
                got=theirs,
            )

    def as_dict(self) -> Dict[str, Any]:
        return {
            "encoder_id": self.encoder_id,
            "feature_schema_id": self.feature_schema_id,
            "normalizer_id": self.normalizer_id,
            "latent_dim": self.latent_dim,
            "training_status": self.training_status,
            "training_data_hash": self.training_data_hash,
            "config_hash": self.config_hash,
            "seed": self.seed,
        }

    @staticmethod
    def from_dict(payload: Mapping[str, Any], path: str = "encoder") -> "EncoderDescriptor":
        require_fields(payload, ("encoder_id", "feature_schema_id", "normalizer_id", "latent_dim"), path)
        descriptor = EncoderDescriptor(
            encoder_id=str(payload["encoder_id"]),
            feature_schema_id=str(payload["feature_schema_id"]),
            normalizer_id=str(payload["normalizer_id"]),
            latent_dim=int(payload["latent_dim"]),
            training_status=str(payload.get("training_status", "trained")),
            training_data_hash=payload.get("training_data_hash"),
            config_hash=payload.get("config_hash"),
            seed=payload.get("seed"),
        )
        descriptor.validate(path)
        return descriptor


@dataclass
class EncodedSequence:
    """One participant's internal-state trajectory up to a cutoff."""

    dataset_id: str
    split_id: str
    participant_key: str
    encoder_id: str
    feature_schema_id: str
    normalizer_id: str
    cutoff_at: datetime
    event_ids: Sequence[str]
    available_times: Sequence[datetime]
    delta_days: Sequence[float]
    latent_dim: int
    h_values: Sequence[Sequence[float]]
    sequence_mask: Sequence[bool]
    quality_flags: Sequence[str] = field(default_factory=tuple)
    encoding_mode: str = "filtering"
    schema_version: str = ENCODED_SCHEMA_VERSION

    def validate(self, path: str = "encoded") -> None:
        require(
            self.schema_version == ENCODED_SCHEMA_VERSION,
            Code.SCHEMA_VERSION_MISMATCH,
            f"encoded schemaの版が違います: {self.schema_version}",
            f"{path}.schema_version",
        )
        require_enum(self.encoding_mode, ENCODING_MODES, f"{path}.encoding_mode")
        require(
            self.latent_dim > 0,
            Code.DIMENSION_MISMATCH,
            "latent_dimは正の整数です。",
            f"{path}.latent_dim",
        )

        length = len(self.event_ids)
        require_same_length(self.event_ids, self.available_times, f"{path}.event_ids", f"{path}.available_times")
        require_same_length(self.event_ids, self.delta_days, f"{path}.event_ids", f"{path}.delta_days")
        require_same_length(self.event_ids, self.h_values, f"{path}.event_ids", f"{path}.h_values")
        require_same_length(self.event_ids, self.sequence_mask, f"{path}.event_ids", f"{path}.sequence_mask")

        require_non_decreasing(list(self.available_times), f"{path}.available_times")
        for index, available_at in enumerate(self.available_times):
            require(
                available_at <= self.cutoff_at,
                Code.FUTURE_LEAKAGE,
                "cutoff_atより後の観測がencodeに入っています。",
                f"{path}.available_times[{index}]",
                cutoff_at=format_time(self.cutoff_at),
                available_at=format_time(available_at),
            )
        for index, delta in enumerate(self.delta_days):
            value = check_finite(delta, f"{path}.delta_days[{index}]")
            require(
                value >= 0.0,
                Code.BAD_TIMESTAMP,
                "delta_daysが負です。経過時間は0以上の日数です。",
                f"{path}.delta_days[{index}]",
            )
        require(
            length == 0 or float(self.delta_days[0]) == 0.0,
            Code.BAD_TIMESTAMP,
            "系列の先頭のdelta_daysは0です。",
            f"{path}.delta_days[0]",
        )

        for row_index, row in enumerate(self.h_values):
            require(
                len(row) == self.latent_dim,
                Code.DIMENSION_MISMATCH,
                f"h_valuesの幅がlatent_dimと違います: {len(row)} != {self.latent_dim}",
                f"{path}.h_values[{row_index}]",
            )
            for column, value in enumerate(row):
                check_finite(value, f"{path}.h_values[{row_index}][{column}]")

    @property
    def is_empty(self) -> bool:
        return len(self.event_ids) == 0

    def as_dict(self) -> Dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "dataset_id": self.dataset_id,
            "split_id": self.split_id,
            "participant_key": self.participant_key,
            "encoder_id": self.encoder_id,
            "feature_schema_id": self.feature_schema_id,
            "normalizer_id": self.normalizer_id,
            "cutoff_at": format_time(self.cutoff_at),
            "event_ids": list(self.event_ids),
            "available_times": [format_time(time) for time in self.available_times],
            "delta_days": [float(value) for value in self.delta_days],
            "latent_dim": self.latent_dim,
            "h_values": [[float(value) for value in row] for row in self.h_values],
            "sequence_mask": [bool(flag) for flag in self.sequence_mask],
            "quality_flags": list(self.quality_flags),
            "encoding_mode": self.encoding_mode,
        }

    @staticmethod
    def from_dict(payload: Mapping[str, Any], path: str = "encoded") -> "EncodedSequence":
        require_fields(payload, ENCODED_FIELDS, path)
        sequence = EncodedSequence(
            schema_version=str(payload["schema_version"]),
            dataset_id=str(payload["dataset_id"]),
            split_id=str(payload["split_id"]),
            participant_key=str(payload["participant_key"]),
            encoder_id=str(payload["encoder_id"]),
            feature_schema_id=str(payload["feature_schema_id"]),
            normalizer_id=str(payload["normalizer_id"]),
            cutoff_at=parse_time(payload["cutoff_at"], f"{path}.cutoff_at"),
            event_ids=tuple(str(value) for value in payload["event_ids"]),
            available_times=tuple(
                parse_time(value, f"{path}.available_times[{index}]")
                for index, value in enumerate(payload["available_times"])
            ),
            delta_days=tuple(float(value) for value in payload["delta_days"]),
            latent_dim=int(payload["latent_dim"]),
            h_values=tuple(tuple(float(value) for value in row) for row in payload["h_values"]),
            sequence_mask=tuple(bool(flag) for flag in payload["sequence_mask"]),
            quality_flags=tuple(str(flag) for flag in payload.get("quality_flags", ())),
            encoding_mode=str(payload.get("encoding_mode", "filtering")),
        )
        sequence.validate(path)
        return sequence

    def content_hash(self) -> str:
        return content_hash(self.as_dict())
