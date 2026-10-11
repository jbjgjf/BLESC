"""#213 — the synthetic cohort is reproducible from its seed and keeps its truth to itself.

Three properties carry the issue's acceptance criteria:

1. **Reproducible.** The same config gives byte-identical data and the same
   hashes; a pinned hash catches a generator change that nobody versioned.
2. **No truth in the data.** The dataset object and its JSON contain no
   latent value, no complete value for a missing day or item, and no
   missingness probability. A missing answer is `None`, never a number.
3. **No future in any day.** A shorter study is an exact prefix of the
   longer one, so nothing generated for day *d* can depend on day *d+1*.

The model-side half of "no truth / no future in the model input" is tested
with the forecasting code in `test_transfer_ranking.py`.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from research_engine.contracts.errors import ContractViolation
from research_engine.transfer import CANDIDATE_STATUS
from research_engine.transfer import cli
from research_engine.transfer.generator import (
    CARRIES_GENERATION_TRUTH,
    MISSINGNESS_SCENARIOS,
    SyntheticCohortConfig,
    generate,
    generator_source_hash,
    manifest_hash,
    read_dataset,
    write_cohort,
)
from research_engine.transfer.schema import ITEM_IDS, STUDY_DAYS, TARGET_PARTICIPANTS, TransferDataset

#: Pinned output of `SyntheticCohortConfig(seed=1, missingness="state_dependent")`.
#: If this changes, the generator produces different data for the same seed.
#: That may be intended — but then bump `GENERATOR_VERSION`, say why in the
#: commit, and remember that any cohort already sealed was made by the old code.
#: The value was checked to be identical under numpy 2.4.6 and 2.5.3 (the
#: version in requirements.lock.txt). A numpy upgrade that changes it means
#: the old cohorts can no longer be re-created with the new numpy.
PINNED_SEED_1_STATE_DEPENDENT = "sha256:14dcbd26a21b845698e142bf44c8462809b4b17d04621c597c00bf628584f759"


def _config(**overrides) -> SyntheticCohortConfig:
    base = dict(seed=1, missingness="state_dependent")
    base.update(overrides)
    return SyntheticCohortConfig(**base)


# --------------------------------------------------------------------------
# 1. Reproducible
# --------------------------------------------------------------------------


def test_the_same_seed_gives_the_same_hashes() -> None:
    first = generate(_config())
    second = generate(_config())
    assert first.dataset.content_hash() == second.dataset.content_hash()
    assert first.truth.content_hash() == second.truth.content_hash()
    assert manifest_hash(first.manifest) == manifest_hash(second.manifest)
    assert json.dumps(first.dataset.as_dict(), sort_keys=True) == json.dumps(second.dataset.as_dict(), sort_keys=True)


def test_the_hash_for_seed_one_is_pinned() -> None:
    assert generate(_config()).manifest["hashes"]["dataset_hash"] == PINNED_SEED_1_STATE_DEPENDENT


def test_a_different_seed_gives_different_data() -> None:
    assert generate(_config(seed=1)).dataset.content_hash() != generate(_config(seed=2)).dataset.content_hash()


@pytest.mark.parametrize("missingness", MISSINGNESS_SCENARIOS)
def test_every_scenario_is_reproducible(missingness: str) -> None:
    assert (
        generate(_config(missingness=missingness)).dataset.content_hash()
        == generate(_config(missingness=missingness)).dataset.content_hash()
    )


def test_seed_and_missingness_have_no_default() -> None:
    # Which seed and scenario become the frozen set is P13. A default would be
    # that decision taken by a library.
    with pytest.raises(TypeError):
        SyntheticCohortConfig()  # type: ignore[call-arg]
    with pytest.raises(TypeError):
        SyntheticCohortConfig(seed=1)  # type: ignore[call-arg]


def test_round_trip_through_disk_keeps_the_hash_and_refuses_drift(tmp_path: Path) -> None:
    cohort = generate(_config())
    paths = write_cohort(cohort, tmp_path)
    loaded = read_dataset(paths["dataset"], paths["manifest"])
    assert loaded.content_hash() == cohort.dataset.content_hash()
    assert paths["truth"].parent.name == "sealed_truth"
    assert paths["truth"].parent != paths["dataset"].parent

    payload = json.loads(paths["dataset"].read_text(encoding="utf-8"))
    payload["records"][0]["day_index"] = payload["records"][0]["day_index"] + 1 if payload["records"][0]["day_index"] < STUDY_DAYS else 1
    paths["dataset"].write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(ContractViolation):
        read_dataset(paths["dataset"], paths["manifest"])


def test_the_cli_writes_the_same_cohort(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    assert cli.main(["generate", "--seed", "1", "--missingness", "state_dependent", "--out", str(tmp_path)]) == 0
    printed = json.loads(capsys.readouterr().out)
    assert printed["dataset_hash"] == generate(_config()).dataset.content_hash()
    assert printed["status"] == CANDIDATE_STATUS


# --------------------------------------------------------------------------
# Shape and manifest
# --------------------------------------------------------------------------


def test_fifty_by_twenty_eight_at_most_one_record_per_day() -> None:
    cohort = generate(_config(missingness="none", withdrawals_keep=0, withdrawals_delete=0))
    dataset = cohort.dataset
    assert len(dataset.enrollments) == TARGET_PARTICIPANTS
    assert len(dataset.records) == TARGET_PARTICIPANTS * STUDY_DAYS == 1400
    assert len({(record.research_code, record.day_index) for record in dataset.records}) == 1400
    for code in dataset.participants:
        assert [record.day_index for record in dataset.records_for(code)] == list(range(1, STUDY_DAYS + 1))


def test_the_manifest_records_what_issue_213_asks_for() -> None:
    cohort = generate(_config())
    manifest = cohort.manifest
    assert manifest["status"] == CANDIDATE_STATUS
    assert manifest["generator"]["kind"] == "statistical"
    assert manifest["generator"]["source_sha256"] == generator_source_hash()
    assert manifest["seed"] == 1
    assert manifest["config"]["seed"] == 1
    assert manifest["missingness_scenario"] == "state_dependent"
    assert manifest["config_hash"].startswith("sha256:")
    assert manifest["environment"]["numpy"] == np.__version__
    assert manifest["hashes"]["dataset_hash"] == cohort.dataset.content_hash()
    assert manifest["hashes"]["truth_hash"] == cohort.truth.content_hash()
    assert manifest["shape"]["matches_protocol"] is True
    assert manifest["inputs"] == {
        "real_participant_data": False,
        "real_text": False,
        "real_data_aggregates": False,
        "note_ja": manifest["inputs"]["note_ja"],
    }
    assert manifest["llm"]["used"] is False
    assert manifest["llm"]["provider_calls"] == 0
    assert "母集団事前分布ではない" in manifest["not_a_population_prior_ja"]
    assert "frozen" not in json.dumps(manifest).replace("not_frozen", "")


def test_a_non_protocol_shape_says_so() -> None:
    cohort = generate(_config(n_participants=10, withdrawals_keep=0, withdrawals_delete=0))
    assert cohort.manifest["shape"]["matches_protocol"] is False


# --------------------------------------------------------------------------
# 2. No truth in the data
# --------------------------------------------------------------------------


def test_missing_is_none_and_a_skipped_day_has_no_record() -> None:
    cohort = generate(_config(withdrawals_keep=0, withdrawals_delete=0))
    by_key = {(record.research_code, record.day_index): record for record in cohort.dataset.records}
    skipped_items = 0
    for code, submitted in cohort.truth.submitted.items():
        for day, was_submitted in enumerate(submitted, start=1):
            record = by_key.get((code, day))
            assert (record is not None) == was_submitted
            if record is None or record.self_report is None:
                continue
            for item_id, value in zip(ITEM_IDS, record.self_report):
                if value is None:
                    skipped_items += 1
                else:
                    assert value == cohort.truth.complete_value(code, day, item_id)
    assert skipped_items > 0, "欠測項目が1件もないと、この検査は何も確かめていない"


def test_the_dataset_carries_no_generated_truth() -> None:
    cohort = generate(_config())
    serialised = json.dumps(cohort.dataset.as_dict(), ensure_ascii=False)
    for key in ("strain", "complete_values", "submit_probability", "submitted\"", "latent"):
        assert key not in serialised
    assert set(TransferDataset.__dataclass_fields__) == {
        "dataset_id",
        "source_kind",
        "records",
        "enrollments",
        "permitted_uses",
        "study_days",
    }
    assert getattr(cohort, CARRIES_GENERATION_TRUTH) is True
    assert getattr(cohort.truth, CARRIES_GENERATION_TRUTH) is True
    assert not getattr(cohort.dataset, CARRIES_GENERATION_TRUTH, False)


def test_missed_days_have_values_only_in_the_truth() -> None:
    cohort = generate(_config(withdrawals_keep=0, withdrawals_delete=0))
    present = {(record.research_code, record.day_index) for record in cohort.dataset.records}
    missed = [
        (code, day)
        for code, submitted in cohort.truth.submitted.items()
        for day, flag in enumerate(submitted, start=1)
        if not flag
    ]
    assert missed
    assert not present & set(missed)
    code, day = missed[0]
    assert cohort.truth.complete_value(code, day, "mood") is not None


# --------------------------------------------------------------------------
# 3. No future in any day, and the scenarios share their latent path
# --------------------------------------------------------------------------


@pytest.mark.parametrize("missingness", MISSINGNESS_SCENARIOS)
def test_a_shorter_study_is_a_prefix_of_the_longer_one(missingness: str) -> None:
    short = generate(_config(missingness=missingness, study_days=14, withdrawals_keep=0, withdrawals_delete=0))
    full = generate(_config(missingness=missingness, withdrawals_keep=0, withdrawals_delete=0))
    prefix = [record.as_dict() for record in full.dataset.records if record.day_index <= 14]
    assert [record.as_dict() for record in short.dataset.records] == prefix
    for code in short.truth.complete_values:
        assert short.truth.complete_values[code] == full.truth.complete_values[code][:14]


def test_the_latent_path_is_the_same_under_every_scenario() -> None:
    cohorts = {scenario: generate(_config(missingness=scenario)) for scenario in MISSINGNESS_SCENARIOS}
    reference = cohorts["none"].truth
    for cohort in cohorts.values():
        assert cohort.truth.complete_values == reference.complete_values
        assert cohort.truth.strain == reference.strain


def test_state_dependent_with_zero_strength_is_the_independent_scenario() -> None:
    independent = generate(_config(missingness="independent"))
    zero = generate(_config(missingness="state_dependent", mnar_strength=0.0))
    assert [record.as_dict() for record in zero.dataset.records] == [
        record.as_dict() for record in independent.dataset.records
    ]


def _strain_gap(cohort) -> float:
    """Mean strain on missed days minus mean strain on submitted days, pooled."""

    missed, kept = [], []
    for code, submitted in cohort.truth.submitted.items():
        for strain, flag in zip(cohort.truth.strain[code], submitted):
            (kept if flag else missed).append(strain)
    return float(np.mean(missed) - np.mean(kept))


def test_state_dependent_missingness_depends_on_the_state_and_independent_does_not() -> None:
    # The scenario's own claim, checked on its own truth. It says nothing about
    # real students: the truth here is synthetic and is never a fact about the pilot.
    independent = generate(_config(missingness="independent", seed=5))
    dependent = generate(_config(missingness="state_dependent", seed=5, mnar_strength=2.0))
    assert abs(_strain_gap(independent)) < 0.15
    assert _strain_gap(dependent) > 0.3


def test_withdrawal_rows_stop_at_the_withdrawal_day_unless_a_defect_is_simulated() -> None:
    clean = generate(_config(withdrawals_keep=2, withdrawals_delete=1))
    withdrawn = [enrollment for enrollment in clean.dataset.enrollments if enrollment.withdrawn]
    assert len(withdrawn) == 3
    assert {enrollment.withdrawal_data_choice for enrollment in withdrawn} == {"keep", "delete"}
    for enrollment in withdrawn:
        assert all(record.day_index < enrollment.withdrawn_day for record in clean.dataset.records_for(enrollment.research_code))

    defective = generate(_config(withdrawals_keep=2, withdrawals_delete=1, stray_rows_after_withdrawal=2))
    stray = [
        record
        for enrollment in defective.dataset.enrollments
        if enrollment.withdrawn
        for record in defective.dataset.records_for(enrollment.research_code)
        if record.day_index >= enrollment.withdrawn_day
    ]
    assert stray, "撤回後の行を模擬できないと、撤回ゲートの検査が空振りする"


def test_text_exists_only_with_retention_consent() -> None:
    cohort = generate(_config())
    for record in cohort.dataset.records:
        enrollment = cohort.dataset.enrollment(record.research_code)
        assert record.text_available == enrollment.raw_text_retention
        assert record.model_training_use == enrollment.model_training_use
