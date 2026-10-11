"""#213 — the pilot's data shape, as the transfer study reads it.

The synthetic participants have to look like the pilot's research export, or a
rank difference between synthetic and real could be a difference in the shape
of the data rather than in the models (pre-registration, 「合成参加者の形」).
So the shape is written down once, here, and `tests/test_transfer_schema.py`
checks it against the documents that own it:

- `docs/pilot/data-dictionary.json` — item ids, order, scales, the 1-based
  relative day, which fields are exported and in what form;
- `docs/pilot/protocol.md` — 50 participants, 28 days, one period, five items;
- `sentra/frontend/src/lib/pilotProtocol.ts` — the numbers the app enforces.

The constants are copied rather than read at runtime because the backend must
not depend on the docs tree being present wherever it runs; the test is what
keeps the copies honest.

**No period split.** Since #315 the 28 days are one period. A record has no
phase, baseline or observation column, and `TransferDataset.validate` refuses
one. A split the analysis wants is computed from `day_index` under the
pre-registered plan (P4), never stamped on the data as if participants had been
told about it.

**Missing is `None`.** Every item is optional. An unanswered item is `None`,
never 0 and never the midpoint, and a day with no submission has no record at
all — exactly as the export emits it.

**`submitted_at` is synthetic-only.** The data dictionary exports submission
time only as the relative day (`journal.submitted_at.in_export =
"as_relative_day"`). Synthetic records carry a timestamp so the measurement
audit (#214) can exercise its time-of-day and weekday metrics, but no model
input reads it: a model that used it would be trained on a field the real
export does not have.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

from ..contracts.common import content_hash, format_time, parse_optional_time, require
from ..contracts.errors import Code, ContractViolation
from .codes import TransferCode

REPO_ROOT = Path(__file__).resolve().parents[4]
DATA_DICTIONARY_PATH = REPO_ROOT / "docs" / "pilot" / "data-dictionary.json"
PROTOCOL_PATH = REPO_ROOT / "docs" / "pilot" / "protocol.md"
PILOT_PROTOCOL_TS_PATH = REPO_ROOT / "sentra" / "frontend" / "src" / "lib" / "pilotProtocol.ts"

#: protocol §3 / `PILOT_STUDY_DAYS`. Four whole weeks, one period (#315).
STUDY_DAYS = 28
#: protocol §2 / `PILOT_TARGET_PARTICIPANTS`.
TARGET_PARTICIPANTS = 50
#: `PILOT_MAX_ENTRIES`: at most one record per participant per day.
MAX_ENTRIES = TARGET_PARTICIPANTS * STUDY_DAYS
PROTOCOL_VERSION = "pilot-protocol-v3"
CONSENT_DOCUMENT_VERSION = "research-consent-doc-v3"
SELF_REPORT_SCHEMA_ID = "pilot-selfreport-v1"

SOURCE_SYNTHETIC = "synthetic"
SOURCE_PARTICIPANT = "participant_observation"
SOURCE_KINDS = (SOURCE_SYNTHETIC, SOURCE_PARTICIPANT)


@dataclass(frozen=True)
class SelfReportItem:
    """One of the five fixed daily items (protocol §4.1)."""

    item_id: str
    label_ja: str
    order: int
    value_type: str
    scale: str
    minimum: float
    maximum: float
    step: float
    unit: str

    def accepts(self, value: Optional[float]) -> bool:
        """`None` is always acceptable; a number must be on the scale's grid."""

        if value is None:
            return True
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return False
        number = float(value)
        if number != number or number < self.minimum or number > self.maximum:
            return False
        steps = (number - self.minimum) / self.step
        return abs(steps - round(steps)) < 1e-9

    def quantise(self, value: float) -> float:
        """Clip to the scale and round to its step — what a slider would have recorded."""

        clipped = min(self.maximum, max(self.minimum, float(value)))
        steps = round((clipped - self.minimum) / self.step)
        quantised = self.minimum + steps * self.step
        return float(int(quantised)) if self.value_type == "integer" else float(quantised)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "item_id": self.item_id,
            "label_ja": self.label_ja,
            "order": self.order,
            "value_type": self.value_type,
            "scale": self.scale,
            "minimum": self.minimum,
            "maximum": self.maximum,
            "step": self.step,
            "unit": self.unit,
        }


