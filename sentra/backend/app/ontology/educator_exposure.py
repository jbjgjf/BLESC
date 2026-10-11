"""No attributable observation path, no educator — for any producer (#100, #102).

#102 lists it among the non-negotiables ("no result shown without traceable
source observations and score/attribution metadata") and #100 restates it for
learned models: outputs without an attributable observation path are excluded
from educator-facing use. #96 already enforces it on the paths the
deterministic traversal builds (`traversal.walk.filter_reportable`, which also
knows the cross-day identity condition only the traversal can see). This module
is the same rule for every other output on its way to an educator, whoever made
it, so that a learned model arriving later has one door to go through rather
than a convention to remember.

An output reaches an educator only if

1. it cites at least one observation;
2. every cited observation can be resolved — a snapshot id and a day — and
   belongs to the participant the output is about;
3. it carries a breakdown of how the observations produced it;
4. and, if a model **learned** it, the Stage 3 entry gate is open.

The fourth condition is evaluated here, not passed in. Today the gate is
closed, so every learned output is withheld even with a perfect path: a path
says where an output came from, not that the model that made it has been
tested. Wiring a future model's gate decision in is a reviewed change to this
function, not an argument a caller supplies.

Withheld outputs come back with their reasons. A consumer that cannot see what
was withheld will present what it received as complete.

The production educator screen does not call this module — it reads Supabase
from the browser. The same rule is applied there to the one graph-derived
output it shows (`sentra/frontend/src/lib/educatorThemes.ts`).
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any, Dict, List, Sequence, Tuple

from .evolution.layers import ObservationRef
from .learning_gates import evaluate_stage3_entry_gate

NO_OBSERVATION_PATH = "no_observation_path"
UNRESOLVABLE_OBSERVATION = "unresolvable_observation"
OBSERVATION_OF_ANOTHER_PARTICIPANT = "observation_of_another_participant"
NO_SCORE_BREAKDOWN = "no_score_breakdown"
LEARNED_OUTPUT_GATE_CLOSED = "learned_output_stage3_gate_closed"


class Producer(str, Enum):
    #: A fixed rule whose parameters travel with the output (#96, the lexicon).
    DETERMINISTIC = "deterministic"
    #: Anything with fitted parameters (#99, #100).
    LEARNED = "learned"


@dataclass(frozen=True)
class EducatorCandidate:
    """An output that wants to be shown to an educator."""

    output_id: str
    participant_id: str
    producer: Producer
    producer_version: str
    observations: Tuple[ObservationRef, ...]
    has_score_breakdown: bool


@dataclass(frozen=True)
class Withheld:
    candidate: EducatorCandidate
    reasons: Tuple[Tuple[str, str], ...]

    @property
    def codes(self) -> Tuple[str, ...]:
        return tuple(code for code, _ in self.reasons)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "output_id": self.candidate.output_id,
            "producer": self.candidate.producer.value,
            "producer_version": self.candidate.producer_version,
            "reasons": [{"code": code, "detail": detail} for code, detail in self.reasons],
        }


def exposure_reasons(candidate: EducatorCandidate) -> Tuple[Tuple[str, str], ...]:
    """Why `candidate` may not reach an educator, as `(code, detail)`. Empty means it may."""
    reasons: List[Tuple[str, str]] = []
    if not candidate.observations:
        reasons.append(
            (NO_OBSERVATION_PATH, "cites no observation; nothing the participant wrote can be traced to it")
        )
    for ref in candidate.observations:
        if not str(ref.snapshot_id).strip() or ref.day is None:
            reasons.append(
                (UNRESOLVABLE_OBSERVATION, f"observation {ref.snapshot_id!r} on {ref.day} cannot be resolved")
            )
        elif ref.participant_id != candidate.participant_id:
            reasons.append(
                (
                    OBSERVATION_OF_ANOTHER_PARTICIPANT,
                    f"cites snapshot {ref.snapshot_id!r}, which belongs to a different participant",
                )
            )
    if not candidate.has_score_breakdown:
        reasons.append((NO_SCORE_BREAKDOWN, "no breakdown; a bare number or label is not an explanation"))
    if candidate.producer is Producer.LEARNED:
        gate = evaluate_stage3_entry_gate()
        if not gate.open:
            reasons.append(
                (
                    LEARNED_OUTPUT_GATE_CLOSED,
                    f"{candidate.producer_version} is a learned output and the Stage 3 entry gate "
                    f"is closed ({len(gate.reasons)} reason(s)); a path does not make an untested "
                    "model's output fit for an educator",
                )
            )
    return tuple(reasons)


def split_for_educators(
    candidates: Sequence[EducatorCandidate],
) -> Tuple[Tuple[EducatorCandidate, ...], Tuple[Withheld, ...]]:
    """`(allowed, withheld)`. Nothing is dropped; every withheld output keeps its reasons."""
    allowed: List[EducatorCandidate] = []
    withheld: List[Withheld] = []
    for candidate in candidates:
        reasons = exposure_reasons(candidate)
        if reasons:
            withheld.append(Withheld(candidate=candidate, reasons=reasons))
        else:
            allowed.append(candidate)
    return tuple(allowed), tuple(withheld)
