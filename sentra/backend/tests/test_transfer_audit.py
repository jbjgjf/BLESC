"""#214 — the measurement audit is participant-level, checked against the dictionary, and leaks nothing.

The audit runs on synthetic data only. The real-data path is exercised to the
point where the consent gate refuses it, which is as far as it may go.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from research_engine.contracts.errors import ContractViolation
from research_engine.transfer import cli
from research_engine.transfer.audit import (
    AUDIT_METRICS,
    AVAILABILITY_VALUES,
    NOT_ADOPTED,
    NOT_IMPLEMENTED,
    check_against_dictionary,
    collect_comparisons,
    compare_audits,
    participant_values,
    public_view,
    run_audit,
)
from research_engine.transfer.codes import TransferCode
from research_engine.transfer.consent_gate import dataset_from_research_export, export_rows_from_dataset
from research_engine.transfer.generator import SyntheticCohortConfig, generate
from research_engine.transfer.preregistration import REPO_ROOT
from research_engine.transfer.schema import ITEM_IDS, STUDY_DAYS, DailyRecord, Enrollment, TransferDataset

AUDIT_DOC = REPO_ROOT / "docs" / "transfer_study_measurement_audit.md"


@pytest.fixture(scope="module")
def cohort():
    return generate(SyntheticCohortConfig(seed=31, missingness="state_dependent"))


@pytest.fixture(scope="module")
def report(cohort):
    return run_audit(cohort.dataset, manifest=cohort.manifest, bootstrap_rounds=300)


def _metric(report, key):
    return next(m for m in report["metrics"] if m["metric_key"] == key)


# --------------------------------------------------------------------------
# Definitions against the data dictionary
# --------------------------------------------------------------------------


def test_every_metric_resolves_in_the_dictionary_and_agrees_with_it() -> None:
    rows = check_against_dictionary()
    assert rows
    disagreements = [row for row in rows if not (row["resolved"] and row["agrees"])]
    assert disagreements == []


def test_time_of_day_and_weekday_are_marked_as_absent_from_the_export() -> None:
    by_id = {metric.metric_id: metric for metric in AUDIT_METRICS}
    for metric_id in ("submission_hour_median", "weekday_submission_rate"):
        assert by_id[metric_id].availability == "not_in_research_export"
    assert by_id["compose_duration"].availability == NOT_IMPLEMENTED
    assert by_id["pause_count"].availability == NOT_ADOPTED
    assert by_id["revision_count"].availability == NOT_ADOPTED
    assert by_id["text_char_count_mean"].availability == "requires_raw_text_retention"
    for metric in AUDIT_METRICS:
        assert metric.availability in AVAILABILITY_VALUES


def test_a_wrong_availability_claim_is_caught() -> None:
    dictionary = json.loads((REPO_ROOT / "docs" / "pilot" / "data-dictionary.json").read_text(encoding="utf-8"))
    dictionary["journal"]["submitted_at"]["in_export"] = True
    rows = [row for row in check_against_dictionary(dictionary) if row["dictionary_ref"] == "journal.submitted_at"]
    assert rows and not any(row["agrees"] for row in rows)


def test_the_document_lists_the_same_metrics() -> None:
    text = AUDIT_DOC.read_text(encoding="utf-8")
    section = text.split("## 指標と data dictionary の照合", 1)[1].split("### ", 1)[0]
    rows = [
        [cell.strip() for cell in line.strip().strip("|").split("|")]
        for line in section.splitlines()
        if line.startswith("| ") and not line.startswith("| metric_id")
    ]
    per = {"参加者": "participant", "参加者×項目": "participant×item", "参加者×曜日": "participant×weekday"}
    documented = [(row[0], per[row[2]], row[3], row[4].strip("`")) for row in rows]
    coded = [(m.metric_id, m.per, m.dictionary_ref, m.availability) for m in AUDIT_METRICS]
    assert documented == coded


# --------------------------------------------------------------------------
# Participant-level, not record-level
# --------------------------------------------------------------------------


def test_summaries_are_over_participants_not_records(cohort, report) -> None:
    metric = _metric(report, "item_response_rate.mood")
    values = [v for v in report["participant_level"]["item_response_rate.mood"].values() if v is not None]
    assert metric["summary"]["n_participants"] == len(values) == report["n_participants"]
    assert metric["summary"]["mean"] == pytest.approx(float(np.mean(values)))

    # The pooled ratio weights people by how often they submitted. It is not
    # what the audit reports, and on this data it is a different number.
    from research_engine.transfer.consent_gate import OPERATION_AUDIT, admit

    admitted = admit(cohort.dataset, OPERATION_AUDIT).dataset
    pooled = sum(1 for r in admitted.records if r.value("mood") is not None) / len(admitted.records)
    assert pooled != pytest.approx(metric["summary"]["mean"], abs=1e-6)
    assert report["unit_of_analysis"] == "participant"
    assert "独立な標本として扱わない" in report["records_are_not_independent_ja"]


def test_the_interval_resamples_participants(report) -> None:
    summary = _metric(report, "submission_rate")["summary"]
    low, high = summary["mean_interval"]
    assert low <= summary["mean"] <= high
    assert summary["interval_method"].startswith("participant_bootstrap")


def _tiny(days_by_code, mood_by_day=None) -> TransferDataset:
    records = []
    for code, days in days_by_code.items():
        for day in days:
            mood = None if mood_by_day is None else mood_by_day.get(day)
            report = tuple(mood if item == "mood" else None for item in ITEM_IDS) if mood is not None else None
            records.append(DailyRecord(code, day, report, None, False))
    enrollments = [Enrollment(code, "synthetic", True, False, False) for code in days_by_code]
    return TransferDataset("tiny", "synthetic", tuple(records), tuple(enrollments), ("synthetic_evaluation",), STUDY_DAYS)


def test_missing_runs_are_counted_on_the_whole_period() -> None:
    days = [1, 2, 3, 6, 7, 20]  # gaps 4-5, 8-19, 21-28
    values = participant_values(_tiny({"SYN-0-000": days}))
    assert values["submission_rate"]["SYN-0-000"] == pytest.approx(6 / 28)
    assert values["longest_missing_run"]["SYN-0-000"] == 12.0
    assert values["n_missing_runs"]["SYN-0-000"] == 3.0


def test_undefined_is_not_zero() -> None:
    # Two observed moods: the SD exists, the autocorrelation does not.
    values = participant_values(_tiny({"SYN-0-000": [1, 2, 10]}, {1: 5.0, 2: 7.0}))
    assert values["within_person_sd.mood"]["SYN-0-000"] == pytest.approx(np.std([5.0, 7.0], ddof=1))
    assert values["lag1_autocorrelation.mood"]["SYN-0-000"] is None
    assert values["within_person_sd.stress"]["SYN-0-000"] is None
    assert values["text_char_count_mean"]["SYN-0-000"] is None


def test_a_complete_cohort_reads_as_complete() -> None:
    cohort = generate(SyntheticCohortConfig(seed=31, missingness="none", withdrawals_keep=0, withdrawals_delete=0))
    report = run_audit(cohort.dataset, bootstrap_rounds=50)
    assert set(report["participant_level"]["submission_rate"].values()) == {1.0}
    assert set(report["participant_level"]["longest_missing_run"].values()) == {0.0}
    for weekday in ("mon", "sun"):
        assert set(report["participant_level"][f"weekday_submission_rate.{weekday}"].values()) == {1.0}


def test_unsupported_metrics_are_listed_not_computed(report) -> None:
    for key in ("compose_duration", "pause_count", "revision_count"):
        metric = _metric(report, key)
        assert metric["status"] == "unsupported"
        assert metric["summary"] == {}


def test_export_shaped_input_has_no_time_metrics() -> None:
    # Synthetic data stripped to what the export carries: the time-of-day and
    # weekday metrics must say "unavailable", not report zeros or guesses.
    cohort = generate(SyntheticCohortConfig(seed=31, missingness="independent", withdrawals_keep=0, withdrawals_delete=0))
    stripped = cohort.dataset.replace(
        records=[DailyRecord(r.research_code, r.day_index, r.self_report, r.text, r.model_training_use) for r in cohort.dataset.records]
    )
    report = run_audit(stripped, bootstrap_rounds=50)
    assert _metric(report, "submission_hour_median")["status"] == "unavailable_in_export"
    assert _metric(report, "weekday_submission_rate.mon")["status"] == "unavailable_in_export"
    assert _metric(report, "submission_rate")["status"] == "ok"


def test_the_audit_refuses_real_data_without_approval(cohort) -> None:
    real = dataset_from_research_export(export_rows_from_dataset(cohort.dataset), dataset_id="real-shaped")
    with pytest.raises(ContractViolation) as caught:
        run_audit(real)
    assert caught.value.code == TransferCode.APPROVAL_MISSING


def test_withdrawn_participants_are_not_audited(cohort, report) -> None:
    withdrawn = {e.research_code for e in cohort.dataset.enrollments if e.withdrawn}
    assert withdrawn
    assert not withdrawn & set(report["participant_level"]["submission_rate"])


# --------------------------------------------------------------------------
# Public view
# --------------------------------------------------------------------------


def test_the_public_view_has_no_codes_no_text_and_no_single_person_values(cohort, report) -> None:
    public = public_view(report)
    serialised = json.dumps(public, ensure_ascii=False)
    assert "participant_level" not in public
    assert "SYN-" not in serialised
    for record in cohort.dataset.records:
        if record.text:
            assert record.text not in serialised
    for metric in public["metrics"]:
        assert "min" not in metric["summary"]
        assert "max" not in metric["summary"]


def test_small_cells_are_suppressed(report) -> None:
    public = public_view(report, min_participants=1000)
    for metric in public["metrics"]:
        if metric["status"] == "ok":
            assert metric["suppressed"] is True
            assert set(metric["summary"]) == {"n_participants"}


# --------------------------------------------------------------------------
# Synthetic vs (stand-in) real
# --------------------------------------------------------------------------


def test_comparing_a_report_with_itself_gives_zero_differences(report) -> None:
    comparison = compare_audits(report, report, bootstrap_rounds=100)
    assert comparison["classification"] == "pre_fixed_metrics"
    for row in comparison["rows"]:
        if row["status"] == "ok":
            assert row["mean_difference_real_minus_synthetic"] == pytest.approx(0.0)


def test_a_different_metric_set_is_refused(report) -> None:
    other = {**report, "metric_set_hash": "sha256:" + "0" * 64}
    with pytest.raises(ContractViolation) as caught:
        compare_audits(report, other)
    assert caught.value.code == TransferCode.AUDIT_METRIC_SET_MISMATCH


def test_a_post_hoc_generator_is_kept_apart(report) -> None:
    stand_in = generate(SyntheticCohortConfig(seed=32, missingness="independent"))
    stand_in_report = run_audit(stand_in.dataset, manifest=stand_in.manifest, bootstrap_rounds=100)
    adjusted = generate(SyntheticCohortConfig(seed=31, missingness="state_dependent", post_hoc_adjusted=True))
    adjusted_report = run_audit(adjusted.dataset, manifest=adjusted.manifest, bootstrap_rounds=100)

    fixed = compare_audits(report, stand_in_report, bootstrap_rounds=100)
    post_hoc = compare_audits(adjusted_report, stand_in_report, bootstrap_rounds=100)
    assert post_hoc["classification"] == "exploratory_post_hoc_generator"
    grouped = collect_comparisons([fixed, post_hoc])
    assert grouped["pre_fixed_metrics"] == [fixed]
    assert grouped["exploratory_post_hoc_generator"] == [post_hoc]


def test_the_cli_writes_internal_public_and_dictionary_outputs(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    assert cli.main(["audit", "--seed", "31", "--missingness", "state_dependent", "--out", str(tmp_path)]) == 0
    assert json.loads(capsys.readouterr().out)["dictionary_agrees"] is True
    assert "SYN-" not in (tmp_path / "audit_public.json").read_text(encoding="utf-8")
    assert (tmp_path / "audit.json").exists()
    assert (tmp_path / "dictionary_check.json").exists()
