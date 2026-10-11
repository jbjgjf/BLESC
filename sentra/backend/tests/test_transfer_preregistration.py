"""#211 — the pre-registration cannot be frozen while anything is still undecided.

Most cases run on small in-memory drafts so that the rule is pinned independently
of what the real draft happens to say today. The checks against the real draft
are written to stay true when a human legitimately freezes it: they assert the
rule ("open items ⇒ not frozen"), not today's state.

Every decision, date and name in these fixtures is fictitious and exists only
inside this file. Nothing here writes to `docs/`.
"""

from __future__ import annotations

from pathlib import Path
from typing import Dict, List, Optional, Sequence

import pytest

from research_engine.contracts.errors import ContractViolation
from research_engine.transfer import cli
from research_engine.transfer.codes import TransferCode
from research_engine.transfer.preregistration import (
    DECISION_COLUMNS,
    FREEZE_COLUMNS,
    PREREGISTRATION_PATH,
    REPO_ROOT,
    REQUIRED_ITEM_IDS,
    document_content_hash,
    freeze_blockers,
    freeze_status,
    load_preregistration,
    parse_preregistration,
    require_freezable,
    require_frozen,
)

FAKE_DECISION = "テスト用の架空の決定"
FAKE_DECIDER = "test-decider（架空）"
FAKE_DATE = "2030-01-01"


def _row(cells: Sequence[str]) -> str:
    return "| " + " | ".join(cells) + " |"


def _item(item_id: str, status: str = "未決定", decision: str = "", decided_on: str = "", decided_by: str = "") -> List[str]:
    return [item_id, f"{item_id} の事項", status, decision, decided_on, decided_by]


def _settled(item_id: str) -> List[str]:
    return _item(item_id, "決定済み", FAKE_DECISION, FAKE_DATE, FAKE_DECIDER)


PLACEHOLDER_FREEZE = ["—", "—", "—", "—", "—", "—", "未凍結"]


def make_doc(
    items: Sequence[Sequence[str]],
    freeze_rows: Optional[Sequence[Sequence[str]]] = None,
    columns: Sequence[str] = DECISION_COLUMNS,
) -> str:
    freeze_rows = list(freeze_rows) if freeze_rows is not None else [PLACEHOLDER_FREEZE]
    lines = [
        "# テスト用の事前登録",
        "",
        "## 未決定（テスト）",
        "",
        _row(columns),
        _row(["---"] * len(columns)),
        *(_row(item) for item in items),
        "",
        "## 凍結記録",
        "",
        _row(FREEZE_COLUMNS),
        _row(["---"] * len(FREEZE_COLUMNS)),
        *(_row(row) for row in freeze_rows),
        "",
        "## 改訂",
        "",
        "| 日付 | 変更 | 理由 |",
        "|---|---|---|",
        "| 2030-01-01 | 架空 | テスト |",
        "",
    ]
    return "\n".join(lines)


def all_settled() -> List[List[str]]:
    return [_settled(item_id) for item_id in REQUIRED_ITEM_IDS]


def frozen_doc(items: Optional[Sequence[Sequence[str]]] = None, reviewer: str = "test-reviewer（架空）") -> str:
    """A draft whose freeze row quotes the hash of its own content."""

    items = list(items) if items is not None else all_settled()
    unfrozen = make_doc(items)
    digest = document_content_hash(unfrozen)
    record = ["v1", FAKE_DATE, "0123456789abcdef0123456789abcdef01234567", digest, "test-approver（架空）", reviewer, "テスト"]
    return make_doc(items, [record])


# --------------------------------------------------------------------------
# The rule itself, on fixtures
# --------------------------------------------------------------------------


def test_a_draft_with_every_item_open_lists_every_item_as_a_blocker() -> None:
    prereg = parse_preregistration(make_doc([_item(item_id) for item_id in REQUIRED_ITEM_IDS]))
    blockers = freeze_blockers(prereg)
    assert [blocker.item_id for blocker in blockers] == list(REQUIRED_ITEM_IDS)
    assert {blocker.code for blocker in blockers} == {"open_item"}
    with pytest.raises(ContractViolation) as caught:
        require_freezable(prereg)
    assert caught.value.code == TransferCode.PREREGISTRATION_NOT_FREEZABLE
    assert len(caught.value.detail["blockers"]) == len(REQUIRED_ITEM_IDS)


