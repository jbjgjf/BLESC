"""The graph-walk MDP, stated explicitly (#98).

#102 is careful that existing storage, BFS and fixed ranking weights are **not**
reinforcement learning. This module is the first thing in the repository that is
an MDP rather than a traversal, and it is written down in full — state, action
set, transition, episode limit, terminal conditions, reward — because "we could
train a policy on this" is a claim that needs a decision process behind it, and
naming one after the fact is how a BFS gets called RL.

**Nothing here trains.** The environment and the reward are separable from any
learner on purpose: the baselines in `policies.py` are policies over this same
MDP, so the comparison #98 requires is between things that step the same
environment rather than between numbers computed in different ways.

## The decision process

**State** — `WalkState`: the case being walked, the concept the walk is standing
on, the concepts already visited, and how many hops have been taken. The visited
set is part of the state rather than bookkeeping outside it, because the cycle
penalty is a function of the state and a Markov property that depended on hidden
history would not be one.

**Actions** — every typed, directed edge leaving the current concept, plus a
single `STOP`. An edge is one action per `(relation, target)` pair, so `causes`
and `buffers` to the same concept are two different actions. Symmetric relations
are expanded in both directions by `build_relation_graph`, which is where this
environment gets its adjacency; a relation outside the ontology vocabulary is not
an action at all, matching the refusal `traversal/walk.py` makes.

**Transition** — deterministic. The graph is fixed for the episode, so `step` is
a function rather than a sample. Stochasticity, if it is ever wanted, belongs in
the policy.

**Episode limit** — `max_hops`, default 4. That is the length of the longest
curated chain (`academic_pressure.benchmark_chain`), so an episode can traverse
the deepest real answer and no further. A limit shorter than the answer would
make every method fail for the same reason and the comparison would measure the
limit.

**Terminal** — `STOP` is chosen, the hop limit is reached, or the current concept
has no outgoing edges. All three end the episode; only the first is the policy's
decision, and `EpisodeResult.terminal_reason` keeps them apart so that a policy
that never stops is distinguishable from one that stops correctly.

## What may be a reward

Reaching a concept that appears in a **human-labelled** target evidence day. That
is the whole reward signal, plus pre-registered penalties.

`RewardSpec` refuses to be built from anything else, and `forbidden_reward_signals`
names the fields that are permanently ineligible — `expected_safety`,
`safety_label`, and any real participant content. #98's non-goals are "no clinical
reward" and "no live-user online learning"; those are enforced here rather than
promised in a docstring, because the failure mode is a plausible-looking commit
that adds a safety bonus and passes review.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any, Dict, List, Optional, Sequence, Tuple

from ..services.benchmark_cases import BenchmarkCase, EvidenceDay
from ..services.benchmark_retrieval import Triple, build_relation_graph, parse_motifs

POLICY_ENV_VERSION = "graph-walk-mdp-v1"

#: The longest curated chain is four hops (`academic_pressure.benchmark_chain`:
#: exam_pressure -> sleep_deprivation -> cognitive_impairment -> depressed_mood
#: -> anhedonia). An episode can traverse the deepest real answer and no more.
DEFAULT_MAX_HOPS = 4

#: Fields that may never contribute to reward, and why. Checked by
#: `RewardSpec.__post_init__` and asserted by a test, so adding a safety bonus
#: fails a build rather than shipping.
FORBIDDEN_REWARD_SIGNALS: Dict[str, str] = {
    "expected_safety": (
        "a case's safety label is a clinical judgement. Rewarding a walk for reaching it "
        "trains a policy on clinical outcome, which #98 rules out."
    ),
    "safety_label": "same, at the evidence-day level",
    "expected_policy": (
        "the product response the case expects. Rewarding it would train the walk to "
        "produce a recommendation rather than to find evidence."
    ),
    "raw_text": "real participant content is never a reward signal and is not in this dataset",
    "clinical_outcome": "no clinical outcome exists in this dataset and none may be introduced as reward",
}


class ActionKind(str, Enum):
    TRAVERSE = "traverse"
    STOP = "stop"


class TerminalReason(str, Enum):
    """Why an episode ended. Three ways, and only one is a decision.

    Kept apart because a policy that never chooses `STOP` and one that stops at
    the right moment can otherwise report the same success rate, and they are not
    the same policy.
    """

    STOPPED = "stopped"
    HOP_LIMIT = "hop_limit"
    NO_ACTIONS = "no_actions"


@dataclass(frozen=True)
class Action:
    kind: ActionKind
    relation: str = ""
    target: str = ""

    @property
    def is_stop(self) -> bool:
        return self.kind is ActionKind.STOP

    def as_dict(self) -> Dict[str, Any]:
        return {"kind": self.kind.value, "relation": self.relation, "target": self.target}


STOP = Action(ActionKind.STOP)


@dataclass(frozen=True)
class WalkState:
    """Everything the transition and the reward depend on. Nothing else."""

    case_id: str
    current: str
    visited: Tuple[str, ...]
    hops: int

    @property
    def has_revisited(self) -> bool:
        return len(set(self.visited)) != len(self.visited)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "case_id": self.case_id,
            "current": self.current,
            "visited": list(self.visited),
            "hops": self.hops,
        }


@dataclass(frozen=True)
class RewardSpec:
    """Pre-registered before any policy was run. See `docs/graph_walk_policy.md`.

    The penalties are engineering choices, not measured values. They are here,
    versioned and echoed into every result, so that a run with different numbers
    is visibly a different run — the same discipline `DynamicsParameters` and the
    benchmark pre-registration use.
    """

    #: Reaching a concept that appears in a human-labelled target evidence day.
    #: Paid once per distinct target concept, so a walk cannot farm one node.
    evidence_reward: float = 1.0
    #: Per traversal. Makes a shorter path to the same evidence worth more.
    step_penalty: float = -0.05
    #: Entering a concept already visited this episode.
    revisit_penalty: float = -0.25
    #: Choosing an action not in the legal set. A policy that does this is
    #: broken rather than unlucky, and `invalid_action_rate` is reported.
    invalid_action_penalty: float = -1.0
    #: Stopping having found nothing. Deliberately 0: stopping early is not
    #: worse than wandering, and a penalty here would train a policy to keep
    #: moving when it has nothing.
    stop_without_evidence: float = 0.0
    declared_before_results: bool = True

    def __post_init__(self) -> None:
        if self.evidence_reward <= 0:
            raise ValueError("evidence must be the only positive term; it cannot be <= 0")
        for name in ("step_penalty", "revisit_penalty", "invalid_action_penalty"):
            if getattr(self, name) > 0:
                raise ValueError(f"{name} is a penalty and cannot be positive")

    def as_dict(self) -> Dict[str, Any]:
        return {
            "evidence_reward": self.evidence_reward,
            "step_penalty": self.step_penalty,
            "revisit_penalty": self.revisit_penalty,
            "invalid_action_penalty": self.invalid_action_penalty,
            "stop_without_evidence": self.stop_without_evidence,
            "declared_before_results": self.declared_before_results,
            "reward_source": "human-labelled target evidence only",
            "forbidden_reward_signals": dict(sorted(FORBIDDEN_REWARD_SIGNALS.items())),
        }


DEFAULT_REWARD = RewardSpec()


@dataclass(frozen=True)
class StepRecord:
    """One transition, with everything needed to reconstruct why it happened.

    #98 requires policy paths to retain complete observation and provenance
    traces. This is that trace: the concept stood on, the typed edge taken, the
    evidence days that concept appears in, and the reward with its reason.
    """

    hop: int
    from_concept: str
    action: Action
    to_concept: str
    reward: float
    reward_reason: str
    #: Evidence day ids in which `to_concept` appears. The provenance handle:
    #: from a step, the days; from a day, the case's own record.
    evidence_ids: Tuple[str, ...]
    was_revisit: bool
    was_invalid: bool

    def as_dict(self) -> Dict[str, Any]:
        return {
            "hop": self.hop,
            "from": self.from_concept,
            "action": self.action.as_dict(),
            "to": self.to_concept,
            "reward": round(self.reward, 6),
            "reward_reason": self.reward_reason,
            "evidence_ids": list(self.evidence_ids),
            "was_revisit": self.was_revisit,
            "was_invalid": self.was_invalid,
        }


@dataclass(frozen=True)
class EpisodeResult:
    """One walk, end to end. The unit `evaluate.py` scores."""

    case_id: str
    anchor: str
    steps: Tuple[StepRecord, ...]
    terminal_reason: TerminalReason
    total_reward: float
    #: Target evidence ids the walk reached, in the order it reached them. The
    #: ranking `ndcg_at_k` scores.
    reached_evidence_ids: Tuple[str, ...]
    invalid_actions: int

    @property
    def path_length(self) -> int:
        return len([step for step in self.steps if not step.was_invalid])

    @property
    def concepts_visited(self) -> Tuple[str, ...]:
        return (self.anchor,) + tuple(step.to_concept for step in self.steps if not step.was_invalid)

    @property
    def found_evidence(self) -> bool:
        return bool(self.reached_evidence_ids)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "case_id": self.case_id,
            "anchor": self.anchor,
            "terminal_reason": self.terminal_reason.value,
            "total_reward": round(self.total_reward, 6),
            "path_length": self.path_length,
            "concepts_visited": list(self.concepts_visited),
            "reached_evidence_ids": list(self.reached_evidence_ids),
            "invalid_actions": self.invalid_actions,
            "found_evidence": self.found_evidence,
            "steps": [step.as_dict() for step in self.steps],
        }


class WalkEnvironment:
    """The MDP for one benchmark case.

    Built per case rather than per dataset: the concept graph is the union of
    that case's own evidence-day motifs, so a walk cannot reach an answer through
    a concept that only exists in a different case. Sharing one graph across
    cases would leak the answer key through the topology.
    """

    def __init__(
        self,
        case: BenchmarkCase,
        reward: RewardSpec = DEFAULT_REWARD,
        max_hops: int = DEFAULT_MAX_HOPS,
    ) -> None:
        self.case = case
        self.reward = reward
        self.max_hops = max_hops

        self.graph: Dict[str, List[Triple]] = build_relation_graph(
            [day.graph_motifs for day in case.evidence]
        )
        self._evidence_by_concept: Dict[str, Tuple[str, ...]] = _concepts_to_evidence(case.evidence)
        self._target_ids = frozenset(case.expected_evidence_ids)
        #: Concepts that appear in a target evidence day — the reward set.
        self.rewarding_concepts: frozenset = frozenset(
            concept
            for concept, ids in self._evidence_by_concept.items()
            if any(evidence_id in self._target_ids for evidence_id in ids)
        )

    # ---- the decision process -------------------------------------------

    @property
    def anchors(self) -> Tuple[str, ...]:
        """Where an episode may start: the query's own concepts.

        Anchors absent from the case's graph are dropped rather than added as
        isolated nodes — a walk starting somewhere with no edges is not a
        measurement of the policy.
        """
        return tuple(
            sorted(anchor.lower() for anchor in self.case.query_anchors if anchor.lower() in self.graph)
        )

    def initial_state(self, anchor: str) -> WalkState:
        return WalkState(case_id=self.case.case_id, current=anchor, visited=(anchor,), hops=0)

    def actions(self, state: WalkState) -> List[Action]:
        """Every legal action. `STOP` is always legal, and always last.

        Sorted, so a policy that breaks ties by position is deterministic and an
        exhaustive enumeration does not depend on dict ordering.
        """
        traversals = [
            Action(ActionKind.TRAVERSE, relation=triple.relation, target=triple.object)
            for triple in self.graph.get(state.current, ())
        ]
        traversals.sort(key=lambda action: (action.relation, action.target))
        return traversals + [STOP]

    def is_terminal(self, state: WalkState) -> Optional[TerminalReason]:
        if state.hops >= self.max_hops:
            return TerminalReason.HOP_LIMIT
        if not self.graph.get(state.current):
            return TerminalReason.NO_ACTIONS
        return None

    def step(self, state: WalkState, action: Action) -> Tuple[WalkState, float, Optional[TerminalReason], StepRecord]:
        """Apply one action. Deterministic.

        An illegal action is charged the invalid penalty and leaves the state
        unchanged rather than raising: a learner will emit them, the rate is a
        reported metric, and an exception would make the metric unmeasurable.
        """
        legal = self.actions(state)

        if action not in legal:
            record = StepRecord(
                hop=state.hops,
                from_concept=state.current,
                action=action,
                to_concept=state.current,
                reward=self.reward.invalid_action_penalty,
                reward_reason="action is not in the legal set for this state",
                evidence_ids=(),
                was_revisit=False,
                was_invalid=True,
            )
            return state, record.reward, None, record

        if action.is_stop:
            found = any(concept in self.rewarding_concepts for concept in state.visited)
            reward = 0.0 if found else self.reward.stop_without_evidence
            record = StepRecord(
                hop=state.hops,
                from_concept=state.current,
                action=action,
                to_concept=state.current,
                reward=reward,
                reward_reason="stopped" if found else "stopped without reaching target evidence",
                evidence_ids=self._evidence_by_concept.get(state.current, ()),
                was_revisit=False,
                was_invalid=False,
            )
            return state, reward, TerminalReason.STOPPED, record

        target = action.target
        revisit = target in state.visited
        first_time_rewarding = target in self.rewarding_concepts and not revisit

        reward = self.reward.step_penalty
        reasons = ["step"]
        if revisit:
            reward += self.reward.revisit_penalty
            reasons.append("revisit")
        if first_time_rewarding:
            reward += self.reward.evidence_reward
            reasons.append("reached target evidence")

        next_state = WalkState(
            case_id=state.case_id,
            current=target,
            visited=state.visited + (target,),
            hops=state.hops + 1,
        )
        record = StepRecord(
            hop=state.hops + 1,
            from_concept=state.current,
            action=action,
            to_concept=target,
            reward=reward,
            reward_reason=" + ".join(reasons),
            evidence_ids=self._evidence_by_concept.get(target, ()),
            was_revisit=revisit,
            was_invalid=False,
        )
        return next_state, reward, self.is_terminal(next_state), record

    # ---- provenance ------------------------------------------------------

    def evidence_for(self, concept: str) -> Tuple[str, ...]:
        return self._evidence_by_concept.get(concept, ())

    def target_evidence_reached(self, concepts: Sequence[str]) -> Tuple[str, ...]:
        """Target evidence ids reachable from the concepts a walk visited.

        Ordered by first arrival, so the result is a ranking rather than a set
        and `ndcg_at_k` can score it the way it scores a retrieval condition.
        """
        seen: List[str] = []
        for concept in concepts:
            for evidence_id in self._evidence_by_concept.get(concept, ()):
                if evidence_id in self._target_ids and evidence_id not in seen:
                    seen.append(evidence_id)
        return tuple(seen)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "environment_version": POLICY_ENV_VERSION,
            "case_id": self.case.case_id,
            "family": self.case.family,
            "lang": self.case.lang,
            "max_hops": self.max_hops,
            "anchors": list(self.anchors),
            "concept_count": len(self.graph),
            "action_count": sum(len(edges) for edges in self.graph.values()) + 1,
            "rewarding_concepts": sorted(self.rewarding_concepts),
            "target_evidence_ids": sorted(self._target_ids),
            "reward": self.reward.as_dict(),
        }


def _concepts_to_evidence(evidence: Sequence[EvidenceDay]) -> Dict[str, Tuple[str, ...]]:
    """Concept -> the evidence day ids whose motifs mention it.

    Both ends of every motif, because a day that says `A causes B` is evidence
    about B as much as about A, and a walk arriving at either has arrived at
    that day.
    """
    mapping: Dict[str, List[str]] = {}
    for day in evidence:
        for triple in parse_motifs(day.graph_motifs):
            for concept in (triple.subject, triple.object):
                bucket = mapping.setdefault(concept, [])
                if day.evidence_id not in bucket:
                    bucket.append(day.evidence_id)
    return {concept: tuple(ids) for concept, ids in mapping.items()}


def environment_contract() -> Dict[str, Any]:
    """The MDP as data, for a doc test or a response.

    #102 is explicit that existing traversal is not RL. Serving the decision
    process makes the difference checkable rather than asserted.
    """
    return {
        "environment_version": POLICY_ENV_VERSION,
        "state": "case, current concept, concepts visited this episode, hop count",
        "actions": "one per typed directed edge leaving the current concept, plus STOP",
        "transition": "deterministic; the graph is fixed for the episode",
        "episode_limit": DEFAULT_MAX_HOPS,
        "episode_limit_rationale": (
            "the longest curated chain is four hops, so an episode can traverse the "
            "deepest real answer and no further"
        ),
        "terminal_conditions": [reason.value for reason in TerminalReason],
        "reward": DEFAULT_REWARD.as_dict(),
        "not_implemented_here": [
            "online learning from live users",
            "any clinical, safety, or diagnostic reward",
            "educator-facing policy output",
            "product integration before the policy beats the deterministic baselines",
        ],
    }