SELF_REPORT_ITEMS: Tuple[SelfReportItem, ...] = (
    SelfReportItem("mood", "今日の気分", 1, "integer", "likert_0_10", 0.0, 10.0, 1.0, "point_0_10"),
    SelfReportItem("stress", "今日のストレス", 2, "integer", "likert_0_10", 0.0, 10.0, 1.0, "point_0_10"),
    SelfReportItem("sleep_quality", "昨夜の睡眠の質", 3, "integer", "likert_0_10", 0.0, 10.0, 1.0, "point_0_10"),
    SelfReportItem("sleep_hours", "昨夜の睡眠時間", 4, "number", "hours_0_5_step", 0.0, 16.0, 0.5, "hour"),
    SelfReportItem("event_intensity", "今日の出来事の大きさ", 5, "integer", "likert_0_10", 0.0, 10.0, 1.0, "point_0_10"),
)
ITEM_IDS: Tuple[str, ...] = tuple(item.item_id for item in SELF_REPORT_ITEMS)
ITEM_BY_ID: Mapping[str, SelfReportItem] = {item.item_id: item for item in SELF_REPORT_ITEMS}

#: In the data dictionary but not one of the protocol's five: `support_contact`
#: is "DECISION REQUIRED" and deliberately not implemented. Generating it would
#: be deciding it.
UNADOPTED_ITEMS: Tuple[str, ...] = ("support_contact",)

#: Columns no record may carry (#315). Listed by the names they have had or
#: could plausibly be given, so that reintroducing the split under a new name
#: is caught too.
FORBIDDEN_COLUMNS: Tuple[str, ...] = (
    "study_phase",
    "phase",
    "baseline",
    "is_baseline",
    "baseline_days",
    "observation_days",
    "observation_window",
    "period",
    "period_label",
    "split",
)

#: The export fields a model may read. Everything an analysis consumes must be
#: in this list, because it is all the real export will have.
MODEL_INPUT_FIELDS: Tuple[str, ...] = ("research_code", "day_index", "self_report")


@dataclass(frozen=True)
class DailyRecord:
    """One submission: one participant, one relative day."""

    research_code: str
    day_index: int
    self_report: Optional[Tuple[Optional[float], ...]]
    text: Optional[str]
    model_training_use: bool
    submitted_at: Optional[datetime] = None

    def value(self, item_id: str) -> Optional[float]:
        if self.self_report is None:
            return None
        return self.self_report[ITEM_IDS.index(item_id)]

    @property
    def text_available(self) -> bool:
        return self.text is not None

    def validate(self, study_days: int, path: str = "record") -> None:
        require(bool(self.research_code), Code.EMPTY_VALUE, "research_codeが空です。", f"{path}.research_code")
        require(
            isinstance(self.day_index, int) and not isinstance(self.day_index, bool),
            Code.WRONG_TYPE,
            "day_indexは整数です。",
            f"{path}.day_index",
        )
        require(
            1 <= self.day_index <= study_days,
            TransferCode.PROTOCOL_SHAPE_MISMATCH,
            f"day_indexは1〜{study_days}です（1起点、data dictionary の relative_day）。",
            f"{path}.day_index",
            got=self.day_index,
        )
        if self.self_report is not None:
            require(
                len(self.self_report) == len(SELF_REPORT_ITEMS),
                Code.LENGTH_MISMATCH,
                "self_reportは固定5項目です。",
                f"{path}.self_report",
            )
            for item, value in zip(SELF_REPORT_ITEMS, self.self_report):
                require(
                    item.accepts(value),
                    TransferCode.PROTOCOL_SHAPE_MISMATCH,
                    f"{item.item_id} の値 {value!r} は尺度（{item.minimum:g}〜{item.maximum:g}、"
                    f"{item.step:g}刻み）の外です。",
                    f"{path}.self_report.{item.item_id}",
                )

    def as_dict(self) -> Dict[str, Any]:
        return {
            "research_code": self.research_code,
            "day_index": self.day_index,
            "self_report": None
            if self.self_report is None
            else {item_id: value for item_id, value in zip(ITEM_IDS, self.self_report)},
            "text": self.text,
            "text_available": self.text_available,
            "model_training_use": self.model_training_use,
            "submitted_at": format_time(self.submitted_at),
        }

    @staticmethod
    def from_dict(payload: Mapping[str, Any], path: str = "record") -> "DailyRecord":
        forbidden = sorted(set(payload) & set(FORBIDDEN_COLUMNS))
        if forbidden:
            raise ContractViolation(
                TransferCode.PROTOCOL_SHAPE_MISMATCH,
                f"期間の区分を表す列があります: {', '.join(forbidden)}。#315 で区分はなくなりました。",
                path,
                {"forbidden": forbidden},
            )
        report = payload.get("self_report")
        values: Optional[Tuple[Optional[float], ...]]
        if report is None:
            values = None
        else:
            values = tuple(
                None if report.get(item_id) is None else float(report[item_id]) for item_id in ITEM_IDS
            )
        return DailyRecord(
            research_code=str(payload["research_code"]),
            day_index=int(payload["day_index"]),
            self_report=values,
            text=payload.get("text"),
            model_training_use=bool(payload.get("model_training_use", False)),
            submitted_at=parse_optional_time(payload.get("submitted_at"), f"{path}.submitted_at"),
        )