def test_one_open_item_is_enough_to_refuse() -> None:
    items = all_settled()
    items[4] = _item("P5")  # the inclusion minimum (protocol §5.1) left open
    prereg = parse_preregistration(make_doc(items))
    blockers = freeze_blockers(prereg)
    assert [(blocker.code, blocker.item_id) for blocker in blockers] == [("open_item", "P5")]
    with pytest.raises(ContractViolation):
        require_freezable(prereg)


def test_unconfirmed_is_open_too() -> None:
    items = all_settled()
    items[8] = _item("P9", "未確認")
    blockers = freeze_blockers(parse_preregistration(make_doc(items)))
    assert [(blocker.code, blocker.item_id) for blocker in blockers] == [("open_item", "P9")]


@pytest.mark.parametrize(
    "decision, decided_on, decided_by, missing",
    [
        ("", FAKE_DATE, FAKE_DECIDER, "決定内容"),
        ("未記入", FAKE_DATE, FAKE_DECIDER, "決定内容"),
        (FAKE_DECISION, "", FAKE_DECIDER, "決定日"),
        (FAKE_DECISION, "2030/01/01", FAKE_DECIDER, "決定日"),
        (FAKE_DECISION, "2030-02-30", FAKE_DECIDER, "決定日"),
        (FAKE_DECISION, FAKE_DATE, "—", "決定者"),
    ],
)
def test_settled_without_what_when_and_who_is_not_settled(decision, decided_on, decided_by, missing) -> None:
    items = all_settled()
    items[0] = _item("P1", "決定済み", decision, decided_on, decided_by)
    blockers = freeze_blockers(parse_preregistration(make_doc(items)))
    assert len(blockers) == 1
    assert blockers[0].code == "incomplete_item"
    assert blockers[0].item_id == "P1"
    assert missing in blockers[0].message_ja


def test_deleting_an_undecided_row_does_not_make_it_decided() -> None:
    items = [item for item in all_settled() if item[0] != "P7"]
    blockers = freeze_blockers(parse_preregistration(make_doc(items)))
    assert [(blocker.code, blocker.item_id) for blocker in blockers] == [("missing_item", "P7")]


def test_a_status_outside_the_vocabulary_is_refused() -> None:
    items = all_settled()
    items[1] = _item("P2", "ほぼ決定", FAKE_DECISION, FAKE_DATE, FAKE_DECIDER)
    blockers = freeze_blockers(parse_preregistration(make_doc(items)))
    assert [(blocker.code, blocker.item_id) for blocker in blockers] == [("unknown_status", "P2")]


def test_a_duplicated_row_is_refused() -> None:
    items = all_settled() + [_item("P3")]
    codes = {(blocker.code, blocker.item_id) for blocker in freeze_blockers(parse_preregistration(make_doc(items)))}
    assert ("duplicate_item", "P3") in codes


def test_a_reshaped_table_fails_loudly_rather_than_reading_the_wrong_column() -> None:
    reshaped = ("#", "事項", "決定内容", "状態", "決定日", "決定者")
    with pytest.raises(ContractViolation) as caught:
        parse_preregistration(make_doc(all_settled(), columns=reshaped))
    assert caught.value.code == TransferCode.PREREGISTRATION_STRUCTURE


def test_a_pipe_inside_a_cell_is_reported_not_misread() -> None:
    items = all_settled()
    items[0] = _item("P1", "決定済み", "A | B", FAKE_DATE, FAKE_DECIDER)
    with pytest.raises(ContractViolation) as caught:
        parse_preregistration(make_doc(items))
    assert caught.value.code == TransferCode.PREREGISTRATION_STRUCTURE


# --------------------------------------------------------------------------
# Frozen = settled + a complete freeze row whose hash is this content
# --------------------------------------------------------------------------


def test_settled_but_unrecorded_is_not_frozen() -> None:
    status = freeze_status(parse_preregistration(make_doc(all_settled())))
    assert status.blockers == ()
    assert status.frozen is False
    assert any("凍結記録がありません" in reason for reason in status.reasons_ja)
    with pytest.raises(ContractViolation) as caught:
        require_frozen(parse_preregistration(make_doc(all_settled())))
    assert caught.value.code == TransferCode.PREREGISTRATION_NOT_FROZEN


