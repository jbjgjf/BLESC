"""Deterministic assembly of a participant temporal graph from snapshots (#95).

Same input, same graph. Every iteration is over a sorted sequence, no wall-clock
is read, no set iteration order reaches the output, and every event carries a
total sort key including its detail — `test_determinism` serialises two
independent assemblies and compares them byte for byte.

**The day is the unit, not the snapshot.** A participant who writes twice on
Tuesday produces two `graph_snapshots` rows and one Tuesday. The assembler
unions a day's snapshots into one day-observation, so a concept in the morning
entry and not the evening one is not a disappearance. Every individual snapshot
still appears in `personal_observations`, so nothing is lost by the union —
only the absence arithmetic is done at day granularity, which is the same
granularity `temporal_diff_json` is written at (`_latest_graph_snapshot` selects
on `day <`).

**Why `temporal_diff_json` is cross-checked rather than consumed.**

The issue asks for an assembler over "day-ordered `graph_snapshots` plus
`temporal_diff_json`". Consuming the stored diff as the source of change would
be wrong for this data. Until #107 the production writer emitted a fixed
placeholder in that field — every node and relation marked newly added, every
day, with no comparison performed (#106) — so a diff-consuming assembler would
conclude that nothing ever recurred. The diff is computed correctly going
forward and carries a `diff_basis`, but historical rows do not, and the FastAPI
research writer (`summarize_temporal_diff`) still records no basis at all. A
field that is right for some rows and wrong for others, with no way to tell
which, cannot be a source of truth.

So change is RECOMPUTED from `nodes_json` / `relations_json`, which were correct
throughout, and the stored diff is then compared against the recomputation:

* where `diff_basis` says the row is trustworthy, agreement or disagreement is
  recorded per snapshot in `AssemblyReport.diff_cross_checks`;
* where it says the row is not (`no_previous_lookup`, `lookup_failed`,
  `legacy_id_scheme_boundary`) or says nothing at all, the check is recorded as
  `not_comparable` **with the reason**, not skipped.

The recomputation goes through `analytics.graph_features.build_temporal_graph_diff`
rather than a private copy, so this does not become a third implementation of
the contract that #106 was about.

**Why identity is not always available.**

Before #107, a Japanese label produced an empty slug and the node id fell back
to `node_${index}` — an array position. `node_1` on Monday and `node_1` on
Friday are unrelated observations that happened to be listed first. Any
temporal claim over such a participant is void, so those snapshots are detected,
`AssemblyReport.identity_is_usable` goes false, and the reason is named. They
are not silently dropped and not silently used.
"""

from __future__ import annotations

import unicodedata
from collections import defaultdict
from dataclasses import dataclass
from datetime import date
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Set, Tuple

from ..analytics.graph_features import build_temporal_graph_diff
from .model import (
    CONTRACT_VERSION,
    IDENTITY_RULE_STRENGTH,
    UNCURATED,
    AssemblyReport,
    CategoryAssignment,
    ContradictionKind,
    CuratedProvenance,
    DiffCrossCheck,
    EventKind,
    IdentityRule,
    ParticipantTemporalGraph,
    PersonalObservation,
    SnapshotRef,
    TemporalEdge,
    TemporalEvent,
    TemporalNode,
    edge_subject,
    merge_intervals,
)

#: Ids of the form `node_1` — array positions from before label-derived
#: identity. See the module docstring.
_LEGACY_ID_PREFIX = "node_"

#: Movement in a relation's confidence before it is worth an event. Matches the
#: 0.15 in `graph_features.build_temporal_graph_diff` and in the TypeScript
#: writer; the three are pinned together by
#: `sentra/shared/temporal_diff_conformance.json`.
CONFIDENCE_SHIFT_THRESHOLD = 0.15

#: Direction of influence each relation type asserts, used only to detect a
#: contradiction. `None` means the type asserts no direction of influence and
#: therefore cannot contradict anything — `co_occurs` is the vocabulary's
#: weakest claim and `precedes` is explicitly ordering-only (see the scope notes
#: in `app/ontology/schema.py`). This mapping is an engineering reading of those
#: scope notes, not a clinical claim, and a type absent from it is treated as
#: contradicting nothing.
RELATION_POLARITY: Dict[str, Optional[str]] = {
    "causes": "raises",
    "escalates": "raises",
    "buffers": "lowers",
    "avoids": "lowers",
    "co_occurs": None,
    "precedes": None,
}

#: `diff_basis` values that mean the stored diff was computed against the
#: participant's real previous snapshot and is therefore worth comparing.
TRUSTED_DIFF_BASES = frozenset({"previous_snapshot", "first_snapshot_for_participant"})

#: The rest, with what each one means. Written by `frontend/src/api/client.ts`
#: and `frontend/src/app/api/entries/route.ts` since #107.
UNTRUSTED_DIFF_BASES: Dict[str, str] = {
    "no_previous_lookup": (
        "written by the stateless route handler, which has no database connection and "
        "cannot see the previous day"
    ),
    "lookup_failed": "the previous-snapshot lookup errored, so the stored diff is against nothing",
    "legacy_id_scheme_boundary": (
        "the previous snapshot used positional node ids, so the comparison was deliberately "
        "suppressed at write time"
    ),
}

_NO_BASIS_REASON = (
    "no `diff_basis` recorded: written before #107, or by the FastAPI research path "
    "(`summarize_temporal_diff`), which does not record one"
)


