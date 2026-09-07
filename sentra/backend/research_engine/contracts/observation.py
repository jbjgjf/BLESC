"""C1 — ObservationBundle: what was observed, when it became knowable, and what may be done with it.

Three fields carry the weight of this contract and are worth naming up front.

`occurred_at` is when the thing happened, `recorded_at` when someone wrote it
down, and `available_at` when the processing system could first use it. Only the
third one governs leakage: a diary entry about Monday written on Friday must not
be visible to a model forecasting Tuesday, and only `available_at` says so.
`occurred_at` is nullable because for a great many observations nobody knows.

`observed_mask` and `values` are checked against each other rather than trusted
separately. A masked-out feature must be `null`. The failure this prevents is
the one the evaluation plan calls out by name in S4: a pipeline that writes 0.0
for "not mentioned" teaches the model that silence means zero, and every metric
downstream then measures a quantity nobody observed.

`permitted_uses` is a *claim*, not an authorisation. In v0 the loader refuses
anything but synthetic use, and a real dataset is refused outright — the
server-side consent check the contract requires does not exist yet, and a
client-declared permission is exactly what it must not rely on.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence

from .common import (
    canonical_json,
    check_optional_finite,
    content_hash,
    format_time,
    parse_optional_time,
    parse_time,
    require,
    require_enum,
    require_fields,
    require_same_length,
)
from .errors import Code, ContractViolation
from .versions import (
    OBSERVATION_SCHEMA_VERSION,
    PERMITTED_USES_V0,
    SOURCE_KINDS,
)

OBSERVATION_FIELDS = (
    "schema_version",
    "dataset_id",
    "participant_key",
    "event_id",
    "recorded_at",
    "available_at",
    "timezone",
    "feature_schema_id",
    "feature_names",
    "units",
    "values",
    "observed_mask",
    "source_kind",
    "permitted_uses",
)

MANIFEST_FIELDS = (
    "dataset_id",
    "schema_version",
    "feature_schema_id",
    "file_hashes",
    "split_id",
    "split_assignment_ref",
    "generation_or_collection_protocol",
    "permitted_uses",
    "created_at",
)


@dataclass(frozen=True)
class Observation:
    """One row: one participant, one moment, one feature vector."""

    dataset_id: str
    participant_key: str
    event_id: str
    recorded_at: datetime
    available_at: datetime
    timezone: str
    feature_schema_id: str
    feature_names: Sequence[str]
    units: Sequence[str]
    values: Sequence[Optional[float]]
    observed_mask: Sequence[bool]
    source_kind: str
    permitted_uses: Sequence[str]
    occurred_at: Optional[datetime] = None
    source_refs: Sequence[str] = field(default_factory=tuple)
    extractor_version: Optional[str] = None
    consent_snapshot_id: Optional[str] = None
    schema_version: str = OBSERVATION_SCHEMA_VERSION

    def validate(self, path: str = "observation") -> None:
        require(
            self.schema_version == OBSERVATION_SCHEMA_VERSION,
            Code.SCHEMA_VERSION_MISMATCH,
            f"observation schemaの版が違います: {self.schema_version}",
            f"{path}.schema_version",
            expected=OBSERVATION_SCHEMA_VERSION,
        )
        for name in ("dataset_id", "participant_key", "event_id", "feature_schema_id", "timezone"):
            require(bool(getattr(self, name)), Code.EMPTY_VALUE, f"{name}は空にできません。", f"{path}.{name}")

        require_enum(self.source_kind, SOURCE_KINDS, f"{path}.source_kind")
        require(
            len(self.feature_names) > 0,
            Code.EMPTY_VALUE,
            "feature_namesが空です。配列には名前・順序・単位が必要です。",
            f"{path}.feature_names",
        )
        require_same_length(self.feature_names, self.units, f"{path}.feature_names", f"{path}.units")
        require_same_length(self.feature_names, self.values, f"{path}.feature_names", f"{path}.values")
        require_same_length(
            self.feature_names, self.observed_mask, f"{path}.feature_names", f"{path}.observed_mask"
        )
        require(
            len(set(self.feature_names)) == len(self.feature_names),
            Code.FEATURE_SCHEMA_MISMATCH,
            "feature_namesが重複しています。",
            f"{path}.feature_names",
        )

        for index, (observed, value) in enumerate(zip(self.observed_mask, self.values)):
            require(
                isinstance(observed, bool),
                Code.WRONG_TYPE,
                "observed_maskはbooleanです。",
                f"{path}.observed_mask[{index}]",
            )
            if observed:
                require(
                    value is not None,
                    Code.MASK_VALUE_MISMATCH,
                    "observed_mask=trueなのに値がnullです。",
                    f"{path}.values[{index}]",
                )
                check_optional_finite(value, f"{path}.values[{index}]")
            else:
                require(
                    value is None,
                    Code.MASK_VALUE_MISMATCH,
                    "observed_mask=falseの数値はnullでなければなりません。0で埋めると欠測が0という観測に化けます。",
                    f"{path}.values[{index}]",
                )

        require(
            len(self.permitted_uses) > 0,
            Code.EMPTY_VALUE,
            "permitted_usesが空の観測は使えません。",
            f"{path}.permitted_uses",
        )
        if self.source_kind == "derived_extraction":
            require(
                bool(self.extractor_version),
                Code.MISSING_FIELD,
                "derived_extractionには抽出器の版が必要です。",
                f"{path}.extractor_version",
            )
            require(
                len(self.source_refs) > 0,
                Code.MISSING_FIELD,
                "derived_extractionには元観測への参照が必要です。",
                f"{path}.source_refs",
            )
        if self.occurred_at is not None:
            require(
                self.occurred_at <= self.recorded_at,
                Code.BAD_TIMESTAMP,
                "occurred_atがrecorded_atより後です。",
                f"{path}.occurred_at",
            )
        require(
            self.recorded_at <= self.available_at,
            Code.BAD_TIMESTAMP,
            "available_atがrecorded_atより前です。記録前に利用可能にはなりません。",
            f"{path}.available_at",
        )

    def as_dict(self) -> Dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "dataset_id": self.dataset_id,
            "participant_key": self.participant_key,
            "event_id": self.event_id,
            "occurred_at": format_time(self.occurred_at),
            "recorded_at": format_time(self.recorded_at),
            "available_at": format_time(self.available_at),
            "timezone": self.timezone,
            "feature_schema_id": self.feature_schema_id,
            "feature_names": list(self.feature_names),
            "units": list(self.units),
            "values": [None if value is None else float(value) for value in self.values],
            "observed_mask": [bool(flag) for flag in self.observed_mask],
            "source_kind": self.source_kind,
            "source_refs": list(self.source_refs),
            "extractor_version": self.extractor_version,
            "consent_snapshot_id": self.consent_snapshot_id,
            "permitted_uses": list(self.permitted_uses),
        }

    @staticmethod
    def from_dict(payload: Mapping[str, Any], path: str = "observation") -> "Observation":
        require_fields(payload, OBSERVATION_FIELDS, path)
        unknown = set(payload) - set(OBSERVATION_FIELDS) - {
            "occurred_at",
            "source_refs",
            "extractor_version",
            "consent_snapshot_id",
        }
        require(
            not unknown,
            Code.UNKNOWN_FIELD,
            f"未知のフィールドです: {', '.join(sorted(unknown))}",
            path,
            unknown=sorted(unknown),
        )
        observation = Observation(
            schema_version=str(payload["schema_version"]),
            dataset_id=str(payload["dataset_id"]),
            participant_key=str(payload["participant_key"]),
            event_id=str(payload["event_id"]),
            occurred_at=parse_optional_time(payload.get("occurred_at"), f"{path}.occurred_at"),
            recorded_at=parse_time(payload["recorded_at"], f"{path}.recorded_at"),
            available_at=parse_time(payload["available_at"], f"{path}.available_at"),
            timezone=str(payload["timezone"]),
            feature_schema_id=str(payload["feature_schema_id"]),
            feature_names=tuple(str(name) for name in payload["feature_names"]),
            units=tuple(str(unit) for unit in payload["units"]),
            values=tuple(payload["values"]),
            observed_mask=tuple(payload["observed_mask"]),
            source_kind=str(payload["source_kind"]),
            source_refs=tuple(str(ref) for ref in payload.get("source_refs", ())),
            extractor_version=payload.get("extractor_version"),
            consent_snapshot_id=payload.get("consent_snapshot_id"),
            permitted_uses=tuple(str(use) for use in payload["permitted_uses"]),
        )
        observation.validate(path)
        return observation


@dataclass(frozen=True)
class DatasetManifest:
    """The manifest that says which files, which split and which uses."""

    dataset_id: str
    feature_schema_id: str
    file_hashes: Mapping[str, str]
    split_id: str
    split_assignment_ref: str
    generation_or_collection_protocol: str
    permitted_uses: Sequence[str]
    created_at: datetime
    feature_names: Sequence[str] = field(default_factory=tuple)
    units: Sequence[str] = field(default_factory=tuple)
    normalizer_id: Optional[str] = None
    schema_version: str = OBSERVATION_SCHEMA_VERSION

    def validate(self, path: str = "manifest") -> None:
        require(
            self.schema_version == OBSERVATION_SCHEMA_VERSION,
            Code.SCHEMA_VERSION_MISMATCH,
            f"manifestの版が違います: {self.schema_version}",
            f"{path}.schema_version",
        )
        for name in (
            "dataset_id",
            "feature_schema_id",
            "split_id",
            "split_assignment_ref",
            "generation_or_collection_protocol",
        ):
            require(bool(getattr(self, name)), Code.EMPTY_VALUE, f"{name}は空にできません。", f"{path}.{name}")
        require(
            len(self.permitted_uses) > 0,
            Code.EMPTY_VALUE,
            "permitted_usesが空のdatasetは使えません。",
            f"{path}.permitted_uses",
        )
        if self.feature_names and self.units:
            require_same_length(self.feature_names, self.units, f"{path}.feature_names", f"{path}.units")

    def as_dict(self) -> Dict[str, Any]:
        return {
            "dataset_id": self.dataset_id,
            "schema_version": self.schema_version,
            "feature_schema_id": self.feature_schema_id,
            "file_hashes": dict(self.file_hashes),
            "split_id": self.split_id,
            "split_assignment_ref": self.split_assignment_ref,
            "generation_or_collection_protocol": self.generation_or_collection_protocol,
            "permitted_uses": list(self.permitted_uses),
            "created_at": format_time(self.created_at),
            "feature_names": list(self.feature_names),
            "units": list(self.units),
            "normalizer_id": self.normalizer_id,
        }

    @staticmethod
    def from_dict(payload: Mapping[str, Any], path: str = "manifest") -> "DatasetManifest":
        require_fields(payload, MANIFEST_FIELDS, path)
        manifest = DatasetManifest(
            dataset_id=str(payload["dataset_id"]),
            schema_version=str(payload["schema_version"]),
            feature_schema_id=str(payload["feature_schema_id"]),
            file_hashes=dict(payload["file_hashes"]),
            split_id=str(payload["split_id"]),
            split_assignment_ref=str(payload["split_assignment_ref"]),
            generation_or_collection_protocol=str(payload["generation_or_collection_protocol"]),
            permitted_uses=tuple(str(use) for use in payload["permitted_uses"]),
            created_at=parse_time(payload["created_at"], f"{path}.created_at"),
            feature_names=tuple(str(name) for name in payload.get("feature_names", ())),
            units=tuple(str(unit) for unit in payload.get("units", ())),
            normalizer_id=payload.get("normalizer_id"),
        )
        manifest.validate(path)
        return manifest


@dataclass
class ObservationBundle:
    """A manifest plus its rows, checked as a whole.

    Bundle-level checks catch what a row cannot see: a repeated `event_id`
    (re-ingesting the same file must not double-count it) and a feature schema
    that changes halfway through the file.
    """

    manifest: DatasetManifest
    observations: List[Observation]

    def validate(self, path: str = "bundle") -> None:
        self.manifest.validate(f"{path}.manifest")
        seen: Dict[str, int] = {}
        for index, observation in enumerate(self.observations):
            row_path = f"{path}.observations[{index}]"
            observation.validate(row_path)
            require(
                observation.dataset_id == self.manifest.dataset_id,
                Code.FEATURE_SCHEMA_MISMATCH,
                "manifestとdataset_idが一致しません。",
                f"{row_path}.dataset_id",
            )
            require(
                observation.feature_schema_id == self.manifest.feature_schema_id,
                Code.FEATURE_SCHEMA_MISMATCH,
                "manifestとfeature_schema_idが一致しません。次元が同じでも互換とは判断しません。",
                f"{row_path}.feature_schema_id",
            )
            if self.manifest.feature_names:
                require(
                    tuple(observation.feature_names) == tuple(self.manifest.feature_names),
                    Code.FEATURE_SCHEMA_MISMATCH,
                    "manifestとfeature_namesの順序・内容が一致しません。",
                    f"{row_path}.feature_names",
                )
            if observation.event_id in seen:
                raise ContractViolation(
                    Code.DUPLICATE_EVENT_ID,
                    f"event_idが重複しています: {observation.event_id}。再取込で二重に数えません。",
                    f"{row_path}.event_id",
                    {"first_index": seen[observation.event_id]},
                )
            seen[observation.event_id] = index

    @property
    def participants(self) -> List[str]:
        """Participant keys in first-appearance order — stable across reruns."""

        ordered: List[str] = []
        for observation in self.observations:
            if observation.participant_key not in ordered:
                ordered.append(observation.participant_key)
        return ordered

    def visible_at(self, cutoff_at: datetime) -> "ObservationBundle":
        """The sub-bundle a model may see at `cutoff_at`.

        `available_at <= cutoff_at`, and nothing else. Filtering on
        `occurred_at` would let a late-recorded row about an early day through,
        which is precisely the leak the contract forbids.
        """

        return ObservationBundle(
            manifest=self.manifest,
            observations=[row for row in self.observations if row.available_at <= cutoff_at],
        )

    def for_participants(self, keys: Iterable[str]) -> "ObservationBundle":
        wanted = set(keys)
        return ObservationBundle(
            manifest=self.manifest,
            observations=[row for row in self.observations if row.participant_key in wanted],
        )

    def as_dict(self) -> Dict[str, Any]:
        return {
            "manifest": self.manifest.as_dict(),
            "observations": [row.as_dict() for row in self.observations],
        }

    @staticmethod
    def from_dict(payload: Mapping[str, Any], path: str = "bundle") -> "ObservationBundle":
        require_fields(payload, ("manifest", "observations"), path)
        bundle = ObservationBundle(
            manifest=DatasetManifest.from_dict(payload["manifest"], f"{path}.manifest"),
            observations=[
                Observation.from_dict(row, f"{path}.observations[{index}]")
                for index, row in enumerate(payload["observations"])
            ],
        )
        bundle.validate(path)
        return bundle

    def content_hash(self) -> str:
        return content_hash(self.as_dict())


def refuse_unpermitted_uses(
    manifest: DatasetManifest, required_use: str, path: str = "manifest.permitted_uses"
) -> None:
    """The v0 permission boundary.

    Two refusals, both deliberate. A use the manifest does not declare is
    refused; and any use outside the synthetic pair is refused *even if the
    manifest declares it*, because in v0 there is nothing on the server that can
    check a real participant's consent. The contract says not to trust a
    client's self-declaration, and the only way to honour that without the check
    is to decline the whole class of data.
    """

    if required_use not in manifest.permitted_uses:
        raise ContractViolation(
            Code.PERMISSION_NOT_GRANTED,
            f"このdatasetは {required_use} を許可していません。",
            path,
            {"declared": list(manifest.permitted_uses), "required": required_use},
        )
    if required_use not in PERMITTED_USES_V0:
        raise ContractViolation(
            Code.REAL_DATA_REFUSED,
            "v0は合成データ専用です。実データの利用許諾をサーバー側で確認できるまで拒否します。",
            path,
            {"allowed_in_v0": list(PERMITTED_USES_V0), "required": required_use},
        )


def refuse_real_source_kinds(bundle: ObservationBundle, path: str = "bundle") -> None:
    """v0 accepts `synthetic` rows only, whatever the manifest claims."""

    for index, observation in enumerate(bundle.observations):
        if observation.source_kind != "synthetic":
            raise ContractViolation(
                Code.REAL_DATA_REFUSED,
                f"v0はsource_kind={observation.source_kind}を受け取りません。",
                f"{path}.observations[{index}].source_kind",
            )
