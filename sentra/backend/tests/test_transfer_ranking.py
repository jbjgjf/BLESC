"""#215 — baselines, splits, leakage, participant-level ranking, the seal, and the stopped real path.

Synthetic data throughout. The "real" side is a second synthetic cohort (the
stand-in) or synthetic rows in the export's shape fed to the real-data path,
which refuses them. Frozen pre-registrations, frozen plans and approvals used
here are fictitious and exist only in memory.
"""

from __future__ import annotations

import dataclasses
import json
from pathlib import Path

import numpy as np
import pytest

from research_engine.contracts.errors import Code, ContractViolation
from research_engine.transfer import cli, forecasting
from research_engine.transfer.codes import TransferCode
from research_engine.transfer.consent_gate import (
    DEFAULT_REQUIRED_ROLES,
    OPERATION_EVALUATE,
    OPERATION_FIT,
    RealDataApproval,
    export_rows_from_dataset,
)
from research_engine.transfer.forecasting import (
    SPLIT_PARTICIPANT,
    SPLIT_TEMPORAL,
    LinearAR,
    ObservedPanel,
    Persistence,
    TrainMean,
    evaluate_dataset,
    leakage_probes,
    refuse_mixed_split_kinds,
)
from research_engine.transfer.generator import SyntheticCohortConfig, generate
from research_engine.transfer.pipeline import STAND_IN_LABEL, run_transfer_dry_run
from research_engine.transfer.plan import (
    DRY_RUN_PLAN,
    FIELD_ITEMS,
    FIT_SYNTHETIC_FROZEN,
    FIT_TARGET_SPLIT,
    ORIGIN_LAST_OBSERVED,
    ORIGIN_REQUIRE_OBSERVED,
    PLAN_STATUS_FROZEN,
    PLAN_STATUS_PLACEHOLDER,
    TIE_MARGIN,
)
from research_engine.transfer.preregistration import load_preregistration, parse_preregistration
from research_engine.transfer.ranking import compare_one, compare_rankings, rank, rank_evaluations
from research_engine.transfer.real_data import score_real_export
from research_engine.transfer.schema import CONSENT_DOCUMENT_VERSION, ITEM_IDS, PROTOCOL_VERSION
from research_engine.transfer.seal import (
    SEAL_CANDIDATE,
    SEAL_CONFIRMATORY,
    build_seal,
    require_confirmatory_seal,
    verify_seal,
    write_seal,
)

from test_transfer_preregistration import frozen_doc

NAN = float("nan")
FAST_PLAN = dataclasses.replace(DRY_RUN_PLAN, target_items=("mood", "sleep_hours"), bootstrap_rounds=200)


@pytest.fixture(scope="module")
def cohort():
    return generate(SyntheticCohortConfig(seed=41, missingness="state_dependent"))


@pytest.fixture(scope="module")
def evaluated(cohort):
    return evaluate_dataset(cohort.dataset, FAST_PLAN, fit_mode=FIT_TARGET_SPLIT)


# --------------------------------------------------------------------------
# The plan is a placeholder and says so
# --------------------------------------------------------------------------


def test_the_only_plan_in_the_code_is_a_labelled_placeholder() -> None:
    assert DRY_RUN_PLAN.status == PLAN_STATUS_PLACEHOLDER
    assert "提案ではなく" in DRY_RUN_PLAN.note_ja
    assert DRY_RUN_PLAN.target_items == ITEM_IDS  # P1 open: nothing singled out
    assert DRY_RUN_PLAN.inclusion_min_submitted_days == 0  # protocol §5.1: exclude nobody yet
    with pytest.raises(ContractViolation) as caught:
        DRY_RUN_PLAN.require_confirmatory()
    assert caught.value.code == TransferCode.PLAN_NOT_CONFIRMATORY
    for name in FIELD_ITEMS:
        assert hasattr(DRY_RUN_PLAN, name)
    assert set(FIELD_ITEMS.values()) <= {f"P{n}" for n in range(1, 15)}


# --------------------------------------------------------------------------
# The models
# --------------------------------------------------------------------------


def test_persistence_needs_the_origin_or_takes_the_last_observed() -> None:
    history = np.array([3.0, NAN, 5.0, NAN])
    assert Persistence().predict(history, ORIGIN_REQUIRE_OBSERVED) == (None, "origin_missing")
    assert Persistence().predict(history, ORIGIN_LAST_OBSERVED) == (5.0, None)
    assert Persistence().predict(np.array([]), ORIGIN_LAST_OBSERVED) == (None, "no_history")