@dataclass(frozen=True)
class SnapshotInput:
    """One extraction, in the shape the assembler needs.

    A narrow struct rather than the SQLModel row, so the assembler can be tested
    without a database and so a caller reading from Supabase, from the research
    database, or from a fixture all go through one door. `load.py` builds these
    from stored rows.
    """

    snapshot_id: str
    day: date
    nodes: Sequence[Mapping[str, Any]]
    relations: Sequence[Mapping[str, Any]]
    entry_id: Optional[str] = None
    extraction_provider: str = "unknown"
    extraction_model: str = "unknown"
    extractor_version: Optional[str] = None
    #: The stored `temporal_diff_json`, verbatim. Cross-checked, never consumed
    #: as truth — see the module docstring.
    temporal_diff: Optional[Mapping[str, Any]] = None

    @property
    def diff_basis(self) -> Optional[str]:
        if not self.temporal_diff:
            return None
        basis = self.temporal_diff.get("diff_basis")
        return str(basis) if basis else None

    @property
    def ref(self) -> SnapshotRef:
        return SnapshotRef(
            snapshot_id=self.snapshot_id,
            day=self.day,
            entry_id=self.entry_id,
            extraction_provider=self.extraction_provider,
            extraction_model=self.extraction_model,
            extractor_version=self.extractor_version,
        )


def normalise_label(label: str) -> str:
    """The label rung of the identity ladder.

    NFKC so that ﾃｽﾄ and テスト, or ＥＸＡＭ and exam, are one concept. Case and
    surrounding whitespace folded. Deliberately NOT stemming, synonym expansion
    or embedding similarity: those are guesses, and a wrong guess here merges
    two things a student said and reports them as one.
    """
    return unicodedata.normalize("NFKC", str(label or "")).strip().lower()


def _is_legacy_identity(nodes: Iterable[Mapping[str, Any]]) -> bool:
    for node in nodes:
        raw_id = str(node.get("id", ""))
        if raw_id.startswith(_LEGACY_ID_PREFIX) and raw_id[len(_LEGACY_ID_PREFIX):].isdigit():
            return True
    return False


class _IdentityResolver:
    """Maps a day's raw node ids onto stable temporal node ids.

    The ladder is explicit and its rungs are recorded. A caller that only trusts
    exact matches can filter on `identity_rule`; nothing forces it to accept the
    whole ladder, which is the point of storing the rule rather than the result.

    Two things it refuses to do:

    * merge two ids that appear in the SAME day's snapshots under one label —
      the participant's own extraction distinguished them, and overriding that
      on a label match would delete a distinction the data made;
    * pick between two existing nodes that both answer to a label. That is a
      coin flip, and a coin flip recorded as a fact is worse than an unresolved
      pair recorded as unresolved.
    """

    def __init__(self, aliases: Optional[Mapping[str, str]] = None) -> None:
        #: raw extraction id -> temporal node id
        self._by_id: Dict[str, str] = {}
        #: normalised label -> temporal node ids known by that label, first seen first
        self._by_label: Dict[str, List[str]] = defaultdict(list)
        #: Declared alias -> canonical node id. Supplied by a curator, never
        #: inferred. An empty table is the honest default.
        self._aliases = {normalise_label(key): value for key, value in (aliases or {}).items()}
        self._node_ids: Set[str] = set()
        #: node id -> the raw id that claimed it earlier in the current day
        self._claimed: Dict[str, str] = {}
        #: (subject, candidates, reason), in encounter order
        self.ambiguities: List[Tuple[str, Tuple[str, ...], str]] = []

    def begin_day(self) -> None:
        self._claimed = {}

    def resolve(self, raw_id: str, label: str) -> Tuple[str, IdentityRule]:
        raw_id = str(raw_id or "")
        normalised = normalise_label(label)
        candidate, rule, competing = self._candidate(raw_id, normalised)

        if candidate is not None:
            claimant = self._claimed.get(candidate)
            collides = claimant is not None and claimant != raw_id

            if collides and rule is IdentityRule.EXACT_ID:
                # Both ids already resolve to this node, which can only be
                # because an earlier day merged them by label. They now co-occur
                # in one day's extraction, so that merge is suspect — but
                # retroactively splitting it would rewrite days already
                # assembled, and this module does not rewrite. Recorded instead.
                self._record_ambiguity(
                    candidate,
                    (),
                    f"`{raw_id}` and `{claimant}` were merged into `{candidate}` by an earlier "
                    "label match and now appear in the same day's extraction; the merge is "
                    "suspect and is reported rather than undone",
                )
                self._claimed[candidate] = raw_id
                return candidate, rule

            if collides:
                # Two ids in one day's extraction, one label. Keep both.
                node_id = self._mint(raw_id or normalised)
                self._record_ambiguity(
                    node_id,
                    (candidate,),
                    f"`{raw_id}` and `{claimant}` appear in the same day's extraction under the "
                    "same normalised label; the extraction distinguished them, so the assembler does not",
                )
                self._register(raw_id, normalised, node_id)
                self._claimed[node_id] = raw_id
                return node_id, IdentityRule.AMBIGUOUS

            self._register(raw_id, normalised, candidate)
            self._claimed[candidate] = raw_id
            return candidate, rule

        node_id = self._mint(raw_id or normalised)
        if rule is IdentityRule.AMBIGUOUS:
            self._record_ambiguity(
                node_id,
                competing,
                "more than one existing node answers to this label and none dominates",
            )
        self._register(raw_id, normalised, node_id)
        self._claimed[node_id] = raw_id
        return node_id, rule

    # ---- ladder ----------------------------------------------------------

    def _candidate(
        self, raw_id: str, normalised: str
    ) -> Tuple[Optional[str], IdentityRule, Tuple[str, ...]]:
        if raw_id and raw_id in self._by_id:
            return self._by_id[raw_id], IdentityRule.EXACT_ID, ()

        if normalised and normalised in self._aliases:
            target = self._aliases[normalised]
            if target in self._node_ids:
                return target, IdentityRule.DECLARED_ALIAS, ()

        candidates = self._by_label.get(normalised, []) if normalised else []
        if len(candidates) == 1:
            return candidates[0], IdentityRule.NORMALISED_LABEL, ()
        if len(candidates) > 1:
            return None, IdentityRule.AMBIGUOUS, tuple(sorted(candidates))
        return None, IdentityRule.NO_MATCH, ()

    def _mint(self, preferred: str) -> str:
        """A node id nothing else holds.

        The preferred id is the raw extraction id, which is free in every path
        that reaches here except one: a node whose raw id is empty falls back to
        its normalised label, and that label may already name a node. The suffix
        exists for that case only, and is visible in the output on purpose —
        a synthetic id should look synthetic.
        """
        if preferred and preferred not in self._node_ids:
            return preferred
        base = preferred or "node"
        counter = 2
        while f"{base}~{counter}" in self._node_ids:
            counter += 1
        return f"{base}~{counter}"

    def _register(self, raw_id: str, normalised: str, node_id: str) -> None:
        self._node_ids.add(node_id)
        if raw_id:
            self._by_id[raw_id] = node_id
        # A node becomes known by every surface form it has been written as, so
        # a later id carrying an older form can find it — and so two nodes that
        # converge on one form become a visible ambiguity rather than a merge.
        if normalised and node_id not in self._by_label[normalised]:
            self._by_label[normalised].append(node_id)

    def _record_ambiguity(self, subject: str, candidates: Tuple[str, ...], reason: str) -> None:
        self.ambiguities.append((subject, tuple(sorted(candidates)), reason))


