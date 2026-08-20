from __future__ import annotations

from pathlib import Path

import pytest

from app.services.benchmark_model_labelling import (
    HARD_STOP_USD,
    LABELLED_BY,
    BudgetExceeded,
    CostLedger,
    Usage,
    agreement_report,
    blind_case,
    generate_cases,
    judge_cases,
    validate_cases,
    validate_judgements,
)


def case(case_id="confirmatory-01-ja", lang="ja"):
    evidence = [
        {
            "evidence_id": f"p01-{lang}-e{index:02d}",
            "day": f"2026-06-{index:02d}",
            "text": f"synthetic {index}",
            "graph_motifs": ["Trigger:pressure -> causes -> State:fatigue"],
            "safety_label": "normal",
        }
        for index in range(1, 21)
    ]
    return {
        "case_id": case_id,
        "pair_id": "pair-01",
        "query": "query",
        "query_anchors": ["pressure"],
        "evidence": evidence,
        "author_intended_evidence_ids": [evidence[0]["evidence_id"]],
        "expected_evidence_ids": [],
        "expected_safety": "normal",
        "expected_policy": "bounded",
        "research_note": "synthetic",
        "family": "multi_day_chain",
        "lang": lang,
        "required_hops": 2,
        "labelled_by": LABELLED_BY,
    }


def judgement(case_id, picks):
    return {
        "case_id": case_id,
        "selected_evidence_ids": picks,
        "confidence": 0.8,
        "reason": "synthetic test",
    }


def test_blind_case_hides_author_intent_and_answer_fields():
    payload = blind_case(case())
    serialised = repr(payload)
    assert "author_intended" not in serialised
    assert "expected_evidence_ids" not in serialised
    assert "research_note" not in serialised
    assert "family" not in serialised
    assert "required_hops" not in serialised


def test_candidate_ids_are_neutral_and_do_not_encode_target_or_decoy():
    ids = [item["evidence_id"] for item in case()["evidence"]]
    assert all("target" not in value and "decoy" not in value for value in ids)
    assert all(value.rsplit("-", 1)[-1].startswith("e") for value in ids)


def test_validation_rejects_invalid_selected_ids():
    sample = case()
    with pytest.raises(ValueError, match="invalid selected"):
        validate_judgements([sample], {"judgements": [judgement(sample["case_id"], ["not-present"])]})


def test_agreement_is_reported_as_same_model_not_inter_rater_kappa():
    sample = case()
    selected = [sample["evidence"][0]["evidence_id"]]
    runs = [{sample["case_id"]: judgement(sample["case_id"], selected)} for _ in range(3)]
    report = agreement_report([sample], runs)
    assert report["unanimous_case_rate"] == 1.0
    assert report["cohens_kappa"] is None
    assert report["same_model_repeated_judgement"] is True
    assert "Not inter-rater" in report["note"]


def test_cost_uses_official_sol_rates_and_fails_before_hard_stop(tmp_path: Path):
    ledger = CostLedger(tmp_path / "ledger.json")
    usage = Usage(input_tokens=1_000_000, cached_input_tokens=100_000, output_tokens=10_000)
    assert usage.cost_usd == pytest.approx(4.85)
    for index in range(5):
        ledger.record(purpose=str(index), usage=usage, response_id=None)
    assert ledger.total_usd == pytest.approx(24.25)
    with pytest.raises(BudgetExceeded):
        ledger.reserve(estimated_input_tokens=100_000, max_output_tokens=100_000)
    assert ledger.hard_stop_usd == HARD_STOP_USD


def test_case_contract_accepts_20_candidates_and_model_label():
    sample = case()
    validate_cases([sample], expected_count=1)
    assert sample["labelled_by"] == "model:gpt-5.6-sol"


def test_judging_resume_skips_completed_batches():
    sample = case()
    selected = [sample["evidence"][0]["evidence_id"]]
    completed = {sample["case_id"]: judgement(sample["case_id"], selected)}
    class NeverCalled:
        responses = None
    runs = judge_cases(NeverCalled(), object(), [sample], initial_runs=[completed, completed, completed])
    assert all(run[sample["case_id"]]["selected_evidence_ids"] == selected for run in runs)