def test_train_mean_ignores_missing_values() -> None:
    model = TrainMean()
    model.fit([np.array([1.0, NAN, 3.0]), np.array([NAN, 5.0])])
    assert model.mean == pytest.approx(3.0)
    assert model.predict(np.array([7.0]), ORIGIN_REQUIRE_OBSERVED) == (pytest.approx(3.0), None)


def test_linear_ar_fits_consecutive_days_only_and_never_zero_fills() -> None:
    # y(t+1) = 2 + 0.5 y(t), with a gap that would poison a row-to-row fit.
    series = [2.0]
    for _ in range(15):
        series.append(2.0 + 0.5 * series[-1])
    clean = np.array(series)
    gapped = clean.copy()
    gapped[[4, 9]] = NAN
    model = LinearAR()
    model.fit([gapped])
    a, b = model.coefficients
    assert a == pytest.approx(2.0, abs=1e-4)
    assert b == pytest.approx(0.5, abs=1e-4)
    assert model.n_pairs == len(clean) - 1 - 4  # each gap removes two pairs


def test_linear_ar_declines_without_enough_pairs() -> None:
    model = LinearAR()
    model.fit([np.array([1.0, NAN, 2.0, NAN])])
    assert model.coefficients is None
    assert model.predict(np.array([1.0]), ORIGIN_REQUIRE_OBSERVED) == (None, "not_fitted")


# --------------------------------------------------------------------------
# Splits and the evaluation set
# --------------------------------------------------------------------------


def test_the_two_split_kinds_are_separate_and_cannot_be_pooled(evaluated) -> None:
    participant = evaluated["evaluations"][SPLIT_PARTICIPANT]["mood"]
    temporal = evaluated["evaluations"][SPLIT_TEMPORAL]["mood"]
    assert not set(participant.fit_codes) & set(participant.eval_codes)
    assert temporal.fit_max_day == FAST_PLAN.temporal_fit_last_day
    assert min(point.target_day for point in temporal.points) > FAST_PLAN.temporal_fit_last_day
    assert set(temporal.eval_codes) & set(temporal.fit_codes)  # same people, earlier days: the point of it
    with pytest.raises(ContractViolation) as caught:
        refuse_mixed_split_kinds([participant, temporal])
    assert caught.value.code == TransferCode.SPLIT_KINDS_MIXED
    assert refuse_mixed_split_kinds([participant]) == SPLIT_PARTICIPANT


def test_fitting_uses_only_training_opt_in_participants(cohort, evaluated) -> None:
    participant = evaluated["evaluations"][SPLIT_PARTICIPANT]["mood"]
    for code in participant.fit_codes + evaluated["evaluations"][SPLIT_TEMPORAL]["mood"].fit_codes:
        assert cohort.dataset.enrollment(code).model_training_use is True


def test_every_point_is_scored_by_every_model_and_exclusions_are_counted(evaluated) -> None:
    for kind in (SPLIT_PARTICIPANT, SPLIT_TEMPORAL):
        evaluation = evaluated["evaluations"][kind]["mood"]
        reduction = evaluation.reduction
        assert reduction["scored"] == len(evaluation.points)
        assert (
            reduction["below_inclusion_minimum"] + reduction["target_missing"] + reduction["declined_by_a_model"] + reduction["scored"]
            == reduction["candidate_points"]
        )
        assert reduction["target_missing"] > 0
        for point in evaluation.points:
            assert set(point.predictions) == set(FAST_PLAN.model_ids)
            assert point.input_max_day <= point.origin_day < point.target_day == point.origin_day + 1


def test_missingness_shrinks_the_evaluation_set() -> None:
    complete = generate(SyntheticCohortConfig(seed=41, missingness="none", withdrawals_keep=0, withdrawals_delete=0))
    reduction = evaluate_dataset(complete.dataset, FAST_PLAN, fit_mode=FIT_TARGET_SPLIT)["evaluations"][SPLIT_PARTICIPANT]["mood"].reduction
    assert reduction["target_missing"] == 0
    assert reduction["declined_by_a_model"] == 0
    assert reduction["scored"] == reduction["candidate_points"]


