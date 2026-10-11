"""One rater's labelling session: what the local labelling screen shows and saves (#127).

The CLI (`scripts/run_benchmark_labelling.py`) hands a rater a JSON file and
takes it back. That works, and it asks a rater to make about 2,400 judgements
by editing lists of ids in a text editor. The screen
(`scripts/run_benchmark_labelling_screen.py`) is the same protocol with a page
in front of it, and this module is everything about it that is not HTML.

What it guarantees, each one pinned by a test:

**Nothing is pre-selected.** A case opens with no day ticked unless THIS rater
ticked it earlier. The drafted key is never read here; showing it as a default
would turn a label into a confirmation of the draft, which is what #88 forbids
a model's answer from becoming. There is no switch to show drafts either: a
rater who wants a second opinion should not get the author's.

**A rater only ever sees their own labels.** A session is opened for one rater
id and reads and writes exactly one file, `benchmark_labels/raters/<rater>.json`.
Nothing here lists other raters or opens their files, so the second rater on the
agreement sample cannot see the first rater's choices through this module. (On a
shared machine nothing stops someone opening the other file by hand; the
runbook says to keep the two raters' files apart until both are done.)

**The held-out split comes last.** The default order is train, then
validation, then test (#127: the less of the held-out set anyone has looked at
while earlier cases are still being argued about, the better). Within a split
the order is a hash, so the en and ja versions of one matched pair do not sit
next to each other: labelling a translation straight after its original would
turn the second judgement into a copy of the first.

**Interrupting loses nothing.** Every save rewrites the rater file atomically,
and opening a session on an existing file resumes from it.

The file is the same shape the CLI exports, in display ids (`k01`...), so it
can be imported, adjudicated and applied exactly like one filled in by hand.
"""

from __future__ import annotations

import json
import os
import re
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Sequence

from .benchmark_cases import BENCHMARK_CASES, BenchmarkCase
from .benchmark_cases._splits import SPLITS
from .benchmark_label_store import (
    DEFAULT_STORE,
    LabelStoreError,
    export_path,
    read_labelling_file,
    validate_rows,
)
from .benchmark_labelling import (
    DATASET_VERSION,
    _shuffle_key,
    agreement_sample,
    display_ids,
    labelling_file,
    labelling_task,
)

#: Who a session is for. Becomes a file name, so it is held to a safe shape.
RATER_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")

#: `main` is the first rater's pass: every drafted case, plus any case in the
#: pre-drawn agreement sample (one of which is a development case — without it
#: the coefficient would be measured over 19 cases, not the 20 fixed in
#: advance). `sample` is the second rater's pass. `all` adds the development
#: cases, which the pre-registration excludes from the confirmatory analysis.
SCOPES = ("main", "sample", "all")

NONE = "none"


def scope_cases(
    scope: str = "main",
    split: Optional[str] = None,
    cases: Sequence[BenchmarkCase] = BENCHMARK_CASES,
) -> List[BenchmarkCase]:
    """The cases one session covers, in the order a rater meets them."""
    if scope not in SCOPES:
        raise ValueError(f"scope must be one of {SCOPES}, not {scope!r}")
    if split is not None and split not in SPLITS:
        raise ValueError(f"split must be one of {SPLITS}, not {split!r}")

    sample_ids = {case.case_id for case in agreement_sample(cases=cases)}
    if scope == "sample":
        chosen = [case for case in cases if case.case_id in sample_ids]
    elif scope == "main":
        chosen = [case for case in cases if case.labelled_by == "draft" or case.case_id in sample_ids]
    else:
        chosen = list(cases)
    if split is not None:
        chosen = [case for case in chosen if case.split == split]
    return default_order(chosen)


def default_order(cases: Sequence[BenchmarkCase]) -> List[BenchmarkCase]:
    """Train, then validation, then test; hash order within a split, with no
    matched pair back to back.

    A hash alone puts a few en/ja twins next to each other by chance, so a
    second pass moves the later twin to the next position where it is not
    adjacent to its partner. Still deterministic, and still within its split.
    """
    rank = {name: index for index, name in enumerate(SPLITS)}
    ordered = sorted(
        cases, key=lambda case: (rank.get(case.split, len(SPLITS)), _shuffle_key("order", case.case_id))
    )
    for index in range(1, len(ordered)):
        if ordered[index].pair_id is None or ordered[index].pair_id != ordered[index - 1].pair_id:
            continue
        for later in range(index + 1, len(ordered)):
            candidate = ordered[later]
            if candidate.split != ordered[index].split:
                break
            if candidate.pair_id != ordered[index - 1].pair_id:
                ordered[index], ordered[later] = ordered[later], ordered[index]
                break
    return ordered


@dataclass(frozen=True)
class CaseView:
    """One case as the screen renders it. Built from `labelling_task` only."""

    index: int
    total: int
    case_id: str
    lang: str
    query: str
    instruction: str
    candidates: List[Dict[str, object]]
    #: This rater's saved selection, in display ids. Empty means unlabelled.
    selected: List[str]
    state: str  # "unlabelled" | "labelled" | "none"


