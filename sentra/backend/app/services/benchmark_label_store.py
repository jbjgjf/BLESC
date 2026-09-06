"""Where rater files live, and how a labelled dataset is assembled from them (#126).

`benchmark_labelling` is deliberately pure: it says what a rater is shown, how
two raters are compared and how a drafted key becomes an answer key, and it
touches no disk. That left a gap. Every function needed to run the labelling
existed and nothing connected them to a file, so the work could only be done
from a Python prompt, and a finished rater file had no route into a benchmark
run — `apply_human_labels()` had no caller outside its own test.

This module is that route. It owns one directory:

    benchmark_labels/
      raters/<rater_id>.json   one returned labelling file, exactly as sent back
      adjudication.json        recorded resolutions, and who signed the labels off

Two decisions worth stating, because both could reasonably have gone the other
way:

**The store is version-controlled.** It holds the answer key to a synthetic
benchmark, not anyone's data, and a result that cannot be regenerated from the
repository is not reproducible. `benchmark_cases/` stays code and this stays
data, so a label is never edited by editing a case file.

**Absence is a state, not an error.** With no store, `resolve_dataset()` returns
the drafted cases and says so. The benchmark then runs exactly as it does today
and reports PRELIMINARY, rather than refusing to run until someone has labelled
82 cases.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Sequence, Set, Tuple

from .benchmark_cases import BENCHMARK_CASES, BenchmarkCase
from .benchmark_labelling import (
    AgreementResult,
    Adjudication,
    RaterLabels,
    adjudicate,
    agreement_sample,
    apply_human_labels,
    cohens_kappa,
    labelling_file,
    read_rater_labels,
)

#: `sentra/backend/benchmark_labels`. Beside the code that reads it rather than
#: under `app/`, so it is visibly not importable and cannot be edited by
#: accident while editing a case.
DEFAULT_STORE = Path(__file__).resolve().parents[2] / "benchmark_labels"

RATERS_DIRNAME = "raters"
ADJUDICATION_FILENAME = "adjudication.json"


class LabelStoreError(RuntimeError):
    """A rater file that cannot be trusted. Never recovered from silently."""


@dataclass(frozen=True)
class LabelledDataset:
    """The case set a benchmark run should use, and where it came from."""

    cases: List[BenchmarkCase]
    agreement: AgreementResult | None
    reviewer: str | None
    raters: List[str]
    #: Cases two raters labelled differently with no resolution recorded. They
    #: keep their drafted keys, so they are excluded rather than guessed at.
    disputed: List[str]
    #: `"drafted"` when no rater file exists at all.
    source: str


# ---------------------------------------------------------------------------
# Writing a task out, reading a rater's answers back
# ---------------------------------------------------------------------------


def export_path(store: Path, rater_id: str) -> Path:
    return store / RATERS_DIRNAME / f"{rater_id}.json"


def write_labelling_file(
    rater_id: str,
    path: Path,
    cases: Sequence[BenchmarkCase] = BENCHMARK_CASES,
) -> Path:
    """The file a rater fills in. Contains no answer — see `labelling_task`."""
    path.parent.mkdir(parents=True, exist_ok=True)
    rows = labelling_file(rater_id, cases)
    path.write_text(json.dumps(rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path


def read_labelling_file(path: Path) -> List[Dict[str, object]]:
    try:
        rows = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise LabelStoreError(f"{path}: not valid JSON — {error}") from error
    if not isinstance(rows, list):
        raise LabelStoreError(f"{path}: expected a list of rows, found {type(rows).__name__}")
    return rows


def validate_rows(rows: Sequence[Dict[str, object]], cases: Sequence[BenchmarkCase] = BENCHMARK_CASES) -> List[str]:
    """Everything wrong with a returned file, rather than the first thing.

    A rater works through a file once. Reporting one problem per run would send
    them back through it repeatedly for faults that were all visible at the
    start.
    """
    by_id = {case.case_id: case for case in cases}
    problems: List[str] = []

    for index, row in enumerate(rows):
        where = f"row {index}"
        case_id = str(row.get("case_id", ""))
        if not case_id:
            problems.append(f"{where}: no case_id")
            continue
        where = f"{case_id}"
        case = by_id.get(case_id)
        if case is None:
            problems.append(f"{where}: not a case in this dataset")
            continue
        if "selected_evidence_ids" not in row:
            problems.append(f"{where}: no selected_evidence_ids field — the file was not filled in")
            continue
        picks = row.get("selected_evidence_ids")
        if not isinstance(picks, list):
            problems.append(f"{where}: selected_evidence_ids must be a list")
            continue
        known = {day.evidence_id for day in case.evidence}
        unknown = [str(pick) for pick in picks if str(pick) not in known and str(pick) != "none"]
        if unknown:
            problems.append(f"{where}: selected {sorted(unknown)}, which are not candidates of this case")
        if "none" in [str(pick) for pick in picks] and len(picks) > 1:
            problems.append(f"{where}: 'none' means nothing helps, so it cannot be combined with a selection")

    seen: Set[str] = set()
    for row in rows:
        case_id = str(row.get("case_id", ""))
        if case_id in seen:
            problems.append(f"{case_id}: appears more than once")
        seen.add(case_id)

    return problems


def store_rater_file(source: Path, store: Path = DEFAULT_STORE, cases: Sequence[BenchmarkCase] = BENCHMARK_CASES) -> Path:
    """Validate a returned file and copy it into the store under its rater id."""
    rows = read_labelling_file(source)
    problems = validate_rows(rows, cases)
    if problems:
        raise LabelStoreError("\n".join([f"{source}: {len(problems)} problem(s)", *problems]))

    labels = read_rater_labels(rows)  # also enforces one rater per file
    destination = export_path(store, labels.rater_id)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return destination


# ---------------------------------------------------------------------------
# Reading the store back
# ---------------------------------------------------------------------------


def load_rater_labels(store: Path = DEFAULT_STORE) -> List[RaterLabels]:
    directory = store / RATERS_DIRNAME
    if not directory.is_dir():
        return []
    return [read_rater_labels(read_labelling_file(path)) for path in sorted(directory.glob("*.json"))]


def load_adjudication_record(store: Path = DEFAULT_STORE) -> Dict[str, object]:
    path = store / ADJUDICATION_FILENAME
    if not path.is_file():
        return {"resolutions": {}, "reviewer": None}
    record = json.loads(path.read_text(encoding="utf-8"))
    record.setdefault("resolutions", {})
    record.setdefault("reviewer", None)
    return record


def write_adjudication_record(record: Dict[str, object], store: Path = DEFAULT_STORE) -> Path:
    store.mkdir(parents=True, exist_ok=True)
    path = store / ADJUDICATION_FILENAME
    path.write_text(json.dumps(record, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return path


def _merge(raters: Sequence[RaterLabels], resolutions: Dict[str, Set[str]]) -> Adjudication:
    """Fold any number of rater files into one adjudication.

    Two raters is the designed case — the set is single-labelled apart from the
    20-case agreement sample — and that case is handed straight to `adjudicate`
    so the pure module keeps owning the semantics the pre-registration cites.

    Three or more needs its own pass rather than a fold. Folding would compare
    each new rater against the *usable* result so far, and a case the first two
    disputed is absent from that, so the third rater would look like the only
    person who saw it and their answer would silently become the label. A
    disagreement must survive every rater who did not resolve it.
    """
    if not raters:
        return Adjudication(agreed={}, disputed={}, resolved={})
    if len(raters) == 1:
        return adjudicate(raters[0], RaterLabels("∅", {}), resolutions)
    if len(raters) == 2:
        return adjudicate(raters[0], raters[1], resolutions)

    agreed: Dict[str, Set[str]] = {}
    disputed: Dict[str, Tuple[Set[str], Set[str]]] = {}
    seen = sorted({case_id for rater in raters for case_id in rater.selections})
    for case_id in seen:
        answers = [rater.selections[case_id] for rater in raters if case_id in rater.selections]
        distinct = [answer for index, answer in enumerate(answers) if answer not in answers[:index]]
        if len(distinct) == 1:
            agreed[case_id] = set(distinct[0])
        else:
            disputed[case_id] = (set(distinct[0]), set(distinct[1]))

    resolved = {case_id: set(picks) for case_id, picks in resolutions.items() if case_id in disputed}
    return Adjudication(agreed=agreed, disputed=disputed, resolved=resolved)


def resolve_dataset(
    store: Path = DEFAULT_STORE,
    cases: Sequence[BenchmarkCase] = BENCHMARK_CASES,
) -> LabelledDataset:
    """The case set to measure on, assembled from whatever the store holds.

    With no rater files this is the drafted set unchanged, reported as
    `source="drafted"`. That is the state the benchmark has always run in; the
    difference is that it is now a fact read off disk rather than the only
    possibility.
    """
    raters = load_rater_labels(store)
    if not raters:
        return LabelledDataset(
            cases=list(cases),
            agreement=None,
            reviewer=None,
            raters=[],
            disputed=[],
            source="drafted",
        )

    record = load_adjudication_record(store)
    resolutions = {
        case_id: {str(pick) for pick in picks}
        for case_id, picks in dict(record.get("resolutions") or {}).items()
    }
    merged = _merge(raters, resolutions)

    return LabelledDataset(
        cases=apply_human_labels(merged, cases),
        agreement=measure_agreement(raters, cases),
        reviewer=record.get("reviewer"),
        raters=[rater.rater_id for rater in raters],
        disputed=sorted(set(merged.disputed) - set(merged.resolved)),
        source="store",
    )


def measure_agreement(
    raters: Sequence[RaterLabels],
    cases: Sequence[BenchmarkCase] = BENCHMARK_CASES,
) -> AgreementResult | None:
    """Kappa over the pre-drawn sample, or `None` when it cannot be computed.

    Restricted to `agreement_sample()` rather than to whatever the two raters
    happen to share: the sample was fixed before any labelling started, and
    measuring on the overlap that emerged instead would let the coefficient be
    selected by which cases the raters got to.

    Kappa is a two-rater statistic, so with more than two files it is computed
    over the first two by rater id. A design needing three would need a
    different coefficient, not a different pair.
    """
    if len(raters) < 2:
        return None
    sample = {case.case_id for case in agreement_sample(cases=cases)}
    first, second = raters[0], raters[1]
    both = [
        case
        for case in cases
        if case.case_id in sample
        and case.case_id in first.selections
        and case.case_id in second.selections
    ]
    if not both:
        return None
    return cohens_kappa(first, second, both)


def dispute_report(
    store: Path = DEFAULT_STORE,
    cases: Sequence[BenchmarkCase] = BENCHMARK_CASES,
) -> List[Dict[str, object]]:
    """Every unresolved disagreement, with both selections, for adjudication."""
    raters = load_rater_labels(store)
    if len(raters) < 2:
        return []
    record = load_adjudication_record(store)
    resolutions = {
        case_id: {str(pick) for pick in picks}
        for case_id, picks in dict(record.get("resolutions") or {}).items()
    }
    merged = _merge(raters, resolutions)
    by_id = {case.case_id: case for case in cases}

    report: List[Dict[str, object]] = []
    for case_id, (picks_a, picks_b) in sorted(merged.disputed.items()):
        if case_id in merged.resolved:
            continue
        case = by_id.get(case_id)
        report.append(
            {
                "case_id": case_id,
                "query": case.query if case else "",
                "first": sorted(picks_a),
                "second": sorted(picks_b),
                "only_first": sorted(picks_a - picks_b),
                "only_second": sorted(picks_b - picks_a),
            }
        )
    return report


def iter_store_files(store: Path = DEFAULT_STORE) -> Iterable[Path]:
    directory = store / RATERS_DIRNAME
    return sorted(directory.glob("*.json")) if directory.is_dir() else []