def test_an_inclusion_minimum_excludes_and_is_counted(cohort) -> None:
    plan = dataclasses.replace(FAST_PLAN, inclusion_min_submitted_days=28)
    evaluation = evaluate_dataset(cohort.dataset, plan, fit_mode=FIT_TARGET_SPLIT)["evaluations"][SPLIT_PARTICIPANT]["mood"]
    assert evaluation.reduction["below_inclusion_minimum"] > 0


def test_frozen_mode_fits_on_the_selection_cohort_only(cohort) -> None:
    stand_in = generate(SyntheticCohortConfig(seed=42, missingness="independent"))
    frozen = evaluate_dataset(stand_in.dataset, FAST_PLAN, fit_mode=FIT_SYNTHETIC_FROZEN, selection=cohort.dataset)
    evaluation = frozen["evaluations"][SPLIT_PARTICIPANT]["mood"]
    assert all(code.startswith("SYN-41-") for code in evaluation.fit_codes)
    assert all(code.startswith("SYN-42-") for code in evaluation.eval_codes)
    with pytest.raises(ContractViolation):
        evaluate_dataset(stand_in.dataset, FAST_PLAN, fit_mode=FIT_SYNTHETIC_FROZEN)


# --------------------------------------------------------------------------
# Leakage — executed
# --------------------------------------------------------------------------


def test_every_leakage_probe_passes_on_synthetic_data(cohort) -> None:
    checks = leakage_probes(cohort.dataset, FAST_PLAN, truth_bearing=cohort)
    failed = [check.as_dict() for check in checks if not check.passed]
    assert failed == []
    names = {check.name for check in checks}
    assert {
        "participant_split_disjoint",
        "temporal_fit_before_scored_targets",
        "inputs_precede_targets",
        "future_values_do_not_move_earlier_forecasts",
        "text_and_timestamps_are_not_inputs",
        "generation_truth_refused_as_input",
        "split_kinds_not_pooled",
    } <= names
    assert all(check.checked_items for check in checks)


def test_the_probes_catch_a_model_that_sees_the_future(cohort, monkeypatch) -> None:
    # Simulate the bug the probes exist for: the history handed to the models
    # runs past the origin. Both the horizon check and the perturbation check
    # must go red.
    monkeypatch.setattr(forecasting, "_history", lambda series, origin: series[: origin + 1])
    checks = {check.name: check for check in leakage_probes(cohort.dataset, FAST_PLAN, truth_bearing=cohort)}
    assert checks["inputs_precede_targets"].passed is False
    assert checks["future_values_do_not_move_earlier_forecasts"].passed is False


def test_a_probe_that_could_not_run_does_not_pass(cohort) -> None:
    checks = {check.name: check for check in leakage_probes(cohort.dataset, FAST_PLAN, truth_bearing=None)}
    assert checks["generation_truth_refused_as_input"].passed is False


# --------------------------------------------------------------------------
# Ranking
# --------------------------------------------------------------------------


def test_mae_is_averaged_over_participants_with_a_paired_interval(evaluated) -> None:
    evaluation = evaluated["evaluations"][SPLIT_PARTICIPANT]["mood"]
    ranking = rank(evaluation, FAST_PLAN)
    errors = evaluation.per_participant_errors()
    per_participant = [np.mean(values) for values in errors["persistence"].values()]
    pooled = np.mean([abs(p.predictions["persistence"] - p.actual) for p in evaluation.points])
    assert ranking["models"]["persistence"]["mae"] == pytest.approx(float(np.mean(per_participant)))
    assert ranking["models"]["persistence"]["mae"] != pytest.approx(float(pooled), abs=1e-9)
    assert ranking["n_participants_scored"] == len(per_participant)
    assert len(ranking["pairs"]) == 3
    for pair in ranking["pairs"]:
        low, high = pair["interval"]
        assert low <= high
    assert ranking["uncertainty_method"].startswith("participant_bootstrap_paired")


def test_identical_models_are_tied_and_a_margin_rule_is_applied(evaluated) -> None:
    evaluation = evaluated["evaluations"][SPLIT_PARTICIPANT]["mood"]
    clone = dataclasses.replace(evaluation, points=[
        dataclasses.replace(point, predictions={**point.predictions, "train_mean": point.predictions["persistence"]})
        for point in evaluation.points
    ])
    ranking = rank(clone, FAST_PLAN)
    pair = next(p for p in ranking["pairs"] if {p["first"], p["second"]} == {"persistence", "train_mean"})
    assert pair["relation"] == "tie"

    wide = rank(evaluation, dataclasses.replace(FAST_PLAN, tie_rule=TIE_MARGIN, tie_margin=100.0))
    assert {pair["relation"] for pair in wide["pairs"]} == {"tie"}