WITHDRAWAL_CHOICES = ("keep", "delete")


@dataclass(frozen=True)
class Enrollment:
    """Per-participant consent and withdrawal state.

    In the pilot this lives in `pilot_enrollments` and `consent_records`, not
    in the research rows; the export uses it to decide which rows exist. The
    synthetic cohort carries it so the consent gate (#212) can be exercised
    end to end on data that is not real.
    """

    research_code: str
    cohort: str
    research_analysis: bool
    raw_text_retention: bool
    model_training_use: bool
    withdrawn_day: Optional[int] = None
    withdrawal_data_choice: Optional[str] = None
    #: 0 = Monday. Operational only: the research export has no calendar.
    start_weekday: Optional[int] = None

    @property
    def withdrawn(self) -> bool:
        return self.withdrawn_day is not None

    def validate(self, study_days: int, path: str = "enrollment") -> None:
        require(bool(self.research_code), Code.EMPTY_VALUE, "research_codeが空です。", f"{path}.research_code")
        if self.withdrawn_day is not None:
            require(
                1 <= self.withdrawn_day <= study_days + 1,
                Code.BAD_TIMESTAMP,
                "撤回日が期間の外です。",
                f"{path}.withdrawn_day",
            )
            require(
                self.withdrawal_data_choice in WITHDRAWAL_CHOICES,
                Code.UNKNOWN_ENUM_VALUE,
                "撤回した参加者の既収集データの扱い（keep/delete）がありません（protocol §5.2）。",
                f"{path}.withdrawal_data_choice",
            )
        else:
            require(
                self.withdrawal_data_choice is None,
                Code.STATUS_PAYLOAD_MISMATCH,
                "撤回していない参加者に撤回時の選択があります。",
                f"{path}.withdrawal_data_choice",
            )

    def as_dict(self) -> Dict[str, Any]:
        return {
            "research_code": self.research_code,
            "cohort": self.cohort,
            "research_analysis": self.research_analysis,
            "raw_text_retention": self.raw_text_retention,
            "model_training_use": self.model_training_use,
            "withdrawn_day": self.withdrawn_day,
            "withdrawal_data_choice": self.withdrawal_data_choice,
            "start_weekday": self.start_weekday,
        }

    @staticmethod
    def from_dict(payload: Mapping[str, Any]) -> "Enrollment":
        return Enrollment(
            research_code=str(payload["research_code"]),
            cohort=str(payload.get("cohort", "")),
            research_analysis=bool(payload["research_analysis"]),
            raw_text_retention=bool(payload["raw_text_retention"]),
            model_training_use=bool(payload["model_training_use"]),
            withdrawn_day=payload.get("withdrawn_day"),
            withdrawal_data_choice=payload.get("withdrawal_data_choice"),
            start_weekday=payload.get("start_weekday"),
        )


