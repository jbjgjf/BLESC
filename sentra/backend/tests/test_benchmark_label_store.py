"""The route between a rater and a benchmark result (#126).

`test_benchmark_labelling.py` covers the protocol — what a rater is shown, how
two raters are compared, how a drafted key becomes an answer key. It could not
cover the part that did not exist: getting a task onto disk, getting an answer
back off it, and having that answer reach the metrics.

The property most worth pinning is the first one. Every other fault here is
recoverable by re-running something; a file that leaks the answer key produces a
benchmark that confirms itself, and nothing downstream can detect it.
"""

from __future__ import annotations

import json

import pytest

from app.services.benchmark_cases import BENCHMARK_CASES
from app.services.benchmark_label_store import (
    LabelStoreError,
    dispute_report,
    load_adjudication_record,
    measure_agreement,
    resolve_dataset,
    store_rater_file,
    validate_rows,
    write_adjudication_record,
    write_labelling_file,
)
from app.services.benchmark_labelling import (
    RaterLabels,
    agreement_sample,
    labelling_status,
)


ANSWER_FIELDS = {
    "expected_evidence_ids",
    "expected_policy",
    "research_note",
    "family",
    "required_hops",
    "split",
    "labelled_by",
}


def _fill(path, picks_for):
    """Answer a written labelling file the way a rater would, then save it."""
    rows = json.loads(path.read_text(encoding="utf-8"))
    for row in rows:
        row["selected_evidence_ids"] = picks_for(row)
    path.write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")
    return rows


#: The 82 cases are a mix: 6 authored during development, 76 drafted by a model.
#: Tests about "a case the raters did not settle" use a drafted one, because
#: that is the population the labelling pass actually covers.
DRAFTED = [case for case in BENCHMARK_CASES if case.labelled_by == "draft"]


def _drafted_key(row):
    case = next(case for case in BENCHMARK_CASES if case.case_id == row["case_id"])
    return list(case.expected_evidence_ids) or ["none"]


# ---- what a rater is sent -------------------------------------------------


def test_the_file_a_rater_gets_carries_no_answer(tmp_path):
    path = write_labelling_file("rater-a", tmp_path / "rater-a.json")
    rows = json.loads(path.read_text(encoding="utf-8"))

    for row in rows:
        assert ANSWER_FIELDS.isdisjoint(row), f"{row['case_id']} was sent with its answer"
        assert row["selected_evidence_ids"] == []
        for candidate in row["candidates"]:
            assert ANSWER_FIELDS.isdisjoint(candidate)


def test_the_file_holds_every_case_and_every_candidate(tmp_path):
    path = write_labelling_file("rater-a", tmp_path / "rater-a.json")
    rows = json.loads(path.read_text(encoding="utf-8"))

    assert {row["case_id"] for row in rows} == {case.case_id for case in BENCHMARK_CASES}
    for row, case in zip(sorted(rows, key=lambda r: r["case_id"]), sorted(BENCHMARK_CASES, key=lambda c: c.case_id)):
        assert len(row["candidates"]) == len(case.evidence)


def test_a_subset_can_be_sent_so_the_test_split_can_be_kept_for_last(tmp_path):
    subset = list(BENCHMARK_CASES[:5])
    path = write_labelling_file("rater-a", tmp_path / "rater-a.json", subset)
    rows = json.loads(path.read_text(encoding="utf-8"))

    assert {row["case_id"] for row in rows} == {case.case_id for case in subset}


# ---- what comes back ------------------------------------------------------


def test_validation_reports_every_problem_not_the_first():
    rows = [
        {"case_id": "not-a-case", "selected_evidence_ids": []},
        {"case_id": BENCHMARK_CASES[0].case_id, "selected_evidence_ids": ["nope"]},
        {"case_id": BENCHMARK_CASES[1].case_id},
    ]
    problems = validate_rows(rows)

    assert len(problems) == 3
    assert any("not a case" in problem for problem in problems)
    assert any("not candidates" in problem for problem in problems)
    assert any("not filled in" in problem for problem in problems)


