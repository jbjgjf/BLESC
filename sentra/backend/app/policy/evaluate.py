"""Evaluating policies over the graph-walk MDP (#98).

Reports what #98 asks for — success rate, nDCG@5, path length, invalid-action
rate, seed variance — and reports it **by case family and by language** rather
than only in aggregate, because the dataset is small enough that an aggregate
number is dominated by whichever family happens to have the most cases.

Three things this refuses to do:

**No number without its chance level.** Every policy is reported next to
`RandomPolicy` on the same cases. A policy at chance is not a weak result, it is
no result, and the old retrieval harness could not tell those apart (#86).

**No aggregate without its group count.** The effective sample size for a
held-out claim is the number of independent leakage groups, not the number of
cases. `assign_splits` computes the groups; `EvaluationReport.warnings` carries
the shortfall into every result.

**No held-out number from a training split.** `evaluate` takes an explicit split
and refuses to silently evaluate on everything, so a number reported as held-out
had to be asked for as held-out.

nDCG@5 is computed over the order in which a walk *reached* target evidence, so
it is comparable with the retrieval conditions in `benchmark_retrieval`, which
score a ranking. A walk that reaches the right day first scores above one that
reaches it fourth, which is the property the metric is for.
"""

from __future__ import annotations

from dataclasses import dataclass
from statistics import fmean, pstdev
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from ..services.benchmark_cases import BENCHMARK_CASES, BenchmarkCase
from ..services.benchmark_labelling import assign_splits, labelling_status
from ..services.benchmark_retrieval import ndcg_at_k
from .mdp import DEFAULT_MAX_HOPS, DEFAULT_REWARD, POLICY_ENV_VERSION, RewardSpec, WalkEnvironment
from .policies import POLICY_FAMILIES, Policy, baseline_policies, run_episode

EVALUATION_VERSION = "graph-walk-evaluation-v1"

#: Seeds every policy is run under. Stochastic policies vary across them and the
#: spread is reported; deterministic ones must not, and a non-zero seed variance
#: on a deterministic policy is a defect the report will show.
DEFAULT_SEEDS: Tuple[int, ...] = (20260813, 20260814, 20260815, 20260816, 20260817)

NDCG_K = 5


@dataclass(frozen=True)
class CaseResult:
    """One policy on one case, over every anchor and every seed."""

    case_id: str
    family: str
    lang: str
    policy: str
    success_rate: float
    ndcg_at_5: float
    mean_path_length: float
    invalid_action_rate: float
    mean_reward: float
    seed_ndcg_values: Tuple[float, ...]
    episodes: int

    @property
    def seed_variance(self) -> float:
        """Population standard deviation of nDCG across seeds. 0 for a
        deterministic policy, and a non-zero value on one is a bug, not noise."""
        return round(pstdev(self.seed_ndcg_values), 6) if len(self.seed_ndcg_values) > 1 else 0.0

    def as_dict(self) -> Dict[str, Any]:
        return {
            "case_id": self.case_id,
            "family": self.family,
            "lang": self.lang,
            "policy": self.policy,
            "success_rate": round(self.success_rate, 4),
            "ndcg_at_5": round(self.ndcg_at_5, 4),
            "mean_path_length": round(self.mean_path_length, 4),
            "invalid_action_rate": round(self.invalid_action_rate, 4),
            "mean_reward": round(self.mean_reward, 4),
            "seed_variance_ndcg": self.seed_variance,
            "episodes": self.episodes,
        }


@dataclass(frozen=True)
class PolicySummary:
    policy: str
    family: str
    cases: int
    success_rate: float
    ndcg_at_5: float
    mean_path_length: float
    invalid_action_rate: float
    max_seed_variance: float
    by_family: Mapping[str, float]
    by_lang: Mapping[str, float]

    def as_dict(self) -> Dict[str, Any]:
        return {
            "policy": self.policy,
            "policy_family": self.family,
            "cases": self.cases,
            "success_rate": round(self.success_rate, 4),
            "ndcg_at_5": round(self.ndcg_at_5, 4),
            "mean_path_length": round(self.mean_path_length, 4),
            "invalid_action_rate": round(self.invalid_action_rate, 4),
            "max_seed_variance_ndcg": round(self.max_seed_variance, 6),
            "ndcg_by_case_family": {key: round(value, 4) for key, value in sorted(self.by_family.items())},
            "ndcg_by_lang": {key: round(value, 4) for key, value in sorted(self.by_lang.items())},
        }


