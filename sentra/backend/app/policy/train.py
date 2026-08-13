"""Fitting a walk policy, and the gate that currently refuses to (#98).

The gate is the point of this module. #98 requires reward to come from
**human-labelled** evidence, and every case in `benchmark_cases.BENCHMARK_CASES`
currently carries `labelled_by="author"` — the labels were written by whoever
wrote the question. Training on those would produce a policy fitted to one
author's idea of the answer and a number that looks like a result, which is worse
than no number.

So `training_gate()` reports blocked, `fit_linear_policy` raises `TrainingBlocked`
rather than returning an unfitted policy that could be mistaken for a fitted one,
and the fitting code below is written and tested against synthetic cases so that
it works the day #88 lands rather than being started then.

**What opens the gate**, all of them:

1. at least `MIN_HUMAN_LABELLED_CASES` cases with `labelled_by == "human"`;
2. a non-empty train split AND a non-empty held-out test split, from
   `assign_splits`, which groups paraphrases, translated pairs and shared chains
   before assigning;
3. at least `MIN_INDEPENDENT_GROUPS` independent leakage groups, because the
   effective sample size for a held-out claim is the group count and three
   groups cannot fill three splits and still leave anything to learn from;
4. inter-rater agreement recorded on the labels (#88 asks for it, and a
   benchmark whose own labels are unreliable cannot supply a reward signal).

**The fitting method.** A seeded random search over the weight vector, keeping
the best mean training return. Deliberately not a gradient method: the action
space is a handful of typed edges, the episode is at most four steps, and the
whole dataset is a few dozen cases — a policy-gradient implementation here would
be more machinery than the data can justify and would invite the reading that
this is a deep RL result. It is a search over six weights. `TrainingRun` records
the method, the seed, the environment version and the data version, so what was
actually done is on the record rather than inferable from the class name.
"""

from __future__ import annotations

import random
from dataclasses import dataclass
from statistics import fmean
from typing import Any, Dict, List, Optional, Sequence, Tuple

from ..services.benchmark_cases import BENCHMARK_CASES, BenchmarkCase
from ..services.benchmark_labelling import DATASET_METADATA, assign_splits, labelling_status
from .mdp import DEFAULT_MAX_HOPS, DEFAULT_REWARD, POLICY_ENV_VERSION, RewardSpec, WalkEnvironment
from .policies import FEATURE_NAMES, LinearPolicy, run_episode

TRAINING_VERSION = "graph-walk-training-v1"

#: #88 targets 60-100 cases. 40 is the floor at which a train/validation/test
#: split leaves enough in each to mean anything; below it the gate stays shut.
MIN_HUMAN_LABELLED_CASES = 40

#: Independent leakage groups, not cases. Paraphrase pairs and translated pairs
#: are one group, so this is the number that bounds a held-out claim.
MIN_INDEPENDENT_GROUPS = 12

DEFAULT_TRAINING_SEED = 20260813
DEFAULT_SEARCH_STEPS = 400


class TrainingBlocked(Exception):
    """The data gate is shut.

    Raised rather than returning an unfitted policy: a caller that got a
    `LinearPolicy` back would have something that walks, and the fact that its
    weights mean nothing would live only in a flag somebody has to check.
    """


@dataclass(frozen=True)
class GateStatus:
    open: bool
    human_labelled_cases: int
    independent_groups: int
    train_cases: int
    test_cases: int
    inter_rater_agreement: Optional[float]
    blocking_reasons: Tuple[str, ...]

    def as_dict(self) -> Dict[str, Any]:
        return {
            "open": self.open,
            "human_labelled_cases": self.human_labelled_cases,
            "required_human_labelled_cases": MIN_HUMAN_LABELLED_CASES,
            "independent_groups": self.independent_groups,
            "required_independent_groups": MIN_INDEPENDENT_GROUPS,
            "train_cases": self.train_cases,
            "test_cases": self.test_cases,
            "inter_rater_agreement": self.inter_rater_agreement,
            "blocking_reasons": list(self.blocking_reasons),
            "opens_when": "#88 lands 60-100 human-labelled cases with agreement reported",
        }


