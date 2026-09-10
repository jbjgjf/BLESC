"""T1b (#142) — splits that hold, and a normaliser fitted on train only.

Two kinds of generalisation are being claimed, and they need different splits:

**Across participants.** Whole participants — in fact whole *split groups* — go
to one side. A group is a family of trajectories that share an origin: S2
generates crossing pairs, and putting one member in train and the other in
heldout would score the model on a near-copy of something it fitted. A different
generator seed is not independence when the trajectory is the same.

**Forward in time for known participants.** The same people appear on both
sides, divided by a cutoff. Reported separately, never averaged together: they
answer different questions and a single number hides which one improved.

The normaliser is fitted on train rows only and carries the hash of exactly
those rows. `normalizer_id` changes when the fit input changes, so a run that
accidentally refitted on the full dataset produces a different id and the
mismatch check in C2 catches it downstream.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

import numpy as np

from ..contracts.common import content_hash, format_time, require
from ..contracts.errors import Code, ContractViolation
from ..contracts.observation import ObservationBundle

SPLIT_NAMES: Tuple[str, ...] = ("train", "validation", "heldout")

#: Fixed at H6 and not to be changed after seeing a score. 10/4/4 of 18.
DEFAULT_FRACTIONS: Tuple[float, float, float] = (0.56, 0.22, 0.22)


@dataclass(frozen=True)
class SplitAssignment:
    """Which participant is on which side, and the group that decided it."""

    split_id: str
    assignment: Mapping[str, str]
    split_groups: Mapping[str, str]
    fractions: Tuple[float, float, float]
    seed: int
    temporal_cutoff_at: Optional[datetime] = None

    def participants_in(self, split: str) -> List[str]:
        return sorted(key for key, value in self.assignment.items() if value == split)

    def validate(self, path: str = "split") -> None:
        groups_by_split: Dict[str, set] = {name: set() for name in SPLIT_NAMES}
        for participant, split in self.assignment.items():
            require(
                split in SPLIT_NAMES,
                Code.UNKNOWN_ENUM_VALUE,
                f"未知のsplit名です: {split}",
                f"{path}.assignment.{participant}",
            )
            groups_by_split[split].add(self.split_groups.get(participant, participant))

        for left in SPLIT_NAMES:
            for right in SPLIT_NAMES:
                if left >= right:
                    continue
                overlap = groups_by_split[left] & groups_by_split[right]
                if overlap:
                    raise ContractViolation(
                        Code.SPLIT_OVERLAP,
                        f"split_groupが{left}と{right}にまたがっています: {sorted(overlap)}",
                        f"{path}.split_groups",
                        {"overlap": sorted(overlap)},
                    )

    def as_dict(self) -> Dict[str, Any]:
        return {
            "split_id": self.split_id,
            "assignment": dict(sorted(self.assignment.items())),
            "split_groups": dict(sorted(self.split_groups.items())),
            "fractions": list(self.fractions),
            "seed": self.seed,
            "temporal_cutoff_at": format_time(self.temporal_cutoff_at),
        }

    def content_hash(self) -> str:
        return content_hash(self.as_dict())


def participant_split(
    bundle: ObservationBundle,
    split_groups: Optional[Mapping[str, str]] = None,
    fractions: Tuple[float, float, float] = DEFAULT_FRACTIONS,
    seed: int = 11,
    split_id: str = "participant-holdout-v0",
) -> SplitAssignment:
    """Assign whole groups to train/validation/heldout.

    Groups are shuffled with a seeded generator and sorted first, so the
    assignment depends on the group names and the seed and on nothing else — not
    on the order rows happened to arrive in.
    """

    groups = dict(split_groups or {})
    for participant in bundle.participants:
        groups.setdefault(participant, participant)

    unique_groups = sorted(set(groups.values()))
    require(
        len(unique_groups) >= len(SPLIT_NAMES),
        Code.EMPTY_VALUE,
        f"split_groupが{len(unique_groups)}件しかなく、3分割できません。",
        "split.groups",
    )

    rng = np.random.default_rng(seed)
    order = list(rng.permutation(len(unique_groups)))
    shuffled = [unique_groups[index] for index in order]

    n_train = max(1, int(round(fractions[0] * len(shuffled))))
    n_validation = max(1, int(round(fractions[1] * len(shuffled))))
    if n_train + n_validation >= len(shuffled):
        n_train = max(1, len(shuffled) - 2)
        n_validation = 1

    group_to_split: Dict[str, str] = {}
    for index, group in enumerate(shuffled):
        if index < n_train:
            group_to_split[group] = "train"
        elif index < n_train + n_validation:
            group_to_split[group] = "validation"
        else:
            group_to_split[group] = "heldout"

    assignment = {participant: group_to_split[group] for participant, group in groups.items()}
    split = SplitAssignment(
        split_id=split_id,
        assignment=assignment,
        split_groups=groups,
        fractions=fractions,
        seed=seed,
    )
    split.validate()
    return split


def temporal_cutoff(bundle: ObservationBundle, input_fraction: float = 0.75) -> datetime:
    """The time that divides "what the model saw" from "what it is scored on".

    Chosen from the distribution of `available_at`, not from wall-clock now: a
    rerun next week must produce the same cutoff or the run is not reproducible.
    """

    times = sorted(row.available_at for row in bundle.observations)
    require(len(times) > 1, Code.EMPTY_VALUE, "観測が1件以下では時間分割できません。", "bundle.observations")
    index = min(len(times) - 1, max(1, int(round(input_fraction * len(times)))))
    return times[index]


def merge_split_groups(*mappings: Mapping[str, str]) -> Dict[str, str]:
    """Combine per-scenario group maps into one, refusing silent collisions."""

    merged: Dict[str, str] = {}
    for mapping in mappings:
        for participant, group in mapping.items():
            existing = merged.get(participant)
            if existing is not None and existing != group:
                raise ContractViolation(
                    Code.SPLIT_OVERLAP,
                    f"participant {participant} に別のsplit_groupが割り当てられています。",
                    "split_groups",
                    {"existing": existing, "incoming": group},
                )
            merged[participant] = group
    return merged