class LabellingSession:
    """One rater, one file, resumable."""

    def __init__(
        self,
        rater_id: str,
        store: Path = DEFAULT_STORE,
        scope: str = "main",
        split: Optional[str] = None,
        cases: Sequence[BenchmarkCase] = BENCHMARK_CASES,
    ) -> None:
        if not RATER_ID.match(rater_id or ""):
            raise ValueError(
                f"rater id {rater_id!r} must be letters, digits, '-' or '_' (it becomes a file name)"
            )
        self.rater_id = rater_id
        self.store = Path(store)
        self.path = export_path(self.store, rater_id)
        self._all_cases = list(cases)
        self._by_id = {case.case_id: case for case in self._all_cases}
        self.cases = scope_cases(scope, split, self._all_cases)
        self._lock = threading.Lock()
        self._rows: Dict[str, Dict[str, object]] = self._load()

    # ---- loading and saving ------------------------------------------------

    def _load(self) -> Dict[str, Dict[str, object]]:
        rows: Dict[str, Dict[str, object]] = {}
        if self.path.is_file():
            existing = read_labelling_file(self.path)
            problems = validate_rows(existing, self._all_cases)
            if problems:
                raise LabelStoreError("\n".join([f"{self.path}: cannot resume", *problems]))
            for row in existing:
                if str(row.get("rater_id")) != self.rater_id:
                    raise LabelStoreError(
                        f"{self.path} belongs to rater {row.get('rater_id')!r}, not {self.rater_id!r}"
                    )
                rows[str(row["case_id"])] = self._normalised(row)
        # Cases in scope with no row yet get a fresh, empty one. Rows outside
        # the scope (an earlier pass over a different scope) are kept as they
        # are and written back untouched.
        for fresh in labelling_file(self.rater_id, [case for case in self.cases if case.case_id not in rows]):
            rows[str(fresh["case_id"])] = fresh
        return rows

    def _normalised(self, row: Dict[str, object]) -> Dict[str, object]:
        """A resumed row, with any internal ids turned into display ids.

        A file written by tooling may carry the case's own ids; the screen only
        ever shows display ids, so it converts rather than showing an id that
        names the drafted role.
        """
        case = self._by_id[str(row["case_id"])]
        shown = display_ids(case)
        picks = [str(pick) for pick in (row.get("selected_evidence_ids") or [])]
        row = {**labelling_file(self.rater_id, [case])[0], "selected_evidence_ids": picks}
        if picks != [NONE]:
            row["selected_evidence_ids"] = sorted(shown.get(pick, pick) for pick in picks)
        return row

    def _write(self) -> None:
        ordered = [self._rows[case.case_id] for case in self._all_cases if case.case_id in self._rows]
        problems = validate_rows(ordered, self._all_cases)
        if problems:  # never write a file the importer would refuse
            raise LabelStoreError("\n".join(problems))
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_name(f".{self.path.name}.tmp")
        temporary.write_text(json.dumps(ordered, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(temporary, self.path)

    # ---- what the screen asks for -------------------------------------------

    @property
    def total(self) -> int:
        return len(self.cases)

    def index_of(self, case_id: str) -> int:
        for index, case in enumerate(self.cases):
            if case.case_id == case_id:
                return index
        raise KeyError(case_id)

    def view(self, index: int) -> CaseView:
        case = self.cases[index]
        task = labelling_task(case)
        picks = list(self._rows[case.case_id].get("selected_evidence_ids") or [])
        state = "unlabelled" if not picks else (NONE if picks == [NONE] else "labelled")
        return CaseView(
            index=index,
            total=self.total,
            case_id=case.case_id,
            lang=str(task["lang"]),
            query=str(task["query"]),
            instruction=str(task["instruction"]),
            candidates=list(task["candidates"]),
            selected=[] if picks == [NONE] else picks,
            state=state,
        )

    def done(self) -> int:
        return sum(1 for case in self.cases if self._rows[case.case_id].get("selected_evidence_ids"))

    def next_unlabelled(self, after: int = -1) -> Optional[int]:
        """The first case after `after` with no label, wrapping round once."""
        order = list(range(after + 1, self.total)) + list(range(0, after + 1))
        for index in order:
            if not self._rows[self.cases[index].case_id].get("selected_evidence_ids"):
                return index
        return None

    def record(self, case_id: str, selected: Sequence[str], nothing_helps: bool = False) -> None:
        """Save this rater's judgement on one case, and write the file.

        `selected` is display ids. `nothing_helps` records `["none"]` — a
        judgement that no day helps, which is not the same as leaving the case
        unlabelled. Both at once is refused rather than guessed at.
        """
        if case_id not in self._rows or case_id not in {case.case_id for case in self.cases}:
            raise KeyError(f"{case_id} is not in this session")
        case = self._by_id[case_id]
        shown = set(display_ids(case).values())
        picks = sorted({str(pick) for pick in selected})
        unknown = [pick for pick in picks if pick not in shown]
        if unknown:
            raise ValueError(f"{case_id}: {unknown} are not candidates shown for this case")
        if nothing_helps and picks:
            raise ValueError(f"{case_id}: 'nothing helps' cannot be combined with a selection")
        with self._lock:
            self._rows[case_id] = {**self._rows[case_id], "selected_evidence_ids": [NONE] if nothing_helps else picks}
            self._write()

    def summary(self) -> Dict[str, object]:
        return {
            "rater_id": self.rater_id,
            "file": str(self.path),
            "dataset_version": DATASET_VERSION,
            "cases": self.total,
            "labelled": self.done(),
            "judgements": sum(len(case.evidence) for case in self.cases),
        }
