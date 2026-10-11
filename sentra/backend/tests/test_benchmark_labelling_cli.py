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


def test_resolve_takes_the_display_ids_adjudicate_prints(monkeypatch, tmp_path, capsys):
    from app.services.benchmark_label_store import load_adjudication_record
    from app.services.benchmark_labelling import display_ids

    store = tmp_path / "store"
    drafted = next(case for case in BENCHMARK_CASES if case.labelled_by == "draft")
    shown = display_ids(drafted)
    picks = [shown[evidence_id] for evidence_id in drafted.expected_evidence_ids]

    assert _run(monkeypatch, "--store", str(store), "adjudicate", "--resolve", f"{drafted.case_id}={','.join(picks)}") == 0
    record = load_adjudication_record(store)
    assert set(record["resolutions"][drafted.case_id]) == set(drafted.expected_evidence_ids)


def test_resolve_refuses_a_day_the_case_does_not_have(monkeypatch, tmp_path):
    drafted = next(case for case in BENCHMARK_CASES if case.labelled_by == "draft")
    with pytest.raises(SystemExit, match="no candidate"):
        _run(monkeypatch, "--store", str(tmp_path / "s"), "adjudicate", "--resolve", f"{drafted.case_id}=k99")
    assert not (tmp_path / "s" / "adjudication.json").exists()


# ---- agreement, exclusion and sign-off on synthetic labels (#127) -----------
#
# The selections below are invented by the test to exercise the flow. They are
# not labels, and nothing here writes outside tmp_path.

from app.services.benchmark_labelling import agreement_sample as _agreement_sample  # noqa: E402

#: The first case of the pre-drawn sample, used as "the one the raters split on".
min_case = min(case.case_id for case in _agreement_sample())


def _label_sample(monkeypatch, store, out, rater, picks_for):
    _run(monkeypatch, "--store", str(store), "export", "--rater", rater, "--sample", "--out", str(out))
    _answer(out / f"{rater}.json", picks_for)
    assert _run(monkeypatch, "--store", str(store), "import", str(out / f"{rater}.json")) == 0


def _first_shown(row, count=1):
    return [candidate["evidence_id"] for candidate in row["candidates"][:count]]


def test_agreement_reports_a_defined_kappa_and_how_much_of_the_sample_it_covers(monkeypatch, tmp_path, capsys):
    store, out = tmp_path / "store", tmp_path / "out"
    _label_sample(monkeypatch, store, out, "a", lambda row: _first_shown(row, 2))
    _label_sample(monkeypatch, store, out, "b", lambda row: _first_shown(row, 2 if row["case_id"] < "m" else 3))
    capsys.readouterr()

    assert _run(monkeypatch, "--store", str(store), "agreement") == 0
    reported = json.loads(capsys.readouterr().out)
    assert reported["is_defined"] is True
    assert isinstance(reported["kappa"], float)
    assert reported["sample_cases_compared"] == reported["agreement_sample_size"] == 20
    assert reported["sample_cases_missing"] == []
    assert reported["report"].startswith("Cohen's kappa = ")


def test_agreement_reports_undefined_and_never_a_number(monkeypatch, tmp_path, capsys):
    """Both raters mark every sample case "none": p_e = 1, kappa undefined."""
    store, out = tmp_path / "store", tmp_path / "out"
    _label_sample(monkeypatch, store, out, "a", lambda row: ["none"])
    _label_sample(monkeypatch, store, out, "b", lambda row: ["none"])
    capsys.readouterr()

    assert _run(monkeypatch, "--store", str(store), "agreement") == 1
    captured = capsys.readouterr()
    reported = json.loads(captured.out)
    assert reported["kappa"] is None and reported["is_defined"] is False
    assert "UNDEFINED" in reported["report"] and "never as 0" in reported["report"]
    assert "not 0" in captured.err


def test_a_disagreement_is_excluded_with_a_reason_and_sign_off_waits_for_it(monkeypatch, tmp_path, capsys):
    store, out = tmp_path / "store", tmp_path / "out"
    _label_sample(monkeypatch, store, out, "a", lambda row: _first_shown(row, 1))
    _label_sample(monkeypatch, store, out, "b", lambda row: _first_shown(row, 2 if row["case_id"] == min_case else 1))
    capsys.readouterr()

    # One unresolved disagreement: sign-off is refused until it is decided.
    assert _run(monkeypatch, "--store", str(store), "apply", "--reviewer", "A Reviewer") == 1
    assert "no recorded decision" in capsys.readouterr().err

    with pytest.raises(SystemExit, match="needs --reason"):
        _run(monkeypatch, "--store", str(store), "adjudicate", "--exclude", min_case)

    reason = "raters disagree on whether a chain link counts"
    assert _run(monkeypatch, "--store", str(store), "adjudicate", "--exclude", min_case, "--reason", reason) == 0
    assert "no unresolved disagreement" in capsys.readouterr().out

    record = json.loads((store / "adjudication.json").read_text(encoding="utf-8"))
    assert record["exclusions"] == {min_case: reason}
    assert min_case not in record["resolutions"]

    assert _run(monkeypatch, "--store", str(store), "status") == 0
    status = json.loads(capsys.readouterr().out)
    assert status["unresolved_disputes"] == []
    assert status["excluded_disputes"] == {min_case: reason}

    from app.services.benchmark_label_store import resolve_dataset

    excluded_case = {case.case_id: case for case in resolve_dataset(store).cases}[min_case]
    assert excluded_case.labelled_by != "human", "an excluded disagreement must keep its drafted key"

    assert _run(monkeypatch, "--store", str(store), "apply", "--reviewer", "A Reviewer") == 0


def test_exclude_refuses_a_case_the_raters_agreed_on(monkeypatch, tmp_path):
    store, out = tmp_path / "store", tmp_path / "out"
    _label_sample(monkeypatch, store, out, "a", lambda row: _first_shown(row, 1))
    _label_sample(monkeypatch, store, out, "b", lambda row: _first_shown(row, 1))

    with pytest.raises(SystemExit, match="not a disagreement"):
        _run(monkeypatch, "--store", str(store), "adjudicate", "--exclude", min_case, "--reason", "hard case")
    assert not (store / "adjudication.json").exists(), "a refused exclusion must not be written"