def _fake_ranking(kind, order, ties=(), status="ok"):
    pairs = []
    position = {model: index for index, model in enumerate(order)}
    models = sorted(order)
    for i, first in enumerate(models):
        for second in models[i + 1 :]:
            relation = "tie" if {first, second} in [set(t) for t in ties] else ("first_better" if position[first] < position[second] else "second_better")
            pairs.append({"first": first, "second": second, "relation": relation, "mean_difference_first_minus_second": 0.1, "interval": [0.0, 0.2]})
    winner = order[0]
    tied = sorted({(set(t) - {winner}).pop() for t in ties if winner in t})
    return {
        "split_kind": kind,
        "item": "mood",
        "status": status,
        "reduction": {},
        "n_participants_scored": 10,
        "models": {model: {"mae": float(position[model]), "interval": [0, 1]} for model in order},
        "pairs": pairs,
        "order": list(order),
        "winner": winner,
        "tied_with_winner": tied,
    }


def test_agreement_reversal_and_tie_zones_are_all_reported() -> None:
    synthetic = _fake_ranking("participant", ["linear_ar", "persistence", "train_mean"])
    real = _fake_ranking("participant", ["persistence", "linear_ar", "train_mean"], ties=[("linear_ar", "train_mean")])
    comparison = compare_one(synthetic, real)
    assert comparison["pair_counts"] == {"agree": 1, "reversal": 1, "tie_both": 0, "tie_synthetic_only": 0, "tie_real_only": 1}
    assert comparison["winner_agrees"] is False
    # The synthetic winner lost to a simple baseline on real data: kept, not hidden.
    assert comparison["synthetic_winner_beaten_on_real_by"] == ["persistence"]


def test_comparisons_refuse_mixed_splits_and_mixed_plans() -> None:
    with pytest.raises(ContractViolation) as caught:
        compare_one(_fake_ranking("participant", ["a", "b"]), _fake_ranking("temporal", ["a", "b"]))
    assert caught.value.code == TransferCode.SPLIT_KINDS_MIXED
    with pytest.raises(ContractViolation) as caught:
        compare_rankings({"plan_hash": "x", "rankings": {}}, {"plan_hash": "y", "rankings": {}})
    assert caught.value.code == TransferCode.PLAN_MISMATCH


def test_the_comparison_leaves_the_primary_outcome_and_failure_rule_open(cohort, evaluated) -> None:
    synthetic = rank_evaluations(evaluated, FAST_PLAN)
    comparison = compare_rankings(synthetic, synthetic)
    assert comparison["primary_outcome"] is None and "P3" in comparison["primary_outcome_note_ja"]
    assert comparison["failure_conditions"] is None and "P7" in comparison["failure_conditions_note_ja"]
    for kind in (SPLIT_PARTICIPANT, SPLIT_TEMPORAL):
        for row in comparison["comparisons"][kind].values():
            assert row["winner_agrees"] is True
            assert row["pair_counts"]["reversal"] == 0


# --------------------------------------------------------------------------
# The seal
# --------------------------------------------------------------------------


def _frozen_plan_for(prereg):
    return dataclasses.replace(FAST_PLAN, status=PLAN_STATUS_FROZEN, preregistration_hash=prereg.content_hash(), plan_id="test-frozen（架空）")


def test_a_seal_under_the_open_draft_is_a_candidate(tmp_path: Path, cohort, evaluated) -> None:
    ranking = rank_evaluations(evaluated, FAST_PLAN)
    record = build_seal(ranking, plan=FAST_PLAN, manifest=cohort.manifest, preregistration=load_preregistration(), sealed_at="2030-01-01T00:00:00Z", code_commit=None)
    path = write_seal(record, tmp_path / "seal.json")
    reread = verify_seal(path)
    assert reread["status"] == SEAL_CANDIDATE
    assert reread["valid_for_confirmatory"] is False
    with pytest.raises(ContractViolation) as caught:
        require_confirmatory_seal(reread)
    assert caught.value.code == TransferCode.SEAL_NOT_CONFIRMATORY


