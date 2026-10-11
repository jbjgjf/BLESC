"""The learned stages are closed, and say why (#99, #100).

These tests pin the state of the repository rather than a behaviour someone
might want: today there is no real data, no approval and no decided
pre-registration, so the gate is closed on every condition. A change that makes
any of these tests fail is either filling in a pre-registration — which needs a
reviewer and the document changed with it — or opening a gate by accident.

Counts and approvals built below are TEST FIXTURES. None is a real participant
or a real approval; they exist to show each condition is checked on its own.
"""

from __future__ import annotations

import inspect
import json
import re
from dataclasses import replace
from datetime import date
from pathlib import Path

import pytest

from app.analytics.data_sufficiency import (
    NO_OBSERVED_DATA,
    NOT_REAL_CONSENTED,
    REAL_CONSENTED,
    REQUIREMENT_UNDECIDED,
    ObservedCounts,
)
from app.analytics.dynamics import MeasureStatus
from app.ontology import learning_gates
from app.ontology.learning_gates import (
    AGREEMENT_BELOW_REQUIREMENT,
    AGREEMENT_UNMEASURED,
    BASELINE_CHANGED_SINCE_PINNED,
    BASELINE_NOT_PINNED,
    DETERMINISTIC_TRAVERSAL,
    ESTIMAND_UNDECIDED,
    FALSIFICATION_UNDECIDED,
    GOVERNANCE_APPROVAL_MISSING,
    GOVERNANCE_APPROVAL_OUT_OF_SCOPE,
    HYPOTHESIS_UNDECIDED,
    INTENDED_USE_UNDECIDED,
    LABEL_REQUIREMENT_UNDECIDED,
    NOT_ENOUGH_DATA,
    PREREGISTRATION_INCOMPLETE,
    PREREGISTRATION_NOT_FROZEN,
    STAGE2,
    STAGE2_OBSERVATION_REQUIREMENT,
    STAGE2_PREREGISTRATION,
    STAGE3,
    STAGE3_LABEL_REQUIREMENT,
    STAGE3_OBSERVATION_REQUIREMENT,
    STAGE3_PREREGISTRATION,
    TOO_FEW_HUMAN_LABELS,
    GovernanceApproval,
    LabelRequirement,
    StageEvidence,
    _baseline_reasons,
    _label_reasons,
    current_baseline_versions,
    current_evidence,
    evaluate_stage2_entry_gate,
    evaluate_stage3_entry_gate,
)
from app.ontology.schema import RELATIONS
from app.services.benchmark_cases import CASE_COMPOSITION

_DOCS = Path(__file__).resolve().parents[2] / "docs"

_HYPOTHETICAL_REAL_COUNTS = ObservedCounts(
    data_classification=REAL_CONSENTED, days_observed=(28,) * 50, source="TEST FIXTURE"
)


def _fixture_approval(stage=STAGE2, version=STAGE2_PREREGISTRATION.version):
    return GovernanceApproval(
        record_ref="TEST FIXTURE - not an approval",
        approving_body="TEST FIXTURE",
        stage=stage,
        preregistration_version=version,
        approved_on=date(2026, 1, 1),
    )


# ── Stage 2 (#99): closed today, on every condition ──────────────────────────


def test_stage2_is_closed_today_on_all_four_entry_conditions():
    decision = evaluate_stage2_entry_gate()

    assert decision.open is False
    assert decision.stage == STAGE2 and decision.issue == "#99"
    assert set(decision.conditions_failing) == {
        "required_observations_defined",
        "enough_real_consented_data",
        "governance_approval",
        "estimand_and_intended_use_documented",
        "preregistration",
    }
    assert set(decision.codes) == {
        REQUIREMENT_UNDECIDED,
        NO_OBSERVED_DATA,
        GOVERNANCE_APPROVAL_MISSING,
        ESTIMAND_UNDECIDED,
        INTENDED_USE_UNDECIDED,
        PREREGISTRATION_INCOMPLETE,
        PREREGISTRATION_NOT_FROZEN,
    }


def test_the_repository_holds_no_evidence():
    """No data, no approval, no measured agreement. Only the label count is read."""
    evidence = current_evidence()
    assert evidence.observed is None
    assert evidence.approvals == ()
    assert evidence.inter_rater_agreement is None
    assert evidence.human_labelled_cases == CASE_COMPOSITION["human_labelled"]
    assert evaluate_stage2_entry_gate(evidence).codes == evaluate_stage2_entry_gate().codes