def test_none_cannot_be_combined_with_a_selection():
    case = BENCHMARK_CASES[0]
    rows = [{"case_id": case.case_id, "selected_evidence_ids": ["none", case.evidence[0].evidence_id]}]

    assert any("cannot be combined" in problem for problem in validate_rows(rows))


def test_a_file_that_selects_an_unknown_id_is_refused(tmp_path):
    path = write_labelling_file("rater-a", tmp_path / "rater-a.json", BENCHMARK_CASES[:2])
    _fill(path, lambda row: ["no-such-candidate"])

    with pytest.raises(LabelStoreError) as error:
        store_rater_file(path, tmp_path / "store")
    assert "not candidates" in str(error.value)


def test_an_empty_selection_is_unlabelled_and_none_is_a_label(tmp_path):
    store = tmp_path / "store"
    cases = DRAFTED[:2]
    path = write_labelling_file("rater-a", tmp_path / "rater-a.json", cases)
    _fill(path, lambda row: [] if row["case_id"] == cases[0].case_id else ["none"])
    store_rater_file(path, store, cases)

    dataset = resolve_dataset(store, cases)
    by_id = {case.case_id: case for case in dataset.cases}

    # Not reached by the rater: keeps its drafted key and stays excluded.
    assert by_id[cases[0].case_id].labelled_by == "draft"
    # Worked through and nothing helped: that is a human label of "no evidence".
    assert by_id[cases[1].case_id].labelled_by == "human"
    assert by_id[cases[1].case_id].expected_evidence_ids == ()


# ---- assembling a dataset -------------------------------------------------


def test_an_empty_store_is_the_drafted_set_and_says_so(tmp_path):
    dataset = resolve_dataset(tmp_path / "store")

    assert dataset.source == "drafted"
    assert dataset.agreement is None
    assert dataset.raters == []
    assert [case.case_id for case in dataset.cases] == [case.case_id for case in BENCHMARK_CASES]


def test_a_stored_file_becomes_human_labels_in_the_cases_order(tmp_path):
    store = tmp_path / "store"
    case = BENCHMARK_CASES[0]
    picked = [day.evidence_id for day in case.evidence][:3]
    path = write_labelling_file("rater-a", tmp_path / "rater-a.json", [case])
    # Reversed on the way in, so the assertion below is about ordering rather
    # than about the rater happening to type them in order.
    _fill(path, lambda row: list(reversed(picked)))
    store_rater_file(path, store, [case])

    dataset = resolve_dataset(store, [case])
    assert dataset.source == "store"
    assert dataset.cases[0].labelled_by == "human"
    assert list(dataset.cases[0].expected_evidence_ids) == [
        day.evidence_id for day in case.evidence if day.evidence_id in set(picked)
    ]


def test_a_disagreement_stays_excluded_until_someone_resolves_it(tmp_path):
    store = tmp_path / "store"
    case = DRAFTED[0]
    ids = [day.evidence_id for day in case.evidence]

    first = write_labelling_file("rater-a", tmp_path / "a.json", [case])
    _fill(first, lambda row: ids[:2])
    store_rater_file(first, store, [case])

    second = write_labelling_file("rater-b", tmp_path / "b.json", [case])
    _fill(second, lambda row: ids[:3])
    store_rater_file(second, store, [case])

    dataset = resolve_dataset(store, [case])
    assert dataset.disputed == [case.case_id]
    assert dataset.cases[0].labelled_by == "draft", "a disputed case must not be promoted"
    assert dataset.cases[0].expected_evidence_ids == case.expected_evidence_ids
    assert [item["case_id"] for item in dispute_report(store, [case])] == [case.case_id]

    record = load_adjudication_record(store)
    record["resolutions"] = {case.case_id: ids[:2]}
    write_adjudication_record(record, store)

    resolved = resolve_dataset(store, [case])
    assert resolved.disputed == []
    assert resolved.cases[0].labelled_by == "human"
    assert list(resolved.cases[0].expected_evidence_ids) == ids[:2]


