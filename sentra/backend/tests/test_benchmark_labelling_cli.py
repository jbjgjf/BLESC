"""The command line around the labelling protocol (#126).

Thin by design — every decision lives in `benchmark_labelling` and
`benchmark_label_store`. What is worth testing here is the part a person
touches: that the file they are handed carries no answer, that a bad file is
refused with every fault named at once rather than one per run, and that
signing off requires a name.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

from app.services.benchmark_cases import BENCHMARK_CASES

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "run_benchmark_labelling.py"


def _cli():
    spec = importlib.util.spec_from_file_location("run_benchmark_labelling", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run(monkeypatch, *argv) -> int:
    module = _cli()
    monkeypatch.setattr("sys.argv", ["run_benchmark_labelling.py", *argv])
    return module.main()


def _answer(path: Path, picks_for) -> None:
    rows = json.loads(path.read_text(encoding="utf-8"))
    for row in rows:
        row["selected_evidence_ids"] = picks_for(row)
    path.write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")


def _key(case_id: str):
    case = next(case for case in BENCHMARK_CASES if case.case_id == case_id)
    return list(case.expected_evidence_ids) or ["none"]


def test_status_runs_against_an_empty_store(monkeypatch, tmp_path, capsys):
    assert _run(monkeypatch, "--store", str(tmp_path / "store"), "status") == 0

    reported = json.loads(capsys.readouterr().out)
    assert reported["label_source"] == "drafted"
    assert reported["human_labelled_count"] == 0
    assert any("PRELIMINARY" in warning for warning in reported["warnings"])


def test_export_writes_a_file_with_no_answer_in_it(monkeypatch, tmp_path):
    store = tmp_path / "store"
    assert _run(monkeypatch, "--store", str(store), "export", "--rater", "a", "--out", str(tmp_path / "out")) == 0

    rows = json.loads((tmp_path / "out" / "a.json").read_text(encoding="utf-8"))
    assert len(rows) == len(BENCHMARK_CASES)
    for row in rows:
        assert "expected_evidence_ids" not in row
        assert row["selected_evidence_ids"] == []


def test_export_can_narrow_to_the_agreement_sample(monkeypatch, tmp_path):
    from app.services.benchmark_labelling import agreement_sample

    out = tmp_path / "out"
    assert _run(monkeypatch, "--store", str(tmp_path / "s"), "export", "--rater", "b", "--sample", "--out", str(out)) == 0

    rows = json.loads((out / "b.json").read_text(encoding="utf-8"))
    assert {row["case_id"] for row in rows} == {case.case_id for case in agreement_sample()}


def test_import_refuses_a_file_that_selects_something_that_is_not_a_candidate(monkeypatch, tmp_path, capsys):
    out = tmp_path / "out"
    _run(monkeypatch, "--store", str(tmp_path / "s"), "export", "--rater", "a", "--out", str(out))
    _answer(out / "a.json", lambda row: ["not-a-candidate"])

    assert _run(monkeypatch, "--store", str(tmp_path / "s"), "import", str(out / "a.json")) == 1
    assert "not candidates" in capsys.readouterr().err


def test_agreement_says_not_measured_rather_than_zero(monkeypatch, tmp_path, capsys):
    assert _run(monkeypatch, "--store", str(tmp_path / "store"), "agreement") == 1

    error = capsys.readouterr().err
    assert "not measured" in error
    assert "do not report it as 0" in error


def test_apply_refuses_without_a_reviewer_then_records_one(monkeypatch, tmp_path, capsys):
    store = tmp_path / "store"
    out = tmp_path / "out"
    _run(monkeypatch, "--store", str(store), "export", "--rater", "a", "--out", str(out))
    _answer(out / "a.json", lambda row: _key(row["case_id"]))
    assert _run(monkeypatch, "--store", str(store), "import", str(out / "a.json")) == 0
    capsys.readouterr()

    assert _run(monkeypatch, "--store", str(store), "apply") == 1
    assert "no reviewer recorded" in capsys.readouterr().err

    assert _run(monkeypatch, "--store", str(store), "apply", "--reviewer", "A Reviewer") == 0
    assert "human-labelled 82/82" in capsys.readouterr().out

    record = json.loads((store / "adjudication.json").read_text(encoding="utf-8"))
    assert record["reviewer"] == "A Reviewer"


def test_adjudicate_records_a_resolution_and_then_reports_none(monkeypatch, tmp_path, capsys):
    store = tmp_path / "store"
    out = tmp_path / "out"
    drafted = next(case for case in BENCHMARK_CASES if case.labelled_by == "draft")
    ids = [day.evidence_id for day in drafted.evidence]

    for rater, picks in (("a", ids[:2]), ("b", ids[:3])):
        _run(monkeypatch, "--store", str(store), "export", "--rater", rater, "--out", str(out))
        rows = json.loads((out / f"{rater}.json").read_text(encoding="utf-8"))
        rows = [row for row in rows if row["case_id"] == drafted.case_id]
        for row in rows:
            row["selected_evidence_ids"] = picks
        (out / f"{rater}.json").write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")
        _run(monkeypatch, "--store", str(store), "import", str(out / f"{rater}.json"))
    capsys.readouterr()

    assert _run(monkeypatch, "--store", str(store), "adjudicate") == 0
    assert "1 unresolved disagreement" in capsys.readouterr().out

    resolution = f"{drafted.case_id}={','.join(ids[:2])}"
    assert _run(monkeypatch, "--store", str(store), "adjudicate", "--resolve", resolution) == 0
    assert "no unresolved disagreement" in capsys.readouterr().out


def test_a_malformed_resolution_is_rejected_rather_than_half_applied(monkeypatch, tmp_path):
    with pytest.raises(SystemExit):
        _run(monkeypatch, "--store", str(tmp_path / "s"), "adjudicate", "--resolve", "missing-equals-sign")
