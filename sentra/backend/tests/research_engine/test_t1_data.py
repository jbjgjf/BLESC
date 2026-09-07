"""T1 (#141, #142): observations in, splits and normalised sequences out.

The tests are written against the properties the contract names, because each
one has a natural implementation that gets it wrong: appending in arrival order
(order dependence), standardising over everything (leakage), splitting by
participant when the trajectories come in pairs (copies across the split), and
writing 0.0 for a value nobody reported.
"""

from __future__ import annotations

import json
import random
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pytest

from app.temporal import SnapshotInput, assemble_participant_graph
from research_engine.contracts import Code, ContractViolation, ObservationBundle, parse_time
from research_engine.data import (
    SPLIT_NAMES,
    fit_normalizer,
    graphs_to_bundle,
    load_observations,
    make_sequences,
    participant_split,
    select_vocabulary,
    sequences_hash,
    temporal_cutoff,
)
from research_engine.data.adapters import VALUE_UNIT
from research_engine.evaluation import GeneratorConfig, generate

TEMPORAL_FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "participant_temporal_graph.json"


@pytest.fixture(scope="module")
def dataset():
    return generate(GeneratorConfig(scenario="S1", seed=11, n_participants=12, n_days=20))


@pytest.fixture(scope="module")
def missing_dataset():
    return generate(GeneratorConfig(scenario="S4", seed=11, n_participants=12, n_days=20))


def _fit_on(bundle, split):
    rows = [row for row in bundle.observations if split.assignment[row.participant_key] == "train"]
    return fit_normalizer(
        rows,
        feature_schema_id=bundle.manifest.feature_schema_id,
        feature_names=bundle.manifest.feature_names,
    )


def test_sequences_do_not_depend_on_input_order(dataset):
    """Same bundle, shuffled rows, byte-identical sequences."""

    bundle = load_observations(dataset.bundle)
    split = participant_split(bundle, dataset.truth.split_groups)
    normalizer = _fit_on(bundle, split)
    first = sequences_hash(make_sequences(bundle, normalizer, split.assignment))

    shuffled_rows = list(dataset.bundle.observations)
    random.Random(4).shuffle(shuffled_rows)
    shuffled = load_observations(ObservationBundle(manifest=dataset.bundle.manifest, observations=shuffled_rows))
    second = sequences_hash(make_sequences(shuffled, normalizer, split.assignment))

    assert first == second


def test_normalizer_id_changes_when_the_fit_input_changes(dataset):
    """An accidental refit on everything produces a different id, and C2 catches it."""

    bundle = load_observations(dataset.bundle)
    split = participant_split(bundle, dataset.truth.split_groups)
    train_only = _fit_on(bundle, split)
    everything = fit_normalizer(
        bundle.observations,
        feature_schema_id=bundle.manifest.feature_schema_id,
        feature_names=bundle.manifest.feature_names,
    )
    assert train_only.normalizer_id != everything.normalizer_id
    assert train_only.n_rows_fitted < everything.n_rows_fitted


def test_normalizer_ignores_masked_positions(missing_dataset):
    """Averaging over nulls as zeros would drag every mean toward zero."""

    bundle = load_observations(missing_dataset.bundle)
    normalizer = fit_normalizer(
        bundle.observations,
        feature_schema_id=bundle.manifest.feature_schema_id,
        feature_names=bundle.manifest.feature_names,
    )
    observed = [
        [value for value, flag in zip(row.values, row.observed_mask) if flag and value is not None]
        for row in bundle.observations
    ]
    first_feature = [
        row.values[0]
        for row in bundle.observations
        if row.observed_mask[0] and row.values[0] is not None
    ]
    assert normalizer.n_observed_per_feature[0] == len(first_feature)
    assert normalizer.means[0] == pytest.approx(float(np.mean(first_feature)))
    assert any(len(row) < len(bundle.manifest.feature_names) for row in observed), "S4 should have gaps"


def test_masked_positions_stay_flagged_after_normalisation(missing_dataset):
    """0.0 after centring and "not measured" must remain distinguishable."""

    bundle = load_observations(missing_dataset.bundle)
    normalizer = fit_normalizer(
        bundle.observations,
        feature_schema_id=bundle.manifest.feature_schema_id,
        feature_names=bundle.manifest.feature_names,
    )
    sequences = make_sequences(bundle, normalizer)
    filled_zero = [
        (sequence.values[t][f], sequence.mask[t][f])
        for sequence in sequences
        for t in range(sequence.length)
        for f in range(len(sequence.feature_names))
        if sequence.values[t][f] == 0.0
    ]
    assert filled_zero, "S4 should produce masked positions"
    assert all(mask is np.False_ or mask == False for _, mask in filled_zero)  # noqa: E712


def test_irregular_gaps_become_real_elapsed_days(missing_dataset):
    """Seven days must not arrive at the model as one step."""

    bundle = load_observations(missing_dataset.bundle)
    normalizer = fit_normalizer(
        bundle.observations,
        feature_schema_id=bundle.manifest.feature_schema_id,
        feature_names=bundle.manifest.feature_names,
    )
    sequences = make_sequences(bundle, normalizer)
    deltas = {delta for sequence in sequences for delta in sequence.delta_days[1:]}
    assert deltas != {1.0}, "S4 is supposed to contain gaps"
    assert min(deltas) >= 1.0