def training_gate(cases: Sequence[BenchmarkCase] = BENCHMARK_CASES) -> GateStatus:
    """Whether a policy may be fitted at all. Fails closed."""
    status = labelling_status()
    assignment = assign_splits(cases)
    human = len([case for case in cases if case.labelled_by == "human"])
    groups = len(assignment.groups)
    train = len(assignment.cases_in("train"))
    test = len(assignment.cases_in("test"))
    agreement = status.get("inter_rater_agreement")

    reasons: List[str] = []
    if human < MIN_HUMAN_LABELLED_CASES:
        reasons.append(
            f"{human} human-labelled case(s); {MIN_HUMAN_LABELLED_CASES} required. "
            "Reward must come from human-labelled evidence (#98), and an author-written "
            "answer key would fit the policy to whoever wrote the question."
        )
    if groups < MIN_INDEPENDENT_GROUPS:
        reasons.append(
            f"{groups} independent leakage group(s); {MIN_INDEPENDENT_GROUPS} required. "
            "The effective sample size for a held-out claim is the group count, not the "
            "case count."
        )
    if not train:
        reasons.append("the train split is empty; there is nothing to fit on")
    if not test:
        reasons.append("the test split is empty; a fitted policy could not be held out from anything")
    if agreement is None:
        reasons.append(
            "no inter-rater agreement is recorded for the labels (#88). A reward signal "
            "whose own reliability is unmeasured cannot support a claim about a policy."
        )

    return GateStatus(
        open=not reasons,
        human_labelled_cases=human,
        independent_groups=groups,
        train_cases=train,
        test_cases=test,
        inter_rater_agreement=agreement,
        blocking_reasons=tuple(reasons),
    )


@dataclass(frozen=True)
class TrainingRun:
    """What was actually done, so a fitted policy can be reproduced or retracted."""

    policy: LinearPolicy
    method: str
    seed: int
    search_steps: int
    train_case_ids: Tuple[str, ...]
    best_mean_return: float
    environment_version: str
    dataset_version: str
    reward: RewardSpec

    def as_dict(self) -> Dict[str, Any]:
        return {
            "training_version": TRAINING_VERSION,
            "method": self.method,
            "seed": self.seed,
            "search_steps": self.search_steps,
            "train_case_ids": list(self.train_case_ids),
            "best_mean_return": round(self.best_mean_return, 6),
            "environment_version": self.environment_version,
            "dataset_version": self.dataset_version,
            "reward": self.reward.as_dict(),
            "policy": self.policy.as_dict(),
            "interpretation": (
                "A seeded random search over six weights on a four-step episode. Not a deep "
                "RL result and not evidence about product behaviour; #98 keeps product "
                "integration out of scope until this beats the deterministic baselines "
                "without losing attribution."
            ),
        }


def mean_return(
    policy: LinearPolicy,
    cases: Sequence[BenchmarkCase],
    reward: RewardSpec = DEFAULT_REWARD,
    max_hops: int = DEFAULT_MAX_HOPS,
) -> float:
    """Average episode return over every anchor of every case. Deterministic."""
    returns: List[float] = []
    for case in cases:
        env = WalkEnvironment(case, reward=reward, max_hops=max_hops)
        for anchor in env.anchors:
            returns.append(run_episode(env, policy, anchor, seed=0).total_reward)
    return fmean(returns) if returns else 0.0


