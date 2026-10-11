"""#212 — real data is refused without its approval record; consent and withdrawal are applied.

Every "real" dataset in this file is synthetic data converted to the research
export's row shape and loaded through the real-data loader. That is the only
way to test the refusal without real data: the input has the real shape, and
the code that would process it never gets that far. Approvals and frozen
pre-registrations used here are fictitious and exist only in memory.
"""

from __future__ import annotations

import json
import re
from typing import List

import pytest

from research_engine.contracts.errors import Code, ContractViolation
from research_engine.transfer import cli
from research_engine.transfer.codes import TransferCode
from research_engine.transfer.consent_gate import (
    CONSENT_MATRIX,
    DEFAULT_REQUIRED_ROLES,
    OPERATION_AUDIT,
    OPERATION_EVALUATE,
    OPERATION_EXTERNAL_AI,
    OPERATION_FIT,
    OPERATION_READ_TEXT,
    PERMISSION_VALUES,
    REFUSED,
    WITHDRAWAL_KEEP_IF_CHOSEN,
    RealDataApproval,
    admit,
    consent_dry_run,
    dataset_from_research_export,
    export_rows_from_dataset,
    require_disjoint,
)
from research_engine.transfer.generator import SyntheticCohortConfig, generate
from research_engine.transfer.preregistration import REPO_ROOT, load_preregistration, parse_preregistration
from research_engine.transfer.schema import CONSENT_DOCUMENT_VERSION, PROTOCOL_VERSION, SOURCE_PARTICIPANT

from test_transfer_preregistration import frozen_doc

MATRIX_DOC = REPO_ROOT / "docs" / "transfer_study_consent_matrix.md"


@pytest.fixture(scope="module")
def cohort():
    return generate(
        SyntheticCohortConfig(
            seed=21,
            missingness="state_dependent",
            withdrawals_keep=2,
            withdrawals_delete=2,
            no_research_consent=2,
            stray_rows_after_withdrawal=2,
        )
    )


@pytest.fixture(scope="module")
def real_shaped(cohort):
    return dataset_from_research_export(export_rows_from_dataset(cohort.dataset), dataset_id="test-real-shaped")


def approvals(operations=(OPERATION_EVALUATE,), **overrides) -> List[RealDataApproval]:
    rows = []
    for role in DEFAULT_REQUIRED_ROLES:
        fields = dict(
            role=role,
            name="test（架空）",
            protocol_version=PROTOCOL_VERSION,
            consent_document_version=CONSENT_DOCUMENT_VERSION,
            approved_on="2030-01-01",
            record_ref="test（架空）",
            operations=tuple(operations),
        )
        fields.update(overrides)
        rows.append(RealDataApproval(**fields))
    return rows


# --------------------------------------------------------------------------
# The table in the document is the table in the code
# --------------------------------------------------------------------------


def test_the_documented_matrix_is_the_coded_matrix() -> None:
    text = MATRIX_DOC.read_text(encoding="utf-8")
    section = text.split("## 列×操作の表", 1)[1].split("### 値の意味", 1)[0]
    rows = [line for line in section.splitlines() if line.startswith("| ") and not line.startswith("| 列 ")]
    parsed = []
    for line in rows:
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        parsed.append((cells[0], cells[1], *(re.sub(r"`", "", cell) for cell in cells[2:])))
    coded = [
        (p.column, p.dictionary_ref, p.evaluate, p.fit, p.external_ai, p.publish) for p in CONSENT_MATRIX
    ]
    assert parsed == coded


def test_every_cell_uses_the_vocabulary_and_external_ai_is_always_refused() -> None:
    for permission in CONSENT_MATRIX:
        for value in (permission.evaluate, permission.fit, permission.external_ai, permission.publish):
            assert value in PERMISSION_VALUES
        assert permission.external_ai == REFUSED


def test_fit_on_self_reports_always_needs_the_training_opt_in() -> None:
    for permission in CONSENT_MATRIX:
        if permission.column.startswith("self_report.") or permission.column == "raw_text":
            assert "model_training_use" in permission.fit


# --------------------------------------------------------------------------
# Refusals
# --------------------------------------------------------------------------


def test_truth_bearing_objects_are_refused(cohort) -> None:
    for candidate in (cohort, cohort.truth):
        with pytest.raises(ContractViolation) as caught:
            admit(candidate, OPERATION_EVALUATE)
        assert caught.value.code == TransferCode.TRUTH_IN_MODEL_INPUT


def test_anything_but_a_dataset_is_refused(cohort) -> None:
    with pytest.raises(ContractViolation) as caught:
        admit(cohort.dataset.as_dict(), OPERATION_EVALUATE)
    assert caught.value.code == Code.WRONG_TYPE


def test_external_ai_is_refused_even_for_synthetic_data(cohort) -> None:
    with pytest.raises(ContractViolation) as caught:
        admit(cohort.dataset, OPERATION_EXTERNAL_AI)
    assert caught.value.code == TransferCode.OPERATION_NOT_PERMITTED