def test_a_third_rater_cannot_quietly_settle_what_the_first_two_disputed(tmp_path):
    """The fold this replaced would have let them.

    Comparing each new rater against the usable result so far drops disputed
    cases from the comparison, so the third rater looks like the only person who
    saw the case and their answer becomes the label unchallenged.
    """
    store = tmp_path / "store"
    case = DRAFTED[0]
    ids = [day.evidence_id for day in case.evidence]

    for rater, picks in (("a", ids[:2]), ("b", ids[:3]), ("c", ids[:4])):
        path = write_labelling_file(rater, tmp_path / f"{rater}.json", [case])
        _fill(path, lambda row, picks=picks: picks)
        store_rater_file(path, store, [case])

    dataset = resolve_dataset(store, [case])
    assert dataset.disputed == [case.case_id]
    assert dataset.cases[0].labelled_by == "draft"


# ---- agreement ------------------------------------------------------------


def test_agreement_needs_two_raters():
    assert measure_agreement([RaterLabels("a", {})]) is None


def test_agreement_is_measured_on_the_predrawn_sample_only():
    """Otherwise the coefficient is selected by which cases the raters reached.

    Both raters here also label a case outside the sample, and disagree on it
    completely. If that case counted, kappa would move.
    """
    sample = agreement_sample()
    outside = next(case for case in BENCHMARK_CASES if case.case_id not in {c.case_id for c in sample})

    shared = {case.case_id: set(case.expected_evidence_ids) for case in sample}
    first = RaterLabels("a", {**shared, outside.case_id: {outside.evidence[0].evidence_id}})
    second = RaterLabels("b", {**shared, outside.case_id: {outside.evidence[-1].evidence_id}})

    result = measure_agreement([first, second])
    assert result is not None
    assert result.judgements == sum(len(case.evidence) for case in sample)


# ---- what a run reports ---------------------------------------------------


def test_status_reports_the_signature_once_the_labels_are_signed_off(tmp_path):
    store = tmp_path / "store"
    cases = list(BENCHMARK_CASES[:2])
    path = write_labelling_file("rater-a", tmp_path / "rater-a.json", cases)
    _fill(path, _drafted_key)
    store_rater_file(path, store, cases)
    write_adjudication_record({"resolutions": {}, "reviewer": "A Reviewer"}, store)

    dataset = resolve_dataset(store, cases)
    status = labelling_status(dataset.agreement, dataset.cases, dataset.reviewer)

    assert status["human_labelled_count"] == len(cases)
    assert status["dataset"]["reviewer"] == "A Reviewer"
    assert "human-labelled" in status["dataset"]["labelling_status"]
    assert "A Reviewer" in status["dataset"]["labelling_status"]
    assert not any("PRELIMINARY" in warning for warning in status["warnings"])


def test_a_benchmark_run_scores_against_the_stored_labels(tmp_path):
    """The point of the whole module: labels that only sat in a file would leave
    every retrieval number measuring the drafted key."""
    from app.services.hf_research_benchmark import run_hf_research_benchmark

    store = tmp_path / "store"
    case = BENCHMARK_CASES[0]
    picked = [case.evidence[-1].evidence_id]
    path = write_labelling_file("rater-a", tmp_path / "rater-a.json", [case])
    _fill(path, lambda row: picked)
    store_rater_file(path, store, [case])

    dataset = resolve_dataset(store, [case])
    result = run_hf_research_benchmark(methods=["keyword"], dataset=dataset)

    assert result["label_provenance"]["source"] == "store"
    assert result["label_provenance"]["raters"] == ["rater-a"]
    assert result["cases"]["keyword"][0]["expected_evidence_ids"] == picked


def test_the_default_run_is_unchanged_when_no_labels_exist():
    from app.services.hf_research_benchmark import run_hf_research_benchmark

    result = run_hf_research_benchmark(methods=["keyword"])

    assert result["label_provenance"]["source"] == "drafted"
    assert any("PRELIMINARY" in warning for warning in result["labelling_status"]["warnings"])
