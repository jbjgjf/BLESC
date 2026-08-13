"""Fixed traversal parameters, one per relation type (#96).

**Nothing here is learned.** These are hand-written constants. They are not
attention weights, they were not fitted to anything, and no result computed with
them may be described as learned. `app/analytics/graph_index.py` already carries
six fixed global ranking weights that have occasionally been talked about as if
they were attention; this module exists partly so that the relation-aware
parameters have a single home that says what they are on every line.

**What is argued and what is arbitrary.**

The *ordering* of `strength_rank` is argued, and the argument is the vocabulary's
own scope notes in `app/ontology/schema.py` — each rule's `rationale` quotes the
one it rests on. `test_relation_rules.py` asserts the ordering stays consistent
with `EvidenceStrength`, so the table cannot drift away from the ontology it
claims to follow.

The *magnitudes* of `step_damping` are engineering choices. There is no source
for "a `co_occurs` hop costs half". They were picked so that the ordering has
visible consequences at the path lengths the benchmark uses — a two-hop `causes`
chain (0.81) outranks a one-hop `co_occurs` edge (0.50), which is the behaviour
the #87 chain family needs — and they should be treated as a tunable constant,
never as a measurement. Changing one is a code change and a version bump in
`walk.GRAPH_TRAVERSAL_VERSION`; deliberately not an environment variable, because
a value that varies per deployment cannot be reported as "the fixed rule this
result used".

**Direction.** Five of the six relations are directed and are traversed in one
direction per walk (see `walk.TraversalMode`). `co_occurs` is symmetric because
its scope note defines it as "undirected co-occurrence in the same account" — the
vocabulary licenses walking it either way, and nothing else here is licensed to.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Dict, Optional, Tuple

from ..ontology.schema import RELATIONS, EvidenceStrength
from ..temporal.assemble import RELATION_POLARITY

#: Bump when a rule changes. Read into every traversal result so a stored result
#: can be matched to the table that produced it.
RELATION_RULES_VERSION = "relation-rules-v1"


class TraversalDirection(str, Enum):
    """Which way a relation may be walked, as a property of the relation itself.

    Distinct from `walk.TraversalMode`, which is the *question* being asked. A
    `FORWARD` relation is walked source→target when asking what the seed leads to
    and target→source when asking what leads to the seed; either way the walk is
    following the asserted direction of influence, in one consistent orientation.
    A `SYMMETRIC` relation has no asserted direction to follow and is walked
    either way in both modes.
    """

    FORWARD = "forward"
    SYMMETRIC = "symmetric"


class UnknownRelationType(KeyError):
    """Raised for a relation type outside the ontology vocabulary.

    Not resolved to a default. `validator.py` coerces an unsupported type to
    `co_occurs` at extraction time and reports the coercion rate; by the time a
    relation reaches traversal, an unrecognised type means the edge came from
    somewhere the vocabulary does not cover, and guessing a parameter for it
    would be inventing evidence. The walker catches this, refuses the edge, and
    records it in `TraversalReport.skipped_edges`.
    """


@dataclass(frozen=True)
class RelationRule:
    """One relation's fixed traversal parameters.

    `source_refs` and `evidence_strength` are read from `ontology/schema.py`
    rather than copied, so this table cannot claim a provenance the ontology does
    not carry.
    """

    relation_type: str
    direction: TraversalDirection
    #: Multiplicative decay applied to a path's `relation_path` component when it
    #: takes this edge. ENGINEERING CHOICE — see the module docstring.
    step_damping: float
    #: 0 is the strongest claim the vocabulary makes. The ordering is argued from
    #: the scope notes; `rationale` names the sentence it rests on.
    strength_rank: int
    rationale: str

    @property
    def influence(self) -> Optional[str]:
        """`raises`, `lowers`, or `None` for a relation asserting no influence.

        Read from `temporal.assemble.RELATION_POLARITY` rather than restated, so
        traversal and contradiction detection cannot disagree about what a
        relation asserts.
        """
        return RELATION_POLARITY.get(self.relation_type)

    @property
    def asserts_influence(self) -> bool:
        return self.influence is not None

    @property
    def source_refs(self) -> Tuple[str, ...]:
        return tuple(RELATIONS[self.relation_type].source_refs)

    @property
    def evidence_strength(self) -> str:
        return RELATIONS[self.relation_type].evidence_strength.value

    @property
    def is_expert_judgement_only(self) -> bool:
        """Whether the relation's only backing is our own judgement.

        Surfaced on every step of every path. A chain held together by
        expert-judgement relations is a chain of our opinions, and a reader is
        entitled to see that without reconstructing it from source ids.
        """
        return RELATIONS[self.relation_type].is_expert_judgement

    def as_dict(self) -> Dict[str, object]:
        return {
            "relation_type": self.relation_type,
            "direction": self.direction.value,
            "step_damping": self.step_damping,
            "strength_rank": self.strength_rank,
            "influence": self.influence,
            "evidence_strength": self.evidence_strength,
            "source_refs": list(self.source_refs),
            "is_expert_judgement_only": self.is_expert_judgement_only,
            "parameter_basis": "engineering_choice",
            "rationale": self.rationale,
        }


RELATION_RULES: Dict[str, RelationRule] = {
    rule.relation_type: rule
    for rule in [
        RelationRule(
            relation_type="causes",
            direction=TraversalDirection.FORWARD,
            step_damping=0.90,
            strength_rank=0,
            rationale=(
                "The strongest claim the vocabulary makes, and sourced (nice_ng134). "
                "Damped at all because the scope note records that the material behind "
                "it reports associations, not causation — a chain of them accumulates "
                "association, not proof."
            ),
        ),
        RelationRule(
            relation_type="buffers",
            direction=TraversalDirection.FORWARD,
            step_damping=0.85,
            strength_rank=1,
            rationale=(
                "Sourced (who_adolescent_mh) and directed, but its scope note says the "
                "WHO material describes protective factors at population level and the "
                "individual-level directed edge is an extension beyond it. Ranked below "
                "`causes` for that extension, not for being protective."
            ),
        ),
        RelationRule(
            relation_type="avoids",
            direction=TraversalDirection.FORWARD,
            step_damping=0.80,
            strength_rank=2,
            rationale=(
                "Sourced (nice_ng134), but the scope note is explicit that the edge "
                "records the student's own account of avoidance and not an inference "
                "about its function. A path through it carries a report, not a mechanism."
            ),
        ),
        RelationRule(
            relation_type="escalates",
            direction=TraversalDirection.FORWARD,
            step_damping=0.75,
            strength_rank=3,
            rationale=(
                "Asserts influence, but its scope note says the distinction from "
                "`causes` is 'a modelling distinction, not one the literature draws' "
                "and its only backing is expert judgement. Last of the influence-bearing "
                "relations."
            ),
        ),
        RelationRule(
            relation_type="precedes",
            direction=TraversalDirection.FORWARD,
            step_damping=0.60,
            strength_rank=4,
            rationale=(
                "Temporal ordering only — the scope note says 'explicitly NOT a causal "
                "claim' and that an edge should be demoted to this when direction is "
                "asserted without support. The step down from 0.75 to 0.60 is where a "
                "path stops carrying influence and starts carrying sequence."
            ),
        ),
        RelationRule(
            relation_type="co_occurs",
            direction=TraversalDirection.SYMMETRIC,
            step_damping=0.50,
            strength_rank=5,
            rationale=(
                "'The weakest claim the vocabulary can make, and the default the "
                "validator coerces to' — so an edge of this type may mean the extractor "
                "could not justify anything stronger. Symmetric because the scope note "
                "defines it as undirected."
            ),
        ),
    ]
}


def rule_for(relation_type: str) -> RelationRule:
    """The rule for `relation_type`, or `UnknownRelationType`. Never a default."""
    try:
        return RELATION_RULES[relation_type]
    except KeyError:
        raise UnknownRelationType(relation_type) from None


def is_known(relation_type: str) -> bool:
    return relation_type in RELATION_RULES


def rules_as_dict() -> Dict[str, object]:
    """The whole table, for embedding in a result or a report.

    A stored traversal result that carries its parameter table can be audited
    later without checking out the revision that produced it.
    """
    return {
        "relation_rules_version": RELATION_RULES_VERSION,
        "parameter_basis": (
            "Magnitudes are engineering choices; the ordering is argued from the scope "
            "notes in app/ontology/schema.py. Nothing here is learned or fitted."
        ),
        "rules": [RELATION_RULES[name].as_dict() for name in sorted(RELATION_RULES)],
    }


#: Ordering the table promises to keep: a relation whose backing is only expert
#: judgement never outranks one with a cited source. Asserted in tests rather
#: than enforced at construction, so a deliberate future exception has to be
#: argued in the test rather than slipped past a validator.
SOURCED_STRENGTHS = frozenset({EvidenceStrength.CAUSAL, EvidenceStrength.ASSOCIATION})
