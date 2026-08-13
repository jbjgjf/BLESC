"""Graph-walk policy learning (#98) — Stage 1 of the roadmap in #102.

An explicit MDP over the benchmark's concept graph, the four comparison policies
#98 names, an evaluation harness that reports by family and language, and the
data gate that currently refuses to fit anything.

**Nothing is trained on this dataset.** Every case carries `labelled_by="author"`;
#98 requires reward to come from human-labelled evidence, so `training_gate()`
is shut until #88 lands. The environment, the baselines and the harness are built
and tested now so that the day labels arrive is a data event rather than a
project.

    from app.policy import WalkEnvironment, baseline_policies, evaluate, training_gate

    training_gate().open          # False, with reasons
    evaluate("test").as_dict()    # baselines over the held-out split
"""

from .evaluate import (
    DEFAULT_SEEDS,
    EVALUATION_VERSION,
    NDCG_K,
    CaseResult,
    EvaluationReport,
    PolicySummary,
    evaluate,
    evaluate_all_splits,
    evaluate_case,
    summarise,
)
from .mdp import (
    DEFAULT_MAX_HOPS,
    DEFAULT_REWARD,
    FORBIDDEN_REWARD_SIGNALS,
    POLICY_ENV_VERSION,
    STOP,
    Action,
    ActionKind,
    EpisodeResult,
    RewardSpec,
    StepRecord,
    TerminalReason,
    WalkEnvironment,
    WalkState,
    environment_contract,
)
from .policies import (
    FEATURE_NAMES,
    POLICY_FAMILIES,
    POLICY_VERSION,
    KeywordPolicy,
    LinearPolicy,
    Policy,
    RandomPolicy,
    RelationAwarePolicy,
    UndirectedBfsPolicy,
    baseline_policies,
    features,
    run_episode,
)
from .train import (
    MIN_HUMAN_LABELLED_CASES,
    MIN_INDEPENDENT_GROUPS,
    TRAINING_VERSION,
    GateStatus,
    TrainingBlocked,
    TrainingRun,
    fit_linear_policy,
    integration_gate,
    mean_return,
    training_gate,
)

__all__ = [
    "Action",
    "ActionKind",
    "CaseResult",
    "DEFAULT_MAX_HOPS",
    "DEFAULT_REWARD",
    "DEFAULT_SEEDS",
    "EVALUATION_VERSION",
    "EpisodeResult",
    "EvaluationReport",
    "FEATURE_NAMES",
    "FORBIDDEN_REWARD_SIGNALS",
    "GateStatus",
    "KeywordPolicy",
    "LinearPolicy",
    "MIN_HUMAN_LABELLED_CASES",
    "MIN_INDEPENDENT_GROUPS",
    "NDCG_K",
    "POLICY_ENV_VERSION",
    "POLICY_FAMILIES",
    "POLICY_VERSION",
    "Policy",
    "PolicySummary",
    "RandomPolicy",
    "RelationAwarePolicy",
    "RewardSpec",
    "STOP",
    "StepRecord",
    "TRAINING_VERSION",
    "TerminalReason",
    "TrainingBlocked",
    "TrainingRun",
    "UndirectedBfsPolicy",
    "WalkEnvironment",
    "WalkState",
    "baseline_policies",
    "environment_contract",
    "evaluate",
    "evaluate_all_splits",
    "evaluate_case",
    "features",
    "fit_linear_policy",
    "integration_gate",
    "mean_return",
    "run_episode",
    "summarise",
    "training_gate",
]