def test_the_seal_is_write_once_and_tamper_evident(tmp_path: Path, cohort, evaluated) -> None:
    ranking = rank_evaluations(evaluated, FAST_PLAN)
    record = build_seal(ranking, plan=FAST_PLAN, manifest=cohort.manifest, preregistration=load_preregistration(), sealed_at="2030-01-01T00:00:00Z", code_commit=None)
    path = write_seal(record, tmp_path / "seal.json")
    with pytest.raises(ContractViolation) as caught:
        write_seal(record, path)
    assert caught.value.code == TransferCode.SEAL_EXISTS

    payload = json.loads(path.read_text(encoding="utf-8"))
    payload["ranking"]["rankings"]["participant"]["mood"]["winner"] = "train_mean"
    path.write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(ContractViolation) as caught:
        verify_seal(path)
    assert caught.value.code == TransferCode.SEAL_MISMATCH


def test_the_ranking_hash_is_reproducible(cohort) -> None:
    first = rank_evaluations(evaluate_dataset(cohort.dataset, FAST_PLAN, fit_mode=FIT_TARGET_SPLIT), FAST_PLAN)
    second = rank_evaluations(evaluate_dataset(cohort.dataset, FAST_PLAN, fit_mode=FIT_TARGET_SPLIT), FAST_PLAN)
    prereg = load_preregistration()
    a = build_seal(first, plan=FAST_PLAN, manifest=cohort.manifest, preregistration=prereg, sealed_at="t1", code_commit=None)
    b = build_seal(second, plan=FAST_PLAN, manifest=cohort.manifest, preregistration=prereg, sealed_at="t2", code_commit=None)
    assert a["ranking_hash"] == b["ranking_hash"]
    assert a["seal_hash"] != b["seal_hash"]


def test_a_frozen_preregistration_and_frozen_plan_make_a_confirmatory_seal(cohort, evaluated) -> None:
    prereg = parse_preregistration(frozen_doc())
    plan = _frozen_plan_for(prereg)
    ranking = rank_evaluations(evaluate_dataset(cohort.dataset, plan, fit_mode=FIT_TARGET_SPLIT), plan)
    record = build_seal(ranking, plan=plan, manifest=cohort.manifest, preregistration=prereg, sealed_at="t", code_commit="abc1234")
    assert record["status"] == SEAL_CONFIRMATORY
    require_confirmatory_seal(verify_seal(record))


# --------------------------------------------------------------------------
# The real-data path: built, and stopped
# --------------------------------------------------------------------------


def _approvals(operations=(OPERATION_EVALUATE, OPERATION_FIT)):
    return [
        RealDataApproval(role, "test（架空）", PROTOCOL_VERSION, CONSENT_DOCUMENT_VERSION, "2030-01-01", "test（架空）", tuple(operations))
        for role in DEFAULT_REQUIRED_ROLES
    ]


@pytest.fixture(scope="module")
def real_path_inputs(cohort):
    prereg = parse_preregistration(frozen_doc())
    plan = _frozen_plan_for(prereg)
    ranking = rank_evaluations(evaluate_dataset(cohort.dataset, plan, fit_mode=FIT_TARGET_SPLIT), plan)
    seal = build_seal(ranking, plan=plan, manifest=cohort.manifest, preregistration=prereg, sealed_at="t", code_commit="abc1234")
    stand_in = generate(SyntheticCohortConfig(seed=43, missingness="independent"))
    rows = export_rows_from_dataset(stand_in.dataset)
    return {"prereg": prereg, "plan": plan, "seal": seal, "rows": rows, "selection": cohort.dataset}


def test_the_real_path_refuses_without_an_approval_record(real_path_inputs) -> None:
    inputs = real_path_inputs
    with pytest.raises(ContractViolation) as caught:
        score_real_export(inputs["rows"], approvals=None, preregistration=inputs["prereg"], plan=inputs["plan"], seal=inputs["seal"], selection=inputs["selection"])
    assert caught.value.code == TransferCode.APPROVAL_MISSING


def test_the_real_path_needs_fit_approval_when_the_plan_fits_on_real_data(real_path_inputs) -> None:
    inputs = real_path_inputs
    with pytest.raises(ContractViolation) as caught:
        score_real_export(inputs["rows"], approvals=_approvals((OPERATION_EVALUATE,)), preregistration=inputs["prereg"], plan=inputs["plan"], seal=inputs["seal"], selection=inputs["selection"])
    assert caught.value.code == TransferCode.OPERATION_NOT_PERMITTED


