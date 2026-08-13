"""Policies over the graph-walk MDP (#98).

Every comparison #98 requires is a policy over the SAME environment: keyword,
undirected BFS, the deterministic relation-aware rule from #96, and random. That
is the point of putting them here rather than comparing against numbers computed
by `benchmark_retrieval` — a learned policy that beat a differently-computed
baseline would be beating a different measurement, not a different method.

| policy | family | what it uses |
| --- | --- | --- |
| `RandomPolicy` | chance | nothing; uniform over legal actions |
| `KeywordPolicy` | lexical | word overlap between the query and the target concept |
| `UndirectedBfsPolicy` | untyped traversal | hop distance, ignoring relation type and direction |
| `RelationAwarePolicy` | fixed-rule traversal | `traversal.RELATION_RULES` — the #96 table, unchanged |
| `LinearPolicy` | learned | weights over the features in `features()`; fitted by `train.py` |

`RelationAwarePolicy` reads the #96 rule table rather than restating it. If that
table changes, this policy changes with it, which is the intended coupling: it
exists to answer "does a learner beat the deterministic rule we actually ship",
and a frozen copy would stop answering that.

**None of these are trained here.** `LinearPolicy` is a parameterised policy with
a default weight vector that is deliberately not fitted; `train.py` owns fitting
and refuses to run until the data gate opens.
"""

from __future__ import annotations

import random
import re
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence, Tuple

from ..traversal import is_known, rule_for
from .mdp import Action, EpisodeResult, StepRecord, TerminalReason, WalkEnvironment, WalkState

POLICY_VERSION = "graph-walk-policies-v1"

_WORD = re.compile(r"[a-z0-9]+")

#: Which family each policy reports under, mirroring
#: `benchmark_retrieval.METHOD_FAMILIES`. A new policy has to declare its family,
#: so a learned method cannot quietly be summarised next to a fixed rule as
#: though they were the same kind of thing.
POLICY_FAMILIES: Dict[str, str] = {
    "random": "chance",
    "keyword": "lexical",
    "undirected_bfs": "untyped_traversal",
    "relation_aware": "fixed_rule_traversal",
    "linear_learned": "learned",
}


class Policy:
    """Chooses one action from the legal set. Stateless across episodes.

    `name` is what results are keyed by, so it is required rather than derived
    from the class name — two configurations of one class are two policies and
    have to be distinguishable in a results table.
    """

    name: str = "policy"

    def reset(self, seed: int) -> None:
        """Called once per episode. Only stochastic policies use it."""

    def choose(self, env: WalkEnvironment, state: WalkState, actions: Sequence[Action]) -> Action:
        raise NotImplementedError

    def as_dict(self) -> Dict[str, Any]:
        return {"name": self.name, "family": POLICY_FAMILIES.get(self.name, "unknown")}


def _words(text: str) -> set:
    return set(_WORD.findall(text.lower()))


class RandomPolicy(Policy):
    """Uniform over legal actions. The chance floor #98 requires.

    Seeded per episode, so "chance" is a reproducible number rather than a
    different one each run — the same reason `benchmark_retrieval.CHANCE_SEED`
    exists.
    """

    name = "random"

    def __init__(self, seed: int = 20260813) -> None:
        self._seed = seed
        self._rng = random.Random(seed)

    def reset(self, seed: int) -> None:
        self._rng = random.Random(seed)

    def choose(self, env: WalkEnvironment, state: WalkState, actions: Sequence[Action]) -> Action:
        return self._rng.choice(list(actions))


class KeywordPolicy(Policy):
    """Walks toward whichever concept shares the most words with the query.

    Included because #98 asks for it and because the cases are built to mislead
    it: `benchmark_cases` makes distractors reuse the query's wording and targets
    paraphrase it, so a lexical walker is actively steered wrong. A keyword
    baseline that looked merely uninformative would not be a baseline.
    """

    name = "keyword"

    def choose(self, env: WalkEnvironment, state: WalkState, actions: Sequence[Action]) -> Action:
        query_words = _words(env.case.query)
        best, best_score = actions[-1], -1.0
        for action in actions:
            if action.is_stop:
                continue
            overlap = len(query_words & _words(action.target))
            if overlap > best_score:
                best, best_score = action, float(overlap)
        # Nothing shares a word: stop rather than pick arbitrarily, so the
        # lexical method's failure reads as "found nothing" rather than as a
        # random walk wearing a lexical name.
        return best if best_score > 0 else actions[-1]


class UndirectedBfsPolicy(Policy):
    """Nearest unvisited concept, ignoring relation type and direction.

    The `analytics/graph_index.traverse_graph` behaviour as a policy: it is the
    comparison that isolates what typing and direction are worth, because it has
    exactly the same reach and none of the semantics.
    """

    name = "undirected_bfs"

    def choose(self, env: WalkEnvironment, state: WalkState, actions: Sequence[Action]) -> Action:
        unvisited = [a for a in actions if not a.is_stop and a.target not in state.visited]
        if not unvisited:
            return actions[-1]
        # Alphabetical among equals: BFS has no preference between siblings, and
        # a stable tie-break keeps the baseline deterministic.
        return min(unvisited, key=lambda action: action.target)