def assemble_participant_graph(
    participant_id: str,
    snapshots: Sequence[SnapshotInput],
    aliases: Optional[Mapping[str, str]] = None,
    curated_node_sources: Optional[Mapping[str, Sequence[str]]] = None,
    curated_edge_sources: Optional[Mapping[Tuple[str, str, str], Sequence[str]]] = None,
    max_gap_days: int = 0,
) -> ParticipantTemporalGraph:
    """Build the graph. Deterministic for a given input.

    `aliases` maps a normalised label to a node id and is supplied by a curator,
    never inferred. `curated_node_sources` / `curated_edge_sources` add curated
    source ids on top of whatever the stored `provenance` annotation (#80)
    already carries. All three land in `curated_provenance`, which is a
    different field holding a different type from `personal_observations`,
    because a curated source is evidence about a population and a participant's
    journal is evidence about that participant. Nothing a participant writes can
    reach `curated_provenance`.
    """
    ordered = sorted(snapshots, key=lambda snapshot: (snapshot.day, snapshot.snapshot_id))
    warnings: List[str] = []

    by_day: Dict[date, List[SnapshotInput]] = defaultdict(list)
    for snapshot in ordered:
        by_day[snapshot.day].append(snapshot)
    all_days = sorted(by_day)

    legacy = tuple(snapshot.snapshot_id for snapshot in ordered if _is_legacy_identity(snapshot.nodes))
    if legacy:
        warnings.append(
            f"{len(legacy)} snapshot(s) use positional node ids (`node_N`) from before "
            "label-derived identity. Those ids are array positions, so the same id on two "
            "days is not the same observation. Every temporal claim over this participant "
            "is void until those rows are re-extracted or excluded."
        )

    resolver = _IdentityResolver(aliases)
    events: List[TemporalEvent] = []

    node_snapshots: Dict[str, Dict[date, List[str]]] = defaultdict(lambda: defaultdict(list))
    node_labels: Dict[str, List[str]] = defaultdict(list)
    node_categories: Dict[str, List[Tuple[date, str]]] = defaultdict(list)
    node_observations: Dict[str, List[PersonalObservation]] = defaultdict(list)
    node_curated: Dict[str, List[CuratedProvenance]] = defaultdict(list)
    #: node id -> every rung used to attach an observation, in encounter order.
    node_rules: Dict[str, List[IdentityRule]] = defaultdict(list)
    #: node id -> the rung that minted it, which `identity_rules` excludes.
    minting_rule: Dict[str, IdentityRule] = {}

    EdgeKey = Tuple[str, str, str]
    edge_snapshots: Dict[EdgeKey, Dict[date, List[str]]] = defaultdict(lambda: defaultdict(list))
    edge_observations: Dict[EdgeKey, List[PersonalObservation]] = defaultdict(list)
    edge_confidence: Dict[EdgeKey, List[Tuple[date, float]]] = defaultdict(list)
    edge_curated: Dict[EdgeKey, List[CuratedProvenance]] = defaultdict(list)

    previous_node_ids: Set[str] = set()
    previous_edge_keys: Set[EdgeKey] = set()
    previous_day: Optional[date] = None
    #: (source, target) -> (day it was last asserted, the types asserted then).
    #: Carried across the whole window, not just yesterday, so a polarity flip
    #: months apart is still a contradiction.
    last_types_by_pair: Dict[Tuple[str, str], Tuple[date, Tuple[str, ...]]] = {}
    seen_node_ids: Set[str] = set()
    seen_edge_keys: Set[EdgeKey] = set()
    dangling = 0
    snapshots_usable = 0
    contradictions = 0

    for day in all_days:
        days_snapshots = by_day[day]
        resolver.begin_day()

        # ---- nodes: the union of the day's snapshots ----
        day_node_ids: Dict[str, str] = {}
        for snapshot in days_snapshots:
            ref = snapshot.ref
            produced_a_node = False
            for raw in sorted(snapshot.nodes, key=lambda node: (str(node.get("id", "")), str(node.get("label", "")))):
                raw_id = str(raw.get("id", ""))
                label = str(raw.get("label", raw_id))
                if not raw_id and not normalise_label(label):
                    # Nothing to identify it by. Counted as a hole rather than
                    # given a positional id, which is the defect #107 fixed.
                    continue
                produced_a_node = True
                if raw_id in day_node_ids:
                    node_id = day_node_ids[raw_id]
                else:
                    node_id, rule = resolver.resolve(raw_id, label)
                    day_node_ids[raw_id] = node_id
                    if node_id in minting_rule:
                        node_rules[node_id].append(rule)
                    else:
                        minting_rule[node_id] = rule
                        if rule is IdentityRule.AMBIGUOUS:
                            # Declining to merge IS a claim about identity, so
                            # it counts even though it also minted the node.
                            node_rules[node_id].append(rule)

                if snapshot.snapshot_id not in node_snapshots[node_id][day]:
                    node_snapshots[node_id][day].append(snapshot.snapshot_id)
                if label and label not in node_labels[node_id]:
                    node_labels[node_id].append(label)
                category = str(raw.get("category", "State"))
                node_categories[node_id].append((day, category))
                node_observations[node_id].append(
                    PersonalObservation(
                        snapshot=ref,
                        confidence=_as_float(raw.get("confidence"), 1.0),
                        intensity=_as_optional_float(raw.get("intensity")),
                        label_as_written=label,
                        category_as_written=category,
                    )
                )
                curated = _curated_from_node(raw)
                if curated.is_matched:
                    node_curated[node_id].append(curated)

            if produced_a_node:
                snapshots_usable += 1
            else:
                warnings.append(
                    f"snapshot {snapshot.snapshot_id} ({day.isoformat()}) contributed no "
                    "identifiable node; it is a hole in every measurement over this window"
                )

        for node_id in sorted(set(day_node_ids.values())):
            # The day's own observation, not the node's latest. A node written
            # as "不眠" today and "眠れない" last month must read as "不眠" in
            # today's event, or the log rewrites what the participant wrote.
            observation = _observation_on(node_observations[node_id], day)
            reference = observation.snapshot if observation else None
            label = observation.label_as_written if observation else node_id
            category = observation.category_as_written if observation else "State"
            if node_id not in seen_node_ids:
                events.append(
                    TemporalEvent(
                        EventKind.NODE_OBSERVED,
                        day,
                        node_id,
                        reference,
                        {
                            "label": label,
                            "category": category,
                            "identity_rule": minting_rule.get(node_id, IdentityRule.NO_MATCH).value,
                        },
                    )
                )
                seen_node_ids.add(node_id)
            elif node_id not in previous_node_ids:
                events.append(
                    TemporalEvent(
                        EventKind.NODE_REAPPEARED,
                        day,
                        node_id,
                        reference,
                        {"label": label, "category": category, "last_seen_before": _last_seen(node_snapshots[node_id], day)},
                    )
                )

        day_node_id_set = set(day_node_ids.values())
        absent_ref = days_snapshots[0].ref
        for gone in sorted(previous_node_ids - day_node_id_set):
            events.append(
                TemporalEvent(
                    EventKind.NODE_ABSENT,
                    day,
                    gone,
                    absent_ref,
                    {"last_observed": previous_day.isoformat() if previous_day else None},
                )
            )

        # ---- edges ----
        day_edge_keys: Set[EdgeKey] = set()
        day_edge_confidence: Dict[EdgeKey, float] = {}
        for snapshot in days_snapshots:
            ref = snapshot.ref
            for raw in sorted(
                snapshot.relations,
                key=lambda rel: (
                    str(rel.get("source_id", "")),
                    str(rel.get("target_id", "")),
                    str(rel.get("type", "")),
                ),
            ):
                source_id = day_node_ids.get(str(raw.get("source_id", "")))
                target_id = day_node_ids.get(str(raw.get("target_id", "")))
                if not source_id or not target_id:
                    # An endpoint is not among this day's nodes. This is exactly
                    # what the pre-#107 Japanese extraction defect produced, and
                    # it is counted rather than dropped in silence.
                    dangling += 1
                    continue

                relation_type = str(raw.get("type", "co_occurs"))
                key = (source_id, target_id, relation_type)
                day_edge_keys.add(key)
                confidence = _as_float(raw.get("confidence"), 1.0)
                day_edge_confidence[key] = confidence

                if snapshot.snapshot_id not in edge_snapshots[key][day]:
                    edge_snapshots[key][day].append(snapshot.snapshot_id)
                edge_observations[key].append(
                    PersonalObservation(
                        snapshot=ref,
                        confidence=confidence,
                        label_as_written="",
                        category_as_written="",
                        relation_type_as_written=relation_type,
                    )
                )
                curated = _curated_from_relation(raw)
                if curated.is_matched:
                    edge_curated[key].append(curated)

        for key in sorted(day_edge_keys):
            confidence = day_edge_confidence[key]
            previous_confidence = edge_confidence[key][-1][1] if edge_confidence[key] else None
            edge_confidence[key].append((day, confidence))
            subject = edge_subject(*key)
            edge_observation = _observation_on(edge_observations[key], day)
            reference = edge_observation.snapshot if edge_observation else None
            if key not in seen_edge_keys:
                events.append(
                    TemporalEvent(
                        EventKind.EDGE_OBSERVED,
                        day,
                        subject,
                        reference,
                        {"relation_type": key[2], "confidence": confidence},
                    )
                )
                seen_edge_keys.add(key)
            elif key not in previous_edge_keys:
                events.append(
                    TemporalEvent(
                        EventKind.EDGE_REAPPEARED,
                        day,
                        subject,
                        reference,
                        {"relation_type": key[2], "confidence": confidence,
                         "last_seen_before": _last_seen(edge_snapshots[key], day)},
                    )
                )
            elif previous_confidence is not None and abs(confidence - previous_confidence) >= CONFIDENCE_SHIFT_THRESHOLD:
                events.append(
                    TemporalEvent(
                        EventKind.EDGE_CONFIDENCE_SHIFTED,
                        day,
                        subject,
                        reference,
                        {
                            "previous_confidence": previous_confidence,
                            "current_confidence": confidence,
                            "delta": round(confidence - previous_confidence, 10),
                        },
                    )
                )

        for gone in sorted(previous_edge_keys - day_edge_keys):
            events.append(
                TemporalEvent(
                    EventKind.EDGE_ABSENT,
                    day,
                    edge_subject(*gone),
                    absent_ref,
                    {"relation_type": gone[2], "last_observed": previous_day.isoformat() if previous_day else None},
                )
            )

        events.extend(_retyping_events(previous_edge_keys, day_edge_keys, day, absent_ref))
        contradiction_events = _contradiction_events(last_types_by_pair, day_edge_keys, day, absent_ref)
        contradictions += len(contradiction_events)
        events.extend(contradiction_events)
        for pair, types in _types_by_pair(day_edge_keys).items():
            last_types_by_pair[pair] = (day, types)

        previous_node_ids = day_node_id_set
        previous_edge_keys = day_edge_keys
        previous_day = day

    # ---- category history, and the reassignments inside it ----
    category_conflicts = 0
    node_category_history: Dict[str, Tuple[CategoryAssignment, ...]] = {}
    for node_id in sorted(node_categories):
        history: List[CategoryAssignment] = []
        for day, category in sorted(node_categories[node_id]):
            if history and history[-1].category == category:
                if day not in history[-1].days:
                    history[-1] = CategoryAssignment(category, history[-1].days + (day,))
                continue
            if history:
                events.append(
                    TemporalEvent(
                        EventKind.CATEGORY_REASSIGNED,
                        day,
                        node_id,
                        None,
                        {"previous_category": history[-1].category, "current_category": category},
                    )
                )
            history.append(CategoryAssignment(category, (day,)))
        if len({assignment.category for assignment in history}) > 1:
            category_conflicts += 1
        node_category_history[node_id] = tuple(history)

    # ---- identity events ----
    first_day = all_days[0] if all_days else date.min
    for subject, candidates, reason in resolver.ambiguities:
        events.append(
            TemporalEvent(
                EventKind.IDENTITY_AMBIGUOUS,
                _first_day_of(node_snapshots.get(subject), first_day),
                subject,
                None,
                {
                    "candidates": list(candidates),
                    "reason": reason,
                    "resolution": "kept separate; merging would record a coin flip as a fact",
                },
            )
        )

    if legacy:
        events.append(
            TemporalEvent(
                EventKind.IDENTITY_UNAVAILABLE,
                first_day,
                participant_id,
                None,
                {
                    "snapshot_ids": list(legacy),
                    "reason": "positional node ids predate label-derived identity",
                },
            )
        )

    ambiguous_by_subject: Dict[str, List[str]] = defaultdict(list)
    for subject, candidates, _reason in resolver.ambiguities:
        ambiguous_by_subject[subject].extend(candidates)

    nodes = {
        node_id: TemporalNode(
            node_id=node_id,
            canonical_label=node_labels[node_id][0] if node_labels[node_id] else node_id,
            labels_seen=tuple(node_labels[node_id]),
            category_history=node_category_history.get(node_id, ()),
            intervals=merge_intervals(node_snapshots[node_id], all_days, max_gap_days),
            personal_observations=tuple(node_observations[node_id]),
            curated_provenance=_merge_curated(
                node_curated[node_id], (curated_node_sources or {}).get(node_id)
            ),
            identity_rules=_identity_rules(node_rules.get(node_id, ())),
            ambiguous_with=tuple(sorted(set(ambiguous_by_subject.get(node_id, ())))),
        )
        for node_id in sorted(node_snapshots)
    }

    edges = {
        key: TemporalEdge(
            source_id=key[0],
            target_id=key[1],
            relation_type=key[2],
            intervals=merge_intervals(edge_snapshots[key], all_days, max_gap_days),
            personal_observations=tuple(edge_observations[key]),
            curated_provenance=_merge_curated(
                edge_curated[key], (curated_edge_sources or {}).get(key)
            ),
            confidence_by_day=tuple(edge_confidence[key]),
        )
        for key in sorted(edge_snapshots)
    }

    if dangling:
        warnings.append(
            f"{dangling} relation(s) referenced a node absent from the same day's snapshots and "
            "were not assembled. That is the shape of the pre-#107 Japanese extraction defect."
        )

    cross_checks = _cross_check_stored_diffs(ordered, by_day)
    disagreements = [check for check in cross_checks if check.status == "disagreed"]
    if disagreements:
        warnings.append(
            f"{len(disagreements)} stored temporal_diff_json row(s) disagree with the diff "
            "recomputed from nodes_json/relations_json. The recomputation is what this graph "
            "is built from; the disagreement is reported so the stored rows can be inspected."
        )

    report = AssemblyReport(
        snapshots_seen=len(ordered),
        snapshots_usable=snapshots_usable,
        days_covered=tuple(all_days),
        legacy_identity_snapshots=legacy,
        dangling_relations=dangling,
        ambiguous_identities=len(resolver.ambiguities),
        category_conflicts=category_conflicts,
        contradictions=contradictions,
        diff_cross_checks=tuple(cross_checks),
        warnings=tuple(warnings),
    )

    return ParticipantTemporalGraph(
        participant_id=participant_id,
        contract_version=CONTRACT_VERSION,
        nodes=nodes,
        edges=edges,
        events=tuple(sorted(events, key=lambda event: event.sort_key())),
        report=report,
    )