def test_settled_and_recorded_with_the_matching_hash_is_frozen() -> None:
    prereg = parse_preregistration(frozen_doc())
    status = require_frozen(prereg)
    assert status.frozen is True
    assert status.latest_record is not None
    assert status.latest_record.document_hash == prereg.content_hash()


def test_writing_the_freeze_row_does_not_change_the_hash_it_quotes() -> None:
    assert document_content_hash(make_doc(all_settled())) == document_content_hash(frozen_doc())


def test_editing_a_decision_after_the_freeze_unfreezes_it() -> None:
    text = frozen_doc()
    edited = text.replace(FAKE_DECISION, FAKE_DECISION + "（後から変更）", 1)
    assert edited != text
    status = freeze_status(parse_preregistration(edited))
    assert status.frozen is False
    assert any("一致しません" in reason for reason in status.reasons_ja)


def test_editing_the_revision_log_after_the_freeze_also_unfreezes_it() -> None:
    edited = frozen_doc().replace("| 2030-01-01 | 架空 | テスト |", "| 2030-01-02 | 架空 | 後から |")
    assert freeze_status(parse_preregistration(edited)).frozen is False


def test_a_freeze_row_written_while_items_are_open_does_not_count() -> None:
    items = all_settled()
    items[0] = _item("P1")
    unfrozen = make_doc(items)
    record = ["v1", FAKE_DATE, "0123456", document_content_hash(unfrozen), "test-approver", "test-reviewer", ""]
    status = freeze_status(parse_preregistration(make_doc(items, [record])))
    assert status.frozen is False
    assert any("未解決の項目が残っている" in reason for reason in status.reasons_ja)


def test_a_freeze_without_a_reviewer_is_not_a_freeze() -> None:
    status = freeze_status(parse_preregistration(frozen_doc(reviewer="")))
    assert status.frozen is False
    assert any("レビュー者" in reason for reason in status.reasons_ja)


def test_crlf_line_endings_do_not_change_the_hash() -> None:
    text = frozen_doc()
    assert document_content_hash(text) == document_content_hash(text.replace("\n", "\r\n"))


# --------------------------------------------------------------------------
# The real draft
# --------------------------------------------------------------------------


def test_the_repository_draft_parses_with_every_required_item() -> None:
    prereg = load_preregistration()
    ids = [item.item_id for item in prereg.items]
    for required in REQUIRED_ITEM_IDS:
        assert required in ids, f"{required} が事前登録にありません"


def test_the_repository_draft_is_not_frozen_while_anything_is_open() -> None:
    prereg = load_preregistration()
    open_items = [item.item_id for item in prereg.items if not item.is_settled]
    status = freeze_status(prereg)
    if open_items:
        assert status.frozen is False
        assert {blocker.item_id for blocker in status.blockers} >= set(open_items)
        with pytest.raises(ContractViolation):
            require_freezable(prereg)
    if status.frozen:
        assert status.blockers == ()


def test_the_cli_status_exits_non_zero_unless_frozen(capsys: pytest.CaptureFixture[str]) -> None:
    code = cli.main(["prereg-status", "--path", str(PREREGISTRATION_PATH)])
    frozen = freeze_status(load_preregistration()).frozen
    assert code == (0 if frozen else 1)
    assert '"frozen"' in capsys.readouterr().out


def test_the_inclusion_minimum_the_protocol_defers_is_an_item_here() -> None:
    # protocol §5.1 says the minimum is decided by #211's pre-registration. If
    # the pre-registration had no row for it, the decision would have nowhere
    # to be recorded, and freezing would not wait for it.
    protocol = (REPO_ROOT / "docs" / "pilot" / "protocol.md").read_text(encoding="utf-8")
    section = protocol.split("### 5.1", 1)[1].split("### 5.2", 1)[0]
    assert "#211" in section
    assert "最低条件" in section

    p5 = load_preregistration().item("P5")
    assert p5 is not None
    assert "解析対象の最低条件" in p5.subject
    assert "§5.1" in p5.subject


def test_the_freeze_procedure_document_exists_and_names_the_commands() -> None:
    procedure = REPO_ROOT / "docs" / "transfer_study_freeze_procedure.md"
    text = procedure.read_text(encoding="utf-8")
    assert "prereg-status" in text
    assert "prereg-hash" in text
    for column in ("文書hash", "承認者", "日付"):
        assert column in text