def test_the_real_path_refuses_the_open_draft_and_the_placeholder_plan(real_path_inputs) -> None:
    inputs = real_path_inputs
    draft = load_preregistration()
    from research_engine.transfer.preregistration import freeze_status

    if not freeze_status(draft).frozen:
        with pytest.raises(ContractViolation) as caught:
            score_real_export(inputs["rows"], approvals=_approvals(), preregistration=draft, plan=inputs["plan"], seal=inputs["seal"], selection=inputs["selection"])
        assert caught.value.code == TransferCode.PREREGISTRATION_NOT_FROZEN
    with pytest.raises(ContractViolation) as caught:
        score_real_export(inputs["rows"], approvals=_approvals(), preregistration=inputs["prereg"], plan=FAST_PLAN, seal=inputs["seal"], selection=inputs["selection"])
    assert caught.value.code == TransferCode.PLAN_NOT_CONFIRMATORY


def test_the_real_path_refuses_a_candidate_or_altered_seal(real_path_inputs, cohort) -> None:
    inputs = real_path_inputs
    candidate = build_seal(inputs["seal"]["ranking"], plan=FAST_PLAN, manifest=cohort.manifest, preregistration=load_preregistration(), sealed_at="t", code_commit=None)
    with pytest.raises(ContractViolation) as caught:
        score_real_export(inputs["rows"], approvals=_approvals(), preregistration=inputs["prereg"], plan=inputs["plan"], seal=candidate, selection=inputs["selection"])
    assert caught.value.code == TransferCode.SEAL_NOT_CONFIRMATORY

    altered = json.loads(json.dumps(inputs["seal"]))
    altered["ranking"]["n_fit_participants"]["participant"] += 1
    with pytest.raises(ContractViolation) as caught:
        score_real_export(inputs["rows"], approvals=_approvals(), preregistration=inputs["prereg"], plan=inputs["plan"], seal=altered, selection=inputs["selection"])
    assert caught.value.code == TransferCode.SEAL_MISMATCH


def test_with_everything_in_place_the_v0_contract_still_refuses_real_rows(real_path_inputs) -> None:
    inputs = real_path_inputs
    with pytest.raises(ContractViolation) as caught:
        score_real_export(inputs["rows"], approvals=_approvals(), preregistration=inputs["prereg"], plan=inputs["plan"], seal=inputs["seal"], selection=inputs["selection"])
    assert caught.value.code == Code.REAL_DATA_REFUSED


# --------------------------------------------------------------------------
# End to end on synthetic data
# --------------------------------------------------------------------------


def test_the_dry_run_goes_end_to_end_and_compares_against_the_sealed_ranking(tmp_path: Path) -> None:
    result = run_transfer_dry_run(5, tmp_path, plan=FAST_PLAN, sealed_at="2030-01-01T00:00:00Z", code_commit="test")
    summary = result["summary"]
    assert summary["leakage_checks_passed"] is True
    assert summary["consent_dry_run_passed"] is True
    assert summary["seal"]["status"] == SEAL_CANDIDATE
    assert summary["real_data_used"] is False
    assert summary["stand_in"]["label"] == STAND_IN_LABEL
    sealed = verify_seal(tmp_path / "synthetic_ranking.seal.json")
    for mode, payload in result["stand_in_results"].items():
        assert payload["comparison"]["synthetic"]["dataset_hash"] == sealed["ranking"]["dataset_hash"]
        assert set(payload["comparison"]["comparisons"]) == {SPLIT_PARTICIPANT, SPLIT_TEMPORAL}
    for name in ("summary.json", "leakage_checks.json", "ranking_comparison.json", "audit_comparison.json", "audit_selection_public.json"):
        assert (tmp_path / name).exists()
    for name in ("ranking_comparison.json", "stand_in_rankings.json", "audit_selection_public.json", "summary.json"):
        assert "SYN-" not in (tmp_path / name).read_text(encoding="utf-8")

    # Write-once: a second dry run into the same directory is refused.
    with pytest.raises(ContractViolation) as caught:
        run_transfer_dry_run(5, tmp_path, plan=FAST_PLAN, sealed_at="2030-01-01T00:00:00Z", code_commit="test")
    assert caught.value.code == TransferCode.SEAL_EXISTS


def test_the_cli_dry_run(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    assert cli.main(["dry-run", "--seed", "5", "--out", str(tmp_path / "run")]) == 0
    printed = json.loads(capsys.readouterr().out)
    assert printed["status"] == "candidate_not_frozen"
    assert printed["plan_status"] == PLAN_STATUS_PLACEHOLDER