def test_the_export_loader_marks_rows_as_real(real_shaped) -> None:
    assert real_shaped.source_kind == SOURCE_PARTICIPANT


@pytest.mark.parametrize("operation", [OPERATION_EVALUATE, OPERATION_FIT, OPERATION_AUDIT, OPERATION_READ_TEXT])
def test_real_data_without_an_approval_record_is_refused(real_shaped, operation: str) -> None:
    with pytest.raises(ContractViolation) as caught:
        admit(real_shaped, operation)
    assert caught.value.code == TransferCode.APPROVAL_MISSING


@pytest.mark.parametrize(
    "overrides, code",
    [
        ({"name": ""}, TransferCode.APPROVAL_INCOMPLETE),
        ({"record_ref": " "}, TransferCode.APPROVAL_INCOMPLETE),
        ({"protocol_version": "pilot-protocol-v2"}, TransferCode.APPROVAL_VERSION_MISMATCH),
        ({"consent_document_version": "research-consent-doc-v2"}, TransferCode.APPROVAL_VERSION_MISMATCH),
    ],
)
def test_an_incomplete_or_outdated_approval_is_refused(real_shaped, overrides, code) -> None:
    with pytest.raises(ContractViolation) as caught:
        admit(real_shaped, OPERATION_EVALUATE, approvals=approvals(**overrides))
    assert caught.value.code == code


def test_a_missing_role_is_refused(real_shaped) -> None:
    with pytest.raises(ContractViolation) as caught:
        admit(real_shaped, OPERATION_EVALUATE, approvals=approvals()[:2])
    assert caught.value.code == TransferCode.APPROVAL_INCOMPLETE


def test_evaluation_approval_does_not_cover_fitting(real_shaped) -> None:
    with pytest.raises(ContractViolation) as caught:
        admit(real_shaped, OPERATION_FIT, approvals=approvals((OPERATION_EVALUATE,)))
    assert caught.value.code == TransferCode.OPERATION_NOT_PERMITTED


def test_approval_without_a_frozen_preregistration_is_refused(real_shaped) -> None:
    with pytest.raises(ContractViolation) as caught:
        admit(real_shaped, OPERATION_EVALUATE, approvals=approvals())
    assert caught.value.code == TransferCode.PREREGISTRATION_NOT_FROZEN

    draft = load_preregistration()
    from research_engine.transfer.preregistration import freeze_status

    if not freeze_status(draft).frozen:
        with pytest.raises(ContractViolation) as caught:
            admit(real_shaped, OPERATION_EVALUATE, approvals=approvals(), preregistration=draft)
        assert caught.value.code == TransferCode.PREREGISTRATION_NOT_FROZEN


def test_even_with_approval_and_a_frozen_preregistration_the_v0_contract_refuses(real_shaped) -> None:
    frozen = parse_preregistration(frozen_doc())
    with pytest.raises(ContractViolation) as caught:
        admit(real_shaped, OPERATION_EVALUATE, approvals=approvals(), preregistration=frozen)
    assert caught.value.code == Code.REAL_DATA_REFUSED


def test_real_data_cannot_use_the_undecided_withdrawal_policy(real_shaped) -> None:
    frozen = parse_preregistration(frozen_doc())
    with pytest.raises(ContractViolation) as caught:
        admit(
            real_shaped,
            OPERATION_EVALUATE,
            approvals=approvals(),
            preregistration=frozen,
            withdrawal_policy=WITHDRAWAL_KEEP_IF_CHOSEN,
        )
    assert caught.value.code == TransferCode.OPERATION_NOT_PERMITTED


def test_the_v0_contract_is_what_judges_permitted_uses(cohort) -> None:
    # A synthetic dataset that does not declare the use is refused by
    # `refuse_unpermitted_uses` — proof that `admit` runs the contract rather
    # than re-implementing it.
    undeclared = type(cohort.dataset)(
        dataset_id=cohort.dataset.dataset_id,
        source_kind=cohort.dataset.source_kind,
        records=cohort.dataset.records,
        enrollments=cohort.dataset.enrollments,
        permitted_uses=("synthetic_training",),
        study_days=cohort.dataset.study_days,
    )
    with pytest.raises(ContractViolation) as caught:
        admit(undeclared, OPERATION_EVALUATE)
    assert caught.value.code == Code.PERMISSION_NOT_GRANTED


# --------------------------------------------------------------------------
# Withdrawal, consent and permission separation
# --------------------------------------------------------------------------