# ---- events over edge sets ------------------------------------------------


def _types_by_pair(keys: Iterable[Tuple[str, str, str]]) -> Dict[Tuple[str, str], Tuple[str, ...]]:
    """Pair -> the relation types asserted between it, sorted.

    Sorted rather than a set because a set's iteration order is
    hash-randomised per process, and anything derived from it would make the
    output differ between two runs of the same input.
    """
    grouped: Dict[Tuple[str, str], List[str]] = defaultdict(list)
    for source_id, target_id, relation_type in keys:
        grouped[(source_id, target_id)].append(relation_type)
    return {pair: tuple(sorted(types)) for pair, types in grouped.items()}


def _retyping_events(
    previous_keys: Set[Tuple[str, str, str]],
    current_keys: Set[Tuple[str, str, str]],
    day: date,
    ref: SnapshotRef,
) -> List[TemporalEvent]:
    """A pair that kept its endpoints but changed relation type.

    `causes` becoming `co_occurs` is one edge being retyped, not an unrelated
    edge appearing next to an unrelated edge vanishing — the shared fixture
    (`relation_retyped_is_an_add_and_a_remove`) says #95 owns this distinction.
    The add and the remove are still emitted; this is recorded alongside them so
    a consumer can tell the two situations apart.
    """
    previous = _types_by_pair(previous_keys)
    current = _types_by_pair(current_keys)
    events: List[TemporalEvent] = []
    for pair in sorted(set(previous) & set(current)):
        was, now = set(previous[pair]), set(current[pair])
        dropped, added = sorted(was - now), sorted(now - was)
        if not dropped or not added:
            continue
        for relation_type in added:
            events.append(
                TemporalEvent(
                    EventKind.EDGE_RETYPED,
                    day,
                    edge_subject(pair[0], pair[1], relation_type),
                    ref,
                    {
                        "previous_relation_types": dropped,
                        "current_relation_type": relation_type,
                        "retained_relation_types": sorted(was & now),
                    },
                )
            )
    return events


