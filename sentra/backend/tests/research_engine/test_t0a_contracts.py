"""T0a (#139): the v0 contracts, their fixtures, and the refusals they owe.

Two halves. The first reads every `*_valid.json` and requires it to load — this
is what lets six teams develop in parallel against the same bytes. The second
reads every `*_invalid_*.json` and requires a *specific* violation code, because
"raises something" would pass even if the check that fired was the wrong one.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from research_engine.contracts import (
    CapabilityFlags,
    Code,
    ContractViolation,
    EncodedSequence,
    EncoderDescriptor,
    EvaluationReport,
    ExplanationBundle,
    ForecastBundle,
    Observation,
    ObservationBundle,
    content_hash,
    parse_time,
    refuse_real_source_kinds,
    refuse_unpermitted_uses,
    stable_forecast_id,
)
from research_engine.contracts.common import elapsed_days
from research_engine.contracts.observation import DatasetManifest

from fixtures_loader import load_fixture

VALID_FIXTURES = {
    "observation_bundle_valid.json": ObservationBundle.from_dict,
    "encoded_sequence_valid.json": EncodedSequence.from_dict,
    "forecast_bundle_valid.json": ForecastBundle.from_dict,
    "explanation_bundle_valid.json": ExplanationBundle.from_dict,
    "evaluation_report_valid.json": EvaluationReport.from_dict,
}

INVALID_FIXTURES = [
    ("observation_bundle_invalid_mask.json", ObservationBundle.from_dict, Code.MASK_VALUE_MISMATCH),
    ("observation_bundle_invalid_duplicate_event.json", ObservationBundle.from_dict, Code.DUPLICATE_EVENT_ID),
    (
        "observation_bundle_invalid_feature_schema.json",
        ObservationBundle.from_dict,
        Code.FEATURE_SCHEMA_MISMATCH,
    ),
    ("encoded_sequence_invalid_future.json", EncodedSequence.from_dict, Code.FUTURE_LEAKAGE),
    ("encoded_sequence_invalid_dim.json", EncodedSequence.from_dict, Code.DIMENSION_MISMATCH),
    (
        "forecast_bundle_invalid_target_not_future.json",
        ForecastBundle.from_dict,
        Code.TARGET_NOT_IN_FUTURE,
    ),
    (
        "forecast_bundle_invalid_status_payload.json",
        ForecastBundle.from_dict,
        Code.STATUS_PAYLOAD_MISMATCH,
    ),
    (
        "forecast_bundle_invalid_deterministic_scale.json",
        ForecastBundle.from_dict,
        Code.UNCERTAINTY_WITHOUT_METHOD,
    ),
    (
        "explanation_bundle_invalid_interaction_order.json",
        ExplanationBundle.from_dict,
        Code.SHAPE_MISMATCH,
    ),
    ("evaluation_report_invalid_missing_hash.json", EvaluationReport.from_dict, Code.MISSING_FIELD),
]


@pytest.mark.parametrize("name,loader", sorted(VALID_FIXTURES.items()))
def test_valid_fixtures_load(name, loader):
    loaded = loader(load_fixture(name))
    assert loaded is not None


@pytest.mark.parametrize("name,loader,expected_code", INVALID_FIXTURES)
def test_invalid_fixtures_are_refused_with_the_right_code(name, loader, expected_code):
    with pytest.raises(ContractViolation) as caught:
        loader(load_fixture(name))
    assert caught.value.code == expected_code, caught.value


@pytest.mark.parametrize("name,loader", sorted(VALID_FIXTURES.items()))
def test_round_trip_is_byte_stable(name, loader):
    """as_dict(from_dict(x)) hashes the same twice — hashes are meaningless otherwise."""

    payload = load_fixture(name)
    once = loader(payload).as_dict()
    twice = loader(once).as_dict()
    assert content_hash(once) == content_hash(twice)


def test_naive_timestamps_are_refused():
    """A timestamp without an offset is a nine-hour leak waiting to happen."""

    payload = load_fixture("observation_bundle_valid.json")
    payload["observations"][0]["available_at"] = "2026-09-01T12:00:01"
    with pytest.raises(ContractViolation) as caught:
        ObservationBundle.from_dict(payload)
    assert caught.value.code == Code.NAIVE_TIMESTAMP


def test_nan_is_refused_rather_than_serialised():
    payload = load_fixture("observation_bundle_valid.json")
    payload["observations"][1]["values"][0] = float("nan")
    with pytest.raises(ContractViolation) as caught:
        ObservationBundle.from_dict(payload)
    assert caught.value.code == Code.NON_FINITE_NUMBER


def test_visible_at_filters_on_availability_not_occurrence():
    """The whole leakage guarantee rests on this being `available_at`."""

    payload = load_fixture("observation_bundle_valid.json")
    # An event that happened first but was only recorded later.
    payload["observations"][1]["occurred_at"] = "2026-08-30T09:00:00Z"
    bundle = ObservationBundle.from_dict(payload)
    cutoff = parse_time("2026-09-01T23:59:59Z", "cutoff")

    visible = bundle.visible_at(cutoff)

    assert [row.event_id for row in visible.observations] == ["synthetic-001-event-01"]


def test_empty_sequence_stays_empty():
    payload = load_fixture("encoded_sequence_valid.json")
    payload["event_ids"] = []
    payload["available_times"] = []
    payload["delta_days"] = []
    payload["h_values"] = []
    payload["sequence_mask"] = []
    sequence = EncodedSequence.from_dict(payload)
    assert sequence.is_empty
    assert sequence.h_values == ()


def test_encoder_descriptors_of_equal_width_are_not_compatible():
    """The rule the contract states in one line, enforced in one assertion."""

    left = EncoderDescriptor(
        encoder_id="gru-lite-v0",
        feature_schema_id="synthetic-features-v0",
        normalizer_id="train-zscore-v0",
        latent_dim=4,
    )
    right = EncoderDescriptor(
        encoder_id="gru-lite-v0",
        feature_schema_id="synthetic-features-v1",
        normalizer_id="train-zscore-v0",
        latent_dim=4,
    )
    with pytest.raises(ContractViolation) as caught:
        left.require_compatible(right)
    assert caught.value.code == Code.FEATURE_SCHEMA_MISMATCH


def test_forecast_id_is_stable_across_reruns_and_moves_with_the_weights():
    common = dict(
        dataset_id="synthetic-dev-v0",
        split_id="participant-holdout-v0",
        participant_key="synthetic-001",
        cutoff_at=parse_time("2026-09-03T00:00:00Z", "cutoff"),
        target_times=[parse_time("2026-09-04T00:00:00Z", "t")],
        target_names=["x1"],
    )
    first = stable_forecast_id(model_hash="sha256:aa", **common)
    rerun = stable_forecast_id(model_hash="sha256:aa", **common)
    retrained = stable_forecast_id(model_hash="sha256:bb", **common)

    assert first == rerun
    assert first != retrained


def test_capability_flags_cannot_claim_causal_effects_in_v0():
    with pytest.raises(ContractViolation) as caught:
        CapabilityFlags(real_world_causal_effects=True).validate()
    assert caught.value.code == Code.FORBIDDEN_CAPABILITY


def test_real_data_is_refused_at_the_permission_boundary():
    """Two refusals: a use not declared, and a real use declared but unverifiable."""

    manifest = DatasetManifest.from_dict(load_fixture("observation_bundle_valid.json")["manifest"])
    with pytest.raises(ContractViolation) as undeclared:
        refuse_unpermitted_uses(manifest, "model_training")
    assert undeclared.value.code == Code.PERMISSION_NOT_GRANTED

    real = DatasetManifest.from_dict(
        {
            **load_fixture("observation_bundle_valid.json")["manifest"],
            "permitted_uses": ["participant_research"],
        }
    )
    with pytest.raises(ContractViolation) as unverifiable:
        refuse_unpermitted_uses(real, "participant_research")
    assert unverifiable.value.code == Code.REAL_DATA_REFUSED


def test_participant_observations_are_refused_in_v0():
    payload = load_fixture("observation_bundle_valid.json")
    payload["observations"][0]["source_kind"] = "participant_observation"
    bundle = ObservationBundle.from_dict(payload)
    with pytest.raises(ContractViolation) as caught:
        refuse_real_source_kinds(bundle)
    assert caught.value.code == Code.REAL_DATA_REFUSED


def test_derived_extraction_must_name_its_extractor():
    payload = load_fixture("observation_bundle_valid.json")
    payload["observations"][0]["source_kind"] = "derived_extraction"
    with pytest.raises(ContractViolation) as caught:
        ObservationBundle.from_dict(payload)
    assert caught.value.code == Code.MISSING_FIELD


def test_one_day_is_exactly_86400_seconds():
    start = parse_time("2026-03-28T00:00:00Z", "t")
    assert elapsed_days(start + timedelta(seconds=86_400), start) == 1.0


def test_report_requires_a_reproducibility_command():
    payload = load_fixture("evaluation_report_valid.json")
    payload["reproducibility_command"] = ""
    with pytest.raises(ContractViolation) as caught:
        EvaluationReport.from_dict(payload)
    assert caught.value.code == Code.EMPTY_VALUE


def test_zero_provider_calls_is_a_fact_and_null_is_not():
    """`0` is evidence that nothing was sent; `null` is an unmeasured field."""

    report = EvaluationReport.from_dict(load_fixture("evaluation_report_valid.json"))
    assert report.measured_usage.provider_calls == 0

    payload = load_fixture("evaluation_report_valid.json")
    payload["measured_usage"]["provider_calls"] = None
    unmeasured = EvaluationReport.from_dict(payload)
    assert unmeasured.measured_usage.provider_calls is None
