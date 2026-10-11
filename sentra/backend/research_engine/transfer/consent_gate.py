"""#212 — the one door every analysis input goes through.

Every analysis in this package (audit, ranking, sensitivity) calls `admit()`
before it reads a record, and receives back only what the requested operation
is allowed to see. The gate does four things, in this order:

1. **Refuses truth.** Anything carrying generated truth (`GeneratedCohort`,
   `GenerationTruth`) is refused outright — the truth exists to grade models,
   and a model that saw it would score what the project most wants to see.
2. **Refuses real data without its paperwork.** A dataset whose source is not
   `synthetic` needs an approval record from every required role, for this
   operation and for the current protocol and consent versions, *and* a frozen
   pre-registration (#211). Missing either is a refusal with its own code.
3. **Applies the v0 contract.** The dataset is converted to the engine's
   `ObservationBundle` and passed through `data.sequences.load_observations`,
   which runs `refuse_unpermitted_uses` and `refuse_real_source_kinds` from
   `contracts/observation.py`. Those refuse every non-synthetic row in v0,
   whatever the approval says. So even with complete paperwork, real data
   stops here — by design. Unblocking it is a reviewed change to that
   contract, made by a person once the server-side consent check it describes
   exists; it is not a flag in this module.
4. **Applies consent and withdrawal.** Participants without research consent
   are dropped. Rows on or after a withdrawal day are always dropped, and so
   is everything from a participant who asked for deletion. By default *all*
   rows of a withdrawn participant are dropped, which is what the research
   export does today (`researchExport.ts`, `isWithdrawn`). Fitting anything —
   a training mean, an AR coefficient, a tuned hyper-parameter — admits only
   participants with `model_training_use`.

**Why fitting a baseline counts as "training" here.** Whether estimating a
training-set mean on a participant's self-reports is "model training" in the
sense of the consent (第15条) is a question for the people who own the
consent, not for this code. Until they answer it, the gate takes the reading
that cannot over-use anyone's data (pre-registration P14; the consent matrix
lists it as pending).

**Late withdrawals.** An export is a snapshot. A participant who withdraws
after it was taken is still in the file. `admit()` therefore takes the current
list of withdrawn research codes as an input and applies it on top of whatever
the dataset itself says.

Every exclusion is counted by reason, never silently: a row that disappeared
without a count is indistinguishable from a row that was never there.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

from ..contracts.common import content_hash, require
from ..contracts.errors import Code, ContractViolation
from ..contracts.evaluation import LeakageCheck
from ..contracts.observation import DatasetManifest, Observation, ObservationBundle
from ..data.sequences import load_observations
from .codes import TransferCode
from .preregistration import Preregistration, require_frozen
from .schema import (
    CONSENT_DOCUMENT_VERSION,
    FORBIDDEN_COLUMNS,
    ITEM_BY_ID,
    ITEM_IDS,
    PROTOCOL_VERSION,
    SELF_REPORT_SCHEMA_ID,
    SOURCE_PARTICIPANT,
    SOURCE_SYNTHETIC,
    STUDY_DAYS,
    DailyRecord,
    Enrollment,
    TransferDataset,
)

# --------------------------------------------------------------------------
# Operations and uses
# --------------------------------------------------------------------------

OPERATION_EVALUATE = "evaluate"
OPERATION_FIT = "fit"
OPERATION_AUDIT = "audit"
OPERATION_READ_TEXT = "read_text"
OPERATION_EXTERNAL_AI = "external_ai"
OPERATIONS: Tuple[str, ...] = (
    OPERATION_EVALUATE,
    OPERATION_FIT,
    OPERATION_AUDIT,
    OPERATION_READ_TEXT,
    OPERATION_EXTERNAL_AI,
)

#: The `permitted_uses` each operation needs. Synthetic uses are the v0 pair;
#: the real ones are named so that a real dataset can declare them — and so
#: that `refuse_unpermitted_uses` can refuse them, which in v0 it always does.
SYNTHETIC_USES: Mapping[str, str] = {
    OPERATION_EVALUATE: "synthetic_evaluation",
    OPERATION_AUDIT: "synthetic_evaluation",
    OPERATION_READ_TEXT: "synthetic_evaluation",
    OPERATION_FIT: "synthetic_training",
}
REAL_USES: Mapping[str, str] = {
    OPERATION_EVALUATE: "pilot_research_evaluation",
    OPERATION_AUDIT: "pilot_research_evaluation",
    OPERATION_READ_TEXT: "pilot_research_evaluation",
    OPERATION_FIT: "pilot_model_training",
}
REAL_PERMITTED_USES: Tuple[str, ...] = ("pilot_research_evaluation", "pilot_model_training")

WITHDRAWAL_STRICT = "exclude_withdrawn_participants"
WITHDRAWAL_KEEP_IF_CHOSEN = "keep_pre_withdrawal_if_chosen"
WITHDRAWAL_POLICIES: Tuple[str, ...] = (WITHDRAWAL_STRICT, WITHDRAWAL_KEEP_IF_CHOSEN)

#: Roles whose approval the real-data path requires. Mirrors the three roles
#: of the v3 internal approval table in `docs/pilot/approvals.md`; whether these
#: are the right approvers for *this* study's processing is for the owner to
#: confirm (listed in the consent matrix).
DEFAULT_REQUIRED_ROLES: Tuple[str, ...] = ("研究責任者", "データ管理責任者", "運用責任者")


# --------------------------------------------------------------------------
# The column × operation table (mirrored in docs/transfer_study_consent_matrix.md)
# --------------------------------------------------------------------------

ALLOWED = "allowed"
REFUSED = "refused"
NOT_IN_EXPORT = "not_in_export"
NOT_ADOPTED = "not_adopted"
NOT_IMPLEMENTED = "not_implemented"
UNUSED = "unused"
AGGREGATE_ONLY = "aggregate_only"
REQUIRES_RESEARCH = "requires:research_analysis"
REQUIRES_RETENTION = "requires:research_analysis+raw_text_retention"
REQUIRES_TRAINING = "requires:research_analysis+model_training_use"
REQUIRES_RETENTION_TRAINING = "requires:research_analysis+raw_text_retention+model_training_use"
PERMISSION_VALUES: Tuple[str, ...] = (
    ALLOWED,
    REFUSED,
    NOT_IN_EXPORT,
    NOT_ADOPTED,
    NOT_IMPLEMENTED,
    UNUSED,
    AGGREGATE_ONLY,
    REQUIRES_RESEARCH,
    REQUIRES_RETENTION,
    REQUIRES_TRAINING,
    REQUIRES_RETENTION_TRAINING,
)


@dataclass(frozen=True)
class ColumnPermission:
    column: str
    dictionary_ref: str
    evaluate: str
    fit: str
    external_ai: str
    publish: str


CONSENT_MATRIX: Tuple[ColumnPermission, ...] = (
    ColumnPermission("research_code", "identity.research_code", ALLOWED, ALLOWED, REFUSED, REFUSED),
    ColumnPermission("day_index", "identity.relative_day", ALLOWED, ALLOWED, REFUSED, AGGREGATE_ONLY),
    *(
        ColumnPermission(
            f"self_report.{item_id}",
            f"daily_self_report.items[{item_id}]",
            REQUIRES_RESEARCH,
            REQUIRES_TRAINING,
            REFUSED,
            AGGREGATE_ONLY,
        )
        for item_id in ITEM_IDS
    ),
    ColumnPermission("raw_text", "journal.text", REQUIRES_RETENTION, REQUIRES_RETENTION_TRAINING, REFUSED, REFUSED),
    ColumnPermission("text_char_count", "journal.text", REQUIRES_RETENTION, REQUIRES_RETENTION_TRAINING, REFUSED, AGGREGATE_ONLY),
    ColumnPermission("model_training_use", "consent.model_training_use", ALLOWED, ALLOWED, REFUSED, AGGREGATE_ONLY),
    ColumnPermission("submitted_at", "journal.submitted_at", NOT_IN_EXPORT, NOT_IN_EXPORT, REFUSED, REFUSED),
    ColumnPermission("measures / ontology", "（export の抽出集計）", UNUSED, UNUSED, REFUSED, REFUSED),
    ColumnPermission("pause_count / revision_count", "process_telemetry.fields", NOT_ADOPTED, NOT_ADOPTED, REFUSED, REFUSED),
    ColumnPermission("compose_duration_ms", "process_telemetry.fields[compose_duration_ms]", NOT_IMPLEMENTED, NOT_IMPLEMENTED, REFUSED, REFUSED),
    ColumnPermission("field_order", "process_telemetry.fields[field_order]", NOT_IMPLEMENTED, NOT_IMPLEMENTED, REFUSED, REFUSED),
)


# --------------------------------------------------------------------------
# Approval records
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class RealDataApproval:
    """One person's approval to process real data for this study.

    Filled in by that person, never by code. The fields mirror
    `docs/pilot/approvals.md`: role, name, the protocol and consent versions
    approved, the date, and where the signed record is kept.
    """

    role: str
    name: str
    protocol_version: str
    consent_document_version: str
    approved_on: str
    record_ref: str
    operations: Tuple[str, ...]

    def problems(self) -> List[str]:
        found = []
        for name in ("role", "name", "approved_on", "record_ref"):
            if not str(getattr(self, name)).strip():
                found.append(f"{name} が空です。")
        if self.protocol_version != PROTOCOL_VERSION:
            found.append(f"protocol版が {PROTOCOL_VERSION} ではありません（{self.protocol_version}）。")
        if self.consent_document_version != CONSENT_DOCUMENT_VERSION:
            found.append(f"同意文書版が {CONSENT_DOCUMENT_VERSION} ではありません（{self.consent_document_version}）。")
        return found


def require_real_data_approval(
    approvals: Optional[Sequence[RealDataApproval]],
    operation: str,
    required_roles: Sequence[str] = DEFAULT_REQUIRED_ROLES,
) -> None:
    """Refuse unless every required role approved this operation on the current versions."""

    if not approvals:
        raise ContractViolation(
            TransferCode.APPROVAL_MISSING,
            "実データの承認記録がありません。承認者と承認文書の版が記録されるまで実データを処理しません（#212）。",
            "approvals",
        )
    by_role: Dict[str, RealDataApproval] = {}
    for approval in approvals:
        problems = approval.problems()
        if problems:
            code = (
                TransferCode.APPROVAL_VERSION_MISMATCH
                if any("版" in problem for problem in problems)
                else TransferCode.APPROVAL_INCOMPLETE
            )
            raise ContractViolation(code, "承認記録が不完全です: " + " ".join(problems), "approvals", {"role": approval.role})
        by_role[approval.role] = approval
    missing_roles = [role for role in required_roles if role not in by_role]
    if missing_roles:
        raise ContractViolation(
            TransferCode.APPROVAL_INCOMPLETE,
            f"承認していない役割があります: {', '.join(missing_roles)}",
            "approvals",
            {"missing_roles": missing_roles},
        )
    not_covering = [role for role in required_roles if operation not in by_role[role].operations]
    if not_covering:
        raise ContractViolation(
            TransferCode.OPERATION_NOT_PERMITTED,
            f"操作 {operation} を承認していない役割があります: {', '.join(not_covering)}",
            "approvals",
            {"operation": operation, "roles": not_covering},
        )


# --------------------------------------------------------------------------
# The v0 contract, reused
# --------------------------------------------------------------------------

#: A relative clock for the C1 contract, which needs timestamps. Day *d* ends at
#: `RELATIVE_EPOCH + d days`. It is not a calendar: the export has no dates,
#: and both synthetic and real data go through the same clock so that the
#: contract sees them identically.
RELATIVE_EPOCH = datetime(2001, 1, 1, tzinfo=timezone.utc)


def day_available_at(day_index: int) -> datetime:
    return RELATIVE_EPOCH + timedelta(days=day_index)


def to_observation_bundle(dataset: TransferDataset) -> ObservationBundle:
    """The dataset as C1 observations, so `load_observations` can judge it."""

    units = tuple(ITEM_BY_ID[item_id].unit for item_id in ITEM_IDS)
    observations = []
    for record in sorted(dataset.records, key=lambda r: (r.research_code, r.day_index)):
        values = tuple(record.value(item_id) for item_id in ITEM_IDS)
        recorded_at = day_available_at(record.day_index)
        observations.append(
            Observation(
                dataset_id=dataset.dataset_id,
                participant_key=record.research_code,
                event_id=f"{record.research_code}-d{record.day_index:02d}",
                recorded_at=recorded_at,
                available_at=recorded_at + timedelta(seconds=1),
                timezone="relative-day-clock",
                feature_schema_id=SELF_REPORT_SCHEMA_ID,
                feature_names=ITEM_IDS,
                units=units,
                values=values,
                observed_mask=tuple(value is not None for value in values),
                source_kind=dataset.source_kind,
                permitted_uses=dataset.permitted_uses,
            )
        )
    manifest = DatasetManifest(
        dataset_id=dataset.dataset_id,
        feature_schema_id=SELF_REPORT_SCHEMA_ID,
        file_hashes={"dataset": dataset.content_hash()},
        split_id="unassigned",
        split_assignment_ref="pending",
        generation_or_collection_protocol=f"research_engine.transfer/{dataset.source_kind}",
        permitted_uses=dataset.permitted_uses,
        created_at=RELATIVE_EPOCH,
        feature_names=ITEM_IDS,
        units=units,
    )
    bundle = ObservationBundle(manifest=manifest, observations=observations)
    bundle.validate()
    return bundle


# --------------------------------------------------------------------------
# admit()
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class AdmittedData:
    dataset: TransferDataset
    operation: str
    required_use: str
    withdrawal_policy: str
    excluded_participants: Mapping[str, int]
    excluded_rows: Mapping[str, int]
    contract_rows_checked: int

    @property
    def participants(self) -> List[str]:
        return self.dataset.participants

    def summary(self) -> Dict[str, Any]:
        """Counts only — no research codes — so it can sit in a report."""

        return {
            "operation": self.operation,
            "required_use": self.required_use,
            "withdrawal_policy": self.withdrawal_policy,
            "n_participants": len(self.dataset.enrollments),
            "n_records": len(self.dataset.records),
            "excluded_participants": dict(sorted(self.excluded_participants.items())),
            "excluded_rows": dict(sorted(self.excluded_rows.items())),
            "contract_rows_checked": self.contract_rows_checked,
        }


def _refuse_truth(candidate: Any) -> None:
    if getattr(candidate, "__carries_generation_truth__", False):
        raise ContractViolation(
            TransferCode.TRUTH_IN_MODEL_INPUT,
            "生成真値を含むオブジェクトは解析の入力にできません。dataset だけを渡してください。",
            type(candidate).__name__,
        )
    if not isinstance(candidate, TransferDataset):
        raise ContractViolation(
            Code.WRONG_TYPE,
            f"解析の入力は TransferDataset です（{type(candidate).__name__}）。",
            "dataset",
        )


def admit(
    candidate: Any,
    operation: str,
    *,
    approvals: Optional[Sequence[RealDataApproval]] = None,
    preregistration: Optional[Preregistration] = None,
    withdrawn_codes: Iterable[str] = (),
    withdrawal_policy: str = WITHDRAWAL_STRICT,
    required_roles: Sequence[str] = DEFAULT_REQUIRED_ROLES,
) -> AdmittedData:
    """Check, then filter. Raises before any filtering if the input may not be used at all."""

    _refuse_truth(candidate)
    dataset: TransferDataset = candidate
    require(operation in OPERATIONS, Code.UNKNOWN_ENUM_VALUE, f"未知の操作です: {operation}", "operation")
    if operation == OPERATION_EXTERNAL_AI:
        raise ContractViolation(
            TransferCode.OPERATION_NOT_PERMITTED,
            "外部AIへの送信はこの研究のどの段階でも行いません（protocol §6）。合成データでも経路を作りません。",
            "operation",
        )
    require(
        withdrawal_policy in WITHDRAWAL_POLICIES,
        Code.UNKNOWN_ENUM_VALUE,
        f"未知の撤回方針です: {withdrawal_policy}",
        "withdrawal_policy",
    )
    dataset.validate()

    real = dataset.source_kind != SOURCE_SYNTHETIC
    if real:
        require_real_data_approval(approvals, operation, required_roles)
        if preregistration is None:
            raise ContractViolation(
                TransferCode.PREREGISTRATION_NOT_FROZEN,
                "事前登録が渡されていません。実データは凍結した事前登録の下でだけ扱います。",
                "preregistration",
            )
        require_frozen(preregistration)
        if withdrawal_policy != WITHDRAWAL_STRICT:
            raise ContractViolation(
                TransferCode.OPERATION_NOT_PERMITTED,
                "撤回者の既収集データを使う方針は決まっていません。export と同じく撤回者は全行除きます。",
                "withdrawal_policy",
            )
    required_use = (REAL_USES if real else SYNTHETIC_USES)[operation]

    # The v0 contract: this is where a real dataset stops, approval or not.
    bundle = to_observation_bundle(dataset)
    visible = load_observations(bundle, required_use=required_use)

    late = set(withdrawn_codes)
    excluded_participants: Counter = Counter()
    excluded_rows: Counter = Counter()
    keep_codes: Dict[str, Optional[int]] = {}
    for enrollment in dataset.enrollments:
        code = enrollment.research_code
        if code in late:
            excluded_participants["withdrawn_after_export"] += 1
            continue
        if not enrollment.research_analysis:
            excluded_participants["no_research_consent"] += 1
            continue
        if enrollment.withdrawn:
            if enrollment.withdrawal_data_choice == "delete":
                excluded_participants["withdrawn_deleted"] += 1
                continue
            if withdrawal_policy == WITHDRAWAL_STRICT:
                excluded_participants["withdrawn"] += 1
                continue
        if operation == OPERATION_FIT and not enrollment.model_training_use:
            excluded_participants["no_model_training_use"] += 1
            continue
        keep_codes[code] = enrollment.withdrawn_day

    records: List[DailyRecord] = []
    for record in dataset.records:
        if record.research_code not in keep_codes:
            excluded_rows["participant_excluded"] += 1
            continue
        withdrawn_day = keep_codes[record.research_code]
        if withdrawn_day is not None and record.day_index >= withdrawn_day:
            # Written on or after withdrawal. The app should never produce
            # this row; the gate drops it anyway and counts it, because "zero
            # rows after withdrawal" is a pass condition of the dry run (#168).
            excluded_rows["on_or_after_withdrawal"] += 1
            continue
        if operation != OPERATION_READ_TEXT and record.text is not None:
            record = DailyRecord(
                research_code=record.research_code,
                day_index=record.day_index,
                self_report=record.self_report,
                text=None,
                model_training_use=record.model_training_use,
                submitted_at=record.submitted_at,
            )
        records.append(record)

    enrollments = [enrollment for enrollment in dataset.enrollments if enrollment.research_code in keep_codes]
    admitted = dataset.replace(records=records, enrollments=enrollments)
    admitted.validate()
    return AdmittedData(
        dataset=admitted,
        operation=operation,
        required_use=required_use,
        withdrawal_policy=withdrawal_policy,
        excluded_participants=dict(excluded_participants),
        excluded_rows=dict(excluded_rows),
        contract_rows_checked=len(visible.observations),
    )


def require_disjoint(fit_codes: Iterable[str], evaluation_codes: Iterable[str], path: str = "split") -> None:
    """Heldout participants never enter anything that was fitted."""

    overlap = sorted(set(fit_codes) & set(evaluation_codes))
    if overlap:
        raise ContractViolation(
            Code.SPLIT_OVERLAP,
            f"学習に使った参加者が評価側にもいます（{len(overlap)}名）。",
            path,
            {"n_overlap": len(overlap)},
        )


# --------------------------------------------------------------------------
# The research export, as the real-data path will receive it
# --------------------------------------------------------------------------


def dataset_from_research_export(
    rows: Sequence[Mapping[str, Any]], dataset_id: str, study_days: int = STUDY_DAYS
) -> TransferDataset:
    """`ResearchRow`s (sentra/frontend/src/lib/researchExport.ts) → a non-synthetic dataset.

    Reads only the fields the analysis may use. A row from before #315 that
    still carries `study_phase` is refused rather than having the column
    dropped quietly: it was exported under a different protocol version.
    Consent per participant is reconstructed fail-closed — if any of a
    participant's rows says `model_training_use: false`, all of them are false.
    """

    records: List[DailyRecord] = []
    training: Dict[str, bool] = {}
    retention: Dict[str, bool] = {}
    cohorts: Dict[str, str] = {}
    for index, row in enumerate(rows):
        path = f"export[{index}]"
        forbidden = sorted(set(row) & set(FORBIDDEN_COLUMNS))
        if forbidden:
            raise ContractViolation(
                TransferCode.PROTOCOL_SHAPE_MISMATCH,
                f"#315 より前の export の列があります: {', '.join(forbidden)}",
                path,
            )
        code = str(row["research_code"])
        report = row.get("self_report")
        values: Optional[Tuple[Optional[float], ...]] = None
        if report is not None:
            values = tuple(None if report.get(item_id) is None else float(report[item_id]) for item_id in ITEM_IDS)
        text = row.get("raw_text") if row.get("raw_text_available") else None
        records.append(
            DailyRecord(
                research_code=code,
                day_index=int(row["day_index"]),
                self_report=values,
                text=text,
                model_training_use=bool(row.get("model_training_use", False)),
            )
        )
        training[code] = training.get(code, True) and row.get("model_training_use") is True
        retention[code] = retention.get(code, False) or bool(row.get("raw_text_available"))
        cohorts[code] = str(row.get("cohort", ""))

    records = [
        DailyRecord(
            research_code=record.research_code,
            day_index=record.day_index,
            self_report=record.self_report,
            text=record.text,
            model_training_use=training[record.research_code],
        )
        for record in records
    ]
    enrollments = [
        Enrollment(
            research_code=code,
            cohort=cohorts[code],
            # The export only contains rows with research consent; the flag is
            # true by construction, not by assumption.
            research_analysis=True,
            raw_text_retention=retention[code],
            model_training_use=training[code],
        )
        for code in sorted(training)
    ]
    dataset = TransferDataset(
        dataset_id=dataset_id,
        source_kind=SOURCE_PARTICIPANT,
        records=tuple(records),
        enrollments=tuple(enrollments),
        permitted_uses=REAL_PERMITTED_USES,
        study_days=study_days,
    )
    dataset.validate()
    return dataset


def export_rows_from_dataset(dataset: TransferDataset) -> List[Dict[str, Any]]:
    """The subset of `ResearchRow` the study reads, built from a synthetic dataset.

    Exists so the real-data path can be exercised on input of the real shape
    without real input: what goes in is synthetic, what comes out is refused.
    """

    rows = []
    for record in sorted(dataset.records, key=lambda r: (r.research_code, r.day_index)):
        enrollment = dataset.enrollment(record.research_code)
        rows.append(
            {
                "research_code": record.research_code,
                "cohort": enrollment.cohort if enrollment else "",
                "day_index": record.day_index,
                "observation_type": "journal",
                "self_report": None
                if record.self_report is None
                else {"schema_version": SELF_REPORT_SCHEMA_ID, **dict(zip(ITEM_IDS, record.self_report))},
                "model_training_use": record.model_training_use,
                "raw_text_available": record.text is not None,
                **({"raw_text": record.text} if record.text is not None else {}),
            }
        )
    return rows


# --------------------------------------------------------------------------
# The synthetic dry run
# --------------------------------------------------------------------------


def consent_dry_run(seed: int, preregistration: Optional[Preregistration] = None) -> Dict[str, Any]:
    """Refusal, withdrawal exclusion and permission separation, on synthetic data only.

    Each check is *executed* and reported with what it examined; a check that
    could not run reports `passed=False`, never a silent pass.
    """

    from .generator import SyntheticCohortConfig, generate
    from .preregistration import load_preregistration

    cohort = generate(
        SyntheticCohortConfig(
            seed=seed,
            missingness="state_dependent",
            withdrawals_keep=2,
            withdrawals_delete=2,
            no_research_consent=2,
            stray_rows_after_withdrawal=2,
        )
    )
    dataset = cohort.dataset
    prereg = preregistration if preregistration is not None else load_preregistration()
    checks: List[LeakageCheck] = []

    def refused(name: str, expected_code: str, action) -> None:
        try:
            action()
        except ContractViolation as violation:
            checks.append(
                LeakageCheck(
                    name=name,
                    passed=violation.code == expected_code,
                    detail_ja=f"拒否された（{violation.code}）。期待した理由: {expected_code}",
                    checked_items=1,
                )
            )
            return
        checks.append(LeakageCheck(name=name, passed=False, detail_ja="拒否されなかった。", checked_items=1))

    real = dataset_from_research_export(export_rows_from_dataset(dataset), dataset_id="dry-run-real-shaped")
    refused("truth_bearing_input_refused", TransferCode.TRUTH_IN_MODEL_INPUT, lambda: admit(cohort, OPERATION_EVALUATE))
    refused("real_without_approval_refused", TransferCode.APPROVAL_MISSING, lambda: admit(real, OPERATION_EVALUATE))
    # With the draft still open this is refused for the missing freeze. Once a
    # human freezes it, the same call goes one step further and is refused by
    # the v0 contract instead — either way, no real row is read.
    from .preregistration import freeze_status

    refused(
        "real_with_approval_still_refused",
        TransferCode.PREREGISTRATION_NOT_FROZEN if not freeze_status(prereg).frozen else Code.REAL_DATA_REFUSED,
        lambda: admit(real, OPERATION_EVALUATE, approvals=_dry_run_approvals(), preregistration=prereg),
    )
    refused(
        "v0_contract_refuses_real_rows",
        Code.REAL_DATA_REFUSED,
        lambda: load_observations(to_observation_bundle(real), required_use=REAL_USES[OPERATION_EVALUATE]),
    )
    refused("external_ai_refused", TransferCode.OPERATION_NOT_PERMITTED, lambda: admit(dataset, OPERATION_EXTERNAL_AI))

    evaluation = admit(dataset, OPERATION_EVALUATE)
    fitting = admit(dataset, OPERATION_FIT)
    text = admit(dataset, OPERATION_READ_TEXT)

    withdrawn = {e.research_code: e for e in dataset.enrollments if e.withdrawn}
    no_consent = {e.research_code for e in dataset.enrollments if not e.research_analysis}
    stray = [
        r for r in dataset.records if r.research_code in withdrawn and r.day_index >= withdrawn[r.research_code].withdrawn_day
    ]
    admitted_sets = (evaluation, fitting, text)
    leaked_withdrawn = sum(1 for a in admitted_sets for r in a.dataset.records if r.research_code in withdrawn)
    checks.append(
        LeakageCheck(
            name="withdrawn_participants_excluded",
            passed=bool(withdrawn) and bool(stray) and leaked_withdrawn == 0,
            detail_ja=f"撤回者{len(withdrawn)}名（撤回後の模擬行{len(stray)}件を含む）の行が、どの操作の入力にも0件。",
            checked_items=len(withdrawn),
        )
    )
    leaked_no_consent = sum(1 for a in admitted_sets for r in a.dataset.records if r.research_code in no_consent)
    checks.append(
        LeakageCheck(
            name="no_research_consent_excluded",
            passed=bool(no_consent) and leaked_no_consent == 0,
            detail_ja=f"研究同意のない{len(no_consent)}名の行が、どの操作の入力にも0件。",
            checked_items=len(no_consent),
        )
    )
    fit_codes = set(fitting.participants)
    non_training = {e.research_code for e in evaluation.dataset.enrollments if not e.model_training_use}
    checks.append(
        LeakageCheck(
            name="fit_only_on_model_training_use",
            passed=bool(fit_codes) and all(fitting.dataset.enrollment(c).model_training_use for c in fit_codes) and bool(non_training),
            detail_ja=(
                f"当てはめに入るのは model_training_use の{len(fit_codes)}名だけ。"
                f"評価にだけ入る参加者が{len(non_training)}名いる（評価利用と学習利用が分かれている）。"
            ),
            checked_items=len(evaluation.participants),
        )
    )
    text_ok = all(
        (r.text is not None) == text.dataset.enrollment(r.research_code).raw_text_retention for r in text.dataset.records
    ) and all(r.text is None for a in (evaluation, fitting) for r in a.dataset.records)
    checks.append(
        LeakageCheck(
            name="text_only_with_retention_and_only_for_read_text",
            passed=text_ok,
            detail_ja="本文は原文保持に同意した参加者だけにあり、read_text 以外の操作には渡らない。",
            checked_items=len(text.dataset.records),
        )
    )
    late_code = evaluation.participants[0]
    late = admit(dataset, OPERATION_EVALUATE, withdrawn_codes=[late_code])
    checks.append(
        LeakageCheck(
            name="withdrawal_after_export_applied",
            passed=late_code not in late.participants and late.excluded_participants.get("withdrawn_after_export") == 1,
            detail_ja="export の後に撤回した参加者を、渡された撤回リストで除外した。",
            checked_items=1,
        )
    )
    fit_side = sorted(fit_codes)[: len(fit_codes) // 2]
    heldout_side = [code for code in evaluation.participants if code not in fit_side]
    try:
        require_disjoint(fit_side, heldout_side)
        disjoint_ok = True
    except ContractViolation:
        disjoint_ok = False
    try:
        require_disjoint(fit_side, fit_side[:1])
        overlap_detected = False
    except ContractViolation:
        overlap_detected = True
    checks.append(
        LeakageCheck(
            name="heldout_never_in_fit",
            passed=disjoint_ok and overlap_detected,
            detail_ja="評価側の参加者が当てはめ側と重ならないことを確かめ、重なりを入れた場合に拒否されることも確かめた。",
            checked_items=len(heldout_side),
        )
    )

    return {
        "dry_run": "consent_gate",
        "source_kind": dataset.source_kind,
        "dataset_hash": dataset.content_hash(),
        "seed": seed,
        "passed": all(check.passed for check in checks),
        "checks": [check.as_dict() for check in checks],
        "admitted": {
            "evaluate": evaluation.summary(),
            "fit": fitting.summary(),
            "read_text": text.summary(),
        },
        "note_ja": "合成データだけの dry run。実データは使っていない。",
    }


def _dry_run_approvals() -> List[RealDataApproval]:
    """Obviously fictitious approvals, used only to reach the next refusal in the dry run."""

    return [
        RealDataApproval(
            role=role,
            name="dry-run（架空）",
            protocol_version=PROTOCOL_VERSION,
            consent_document_version=CONSENT_DOCUMENT_VERSION,
            approved_on="2001-01-01",
            record_ref="dry-run（架空・記録なし）",
            operations=(OPERATION_EVALUATE,),
        )
        for role in DEFAULT_REQUIRED_ROLES
    ]


def consent_matrix_hash() -> str:
    return content_hash([permission.__dict__ for permission in CONSENT_MATRIX])