def _contradiction_events(
    last_types_by_pair: Mapping[Tuple[str, str], Tuple[date, Tuple[str, ...]]],
    current_keys: Set[Tuple[str, str, str]],
    day: date,
    ref: SnapshotRef,
) -> List[TemporalEvent]:
    """Assertions that cannot both hold, recorded rather than resolved.

    Two shapes, both narrow on purpose (see `ContradictionKind`):

    * the same ordered pair carrying a raising and a lowering relation — on one
      day, or a raising one the last time the pair was seen and a lowering one
      today;
    * A→B and B→A both raising on the same day.

    The across-days check is against the pair's LAST OBSERVED types, not against
    yesterday. A student who says the club makes it worse in May and better in
    July has contradicted themselves whether or not the pair happened to appear
    on consecutive entries, and a day-over-day check would miss exactly the
    long-range case worth having.

    Nothing is dropped or corrected. A contradiction across two months is
    ordinary; one inside a single day is a signal about the extraction. Neither
    is an error the assembler is entitled to fix, so both become events and the
    graph keeps both edges.
    """
    events: List[TemporalEvent] = []
    current = _types_by_pair(current_keys)

    for pair in sorted(current):
        raising = [t for t in current[pair] if RELATION_POLARITY.get(t) == "raises"]
        lowering = [t for t in current[pair] if RELATION_POLARITY.get(t) == "lowers"]

        if raising and lowering:
            events.append(
                TemporalEvent(
                    EventKind.CONTRADICTION,
                    day,
                    edge_subject(pair[0], pair[1], sorted(current[pair])[0]),
                    ref,
                    {
                        "kind": ContradictionKind.OPPOSITE_POLARITY.value,
                        "scope": "same_day",
                        "source_id": pair[0],
                        "target_id": pair[1],
                        "raising_relation_types": raising,
                        "lowering_relation_types": lowering,
                        "resolution": "both edges kept; the assembler does not adjudicate",
                    },
                )
            )
        elif pair in last_types_by_pair:
            previous_day, previous_types = last_types_by_pair[pair]
            was_raising = [t for t in previous_types if RELATION_POLARITY.get(t) == "raises"]
            was_lowering = [t for t in previous_types if RELATION_POLARITY.get(t) == "lowers"]
            if (was_raising and lowering) or (was_lowering and raising):
                events.append(
                    TemporalEvent(
                        EventKind.CONTRADICTION,
                        day,
                        edge_subject(pair[0], pair[1], sorted(current[pair])[0]),
                        ref,
                        {
                            "kind": ContradictionKind.OPPOSITE_POLARITY.value,
                            "scope": "across_days",
                            "source_id": pair[0],
                            "target_id": pair[1],
                            "previous_day": previous_day.isoformat(),
                            "previous_relation_types": list(previous_types),
                            "current_relation_types": list(current[pair]),
                            "resolution": "both observations kept; the earlier one is not rewritten",
                        },
                    )
                )

    for pair in sorted(current):
        reverse = (pair[1], pair[0])
        if reverse not in current or not pair[0] < pair[1]:
            continue
        forward_raising = [t for t in current[pair] if RELATION_POLARITY.get(t) == "raises"]
        reverse_raising = [t for t in current[reverse] if RELATION_POLARITY.get(t) == "raises"]
        if forward_raising and reverse_raising:
            events.append(
                TemporalEvent(
                    EventKind.CONTRADICTION,
                    day,
                    edge_subject(pair[0], pair[1], forward_raising[0]),
                    ref,
                    {
                        "kind": ContradictionKind.MUTUAL_CAUSATION.value,
                        "scope": "same_day",
                        "source_id": pair[0],
                        "target_id": pair[1],
                        "forward_relation_types": forward_raising,
                        "reverse_relation_types": reverse_raising,
                        "resolution": "both directions kept; a cycle is a finding, not an error",
                    },
                )
            )
    return events


