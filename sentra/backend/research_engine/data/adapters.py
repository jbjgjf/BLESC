"""T1a (#141) — turning the existing temporal graph into an ObservationBundle.

`app/temporal` already holds what was observed and when, with provenance. What
it does not hold is a numeric matrix, and the research engine needs one. This
module does that conversion and nothing else: it adds no inference, resolves no
ambiguity and fills no gap.

The conversion that matters is the missing one. A concept the participant did
not mention on a given day becomes `null` with `observed_mask=false` — **not**
0.0. "Not written about" is not "reported absent", and the contract says so in
one line: *ある日記で言及されない概念を、本人に存在しないものへ変換しない*. Because
most concepts go unmentioned on most days, the resulting rows are mostly masked;
that is the honest shape of diary data and the reason S4 exists as a scenario.

The value carried where a concept *was* mentioned is the extractor's
`confidence`, in the unit `extractor_confidence`. It is one quantity, named as
what it is. Mixing it with `intensity` on some days and confidence on others
would produce a channel with no defined unit, which no metric could then be
reported in.

Every produced row is `source_kind="derived_extraction"` and carries the
extractor version and a reference back to the snapshot. In v0 the loader refuses
exactly those rows — real participant data is not admitted until a server-side
consent check exists — so this adapter is currently exercised by tests and by
the R1 plan, not by the smoke run. The conversion is written now so that the
refusal is the only thing standing between the engine and real data, rather than
the absence of a converter.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

from ..contracts.common import require
from ..contracts.errors import Code
from ..contracts.observation import DatasetManifest, Observation, ObservationBundle

#: The unit of every value this adapter emits. Named so a metric computed over
#: it cannot be reported as if it were a measured quantity about a person.
VALUE_UNIT = "extractor_confidence"

#: Diary days have no clock time in the graph; the engine needs an instant. Noon
#: UTC is a convention, recorded here rather than scattered, and `available_at`
#: is one second later so "recorded" and "usable" never collapse into one value.
DAY_INSTANT = time(12, 0, 0)


@dataclass(frozen=True)
class VocabularySelection:
    """Which nodes become features, and why those.

    Fixed before the split so the feature schema does not depend on data the
    model is later scored on. Selecting the vocabulary from the whole dataset
    would leak the heldout participants' topics into the input schema.
    """

    node_ids: Tuple[str, ...]
    labels: Tuple[str, ...]
    feature_schema_id: str
    min_participants: int
    min_observations: int


def select_vocabulary(
    graphs: Sequence[Any],
    *,
    min_participants: int = 2,
    min_observations: int = 3,
    max_features: int = 32,
    feature_schema_id: Optional[str] = None,
) -> VocabularySelection:
    """Pick the recurring concepts, deterministically.

    Ordered by (participant count, observation count, node id) so the schema
    does not depend on dict iteration order, and truncated to `max_features` so
    a long tail of one-off concepts does not become a mostly-empty matrix.
    """

    participants_by_node: Dict[str, set] = {}
    observations_by_node: Dict[str, int] = {}
    label_by_node: Dict[str, str] = {}

    for graph in graphs:
        for node_id, node in graph.nodes.items():
            count = sum(interval.observation_count for interval in node.intervals)
            if count == 0:
                continue
            participants_by_node.setdefault(node_id, set()).add(graph.participant_id)
            observations_by_node[node_id] = observations_by_node.get(node_id, 0) + count
            label_by_node.setdefault(node_id, node.canonical_label)

    eligible = [
        node_id
        for node_id in participants_by_node
        if len(participants_by_node[node_id]) >= min_participants
        and observations_by_node[node_id] >= min_observations
    ]
    eligible.sort(
        key=lambda node_id: (
            -len(participants_by_node[node_id]),
            -observations_by_node[node_id],
            node_id,
        )
    )
    chosen = tuple(eligible[:max_features])
    labels = tuple(label_by_node[node_id] for node_id in chosen)

    return VocabularySelection(
        node_ids=chosen,
        labels=labels,
        feature_schema_id=feature_schema_id or f"temporal-nodes-v0-{len(chosen):03d}",
        min_participants=min_participants,
        min_observations=min_observations,
    )


def _day_times(day: date) -> Tuple[datetime, datetime]:
    recorded_at = datetime.combine(day, DAY_INSTANT, tzinfo=timezone.utc)
    return recorded_at, recorded_at + timedelta(seconds=1)


def _observed_days(node: Any) -> Dict[date, Any]:
    """Day → the personal observation recorded on it."""

    by_day: Dict[date, Any] = {}
    for observation in node.personal_observations:
        by_day.setdefault(observation.snapshot.day, observation)
    return by_day


def graph_to_observations(
    graph: Any,
    vocabulary: VocabularySelection,
    *,
    dataset_id: str,
    participant_key: str,
    permitted_uses: Sequence[str],
    extractor_version: str,
    timezone_name: str = "Asia/Tokyo",
) -> List[Observation]:
    """One row per day on which this participant has any observation at all.

    A day with no entry produces no row — an all-null row would assert that the
    day was observed and everything was absent, which is the opposite of what
    silence means.
    """

    per_node_days = {node_id: _observed_days(graph.nodes[node_id]) for node_id in vocabulary.node_ids if node_id in graph.nodes}
    all_days = sorted({day for days in per_node_days.values() for day in days})

    rows: List[Observation] = []
    for day in all_days:
        values: List[Optional[float]] = []
        mask: List[bool] = []
        source_refs: List[str] = []
        for node_id in vocabulary.node_ids:
            observation = per_node_days.get(node_id, {}).get(day)
            if observation is None:
                values.append(None)
                mask.append(False)
                continue
            values.append(float(observation.confidence))
            mask.append(True)
            source_refs.append(f"snapshot:{observation.snapshot.snapshot_id}")

        recorded_at, available_at = _day_times(day)
        rows.append(
            Observation(
                dataset_id=dataset_id,
                participant_key=participant_key,
                event_id=f"{participant_key}-{day.isoformat()}",
                occurred_at=recorded_at,
                recorded_at=recorded_at,
                available_at=available_at,
                timezone=timezone_name,
                feature_schema_id=vocabulary.feature_schema_id,
                feature_names=vocabulary.node_ids,
                units=tuple(VALUE_UNIT for _ in vocabulary.node_ids),
                values=tuple(values),
                observed_mask=tuple(mask),
                source_kind="derived_extraction",
                source_refs=tuple(sorted(set(source_refs))),
                extractor_version=extractor_version,
                permitted_uses=tuple(permitted_uses),
            )
        )
    return rows


def graphs_to_bundle(
    graphs: Sequence[Any],
    vocabulary: VocabularySelection,
    *,
    dataset_id: str,
    permitted_uses: Sequence[str],
    extractor_version: str,
    participant_keys: Optional[Mapping[str, str]] = None,
    created_at: Optional[datetime] = None,
    collection_protocol: str = "app.temporal.ParticipantTemporalGraph",
) -> ObservationBundle:
    """Convert several participants' graphs into one bundle.

    `participant_keys` maps the app's participant id to the opaque key used
    inside the dataset, and it is **required to be complete**. It used to fall
    back to `graph.participant_id`, which put the re-identifying application id
    into `participant_key` and into every generated `event_id` — the exact thing
    this function's own docstring forbids. The refusal in the v0 loader would
    not have caught it either: anything that serialises the adapter's output
    before that refusal, or the planned real-data path once it opens, writes
    those ids into research artifacts. A missing entry is now an error.
    """

    require(
        len(vocabulary.node_ids) > 0,
        Code.EMPTY_VALUE,
        "語彙が空です。特徴量を1つも選べていません。",
        "vocabulary.node_ids",
    )

    mapping = dict(participant_keys or {})
    unmapped = sorted({graph.participant_id for graph in graphs} - set(mapping))
    require(
        not unmapped,
        Code.MISSING_FIELD,
        f"participant_keysに対応のないparticipantがいます: {unmapped}。"
        "アプリのidをそのまま研究artifactへ書かないため、対応表は完全である必要があります。",
        "graphs_to_bundle.participant_keys",
        unmapped=unmapped,
    )

    observations: List[Observation] = []
    for graph in graphs:
        key = mapping[graph.participant_id]
        observations.extend(
            graph_to_observations(
                graph,
                vocabulary,
                dataset_id=dataset_id,
                participant_key=key,
                permitted_uses=permitted_uses,
                extractor_version=extractor_version,
            )
        )

    manifest = DatasetManifest(
        dataset_id=dataset_id,
        feature_schema_id=vocabulary.feature_schema_id,
        file_hashes={},
        split_id="unassigned",
        split_assignment_ref="pending",
        generation_or_collection_protocol=collection_protocol,
        permitted_uses=tuple(permitted_uses),
        created_at=created_at or datetime.now(timezone.utc),
        feature_names=vocabulary.node_ids,
        units=tuple(VALUE_UNIT for _ in vocabulary.node_ids),
    )
    bundle = ObservationBundle(manifest=manifest, observations=observations)
    bundle.validate()
    return bundle