@dataclass(frozen=True)
class TransferDataset:
    """What an analysis is handed: records plus enrollment state, and nothing generated-true.

    The generating truth is a different type held by the generator's caller.
    This class has no field that could carry it, so "the truth leaked into the
    model input" would need a code change here, not just a careless call.
    """

    dataset_id: str
    source_kind: str
    records: Tuple[DailyRecord, ...]
    enrollments: Tuple[Enrollment, ...]
    permitted_uses: Tuple[str, ...]
    study_days: int = STUDY_DAYS

    @property
    def participants(self) -> List[str]:
        return sorted(enrollment.research_code for enrollment in self.enrollments)

    def enrollment(self, research_code: str) -> Optional[Enrollment]:
        for candidate in self.enrollments:
            if candidate.research_code == research_code:
                return candidate
        return None

    def validate(self, path: str = "dataset") -> None:
        require(bool(self.dataset_id), Code.EMPTY_VALUE, "dataset_idが空です。", f"{path}.dataset_id")
        require(
            self.source_kind in SOURCE_KINDS,
            Code.UNKNOWN_ENUM_VALUE,
            f"未知のsource_kindです: {self.source_kind}",
            f"{path}.source_kind",
        )
        codes = set()
        for index, enrollment in enumerate(self.enrollments):
            enrollment.validate(self.study_days, f"{path}.enrollments[{index}]")
            require(
                enrollment.research_code not in codes,
                Code.DUPLICATE_EVENT_ID,
                f"research_codeが重複しています: {enrollment.research_code}",
                f"{path}.enrollments[{index}]",
            )
            codes.add(enrollment.research_code)

        seen = set()
        for index, record in enumerate(self.records):
            record.validate(self.study_days, f"{path}.records[{index}]")
            require(
                record.research_code in codes,
                Code.MISSING_FIELD,
                f"登録のない参加者の記録です: {record.research_code}",
                f"{path}.records[{index}].research_code",
            )
            key = (record.research_code, record.day_index)
            require(
                key not in seen,
                Code.DUPLICATE_EVENT_ID,
                "同じ参加者・同じ相対日の記録が2件あります。1日1件です（protocol §4.2）。",
                f"{path}.records[{index}]",
                research_code=record.research_code,
                day_index=record.day_index,
            )
            seen.add(key)
        require(
            len(self.records) <= len(self.enrollments) * self.study_days,
            TransferCode.PROTOCOL_SHAPE_MISMATCH,
            "記録数が参加者数×日数を超えています。",
            f"{path}.records",
        )

    def records_for(self, research_code: str) -> List[DailyRecord]:
        return sorted(
            (record for record in self.records if record.research_code == research_code),
            key=lambda record: record.day_index,
        )

    def replace(
        self,
        *,
        records: Optional[Iterable[DailyRecord]] = None,
        enrollments: Optional[Iterable[Enrollment]] = None,
        dataset_id: Optional[str] = None,
    ) -> "TransferDataset":
        return TransferDataset(
            dataset_id=dataset_id or self.dataset_id,
            source_kind=self.source_kind,
            records=tuple(records) if records is not None else self.records,
            enrollments=tuple(enrollments) if enrollments is not None else self.enrollments,
            permitted_uses=self.permitted_uses,
            study_days=self.study_days,
        )

    def as_dict(self) -> Dict[str, Any]:
        return {
            "dataset_id": self.dataset_id,
            "source_kind": self.source_kind,
            "study_days": self.study_days,
            "permitted_uses": list(self.permitted_uses),
            "enrollments": [enrollment.as_dict() for enrollment in sorted(self.enrollments, key=lambda e: e.research_code)],
            "records": [
                record.as_dict()
                for record in sorted(self.records, key=lambda r: (r.research_code, r.day_index))
            ],
        }

    def content_hash(self) -> str:
        return content_hash(self.as_dict())

    @staticmethod
    def from_dict(payload: Mapping[str, Any]) -> "TransferDataset":
        dataset = TransferDataset(
            dataset_id=str(payload["dataset_id"]),
            source_kind=str(payload["source_kind"]),
            study_days=int(payload.get("study_days", STUDY_DAYS)),
            permitted_uses=tuple(str(use) for use in payload["permitted_uses"]),
            enrollments=tuple(Enrollment.from_dict(row) for row in payload["enrollments"]),
            records=tuple(
                DailyRecord.from_dict(row, f"records[{index}]") for index, row in enumerate(payload["records"])
            ),
        )
        dataset.validate()
        return dataset


def protocol_shape(dataset: TransferDataset) -> Dict[str, Any]:
    """Whether the dataset has the pilot's shape, stated as facts rather than a verdict."""

    return {
        "n_participants": len(dataset.enrollments),
        "study_days": dataset.study_days,
        "n_records": len(dataset.records),
        "max_records": len(dataset.enrollments) * dataset.study_days,
        "protocol_participants": TARGET_PARTICIPANTS,
        "protocol_study_days": STUDY_DAYS,
        "protocol_max_entries": MAX_ENTRIES,
        "matches_protocol": len(dataset.enrollments) == TARGET_PARTICIPANTS and dataset.study_days == STUDY_DAYS,
        "has_period_split_column": bool(set(DailyRecord.__dataclass_fields__) & set(FORBIDDEN_COLUMNS)),
    }