# ---- the stored diff, cross-checked ---------------------------------------


def _node_ids_of(entities: Any) -> Tuple[str, ...]:
    if not isinstance(entities, list):
        return ()
    return tuple(sorted({str(entity.get("id", "")) for entity in entities if isinstance(entity, dict)}))


def _relation_keys_of(entities: Any) -> Tuple[str, ...]:
    if not isinstance(entities, list):
        return ()
    return tuple(
        sorted(
            {
                edge_subject(
                    str(entity.get("source_id", "")),
                    str(entity.get("target_id", "")),
                    str(entity.get("type", "co_occurs")),
                )
                for entity in entities
                if isinstance(entity, dict)
            }
        )
    )


def _cross_check_stored_diffs(
    ordered: Sequence[SnapshotInput],
    by_day: Mapping[date, Sequence[SnapshotInput]],
) -> List[DiffCrossCheck]:
    """Compare each stored `temporal_diff_json` with the diff recomputed here.

    The recomputation reproduces the production writer's basis: a snapshot is
    compared against the last snapshot of the participant's previous *day*
    (`client.ts` selects on `day <`), not against the previous row on the same
    day.
    """
    checks: List[DiffCrossCheck] = []
    days = sorted(by_day)
    day_index = {day: index for index, day in enumerate(days)}

    for snapshot in ordered:
        basis = snapshot.diff_basis
        if snapshot.temporal_diff is None:
            checks.append(
                DiffCrossCheck(
                    snapshot.snapshot_id,
                    snapshot.day,
                    None,
                    "absent",
                    "no temporal_diff_json was supplied for this snapshot",
                )
            )
            continue
        if basis is None:
            checks.append(
                DiffCrossCheck(snapshot.snapshot_id, snapshot.day, None, "not_comparable", _NO_BASIS_REASON)
            )
            continue
        if basis not in TRUSTED_DIFF_BASES:
            checks.append(
                DiffCrossCheck(
                    snapshot.snapshot_id,
                    snapshot.day,
                    basis,
                    "not_comparable",
                    UNTRUSTED_DIFF_BASES.get(basis, f"unrecognised diff_basis `{basis}`"),
                )
            )
            continue

        index = day_index[snapshot.day]
        previous_day_snapshots = by_day[days[index - 1]] if index > 0 else ()

        if not previous_day_snapshots:
            if basis == "previous_snapshot":
                checks.append(
                    DiffCrossCheck(
                        snapshot.snapshot_id,
                        snapshot.day,
                        basis,
                        "not_comparable",
                        "the stored diff was computed against a snapshot that precedes the "
                        "assembled window, so there is nothing here to compare it with",
                    )
                )
            else:
                checks.append(
                    _compare_diff(snapshot, None, "the window starts here and the stored diff claims no previous day")
                )
            continue

        if basis == "first_snapshot_for_participant":
            checks.append(
                DiffCrossCheck(
                    snapshot.snapshot_id,
                    snapshot.day,
                    basis,
                    "disagreed",
                    "the stored diff claims this is the participant's first snapshot, but an "
                    "earlier day is present in the assembled window",
                    ("claimed_first_snapshot_but_earlier_day_exists",),
                )
            )
            continue

        if len(previous_day_snapshots) > 1:
            checks.append(
                DiffCrossCheck(
                    snapshot.snapshot_id,
                    snapshot.day,
                    basis,
                    "not_comparable",
                    "the previous day holds more than one snapshot, so which row the stored "
                    "diff was computed against cannot be identified from this window",
                )
            )
            continue

        checks.append(
            _compare_diff(snapshot, previous_day_snapshots[-1], "compared against the previous day's snapshot")
        )

    return checks