def test_withdrawn_and_unconsented_participants_are_excluded_by_default(cohort) -> None:
    dataset = cohort.dataset
    admitted = admit(dataset, OPERATION_EVALUATE)
    gone = {e.research_code for e in dataset.enrollments if e.withdrawn or not e.research_analysis}
    assert len(gone) == 6
    assert not gone & set(admitted.participants)
    assert not any(record.research_code in gone for record in admitted.dataset.records)
    assert admitted.excluded_participants == {"withdrawn": 2, "withdrawn_deleted": 2, "no_research_consent": 2}


def test_rows_after_withdrawal_and_deleted_participants_never_survive_any_policy(cohort) -> None:
    dataset = cohort.dataset
    admitted = admit(dataset, OPERATION_EVALUATE, withdrawal_policy=WITHDRAWAL_KEEP_IF_CHOSEN)
    for enrollment in dataset.enrollments:
        if not enrollment.withdrawn:
            continue
        kept = [r for r in admitted.dataset.records if r.research_code == enrollment.research_code]
        if enrollment.withdrawal_data_choice == "delete":
            assert kept == []
        else:
            assert kept, "「残す」を選んだ参加者の撤回前の行が、この方針では残るはず"
            assert all(r.day_index < enrollment.withdrawn_day for r in kept)
    assert admitted.excluded_rows["on_or_after_withdrawal"] > 0


def test_fitting_admits_only_the_training_opt_in_and_evaluation_admits_more(cohort) -> None:
    evaluation = admit(cohort.dataset, OPERATION_EVALUATE)
    fitting = admit(cohort.dataset, OPERATION_FIT)
    assert set(fitting.participants) < set(evaluation.participants)
    assert all(fitting.dataset.enrollment(code).model_training_use for code in fitting.participants)
    assert fitting.excluded_participants["no_model_training_use"] == len(evaluation.participants) - len(fitting.participants)


def test_text_reaches_only_the_read_text_operation(cohort) -> None:
    assert all(record.text is None for record in admit(cohort.dataset, OPERATION_EVALUATE).dataset.records)
    assert all(record.text is None for record in admit(cohort.dataset, OPERATION_AUDIT).dataset.records)
    text = admit(cohort.dataset, OPERATION_READ_TEXT)
    assert any(record.text is not None for record in text.dataset.records)
    for record in text.dataset.records:
        assert record.text_available == text.dataset.enrollment(record.research_code).raw_text_retention


def test_a_withdrawal_after_the_export_is_applied(cohort) -> None:
    evaluation = admit(cohort.dataset, OPERATION_EVALUATE)
    late = evaluation.participants[:3]
    after = admit(cohort.dataset, OPERATION_EVALUATE, withdrawn_codes=late)
    assert not set(late) & set(after.participants)
    assert after.excluded_participants["withdrawn_after_export"] == 3


def test_overlapping_fit_and_evaluation_participants_are_refused() -> None:
    require_disjoint(["a", "b"], ["c"])
    with pytest.raises(ContractViolation) as caught:
        require_disjoint(["a", "b"], ["b", "c"])
    assert caught.value.code == Code.SPLIT_OVERLAP


# --------------------------------------------------------------------------
# The export loader
# --------------------------------------------------------------------------


def test_an_export_from_before_315_is_refused(cohort) -> None:
    rows = export_rows_from_dataset(cohort.dataset)
    rows[0] = {**rows[0], "study_phase": "baseline"}
    with pytest.raises(ContractViolation) as caught:
        dataset_from_research_export(rows, dataset_id="old")
    assert caught.value.code == TransferCode.PROTOCOL_SHAPE_MISMATCH


def test_the_training_flag_is_reconstructed_fail_closed(cohort) -> None:
    rows = export_rows_from_dataset(cohort.dataset)
    code = next(row["research_code"] for row in rows if row["model_training_use"])
    first = next(index for index, row in enumerate(rows) if row["research_code"] == code)
    rows[first] = {**rows[first], "model_training_use": False}
    loaded = dataset_from_research_export(rows, dataset_id="mixed")
    assert loaded.enrollment(code).model_training_use is False
    assert all(not record.model_training_use for record in loaded.records if record.research_code == code)


def test_the_export_loader_keeps_values_and_nulls(cohort, real_shaped) -> None:
    original = {(r.research_code, r.day_index): r.self_report for r in cohort.dataset.records}
    loaded = {(r.research_code, r.day_index): r.self_report for r in real_shaped.records}
    assert loaded == original


# --------------------------------------------------------------------------
# The dry run
# --------------------------------------------------------------------------


def test_the_synthetic_dry_run_passes_every_check() -> None:
    report = consent_dry_run(11)
    failed = [check for check in report["checks"] if not check["passed"]]
    assert failed == []
    assert report["passed"] is True
    assert len(report["checks"]) >= 10
    assert "SYN-" not in json.dumps(report["admitted"])


def test_the_cli_dry_run_exits_zero(capsys: pytest.CaptureFixture[str]) -> None:
    assert cli.main(["consent-dry-run", "--seed", "11"]) == 0
    assert json.loads(capsys.readouterr().out)["passed"] is True