def test_closed_means_not_enough_data_never_a_population_default():
    decision = evaluate_stage2_entry_gate()

    assert decision.fallback == NOT_ENOUGH_DATA
    # One spelling of "not enough data" across the product, whichever gate says it.
    assert NOT_ENOUGH_DATA == MeasureStatus.NOT_ENOUGH_DATA.value
    assert STAGE2_PREREGISTRATION.item("rollback").decided == NOT_ENOUGH_DATA


def test_the_research_decisions_are_left_undecided():
    """Only what #99's acceptance criteria already fix is decided."""
    decided = {item.key for item in STAGE2_PREREGISTRATION.items if item.decided is not None}
    assert decided == {"rollback", "comparators"}
    assert all(item.fixed_by for item in STAGE2_PREREGISTRATION.items if item.decided is not None)
    assert STAGE2_OBSERVATION_REQUIREMENT.undecided() == STAGE2_OBSERVATION_REQUIREMENT.must_decide
    assert STAGE2_OBSERVATION_REQUIREMENT.decided_in is None
    assert STAGE2_PREREGISTRATION.frozen_at is None


# ── each condition is checked on its own ─────────────────────────────────────


def test_synthetic_counts_are_refused_and_the_gate_stays_closed():
    synthetic = ObservedCounts(data_classification="synthetic", days_observed=(28,) * 50)
    decision = evaluate_stage2_entry_gate(StageEvidence(observed=synthetic))

    assert decision.open is False
    assert NOT_REAL_CONSENTED in decision.codes
    assert NO_OBSERVED_DATA not in decision.codes


def test_counts_alone_do_not_open_it():
    decision = evaluate_stage2_entry_gate(StageEvidence(observed=_HYPOTHETICAL_REAL_COUNTS))

    assert decision.open is False
    assert NO_OBSERVED_DATA not in decision.codes
    # The requirement is still undecided, so "enough" cannot be judged.
    assert REQUIREMENT_UNDECIDED in decision.codes


def test_an_approval_of_something_else_is_not_an_approval_of_this():
    pilot_protocol = _fixture_approval(stage="pilot_protocol", version="pilot-protocol-v3")
    decision = evaluate_stage2_entry_gate(StageEvidence(approvals=(pilot_protocol,)))
    assert GOVERNANCE_APPROVAL_OUT_OF_SCOPE in decision.codes

    stale = _fixture_approval(version="stage2-prereg-older-draft")
    decision = evaluate_stage2_entry_gate(StageEvidence(approvals=(stale,)))
    assert GOVERNANCE_APPROVAL_OUT_OF_SCOPE in decision.codes


def test_everything_a_caller_can_supply_still_leaves_it_closed():
    """Inputs cannot open the gate. Only a reviewed pre-registration change can."""
    decision = evaluate_stage2_entry_gate(
        StageEvidence(observed=_HYPOTHETICAL_REAL_COUNTS, approvals=(_fixture_approval(),))
    )

    assert decision.open is False
    assert GOVERNANCE_APPROVAL_MISSING not in decision.codes
    assert GOVERNANCE_APPROVAL_OUT_OF_SCOPE not in decision.codes
    assert {REQUIREMENT_UNDECIDED, ESTIMAND_UNDECIDED, PREREGISTRATION_NOT_FROZEN} <= set(decision.codes)


def test_there_is_no_switch():
    """No argument, environment variable or setting reaches the decision."""
    for gate in (evaluate_stage2_entry_gate, evaluate_stage3_entry_gate):
        assert list(inspect.signature(gate).parameters) == ["evidence"]
    source = inspect.getsource(learning_gates)
    for forbidden in ("os.environ", "getenv", "import os", "settings"):
        assert forbidden not in source


def test_the_decision_is_machine_readable():
    payload = json.loads(json.dumps(evaluate_stage2_entry_gate().as_dict()))

    assert payload["open"] is False
    assert payload["fallback"] == "not_enough_data"
    assert all(set(reason) == {"condition", "code", "detail"} for reason in payload["reasons"])
    assert payload["sufficiency"]["design"]["max_observations"] == 1400
    assert payload["sufficiency"]["design_ceiling_effective_n"] == pytest.approx(96.552, abs=1e-3)


# ── Stage 3 (#100): closed today, on every condition ─────────────────────────


def test_stage3_is_closed_today_on_every_entry_condition():
    decision = evaluate_stage3_entry_gate()

    assert decision.open is False
    assert decision.stage == STAGE3 and decision.issue == "#100"
    assert set(decision.conditions_failing) == {
        "deterministic_baseline_stable",
        "training_data_sufficient",
        "label_quality_sufficient",
        "hypothesis_and_falsification_preregistered",
        "governance_approval",
        "preregistration",
    }
    assert set(decision.codes) == {
        BASELINE_NOT_PINNED,
        REQUIREMENT_UNDECIDED,
        NO_OBSERVED_DATA,
        LABEL_REQUIREMENT_UNDECIDED,
        TOO_FEW_HUMAN_LABELS,
        AGREEMENT_UNMEASURED,
        HYPOTHESIS_UNDECIDED,
        FALSIFICATION_UNDECIDED,
        GOVERNANCE_APPROVAL_MISSING,
        PREREGISTRATION_INCOMPLETE,
        PREREGISTRATION_NOT_FROZEN,
    }