@dataclass(frozen=True)
class EvaluationReport:
    split: str
    case_ids: Tuple[str, ...]
    summaries: Tuple[PolicySummary, ...]
    case_results: Tuple[CaseResult, ...]
    seeds: Tuple[int, ...]
    reward: RewardSpec
    warnings: Tuple[str, ...]

    @property
    def chance(self) -> Optional[PolicySummary]:
        return next((summary for summary in self.summaries if summary.policy == "random"), None)

    @property
    def discriminates(self) -> bool:
        """Whether this split separates any policy from the random walk at all.

        A split where every policy including chance scores the same is not a
        split where every policy is equally good — it is a split that measures
        nothing, and reading a 1.0 off it as a result is exactly the saturation
        #86 removed from the retrieval harness. Reported rather than left for a
        reader to notice from a table of identical numbers.
        """
        scores = {round(summary.ndcg_at_5, 6) for summary in self.summaries}
        return len(scores) > 1

    def beats_chance(self, policy: str) -> Optional[bool]:
        """Whether `policy` scored above the random walk on this split.

        `None` when there is no chance summary to compare against — an absent
        comparison is not a pass.
        """
        chance = self.chance
        target = next((summary for summary in self.summaries if summary.policy == policy), None)
        if chance is None or target is None:
            return None
        return target.ndcg_at_5 > chance.ndcg_at_5

    def as_dict(self) -> Dict[str, Any]:
        return {
            "evaluation_version": EVALUATION_VERSION,
            "environment_version": POLICY_ENV_VERSION,
            "split": self.split,
            "case_ids": list(self.case_ids),
            "seeds": list(self.seeds),
            "ndcg_k": NDCG_K,
            "reward": self.reward.as_dict(),
            "discriminates": self.discriminates,
            "summaries": [summary.as_dict() for summary in self.summaries],
            "case_results": [result.as_dict() for result in self.case_results],
            "warnings": list(self.warnings),
            "interpretation": (
                "Success rate and nDCG@5 over walks through the MDP in `policy/mdp.py`. "
                "Every policy is reported next to the random walk on the same cases; a "
                "policy at chance is no result. The effective sample size for any "
                "held-out claim is the independent group count in `warnings`, not the "
                "case count."
            ),
        }


def evaluate_case(
    case: BenchmarkCase,
    policy: Policy,
    seeds: Sequence[int] = DEFAULT_SEEDS,
    reward: RewardSpec = DEFAULT_REWARD,
    max_hops: int = DEFAULT_MAX_HOPS,
) -> CaseResult:
    """One policy on one case: every anchor crossed with every seed."""
    env = WalkEnvironment(case, reward=reward, max_hops=max_hops)
    anchors = env.anchors

    successes: List[float] = []
    ndcgs: List[float] = []
    lengths: List[float] = []
    invalid: List[float] = []
    rewards: List[float] = []
    per_seed_ndcg: List[float] = []

    expected = set(case.expected_evidence_ids)

    for seed in seeds:
        seed_ndcgs: List[float] = []
        for anchor in anchors:
            episode = run_episode(env, policy, anchor, seed=seed)
            value = ndcg_at_k(episode.reached_evidence_ids, expected, NDCG_K)
            successes.append(1.0 if episode.found_evidence else 0.0)
            ndcgs.append(value)
            seed_ndcgs.append(value)
            lengths.append(float(episode.path_length))
            total_actions = max(1, len(episode.steps))
            invalid.append(episode.invalid_actions / total_actions)
            rewards.append(episode.total_reward)
        per_seed_ndcg.append(fmean(seed_ndcgs) if seed_ndcgs else 0.0)

    return CaseResult(
        case_id=case.case_id,
        family=case.family,
        lang=case.lang,
        policy=policy.name,
        success_rate=fmean(successes) if successes else 0.0,
        ndcg_at_5=fmean(ndcgs) if ndcgs else 0.0,
        mean_path_length=fmean(lengths) if lengths else 0.0,
        invalid_action_rate=fmean(invalid) if invalid else 0.0,
        mean_reward=fmean(rewards) if rewards else 0.0,
        seed_ndcg_values=tuple(per_seed_ndcg),
        episodes=len(ndcgs),
    )


