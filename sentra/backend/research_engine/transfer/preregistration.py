"""#211 — the pre-registration draft, read as data, and the rule that it cannot freeze early.

The draft lives in `docs/transfer_study_preregistration.md` and humans edit it
there. A second, machine-readable copy (a JSON sidecar, say) would be one more
thing to drift: the reviewer would read one file and the code would check the
other. So the Markdown *is* the structure. Two tables carry it:

- the "未決定" table — one row per research decision (P1–P14), with the
  status, the decision itself, the date and who made it;
- the "凍結記録" table — one row per freeze, with the commit, the document
  hash and the approver.

Both tables have fixed columns. If someone reshapes a table, parsing fails
loudly (`preregistration_structure_changed`) rather than reading the wrong
column as the status — a parser that guessed would let a renamed column
silently turn every row into "decided".

**What freezing means here.** The draft can be frozen only when every required
item is settled *and* says what was settled, when, and by whom. A row that was
deleted counts as open, not as gone: otherwise the shortest path to a freezable
draft is to remove the rows nobody has decided.

**Why the hash leaves out the freeze section.** The freeze record has to quote
the document hash, and the record is inside the document. Hashing everything
would make the hash change the moment it is written down. So the body of the
"凍結記録" section is replaced by a fixed marker before hashing; every other
byte — including the revision log — is covered. Editing any decision after the
freeze changes the hash, and the draft then reads as *not* frozen until a new
freeze row is written for the new content.

**What this module never does** is write a decision or a freeze row. It reads,
reports blockers and computes the hash for a human to copy. Approval is a
person's act and is recorded by that person.

A hash confirms content identity, not authorship: anyone who can edit the file
can edit the record with it. Git history and review are what make the record
mean something, and the procedure document says so.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

from ..contracts.errors import ContractViolation
from .codes import TransferCode

REPO_ROOT = Path(__file__).resolve().parents[4]
PREREGISTRATION_PATH = REPO_ROOT / "docs" / "transfer_study_preregistration.md"

DECISION_HEADING = "## 未決定"
FREEZE_HEADING = "## 凍結記録"

DECISION_COLUMNS: Tuple[str, ...] = ("#", "事項", "状態", "決定内容", "決定日", "決定者")
FREEZE_COLUMNS: Tuple[str, ...] = ("版", "日付", "commit", "文書hash", "承認者", "レビュー者", "備考")

#: Every item the pre-registration must settle. P1–P9 are the draft's own
#: (PR #329); P10–P14 were added for #211 because its specification asks for
#: them and the draft had no row. Removing an id here is a change to what the
#: study pre-registers and needs the same review as editing the document.
REQUIRED_ITEM_IDS: Tuple[str, ...] = tuple(f"P{number}" for number in range(1, 15))

OPEN_STATUSES: Tuple[str, ...] = ("未決定", "未確認")
SETTLED_STATUSES: Tuple[str, ...] = ("決定済み", "確認済み")
KNOWN_STATUSES: Tuple[str, ...] = OPEN_STATUSES + SETTLED_STATUSES

#: Cells read as "not filled in". The document's own convention is a blank
#: cell or 「未記入」; an em dash is what the placeholder freeze row uses.
EMPTY_MARKERS: Tuple[str, ...] = ("", "—", "-", "–", "未記入")

FREEZE_SECTION_MARKER = "<!-- freeze-record section excluded from the document hash -->"

_ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_COMMIT = re.compile(r"^[0-9a-f]{7,40}$")
_HASH = re.compile(r"^sha256:[0-9a-f]{64}$")


def _is_empty(value: str) -> bool:
    return value.strip() in EMPTY_MARKERS


def _valid_date(value: str) -> bool:
    if not _ISO_DATE.match(value.strip()):
        return False
    try:
        date.fromisoformat(value.strip())
    except ValueError:
        return False
    return True


@dataclass(frozen=True)
class DecisionItem:
    item_id: str
    subject: str
    status: str
    decision: str
    decided_on: str
    decided_by: str

    @property
    def is_settled(self) -> bool:
        return (
            self.status in SETTLED_STATUSES
            and not _is_empty(self.decision)
            and _valid_date(self.decided_on)
            and not _is_empty(self.decided_by)
        )

    def as_dict(self) -> Dict[str, Any]:
        return {
            "item_id": self.item_id,
            "subject": self.subject,
            "status": self.status,
            "decision": None if _is_empty(self.decision) else self.decision,
            "decided_on": None if _is_empty(self.decided_on) else self.decided_on,
            "decided_by": None if _is_empty(self.decided_by) else self.decided_by,
            "settled": self.is_settled,
        }


@dataclass(frozen=True)
class FreezeRecord:
    version: str
    frozen_on: str
    commit: str
    document_hash: str
    approver: str
    reviewer: str
    note: str

    @property
    def is_placeholder(self) -> bool:
        """The `— … 未凍結` row the draft carries before any freeze."""

        return all(
            _is_empty(value)
            for value in (self.version, self.frozen_on, self.commit, self.document_hash, self.approver)
        )

    def problems(self) -> List[str]:
        """What is missing or malformed, in words a human can act on."""

        found: List[str] = []
        if _is_empty(self.version):
            found.append("版が空です。")
        if not _valid_date(self.frozen_on):
            found.append("日付が YYYY-MM-DD ではありません。")
        if not _COMMIT.match(self.commit.strip()):
            found.append("commit が16進のハッシュではありません。")
        if not _HASH.match(self.document_hash.strip()):
            found.append("文書hash が sha256:<64桁> ではありません。")
        if _is_empty(self.approver):
            found.append("承認者が空です。")
        if _is_empty(self.reviewer):
            found.append("レビュー者が空です。凍結はレビューを受けた後に行う（草案の冒頭）。")
        return found

    def as_dict(self) -> Dict[str, Any]:
        return {
            "version": self.version,
            "frozen_on": self.frozen_on,
            "commit": self.commit,
            "document_hash": self.document_hash,
            "approver": self.approver,
            "reviewer": self.reviewer,
            "note": self.note,
        }


@dataclass(frozen=True)
class Blocker:
    """One reason the draft cannot be frozen yet."""

    code: str
    item_id: Optional[str]
    message_ja: str

    def as_dict(self) -> Dict[str, Any]:
        return {"code": self.code, "item_id": self.item_id, "message_ja": self.message_ja}


@dataclass(frozen=True)
class Preregistration:
    text: str
    items: Tuple[DecisionItem, ...]
    freeze_records: Tuple[FreezeRecord, ...]
    source: str = "<memory>"

    def item(self, item_id: str) -> Optional[DecisionItem]:
        for candidate in self.items:
            if candidate.item_id == item_id:
                return candidate
        return None

    def content_hash(self) -> str:
        return document_content_hash(self.text)


@dataclass(frozen=True)
class FreezeStatus:
    frozen: bool
    blockers: Tuple[Blocker, ...]
    content_hash: str
    latest_record: Optional[FreezeRecord]
    reasons_ja: Tuple[str, ...] = field(default_factory=tuple)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "frozen": self.frozen,
            "content_hash": self.content_hash,
            "blockers": [blocker.as_dict() for blocker in self.blockers],
            "latest_record": None if self.latest_record is None else self.latest_record.as_dict(),
            "reasons_ja": list(self.reasons_ja),
        }


# --------------------------------------------------------------------------
# Parsing
# --------------------------------------------------------------------------


def _normalise(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\r", "\n")


def _section_bounds(lines: Sequence[str], heading_prefix: str) -> Optional[Tuple[int, int]]:
    """(first body line, end) of the `## ` section whose heading starts with the prefix."""

    start: Optional[int] = None
    for index, line in enumerate(lines):
        if start is None:
            if line.startswith(heading_prefix):
                start = index + 1
            continue
        if line.startswith("## "):
            return start, index
    if start is None:
        return None
    return start, len(lines)


def _split_row(line: str) -> List[str]:
    stripped = line.strip()
    if stripped.startswith("|"):
        stripped = stripped[1:]
    if stripped.endswith("|"):
        stripped = stripped[:-1]
    return [cell.strip() for cell in stripped.split("|")]


def _first_table(lines: Sequence[str], heading: str, columns: Tuple[str, ...]) -> List[Dict[str, str]]:
    bounds = _section_bounds(lines, heading)
    if bounds is None:
        raise ContractViolation(
            TransferCode.PREREGISTRATION_STRUCTURE,
            f"事前登録に「{heading.lstrip('# ')}」の節がありません。",
            heading,
        )
    start, end = bounds
    table: List[str] = []
    for line in lines[start:end]:
        if line.strip().startswith("|"):
            table.append(line)
        elif table:
            break  # first table only; prose after it is not part of the structure
    if len(table) < 2:
        raise ContractViolation(
            TransferCode.PREREGISTRATION_STRUCTURE,
            f"「{heading.lstrip('# ')}」に表がありません。",
            heading,
        )
    header = tuple(_split_row(table[0]))
    if header != columns:
        raise ContractViolation(
            TransferCode.PREREGISTRATION_STRUCTURE,
            "表の列が想定と違います。列を変えるときは preregistration.py とテストも変えてください。",
            heading,
            {"expected": list(columns), "got": list(header)},
        )
    rows: List[Dict[str, str]] = []
    for line in table[2:]:
        cells = _split_row(line)
        if len(cells) != len(columns):
            raise ContractViolation(
                TransferCode.PREREGISTRATION_STRUCTURE,
                f"列の数が合わない行があります（{len(cells)}列、想定{len(columns)}列）。"
                "セルの中に | を書くと列がずれます。",
                heading,
                {"row": line.strip()},
            )
        rows.append(dict(zip(columns, cells)))
    return rows


def parse_preregistration(text: str, source: str = "<memory>") -> Preregistration:
    normalised = _normalise(text)
    lines = normalised.split("\n")
    decision_rows = _first_table(lines, DECISION_HEADING, DECISION_COLUMNS)
    freeze_rows = _first_table(lines, FREEZE_HEADING, FREEZE_COLUMNS)

    items = tuple(
        DecisionItem(
            item_id=row["#"],
            subject=row["事項"],
            status=row["状態"],
            decision=row["決定内容"],
            decided_on=row["決定日"],
            decided_by=row["決定者"],
        )
        for row in decision_rows
    )
    records = tuple(
        FreezeRecord(
            version=row["版"],
            frozen_on=row["日付"],
            commit=row["commit"],
            document_hash=row["文書hash"],
            approver=row["承認者"],
            reviewer=row["レビュー者"],
            note=row["備考"],
        )
        for row in freeze_rows
    )
    return Preregistration(text=normalised, items=items, freeze_records=records, source=source)


def load_preregistration(path: Path = PREREGISTRATION_PATH) -> Preregistration:
    return parse_preregistration(Path(path).read_text(encoding="utf-8"), source=str(path))


def document_content_hash(text: str) -> str:
    """sha256 of the document with the freeze-record body replaced by a marker."""

    lines = _normalise(text).split("\n")
    bounds = _section_bounds(lines, FREEZE_HEADING)
    if bounds is not None:
        start, end = bounds
        lines = list(lines[:start]) + [FREEZE_SECTION_MARKER] + list(lines[end:])
    payload = "\n".join(lines).encode("utf-8")
    return "sha256:" + hashlib.sha256(payload).hexdigest()


# --------------------------------------------------------------------------
# The freeze rule
# --------------------------------------------------------------------------


def freeze_blockers(prereg: Preregistration) -> List[Blocker]:
    """Every reason the draft cannot be frozen, not just the first.

    A reviewer fixing one blocker at a time against a check that reports only
    the first would need fourteen round trips; the list is the to-do list.
    """

    blockers: List[Blocker] = []
    seen: Dict[str, int] = {}
    for item in prereg.items:
        seen[item.item_id] = seen.get(item.item_id, 0) + 1

    for item_id, count in sorted(seen.items()):
        if count > 1:
            blockers.append(
                Blocker("duplicate_item", item_id, f"{item_id} が{count}行あります。どちらが決定か読めません。")
            )

    for required in REQUIRED_ITEM_IDS:
        if required not in seen:
            blockers.append(
                Blocker(
                    "missing_item",
                    required,
                    f"{required} の行がありません。行を消しても決定したことにはなりません。",
                )
            )

    for item in prereg.items:
        if item.status not in KNOWN_STATUSES:
            blockers.append(
                Blocker(
                    "unknown_status",
                    item.item_id,
                    f"{item.item_id} の状態「{item.status}」は使える語ではありません"
                    f"（{'・'.join(KNOWN_STATUSES)}）。",
                )
            )
            continue
        if item.status in OPEN_STATUSES:
            blockers.append(Blocker("open_item", item.item_id, f"{item.item_id} は「{item.status}」です。"))
            continue
        missing = []
        if _is_empty(item.decision):
            missing.append("決定内容")
        if not _valid_date(item.decided_on):
            missing.append("決定日（YYYY-MM-DD）")
        if _is_empty(item.decided_by):
            missing.append("決定者")
        if missing:
            blockers.append(
                Blocker(
                    "incomplete_item",
                    item.item_id,
                    f"{item.item_id} は「{item.status}」ですが、{ '・'.join(missing) } が空です。",
                )
            )
    return blockers


def require_freezable(prereg: Preregistration) -> None:
    """Raise unless every decision is settled and recorded."""

    blockers = freeze_blockers(prereg)
    if blockers:
        raise ContractViolation(
            TransferCode.PREREGISTRATION_NOT_FREEZABLE,
            f"事前登録を凍結できません。未解決が{len(blockers)}件あります。",
            prereg.source,
            {"blockers": [blocker.as_dict() for blocker in blockers]},
        )


def _complete_records(prereg: Preregistration) -> List[FreezeRecord]:
    return [record for record in prereg.freeze_records if not record.is_placeholder]


def freeze_status(prereg: Preregistration) -> FreezeStatus:
    """Frozen means: no blockers, a complete freeze row, and that row's hash is this content."""

    blockers = tuple(freeze_blockers(prereg))
    current = prereg.content_hash()
    records = _complete_records(prereg)
    latest = records[-1] if records else None
    reasons: List[str] = []

    if blockers:
        reasons.append(f"未解決の項目が{len(blockers)}件あります。")
        if latest is not None:
            # A freeze row written while items are still open is itself a
            # problem worth naming: it reads as frozen to anyone who only looks
            # at the table.
            reasons.append("凍結記録に行がありますが、未解決の項目が残っているため凍結とは扱いません。")
    if latest is None:
        reasons.append("凍結記録がありません。")
    else:
        problems = latest.problems()
        reasons.extend(f"凍結記録（{latest.version or '版なし'}）: {problem}" for problem in problems)
        if latest.document_hash.strip() != current:
            reasons.append(
                "凍結記録の文書hashが現在の内容と一致しません。凍結後に本文が変わったなら、"
                "改訂として新しい版の凍結記録が要ります。"
            )

    frozen = (
        not blockers
        and latest is not None
        and not latest.problems()
        and latest.document_hash.strip() == current
    )
    return FreezeStatus(
        frozen=frozen,
        blockers=blockers,
        content_hash=current,
        latest_record=latest,
        reasons_ja=tuple(reasons),
    )


def require_frozen(prereg: Preregistration) -> FreezeStatus:
    """The gate the real-data path calls before it reads a single row."""

    status = freeze_status(prereg)
    if not status.frozen:
        raise ContractViolation(
            TransferCode.PREREGISTRATION_NOT_FROZEN,
            "事前登録が凍結されていません。実データの採点は凍結の後でなければ行いません。",
            prereg.source,
            status.as_dict(),
        )
    return status