def test_split_groups_never_straddle_a_split():
    """S2's crossing pairs are near-copies; one in train and one in heldout is not generalisation."""

    dataset = generate(GeneratorConfig(scenario="S2", seed=11, n_participants=12, n_days=20))
    bundle = load_observations(dataset.bundle)
    split = participant_split(bundle, dataset.truth.split_groups)

    groups_per_split = {
        name: {dataset.truth.split_groups[key] for key in split.participants_in(name)}
        for name in SPLIT_NAMES
    }
    assert not groups_per_split["train"] & groups_per_split["heldout"]
    assert not groups_per_split["train"] & groups_per_split["validation"]
    assert not groups_per_split["validation"] & groups_per_split["heldout"]


def test_a_group_straddling_a_split_is_refused():
    from research_engine.data.splits import SplitAssignment

    straddling = SplitAssignment(
        split_id="broken",
        assignment={"a": "train", "b": "heldout"},
        split_groups={"a": "pair-00", "b": "pair-00"},
        fractions=(0.5, 0.25, 0.25),
        seed=1,
    )
    with pytest.raises(ContractViolation) as caught:
        straddling.validate()
    assert caught.value.code == Code.SPLIT_OVERLAP


def test_split_is_reproducible_for_a_seed(dataset):
    bundle = load_observations(dataset.bundle)
    first = participant_split(bundle, dataset.truth.split_groups, seed=11)
    again = participant_split(bundle, dataset.truth.split_groups, seed=11)
    different = participant_split(bundle, dataset.truth.split_groups, seed=12)
    assert first.content_hash() == again.content_hash()
    assert first.content_hash() != different.content_hash()


def test_cutoff_hides_later_rows(dataset):
    bundle = load_observations(dataset.bundle)
    cutoff = temporal_cutoff(bundle, input_fraction=0.5)
    visible = load_observations(dataset.bundle, cutoff_at=cutoff)
    assert len(visible.observations) < len(bundle.observations)
    assert all(row.available_at <= cutoff for row in visible.observations)


def test_real_data_is_refused_by_the_loader(dataset):
    payload = dataset.bundle.as_dict()
    payload["observations"][0]["source_kind"] = "participant_observation"
    bundle = ObservationBundle.from_dict(payload)
    with pytest.raises(ContractViolation) as caught:
        load_observations(bundle)
    assert caught.value.code == Code.REAL_DATA_REFUSED


# ---- the adapter over the existing temporal graph (#141) ------------------


def _graphs():
    payload = json.loads(TEMPORAL_FIXTURE.read_text(encoding="utf-8"))
    graphs = []
    for participant, blob in payload["participants"].items():
        inputs = [
            SnapshotInput(
                snapshot_id=snapshot["snapshot_id"],
                day=date.fromisoformat(snapshot["day"]),
                nodes=snapshot["nodes"],
                relations=snapshot["relations"],
                entry_id=snapshot.get("entry_id"),
                extraction_provider=snapshot.get("extraction_provider", "unknown"),
                extraction_model=snapshot.get("extraction_model", "unknown"),
                extractor_version=snapshot.get("extractor_version"),
            )
            for snapshot in blob["snapshots"]
        ]
        graphs.append(assemble_participant_graph(participant, inputs, aliases=blob.get("aliases")))
    return graphs


def test_adapter_marks_unmentioned_concepts_as_unobserved_not_absent():
    """The single most important line of the adapter, asserted directly."""

    graphs = _graphs()
    vocabulary = select_vocabulary(graphs, min_participants=1, min_observations=1)
    bundle = graphs_to_bundle(
        graphs,
        vocabulary,
        dataset_id="temporal-adapter-test",
        permitted_uses=("synthetic_training",),
        extractor_version="temporal-v1",
        participant_keys={graph.participant_id: f"key-{index}" for index, graph in enumerate(graphs)},
    )

    unobserved = [
        (row.event_id, index)
        for row in bundle.observations
        for index, flag in enumerate(row.observed_mask)
        if not flag
    ]
    assert unobserved, "a diary day mentions only a few concepts"
    for row in bundle.observations:
        for value, flag in zip(row.values, row.observed_mask):
            assert (value is None) == (not flag)


def test_adapter_output_is_refused_by_the_v0_loader():
    """The conversion works; admitting it does not. Both halves are the point."""

    graphs = _graphs()
    vocabulary = select_vocabulary(graphs, min_participants=1, min_observations=1)
    bundle = graphs_to_bundle(
        graphs,
        vocabulary,
        dataset_id="temporal-adapter-test",
        permitted_uses=("synthetic_training",),
        extractor_version="temporal-v1",
    )
    with pytest.raises(ContractViolation) as caught:
        load_observations(bundle)
    assert caught.value.code == Code.REAL_DATA_REFUSED


def test_adapter_names_its_unit_and_its_extractor():
    graphs = _graphs()
    vocabulary = select_vocabulary(graphs, min_participants=1, min_observations=1)
    bundle = graphs_to_bundle(
        graphs,
        vocabulary,
        dataset_id="temporal-adapter-test",
        permitted_uses=("synthetic_training",),
        extractor_version="temporal-v1",
    )
    assert set(bundle.manifest.units) == {VALUE_UNIT}
    assert all(row.extractor_version == "temporal-v1" for row in bundle.observations)
    assert all(row.source_refs for row in bundle.observations)


def test_vocabulary_selection_is_deterministic():
    graphs = _graphs()
    first = select_vocabulary(graphs, min_participants=1, min_observations=1)
    again = select_vocabulary(list(reversed(graphs)), min_participants=1, min_observations=1)
    assert first.node_ids == again.node_ids
