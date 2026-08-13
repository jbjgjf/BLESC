"""Precedence across the three layers, and the one thing it must never do (#101).

Precedence here does **not** pick a winner and discard the rest. It returns two
answers, because the claims are answers to two different questions:

- `general` — what published knowledge says about people, from the curated layer.
- `about_participant` — what is known about *this* person, which is usually
  their own observations.

A participant's entries outrank a guideline for describing that participant, and
a guideline outranks their entries for describing anybody else. Collapsing those
into one ranking would mean either generalising from one student or overriding a
student's own account with a population statement. Both are wrong, and they are
wrong in opposite directions, which is why the resolution has two fields instead
of a sort order.

**Association never becomes causation.** `Resolution.causal_support` is true only
when a claim whose `evidence_strength` is `CAUSAL` supports the edge. It is never
inferred from the relation type — a `causes` edge resting on an observational
study is the normal case, and `causes` + `ASSOCIATION` is a legitimate
combination this repository deliberately preserves (`ontology/schema.py`).
Personal observations and candidate proposals report `asserts_causation = False`
unconditionally: a participant reporting a link is not evidence of one, and a
model's confidence is not evidence strength at any value.

The ordering within a scope, strongest first:

1. **Reviewer decision.** A curated edge is by definition one a human accepted.
2. **Layer.** curated, then personal, then candidate. A proposal never outranks
   a record of something that happened.
3. **Evidence strength**, among curated claims: causal, association, expert
   judgement.
4. **Recency**, as a tie-break only. A newer claim of the same kind supersedes
   an older one; a newer claim of a weaker kind does not.

Candidates are ranked but marked non-authoritative throughout: nothing in the
product may read the candidate layer as knowledge, and `Resolution.authoritative`
excludes it.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Any, Dict, List, Optional, Sequence, Tuple, Union

from ..schema import EvidenceStrength
from .layers import CandidateEdge, CuratedEdge, EdgeKey, Layer, PersonalEdge

Claim = Union[CuratedEdge, PersonalEdge, CandidateEdge]

#: Strongest first. Explicit rather than relying on the enum's declaration order,
#: which is not a ranking and would silently become one.
_LAYER_RANK: Dict[Layer, int] = {Layer.CURATED: 0, Layer.PERSONAL: 1, Layer.CANDIDATE: 2}

_STRENGTH_RANK: Dict[EvidenceStrength, int] = {
    EvidenceStrength.CAUSAL: 0,
    EvidenceStrength.ASSOCIATION: 1,
    EvidenceStrength.EXPERT_JUDGEMENT: 2,
}

#: Relation types that assert a direction of influence, and which way. Shared
#: with `temporal.assemble.RELATION_POLARITY` in intent — a contradiction is a
#: pair of claims pointing opposite ways about the same ordered pair. `co_occurs`
#: and `precedes` assert no direction and so contradict nothing.
_POLARITY: Dict[str, Optional[str]] = {
    "causes": "raises",
    "escalates": "raises",
    "buffers": "lowers",
    "avoids": "lowers",
    "co_occurs": None,
    "precedes": None,
}


def claim_date(claim: Claim) -> date:
    """The date precedence reads as "when this claim was last stood behind"."""
    if isinstance(claim, CuratedEdge):
        return claim.reviewed_on
    if isinstance(claim, PersonalEdge):
        return claim.last_observed
    return claim.proposed_on


def _sort_key(claim: Claim) -> Tuple[int, int, int, str]:
    """Layer, then evidence strength, then recency, then the key.

    Recency descends while everything else ascends, so it enters as a negated
    ordinal rather than as a second sort pass. The edge key breaks the final tie
    so that two claims agreeing on every other term still order deterministically
    rather than by their position in the caller's list.
    """
    strength = (
        _STRENGTH_RANK[claim.evidence_strength]
        if isinstance(claim, CuratedEdge)
        else len(_STRENGTH_RANK)
    )
    return (
        _LAYER_RANK[claim.layer],
        strength,
        -claim_date(claim).toordinal(),
        "|".join(claim.edge_key),
    )


def _ranked(claims: Sequence[Claim]) -> List[Claim]:
    return sorted(claims, key=_sort_key)


def rank_reason(claim: Claim) -> str:
    if isinstance(claim, CuratedEdge):
        return (
            f"curated, reviewed by {claim.reviewed_by} on {claim.reviewed_on.isoformat()}, "
            f"support: {claim.evidence_strength.value}"
        )
    if isinstance(claim, PersonalEdge):
        return (
            f"this participant's own account, {len(claim.observations)} observation(s) "
            f"over {claim.recurrence_count} appearance(s), last {claim.last_observed.isoformat()}"
        )
    return (
        f"model proposal ({claim.model_version} / {claim.data_version}), confidence "
        f"{claim.confidence}, status {claim.status.value} — not knowledge"
    )


@dataclass(frozen=True)
class Contradiction:
    """Two claims about one ordered pair pointing opposite ways."""

    edge_key: EdgeKey
    left: Claim
    right: Claim
    detail: str

    def as_dict(self) -> Dict[str, Any]:
        return {
            "edge_key": list(self.edge_key),
            "layers": sorted({self.left.layer.value, self.right.layer.value}),
            "left": self.left.as_dict(),
            "right": self.right.as_dict(),
            "detail": self.detail,
            "resolution": "recorded, not resolved; both claims are kept",
        }


@dataclass(frozen=True)
class Resolution:
    """What is believed about one pair of nodes, from whose point of view.

    Two answers rather than one, plus everything that was set aside and why.
    """

    source_id: str
    target_id: str
    participant_id: Optional[str]
    #: Strongest general-scope claim — published knowledge about people.
    general: Optional[Claim]
    #: Strongest claim about this participant specifically.
    about_participant: Optional[Claim]
    ranked: Tuple[Tuple[Claim, str], ...]
    contradictions: Tuple[Contradiction, ...]
    excluded: Tuple[Tuple[Claim, str], ...]
    warnings: Tuple[str, ...]

    @property
    def authoritative(self) -> Tuple[Claim, ...]:
        """Claims the product may present as knowledge. Never a candidate."""
        return tuple(claim for claim, _reason in self.ranked if claim.layer is not Layer.CANDIDATE)

    @property
    def causal_support(self) -> bool:
        """Whether any surviving claim's SUPPORT is causal.

        Never derived from the relation type. This is the property #101 means by
        "without treating association as causation", and it is a method on the
        resolution rather than a field on an edge so that no caller can read it
        off a single claim and skip the rest.
        """
        return any(claim.asserts_causation for claim, _ in self.ranked)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "source_id": self.source_id,
            "target_id": self.target_id,
            "participant_id": self.participant_id,
            "general": self.general.as_dict() if self.general else None,
            "about_participant": self.about_participant.as_dict() if self.about_participant else None,
            "causal_support": self.causal_support,
            "ranked": [{"claim": claim.as_dict(), "reason": reason} for claim, reason in self.ranked],
            "contradictions": [contradiction.as_dict() for contradiction in self.contradictions],
            "excluded": [{"claim": claim.as_dict(), "reason": reason} for claim, reason in self.excluded],
            "warnings": list(self.warnings),
        }


def resolve(
    claims: Sequence[Claim],
    source_id: str,
    target_id: str,
    participant_id: Optional[str] = None,
) -> Resolution:
    """Rank every claim about `source_id -> target_id`, keeping all of them.

    `participant_id` selects whose personal layer is in view. Passing `None`
    asks the general question, and personal claims are then excluded rather
    than ranked — one student's entries are not evidence about students.
    """
    relevant: List[Claim] = []
    excluded: List[Tuple[Claim, str]] = []

    for claim in claims:
        if claim.edge_key[0] != source_id or claim.edge_key[1] != target_id:
            excluded.append((claim, "different node pair"))
            continue
        if isinstance(claim, CandidateEdge) and not claim.status.is_live:
            excluded.append((claim, f"candidate is {claim.status.value}; not in play"))
            continue
        if not claim.scope.covers(participant_id):
            excluded.append(
                (
                    claim,
                    "scoped to a different participant"
                    if participant_id
                    else "participant-scoped; not evidence about people in general",
                )
            )
            continue
        relevant.append(claim)

    ranked = _ranked(relevant)
    general = next((claim for claim in ranked if claim.scope.is_general and claim.layer is not Layer.CANDIDATE), None)
    about_participant = (
        next(
            (
                claim
                for claim in ranked
                if participant_id
                and not claim.scope.is_general
                and claim.layer is not Layer.CANDIDATE
            ),
            None,
        )
        if participant_id
        else None
    )

    warnings: List[str] = []
    strongest = ranked[0] if ranked else None
    if strongest is not None and not strongest.asserts_causation:
        warnings.append(
            f"no claim about {source_id} -> {target_id} rests on causal evidence; the relation "
            "type describes a modelled direction, not a demonstrated cause"
        )
    if about_participant is not None and general is not None and about_participant is not general:
        warnings.append(
            "a general claim and this participant's own account both exist; they answer "
            "different questions and neither replaces the other"
        )
    if any(claim.layer is Layer.CANDIDATE for claim in ranked):
        warnings.append("a model proposal is included in the ranking and is not knowledge")

    return Resolution(
        source_id=source_id,
        target_id=target_id,
        participant_id=participant_id,
        general=general,
        about_participant=about_participant,
        ranked=tuple((claim, rank_reason(claim)) for claim in ranked),
        contradictions=tuple(find_contradictions(claims, participant_id)),
        excluded=tuple(excluded),
        warnings=tuple(warnings),
    )


def find_contradictions(
    claims: Sequence[Claim], participant_id: Optional[str] = None
) -> List[Contradiction]:
    """Claims about one ordered pair that point opposite ways.

    Cross-layer by design: a guideline saying a support buffers a state and a
    participant reporting that the same support makes it worse is exactly the
    case #101 asks be retained as an event rather than resolved. Neither claim
    is touched, and which of them is "right" is not a question this function is
    equipped to answer.
    """
    in_view = [claim for claim in claims if claim.scope.covers(participant_id)]
    found: List[Contradiction] = []

    for index, left in enumerate(in_view):
        for right in in_view[index + 1 :]:
            if left.edge_key[:2] != right.edge_key[:2]:
                continue
            left_polarity = _POLARITY.get(left.edge_key[2])
            right_polarity = _POLARITY.get(right.edge_key[2])
            if not left_polarity or not right_polarity or left_polarity == right_polarity:
                continue
            found.append(
                Contradiction(
                    edge_key=left.edge_key,
                    left=left,
                    right=right,
                    detail=(
                        f"`{left.edge_key[2]}` ({left_polarity}) from the {left.layer.value} layer "
                        f"against `{right.edge_key[2]}` ({right_polarity}) from the "
                        f"{right.layer.value} layer"
                    ),
                )
            )
    return sorted(found, key=lambda contradiction: "|".join(contradiction.edge_key))


def precedence_rules() -> Dict[str, Any]:
    """The rules as data, so a response or a doc test can assert on them."""
    return {
        "order": [
            "reviewer decision — a curated edge is one a human accepted",
            "layer — curated, then personal, then candidate",
            "evidence strength among curated claims — causal, association, expert_judgement",
            "recency, as a tie-break within the same layer and strength",
        ],
        "scope": (
            "A participant's own account outranks a general claim FOR DESCRIBING THAT "
            "PARTICIPANT, and never for anybody else. The resolution reports both "
            "answers rather than choosing between them."
        ),
        "causation": (
            "causal_support is true only where a claim's evidence_strength is `causal`. "
            "It is never inferred from the relation type; `causes` + `association` is a "
            "legitimate and common combination. Personal and candidate claims never "
            "assert causation, at any confidence."
        ),
        "candidates": "ranked but never authoritative; nothing in the product reads them as knowledge",
        "layer_rank": {layer.value: rank for layer, rank in sorted(_LAYER_RANK.items(), key=lambda item: item[1])},
        "evidence_rank": {
            strength.value: rank for strength, rank in sorted(_STRENGTH_RANK.items(), key=lambda item: item[1])
        },
    }