def _mean_by(results: Sequence[CaseResult], key: str) -> Dict[str, float]:
    buckets: Dict[str, List[float]] = {}
    for result in results:
        buckets.setdefault(getattr(result, key), []).append(result.ndcg_at_5)
    return {name: fmean(values) for name, values in buckets.items()}


def summarise(results: Sequence[CaseResult]) -> PolicySummary:
    name = results[0].policy
    return PolicySummary(
        policy=name,
        family=POLICY_FAMILIES.get(name, "unknown"),
        cases=len(results),
        success_rate=fmean(result.success_rate for result in results),
        ndcg_at_5=fmean(result.ndcg_at_5 for result in results),
        mean_path_length=fmean(result.mean_path_length for result in results),
        invalid_action_rate=fmean(result.invalid_action_rate for result in results),
        max_seed_variance=max(result.seed_variance for result in results),
        by_family=_mean_by(results, "family"),
        by_lang=_mean_by(results, "lang"),
    )


def evaluate(
    split: str = "test",
    policies: Optional[Sequence[Policy]] = None,
    cases: Sequence[BenchmarkCase] = BENCHMARK_CASES,
    seeds: Sequence[int] = DEFAULT_SEEDS,
    reward: RewardSpec = DEFAULT_REWARD,
) -> EvaluationReport:
    """Run every policy over one split.

    `split` is required and has no "everything" value on purpose. A number
    reported as held-out has to have been asked for as held-out, and the split
    assignment comes from `benchmark_labelling.assign_splits`, which groups by
    paraphrase, translated pair and shared chain before assigning.
    """
    assignment = assign_splits(cases)
    selected = [case for case in cases if assignment.assignment.get(case.case_id) == split]
    policies = list(policies) if policies is not None else baseline_policies(seeds[0])

    warnings: List[str] = list(assignment.warnings)
    status = labelling_status()
    if status["human_labelled_count"] == 0:
        warnings.append(
            "no case in this dataset carries a human label; every `expected_evidence_ids` "
            "was written by the case author. #98 requires reward to come from human-labelled "
            "evidence, so these numbers describe the environment and the baselines, not a "
            "trained policy. See #88."
        )
    if not selected:
        warnings.append(
            f"split {split!r} contains no cases; nothing was evaluated. "
            f"{len(assignment.groups)} independent group(s) exist across {len(cases)} case(s)."
        )

    case_results: List[CaseResult] = []
    summaries: List[PolicySummary] = []
    for policy in policies:
        results = [evaluate_case(case, policy, seeds, reward) for case in selected]
        case_results.extend(results)
        if results:
            summaries.append(summarise(results))

    report = EvaluationReport(
        split=split,
        case_ids=tuple(case.case_id for case in selected),
        summaries=tuple(summaries),
        case_results=tuple(case_results),
        seeds=tuple(seeds),
        reward=reward,
        warnings=tuple(warnings),
    )
    if summaries and not report.discriminates:
        ceiling = summaries[0].ndcg_at_5
        warnings.append(
            f"split {split!r} does not discriminate: every policy, including the random "
            f"walk, scores nDCG@5 {ceiling:.4f}. On these cases the answer sits one hop "
            "from the anchor, so the walk is solved before the policy matters. A number "
            "read off this split says nothing about any method."
        )
        report = EvaluationReport(
            split=report.split,
            case_ids=report.case_ids,
            summaries=report.summaries,
            case_results=report.case_results,
            seeds=report.seeds,
            reward=report.reward,
            warnings=tuple(warnings),
        )
    return report


def evaluate_all_splits(
    policies: Optional[Sequence[Policy]] = None,
    cases: Sequence[BenchmarkCase] = BENCHMARK_CASES,
    seeds: Sequence[int] = DEFAULT_SEEDS,
) -> Dict[str, Any]:
    """Every split, reported separately. Never pooled.

    Pooling train and test into one number is the thing held-out evaluation
    exists to prevent, so this returns a mapping rather than a combined report.
    """
    return {
        "evaluation_version": EVALUATION_VERSION,
        "labelling_status": labelling_status(),
        "splits": {
            split: evaluate(split, policies, cases, seeds).as_dict()
            for split in ("train", "validation", "test")
        },
    }
