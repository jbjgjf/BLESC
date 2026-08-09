"""The five categories and six relations, with where each came from.

`validator.py` held these as two bare sets — eleven design decisions with no
recorded basis, under a landing page describing them as an ontology structured
on medical research.

The sharpest problem is `causes`. Most literature that would support these
edges reports **association**, not causation, so `EvidenceStrength` is kept
separate from the relation type: an edge can be typed `causes` while recording
that its support is observational. Collapsing the two would hide exactly the
gap that matters, which is the same error this module exists to correct, one
level up.

This module only records provenance for the vocabularies that already exist.
Widening or narrowing them is a separate change needing its own argument.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, List

from .sources import SourceKind, resolve


class EvidenceStrength(str, Enum):
    """How strongly the cited material supports the edge — NOT what the edge means.

    Deliberately distinct from the relation type. `causes` + `ASSOCIATION` is a
    legitimate and common combination: the graph models a direction, the
    literature reports a correlation, and the reader can see the difference.
    """

    CAUSAL = "causal"
    ASSOCIATION = "association"
    EXPERT_JUDGEMENT = "expert_judgement"


@dataclass(frozen=True)
class OntologyTerm:
    name: str
    scope_note: str
    source_refs: List[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        if not self.source_refs:
            raise ValueError(f"{self.name}: source_refs cannot be empty — use 'expert_judgement'")
        if not self.scope_note.strip():
            raise ValueError(f"{self.name}: scope_note is required")
        for source_id in self.source_refs:
            resolve(source_id)

    @property
    def is_expert_judgement(self) -> bool:
        return all(resolve(ref).kind is SourceKind.EXPERT_JUDGEMENT for ref in self.source_refs)


@dataclass(frozen=True)
class RelationTerm(OntologyTerm):
    evidence_strength: EvidenceStrength = EvidenceStrength.EXPERT_JUDGEMENT


CATEGORIES: Dict[str, OntologyTerm] = {
    term.name: term
    for term in [
        OntologyTerm(
            name="State",
            scope_note=(
                "An internal psychological or physical state the student reports. "
                "Guideline material describes such states as things a clinician asks "
                "about; it does not license inferring one the student did not report."
            ),
            source_refs=["nice_ng134", "who_mhgap"],
        ),
        OntologyTerm(
            name="Trigger",
            scope_note=(
                "A circumstance the student links to a state. NG134 directs clinicians "
                "to consider precipitating factors, which is the basis for the category "
                "existing — not for any particular trigger being causal."
            ),
            source_refs=["nice_ng134"],
        ),
        OntologyTerm(
            name="Protective",
            scope_note=(
                "A support or resource the student reports. WHO adolescent material "
                "frames protective factors as a population-level concept; using it for "
                "an individual is an extension the source does not make."
            ),
            source_refs=["who_adolescent_mh"],
        ),
        OntologyTerm(
            name="Behavior",
            scope_note=(
                "Something the student reports doing. No source defines this category as "
                "used here; it is an engineering distinction that keeps actions separate "
                "from the states they accompany, so the two are not conflated in a graph."
            ),
            source_refs=["expert_judgement"],
        ),
        OntologyTerm(
            name="Event",
            scope_note=(
                "A datable occurrence, carrying start/end/duration. Not a psychological "
                "category at all — it exists so temporal reasoning has something to "
                "anchor to. No source is claimed and none applies."
            ),
            source_refs=["expert_judgement"],
        ),
    ]
}

RELATIONS: Dict[str, RelationTerm] = {
    term.name: term
    for term in [
        RelationTerm(
            name="causes",
            scope_note=(
                "Models a directed influence the student describes. The available "
                "guideline material reports associations between factors and outcomes, "
                "not causation, so edges of this type default to ASSOCIATION and must "
                "justify anything stronger individually."
            ),
            source_refs=["nice_ng134"],
            evidence_strength=EvidenceStrength.ASSOCIATION,
        ),
        RelationTerm(
            name="escalates",
            scope_note=(
                "One element intensifying another already present. Distinguished from "
                "`causes` by presupposing the target — a modelling distinction, not one "
                "the literature draws."
            ),
            source_refs=["expert_judgement"],
            evidence_strength=EvidenceStrength.EXPERT_JUDGEMENT,
        ),
        RelationTerm(
            name="buffers",
            scope_note=(
                "A protective element reducing a state's intensity. WHO material "
                "describes protective factors at population level; the individual-level "
                "directed edge is an extension beyond it."
            ),
            source_refs=["who_adolescent_mh"],
            evidence_strength=EvidenceStrength.ASSOCIATION,
        ),
        RelationTerm(
            name="avoids",
            scope_note=(
                "Reported avoidance of a trigger or situation. NG134 treats avoidance as "
                "something clinicians ask about; the edge records the student's own "
                "account, not an inference about function."
            ),
            source_refs=["nice_ng134"],
            evidence_strength=EvidenceStrength.ASSOCIATION,
        ),
        RelationTerm(
            name="co_occurs",
            scope_note=(
                "Undirected co-occurrence in the same account. The weakest claim the "
                "vocabulary can make, and the default the validator coerces to — which "
                "is the right default precisely because it asserts least."
            ),
            source_refs=["expert_judgement"],
            evidence_strength=EvidenceStrength.EXPERT_JUDGEMENT,
        ),
        RelationTerm(
            name="precedes",
            scope_note=(
                "Temporal ordering only. Explicitly NOT a causal claim; it exists so "
                "sequence can be recorded without implying one, and an edge should be "
                "demoted to this when direction is asserted without support."
            ),
            source_refs=["expert_judgement"],
            evidence_strength=EvidenceStrength.EXPERT_JUDGEMENT,
        ),
    ]
}

#: What validator.py imports. Same contents as the sets it used to declare —
#: this module adds provenance, it does not change the vocabulary.
VALID_CATEGORIES = frozenset(CATEGORIES)
VALID_RELATIONS = frozenset(RELATIONS)