def _compare_diff(
    snapshot: SnapshotInput, previous: Optional[SnapshotInput], reason: str
) -> DiffCrossCheck:
    recomputed = build_temporal_graph_diff(
        list(snapshot.nodes),
        list(snapshot.relations),
        list(previous.nodes) if previous else [],
        list(previous.relations) if previous else [],
    )
    stored = snapshot.temporal_diff or {}

    comparisons = (
        ("added_nodes", _node_ids_of),
        ("removed_nodes", _node_ids_of),
        ("added_relations", _relation_keys_of),
        ("removed_relations", _relation_keys_of),
        ("changed_relations", _relation_keys_of),
    )
    disagreements = [
        field_name
        for field_name, extract in comparisons
        if extract(stored.get(field_name)) != extract(recomputed.get(field_name))
    ]

    if disagreements:
        return DiffCrossCheck(
            snapshot.snapshot_id,
            snapshot.day,
            snapshot.diff_basis,
            "disagreed",
            reason,
            tuple(disagreements),
        )
    return DiffCrossCheck(snapshot.snapshot_id, snapshot.day, snapshot.diff_basis, "agreed", reason)


# ---- curated provenance ---------------------------------------------------


def _curated_from_node(raw: Mapping[str, Any]) -> CuratedProvenance:
    provenance = raw.get("provenance")
    if not isinstance(provenance, dict) or not provenance.get("matched"):
        return UNCURATED
    return CuratedProvenance(
        source_refs=tuple(sorted(str(ref) for ref in provenance.get("source_refs", ()) or ())),
        subgraph_id=_optional_str(provenance.get("subgraph_id")),
        seed_id=_optional_str(provenance.get("seed_id")),
        match_rule=_optional_str(provenance.get("match_rule")),
    )