class RelationAwarePolicy(Policy):
    """The #96 fixed rule, as a policy.

    Prefers edges the rule table rates as stronger claims (`strength_rank`, 0 is
    strongest) and less lossy (`step_damping`), and prefers an unvisited target.
    This is the baseline that matters: #98's integration gate is "the policy
    beats deterministic baselines without losing attribution", and this is the
    deterministic baseline the product ships.

    Direction is not re-checked here. `build_relation_graph` has already applied
    it — a `FORWARD` relation appears only source→target and a `SYMMETRIC` one is
    expanded both ways — so every action reaching this method is one the rule
    table already permits, and re-deriving it would be a second opinion about
    something #96 has settled.
    """

    name = "relation_aware"

    def choose(self, env: WalkEnvironment, state: WalkState, actions: Sequence[Action]) -> Action:
        scored: List[Tuple[Tuple[int, float, str], Action]] = []
        for action in actions:
            if action.is_stop or not is_known(action.relation):
                continue
            rule = rule_for(action.relation)
            revisit_rank = 1 if action.target in state.visited else 0
            scored.append((
                (revisit_rank, rule.strength_rank - rule.step_damping, action.target),
                action,
            ))
        if not scored:
            return actions[-1]
        return min(scored, key=lambda item: item[0])[1]


# ---- the learned family ----------------------------------------------------


#: The feature names a linear policy scores an action with, in a fixed order.
#: Named and ordered here so a fitted weight vector is interpretable and a
#: reordering fails a test rather than silently permuting a trained policy.
FEATURE_NAMES: Tuple[str, ...] = (
    "relation_strength",
    "step_damping",
    "is_revisit",
    "target_word_overlap",
    "is_stop",
    "hops_taken",
)


def features(env: WalkEnvironment, state: WalkState, action: Action) -> Tuple[float, ...]:
    """The action's feature vector. Deliberately small and legible.

    No feature reads the target evidence ids. A feature that did would let the
    policy see the answer key at inference and would make every reported number
    meaningless — the same reason `benchmark_retrieval` refuses to score a graph
    condition on wording.
    """
    if action.is_stop:
        return (0.0, 0.0, 0.0, 0.0, 1.0, float(state.hops))

    known = is_known(action.relation)
    rule = rule_for(action.relation) if known else None
    return (
        float(-(rule.strength_rank) if rule else -9.0),
        float(rule.step_damping if rule else 0.0),
        1.0 if action.target in state.visited else 0.0,
        float(len(_words(env.case.query) & _words(action.target))),
        0.0,
        float(state.hops),
    )


@dataclass
class LinearPolicy(Policy):
    """Scores each action with `weights · features(action)` and takes the best.

    The default weights are **not fitted**. They are zeros with a small negative
    term on revisiting, which makes the untrained policy a deterministic
    tie-break rather than anything meaningful — an untrained policy that happened
    to score well would be the most misleading thing this module could ship.
    `train.py` produces fitted weights, and `is_fitted` says which you have.
    """

    weights: Tuple[float, ...] = (0.0, 0.0, -1.0, 0.0, 0.0, 0.0)
    is_fitted: bool = False
    fitted_on: str = "not fitted"
    name: str = "linear_learned"

    def __post_init__(self) -> None:
        if len(self.weights) != len(FEATURE_NAMES):
            raise ValueError(
                f"expected {len(FEATURE_NAMES)} weights for {FEATURE_NAMES}, got {len(self.weights)}"
            )

    def score(self, env: WalkEnvironment, state: WalkState, action: Action) -> float:
        return sum(weight * value for weight, value in zip(self.weights, features(env, state, action)))

    def choose(self, env: WalkEnvironment, state: WalkState, actions: Sequence[Action]) -> Action:
        # Tie-broken by (relation, target) so an unfitted or degenerate weight
        # vector is still deterministic.
        return max(
            actions,
            key=lambda action: (self.score(env, state, action), action.relation, action.target),
        )

    def as_dict(self) -> Dict[str, Any]:
        return {
            **super().as_dict(),
            "weights": dict(zip(FEATURE_NAMES, self.weights)),
            "is_fitted": self.is_fitted,
            "fitted_on": self.fitted_on,
        }


# ---- running an episode ----------------------------------------------------


def run_episode(
    env: WalkEnvironment,
    policy: Policy,
    anchor: str,
    seed: int = 0,
    max_steps: Optional[int] = None,
) -> EpisodeResult:
    """One walk from one anchor. Deterministic given the policy and the seed.

    `max_steps` bounds the loop independently of `max_hops`, because an invalid
    action does not advance the hop count and a policy that emitted only invalid
    actions would otherwise never terminate. It defaults to twice the hop limit,
    which is enough slack to see the invalid-action rate without hanging.
    """
    policy.reset(seed)
    state = env.initial_state(anchor)
    steps: List[StepRecord] = []
    total = 0.0
    invalid = 0
    budget = max_steps if max_steps is not None else env.max_hops * 2
    terminal = env.is_terminal(state)

    while terminal is None and len(steps) < budget:
        actions = env.actions(state)
        action = policy.choose(env, state, actions)
        state, reward, terminal, record = env.step(state, action)
        steps.append(record)
        total += reward
        if record.was_invalid:
            invalid += 1

    if terminal is None:
        terminal = TerminalReason.HOP_LIMIT

    visited = (anchor,) + tuple(step.to_concept for step in steps if not step.was_invalid)
    return EpisodeResult(
        case_id=env.case.case_id,
        anchor=anchor,
        steps=tuple(steps),
        terminal_reason=terminal,
        total_reward=total,
        reached_evidence_ids=env.target_evidence_reached(visited),
        invalid_actions=invalid,
    )


def baseline_policies(seed: int = 20260813) -> List[Policy]:
    """The comparison set #98 names, in reporting order (weakest first)."""
    return [RandomPolicy(seed), KeywordPolicy(), UndirectedBfsPolicy(), RelationAwarePolicy()]
