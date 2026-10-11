"""#213 — the synthetic schema is the pilot's schema, checked against the documents that own it.

`research_engine/transfer/schema.py` copies the shape (28 days, 50 people, five
items and their scales) so the backend does not depend on the docs tree at
runtime. These tests are what stop the copy from drifting: each constant is
compared with `docs/pilot/data-dictionary.json`, `docs/pilot/protocol.md`,
`sentra/frontend/src/lib/pilotProtocol.ts` and the pre-registration draft.
"""

from __future__ import annotations

import json
import re
from typing import Any, Dict, Iterable

import pytest

from research_engine.contracts.errors import ContractViolation
from research_engine.transfer.codes import TransferCode
from research_engine.transfer.generator import SyntheticCohortConfig, generate
from research_engine.transfer.preregistration import PREREGISTRATION_PATH
from research_engine.transfer.schema import (
    CONSENT_DOCUMENT_VERSION,
    DATA_DICTIONARY_PATH,
    FORBIDDEN_COLUMNS,
    ITEM_IDS,
    MAX_ENTRIES,
    MODEL_INPUT_FIELDS,
    PILOT_PROTOCOL_TS_PATH,
    PROTOCOL_PATH,
    PROTOCOL_VERSION,
    SELF_REPORT_ITEMS,
    SELF_REPORT_SCHEMA_ID,
    STUDY_DAYS,
    TARGET_PARTICIPANTS,
    UNADOPTED_ITEMS,
    DailyRecord,
)