def _curated_from_relation(raw: Mapping[str, Any]) -> CuratedProvenance:
    provenance = raw.get("provenance")
    if not isinstance(provenance, dict) or not provenance.get("matched"):
        return UNCURATED
    type_matches = provenance.get("type_matches_seed")
    return CuratedProvenance(
        source_refs=tuple(sorted(str(ref) for ref in provenance.get("source_refs", ()) or ())),
        subgraph_id=_optional_str(provenance.get("subgraph_id")),
        seed_id=_optional_str(provenance.get("seed_id")),
        match_rule=_optional_str(provenance.get("match_rule")),
        evidence_strength=_optional_str(provenance.get("evidence_strength")),
        seed_relation_type=_optional_str(provenance.get("seed_relation_type")),
        type_matches_seed=bool(type_matches) if type_matches is not None else None,
    )


def _merge_curated(
    observed: Sequence[CuratedProvenance], declared: Optional[Sequence[str]]
) -> CuratedProvenance:
    """One curated record from however many days carried an annotation.

    Source refs are unioned, because a curation that matched on Tuesday and not
    on Thursday still matched. The scalar fields take the LAST day's value: the
    curation is versioned outside this module, and the most recent extraction
    saw the most recent seed graph. Both are stated here rather than left to be
    inferred from the code.
    """
    if not observed and not declared:
        return UNCURATED

    refs: Set[str] = set()
    for record in observed:
        refs.update(record.source_refs)
    refs.update(str(ref) for ref in (declared or ()))

    latest = observed[-1] if observed else UNCURATED
    return CuratedProvenance(
        source_refs=tuple(sorted(refs)),
        subgraph_id=latest.subgraph_id,
        seed_id=latest.seed_id,
        match_rule=latest.match_rule if observed else "curator_declared",
        evidence_strength=latest.evidence_strength,
        seed_relation_type=latest.seed_relation_type,
        type_matches_seed=latest.type_matches_seed,
    )


# ---- small helpers --------------------------------------------------------


def _identity_rules(used: Sequence[IdentityRule]) -> Tuple[IdentityRule, ...]:
    """Deduplicate, in ladder order. Empty means nothing was ever matched to it."""
    if not used:
        return (IdentityRule.NO_MATCH,)
    ordered = sorted({rule.value for rule in used}, key=lambda value: IDENTITY_RULE_STRENGTH[value])
    return tuple(IdentityRule(value) for value in ordered)


def _observation_on(
    observations: Sequence[PersonalObservation], day: date
) -> Optional[PersonalObservation]:
    """The last observation recorded on `day`.

    Last rather than first because a participant who writes twice has revised
    their own account by the evening, and the day's event should carry what they
    ended up saying. Every individual observation is still on the node.
    """
    for observation in reversed(observations):
        if observation.snapshot.day == day:
            return observation
    return None


def _last_seen(days_to_snapshots: Mapping[date, Sequence[str]], before: date) -> Optional[str]:
    earlier = [day for day in days_to_snapshots if day < before]
    return max(earlier).isoformat() if earlier else None


def _first_day_of(days_to_snapshots: Optional[Mapping[date, Sequence[str]]], fallback: date) -> date:
    if not days_to_snapshots:
        return fallback
    return min(days_to_snapshots)


def _optional_str(value: Any) -> Optional[str]:
    return str(value) if value not in (None, "") else None


def _as_float(value: Any, fallback: float) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return fallback
    return result if result == result else fallback  # NaN check


def _as_optional_float(value: Any) -> Optional[float]:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if result == result else None