def fit_linear_policy(
    cases: Sequence[BenchmarkCase] = BENCHMARK_CASES,
    seed: int = DEFAULT_TRAINING_SEED,
    search_steps: int = DEFAULT_SEARCH_STEPS,
    reward: RewardSpec = DEFAULT_REWARD,
    enforce_gate: bool = True,
) -> TrainingRun:
    """Fit the weight vector by seeded random search over the train split.

    `enforce_gate=False` exists so the search itself can be tested against
    synthetic cases without waiting for #88. It is not a way to train on the real
    dataset early: a run made with the gate disabled records
    `method="random_search (gate bypassed)"`, so a result produced that way says
    so in its own metadata rather than needing someone to remember.
    """
    gate = training_gate(cases)
    if enforce_gate and not gate.open:
        raise TrainingBlocked(
            "the training data gate is shut:\n  - " + "\n  - ".join(gate.blocking_reasons)
        )

    assignment = assign_splits(cases)
    train_ids = set(assignment.cases_in("train"))
    train_cases = [case for case in cases if case.case_id in train_ids]
    if not train_cases:
        raise TrainingBlocked("the train split is empty; there is nothing to fit on")

    rng = random.Random(seed)
    best_weights: Tuple[float, ...] = (0.0,) * len(FEATURE_NAMES)
    best_score = mean_return(LinearPolicy(weights=best_weights), train_cases, reward)

    for _ in range(search_steps):
        candidate = tuple(rng.uniform(-1.0, 1.0) for _ in FEATURE_NAMES)
        score = mean_return(LinearPolicy(weights=candidate), train_cases, reward)
        if score > best_score:
            best_weights, best_score = candidate, score

    fitted = LinearPolicy(
        weights=best_weights,
        is_fitted=True,
        fitted_on=f"train split of {DATASET_METADATA.get('version', 'unversioned')}",
    )
    return TrainingRun(
        policy=fitted,
        method="random_search" if enforce_gate else "random_search (gate bypassed)",
        seed=seed,
        search_steps=search_steps,
        train_case_ids=tuple(sorted(case.case_id for case in train_cases)),
        best_mean_return=best_score,
        environment_version=POLICY_ENV_VERSION,
        dataset_version=str(DATASET_METADATA.get("version", "unversioned")),
        reward=reward,
    )


def integration_gate(report: Any) -> Dict[str, Any]:
    """Whether a fitted policy may be considered for product use. It may not.

    #98's last criterion: product integration is out of scope until the policy
    beats the deterministic baselines **without losing attribution**. Both halves
    are checked — a policy that scored higher while producing paths with no
    evidence trace has not met the bar, and the second half is the one that would
    otherwise be forgotten.
    """
    reasons: List[str] = []
    beats_relation_aware = None

    summaries = {summary.policy: summary for summary in getattr(report, "summaries", ())}
    learned = summaries.get("linear_learned")
    deterministic = summaries.get("relation_aware")

    if learned is None or deterministic is None:
        reasons.append("both the learned policy and the deterministic baseline must be evaluated on the same split")
    else:
        beats_relation_aware = learned.ndcg_at_5 > deterministic.ndcg_at_5
        if not beats_relation_aware:
            reasons.append(
                f"nDCG@5 {learned.ndcg_at_5:.4f} does not beat the deterministic relation-aware "
                f"baseline at {deterministic.ndcg_at_5:.4f}"
            )
        if learned.invalid_action_rate > 0:
            reasons.append(
                f"invalid-action rate is {learned.invalid_action_rate:.4f}; a policy proposing "
                "illegal traversals is not ready to be attributed to"
            )

    gate = training_gate()
    if not gate.open:
        reasons.append("the training data gate is shut, so no policy on this dataset is eligible")

    return {
        "eligible_for_product_integration": False,
        "reasons_blocking": reasons or ["no blocking reason was found, but integration remains out of scope for #98"],
        "beats_deterministic_baseline": beats_relation_aware,
        "requirement": (
            "beats the deterministic baselines AND retains a complete attribution trace. "
            "#98 keeps integration out of scope regardless; this function exists so the "
            "condition is checkable rather than remembered."
        ),
    }