@pytest.fixture(scope="module")
def dictionary() -> Dict[str, Any]:
    return json.loads(DATA_DICTIONARY_PATH.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def cohort():
    return generate(SyntheticCohortConfig(seed=3, missingness="state_dependent"))


def _all_keys(value: Any) -> Iterable[str]:
    if isinstance(value, dict):
        for key, inner in value.items():
            yield str(key)
            yield from _all_keys(inner)
    elif isinstance(value, list):
        for inner in value:
            yield from _all_keys(inner)


def _ts_constant(name: str) -> str:
    source = PILOT_PROTOCOL_TS_PATH.read_text(encoding="utf-8")
    match = re.search(rf"export const {name} = ([^;]+);", source)
    assert match, f"{name} が pilotProtocol.ts にありません"
    return match.group(1).strip()


# --------------------------------------------------------------------------
# The period and the cohort size
# --------------------------------------------------------------------------


def test_period_and_size_match_the_app() -> None:
    assert _ts_constant("PILOT_STUDY_DAYS") == str(STUDY_DAYS) == "28"
    assert _ts_constant("PILOT_TARGET_PARTICIPANTS") == str(TARGET_PARTICIPANTS) == "50"
    assert _ts_constant("PILOT_MAX_ENTRIES") == "PILOT_TARGET_PARTICIPANTS * PILOT_STUDY_DAYS"
    assert MAX_ENTRIES == 1400
    assert _ts_constant("PILOT_PROTOCOL_VERSION") == f'"{PROTOCOL_VERSION}"'


def test_period_matches_the_protocol() -> None:
    protocol = PROTOCOL_PATH.read_text(encoding="utf-8")
    assert re.search(rf"^# 研究protocol: {TARGET_PARTICIPANTS}名×{STUDY_DAYS}日", protocol, re.M)
    assert re.search(rf"Day 1-{STUDY_DAYS} +収集期間（{STUDY_DAYS}日）", protocol)
    assert "1,400件" in protocol
    assert "baseline／観察の区分を設けない" in protocol


def test_the_preregistration_states_the_same_conditions() -> None:
    prereg = PREREGISTRATION_PATH.read_text(encoding="utf-8")
    section = prereg.split("## 確定済みの研究条件", 1)[1].split("\n## ", 1)[0]
    assert f"{TARGET_PARTICIPANTS}名" in section
    assert f"**{STUDY_DAYS}日固定**" in section
    assert "1,400件" in section
    assert f"`{PROTOCOL_VERSION}`／`{CONSENT_DOCUMENT_VERSION}`" in section
    assert f"相対日 1〜{STUDY_DAYS}" in prereg


# --------------------------------------------------------------------------
# The relative day and the absence of a period split
# --------------------------------------------------------------------------


def test_relative_day_is_one_based_to_study_days(dictionary, cohort) -> None:
    description = dictionary["identity"]["relative_day"]["description"]
    assert "1起点" in description
    assert "1..study_days" in description
    days = {record.day_index for record in cohort.dataset.records}
    assert min(days) == 1
    assert max(days) == STUDY_DAYS
    assert days <= set(range(1, STUDY_DAYS + 1))


def test_no_record_and_no_dictionary_field_carries_a_period_split(dictionary, cohort) -> None:
    assert "baseline／観察の区分は持たない" in dictionary["identity"]["relative_day"]["description"]
    assert not set(_all_keys(dictionary)) & set(FORBIDDEN_COLUMNS)
    assert not set(DailyRecord.__dataclass_fields__) & set(FORBIDDEN_COLUMNS)
    for record in cohort.dataset.records[:50]:
        assert not set(record.as_dict()) & set(FORBIDDEN_COLUMNS)
    assert cohort.manifest["schema"]["period_split"] is None
    assert cohort.manifest["shape"]["has_period_split_column"] is False


def test_a_record_with_a_phase_column_is_refused() -> None:
    payload = {
        "research_code": "SYN-0-000",
        "day_index": 3,
        "self_report": None,
        "text": None,
        "model_training_use": False,
        "study_phase": "baseline",
    }
    with pytest.raises(ContractViolation) as caught:
        DailyRecord.from_dict(payload)
    assert caught.value.code == TransferCode.PROTOCOL_SHAPE_MISMATCH


@pytest.mark.parametrize("day", [0, STUDY_DAYS + 1, -1])
def test_a_day_outside_one_to_twenty_eight_is_refused(day: int) -> None:
    record = DailyRecord("SYN-0-000", day, None, None, False)
    with pytest.raises(ContractViolation):
        record.validate(STUDY_DAYS)


# --------------------------------------------------------------------------
# The five items
# --------------------------------------------------------------------------


def test_the_five_items_match_the_data_dictionary(dictionary) -> None:
    block = dictionary["daily_self_report"]
    assert block["schema_id"] == SELF_REPORT_SCHEMA_ID
    assert block["presentation_order_is_fixed"] is True
    adopted = [item for item in block["items"] if item["id"] not in UNADOPTED_ITEMS]
    assert [item["id"] for item in adopted] == list(ITEM_IDS)
    for ours, theirs in zip(SELF_REPORT_ITEMS, adopted):
        assert ours.order == theirs["order"]
        assert ours.label_ja == theirs["label_ja"]
        assert ours.scale == theirs["scale"]
        assert ours.value_type == theirs["type"]
        assert theirs["required"] is False
        assert theirs["implementation"] == "implemented"
        if theirs["scale"] == "likert_0_10":
            assert (ours.minimum, ours.maximum, ours.step) == (0.0, 10.0, 1.0)
            assert set(theirs["anchors_ja"]) == {"0", "10"}
        else:
            assert theirs["scale"] == "hours_0_5_step"
            assert [ours.minimum, ours.maximum] == theirs["range"]
            assert ours.step == 0.5


def test_the_unadopted_item_is_undecided_in_the_dictionary_and_never_generated(dictionary, cohort) -> None:
    support = next(item for item in dictionary["daily_self_report"]["items"] if item["id"] == "support_contact")
    assert support["implementation"] == "not_implemented"
    assert "DECISION REQUIRED" in support["description"]
    for record in cohort.dataset.records:
        if record.self_report is not None:
            assert set(record.as_dict()["self_report"]) == set(ITEM_IDS)


def test_the_protocol_lists_the_same_five_items_in_the_same_order() -> None:
    protocol = PROTOCOL_PATH.read_text(encoding="utf-8")
    section = protocol.split("### 4.1", 1)[1].split("### 4.2", 1)[0]
    rows = [line for line in section.splitlines() if re.match(r"^\| [1-9] \|", line)]
    assert len(rows) == len(SELF_REPORT_ITEMS)
    for row, item in zip(rows, SELF_REPORT_ITEMS):
        cells = [cell.strip() for cell in row.strip("|").split("|")]
        assert cells[0] == str(item.order)
        assert cells[3] == "任意"
        if item.scale == "likert_0_10":
            assert cells[2].startswith("0〜10")
        else:
            assert "0.5刻み" in cells[2]
    assert "固定項目は上記5項目のみ" in section


@pytest.mark.parametrize(
    "item_id, value, ok",
    [
        ("mood", None, True),
        ("mood", 0.0, True),
        ("mood", 10.0, True),
        ("mood", 11.0, False),
        ("mood", 5.5, False),
        ("mood", -1.0, False),
        ("sleep_hours", 7.5, True),
        ("sleep_hours", 7.25, False),
        ("sleep_hours", 16.5, False),
    ],
)
def test_values_are_on_the_scale_or_none(item_id: str, value, ok: bool) -> None:
    report = [None] * len(ITEM_IDS)
    report[ITEM_IDS.index(item_id)] = value
    record = DailyRecord("SYN-0-000", 1, tuple(report), None, False)
    if ok:
        record.validate(STUDY_DAYS)
    else:
        with pytest.raises(ContractViolation):
            record.validate(STUDY_DAYS)


def test_every_generated_value_is_on_its_scale(cohort) -> None:
    for record in cohort.dataset.records:
        record.validate(STUDY_DAYS)


# --------------------------------------------------------------------------
# What a model may read
# --------------------------------------------------------------------------


def test_model_inputs_are_fields_the_research_export_actually_has(dictionary) -> None:
    # The dictionary exports submission time only as the relative day. A model
    # that read `submitted_at` would be fitted on a field the real export
    # does not carry, and its synthetic score would not transfer by design.
    assert dictionary["journal"]["submitted_at"]["in_export"] == "as_relative_day"
    assert "submitted_at" not in MODEL_INPUT_FIELDS
    assert dictionary["identity"]["research_code"]["in_export"] is True
    assert dictionary["identity"]["relative_day"]["export_field"] == "day_index"
    assert set(MODEL_INPUT_FIELDS) == {"research_code", "day_index", "self_report"}