def test_closed_stage3_leaves_the_deterministic_traversal_in_place():
    decision = evaluate_stage3_entry_gate()
    assert decision.fallback == DETERMINISTIC_TRAVERSAL

    detail = next(r.detail for r in decision.reasons if r.code == BASELINE_NOT_PINNED)
    for version in current_baseline_versions().values():
        assert version in detail


def test_stage3_needs_data_for_every_relation_type():
    assert set(STAGE3_OBSERVATION_REQUIREMENT.relation_types) == set(RELATIONS)
    assert "min_edges_per_relation_type" in STAGE3_OBSERVATION_REQUIREMENT.undecided()
    assert STAGE3_LABEL_REQUIREMENT.undecided() == (
        "min_human_labelled_cases",
        "min_inter_rater_agreement",
        "agreement_statistic",
    )


def test_the_label_count_is_reported_not_assumed():
    decision = evaluate_stage3_entry_gate()
    detail = next(r.detail for r in decision.reasons if r.code == TOO_FEW_HUMAN_LABELS)
    assert detail.startswith(f"{CASE_COMPOSITION['human_labelled']} benchmark case(s)")


def test_no_label_count_clears_an_undecided_minimum():
    plenty = StageEvidence(human_labelled_cases=500, inter_rater_agreement=0.95)
    codes = {reason.code for reason in _label_reasons(STAGE3_LABEL_REQUIREMENT, plenty)}
    assert codes == {LABEL_REQUIREMENT_UNDECIDED, TOO_FEW_HUMAN_LABELS, AGREEMENT_BELOW_REQUIREMENT}


def test_a_decided_label_requirement_is_checked_against_the_counts():
    requirement = LabelRequirement(min_human_labelled_cases=60, min_inter_rater_agreement=0.6, agreement_statistic="kappa")

    short = StageEvidence(human_labelled_cases=12, inter_rater_agreement=0.4)
    assert {r.code for r in _label_reasons(requirement, short)} == {TOO_FEW_HUMAN_LABELS, AGREEMENT_BELOW_REQUIREMENT}

    enough = StageEvidence(human_labelled_cases=60, inter_rater_agreement=0.6)
    assert _label_reasons(requirement, enough) == []


def test_a_pinned_baseline_must_still_match_the_code():
    versions = current_baseline_versions()
    pinned_now = "; ".join(f"{name}={version}" for name, version in sorted(versions.items()))

    def pinned(value):
        items = tuple(
            replace(item, decided=value) if item.key == "baseline_versions" else item
            for item in STAGE3_PREREGISTRATION.items
        )
        return replace(STAGE3_PREREGISTRATION, items=items)

    assert _baseline_reasons(pinned(pinned_now), versions) == []
    moved = {**versions, "traversal": "relation-aware-traversal-v2"}
    assert [r.code for r in _baseline_reasons(pinned(pinned_now), moved)] == [BASELINE_CHANGED_SINCE_PINNED]


def test_a_stage2_approval_does_not_approve_stage3():
    stage2_approval = _fixture_approval()
    decision = evaluate_stage3_entry_gate(StageEvidence(approvals=(stage2_approval,)))
    assert GOVERNANCE_APPROVAL_OUT_OF_SCOPE in decision.codes


# ── the document and the code describe the same pre-registration ─────────────

_ROW = re.compile(r"^\|\s*(S[23]-\d{2})\s*\|\s*`([a-z_]+)`\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$")


def _document_items(path: Path):
    rows = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        match = _ROW.match(line)
        if match:
            rows[match.group(2)] = (match.group(3), match.group(4))
    return rows


@pytest.mark.parametrize("prereg", [STAGE2_PREREGISTRATION, STAGE3_PREREGISTRATION], ids=lambda p: p.stage)
def test_document_and_code_agree_item_for_item(prereg):
    document = Path(__file__).resolve().parents[3] / prereg.document
    rows = _document_items(document)

    assert set(rows) == {item.key for item in prereg.items}
    for item in prereg.items:
        title, status = rows[item.key]
        assert title == item.title
        if item.decided is None:
            assert status == "未決定", item.key
        else:
            assert status.startswith("決定済み"), item.key
    assert prereg.version in document.read_text(encoding="utf-8")
