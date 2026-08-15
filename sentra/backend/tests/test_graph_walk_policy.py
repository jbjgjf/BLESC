"""The graph-walk MDP, its policies, and the data gate (#98).

Written against the acceptance criteria. The load-bearing tests are the ones
about what may NOT happen: that a clinical or safety field cannot become reward,
that the training gate is shut on this dataset, and that a split which fails to
separate any policy from chance says so instead of reporting a ceiling.

#102 is explicit that existing storage, BFS and fixed ranking are not
reinforcement learning. `test_the_decision_process_is_stated_in_full` is what
makes the difference checkable rather than asserted.
"""

from __future__ import annotations

import dataclasses
import json
from pathlib import Path

import pytest

from app.policy import (
    DEFAULT_MAX_HOPS,
    DEFAULT_REWARD,
    DEFAULT_SEEDS,
    FEATURE_NAMES,
    FORBIDDEN_REWARD_SIGNALS,
    POLICY_ENV_VERSION,
    STOP,
    Action,
    ActionKind,
    KeywordPolicy,
    LinearPolicy,
    RandomPolicy,
    RelationAwarePolicy,
    RewardSpec,
    TerminalReason,
    TrainingBlocked,
    UndirectedBfsPolicy,
    WalkEnvironment,
    baseline_policies,
    environment_contract,
    evaluate,
    evaluate_all_splits,
    evaluate_case,
    features,
    fit_linear_policy,
    integration_gate,
    mean_return,
    run_episode,
    training_gate,
)
from app.services.benchmark_cases import BENCHMARK_CASES, BenchmarkCase, EvidenceDay

BACKEND = Path(__file__).resolve().parents[1]


def case_by_id(case_id: str) -> BenchmarkCase:
    return next(case for case in BENCHMARK_CASES if case.case_id == case_id)


CHAIN = case_by_id("sleep_chain_en")


def synthetic_case(case_id: str = "synthetic", labelled_by: str = "human") -> BenchmarkCase:
    """A two-hop chain, a leaf branch, and a symmetric edge to walk back along.

    Built here rather than drawn from the real set, so environment behaviour is
    asserted against a shape under test control. Every concept and every text is
    namespaced by `case_id`, because `benchmark_labelling._linked` groups cases
    that share a target text or a target motif triple — identical synthetic
    cases would collapse into one leakage group and land in one split.

        start --causes--> middle <--co_occurs--> answer     (answer is the target)
        start --causes--> decoy                             (a leaf: NO_ACTIONS)
    """
    tag = case_id
    return BenchmarkCase(
        case_id=case_id,
        query=f"it keeps happening {tag}",
        query_anchors=(f"start {tag}",),
        evidence=(
            EvidenceDay(
                "d1",
                "2026-05-01",
                f"one {tag}",
                (f"Trigger:start {tag} -> causes -> State:middle {tag}",),
            ),
            EvidenceDay(
                "d2",
                "2026-05-02",
                f"two {tag}",
                (f"State:middle {tag} -> co_occurs -> State:answer {tag}",),
            ),
            EvidenceDay(
                "d3",
                "2026-05-03",
                f"three {tag}",
                (f"Trigger:start {tag} -> causes -> State:decoy {tag}",),
            ),
        ),
        expected_evidence_ids=("d2",),
        expected_safety="normal",
        expected_policy="surface the chain",
        research_note="synthetic",
        family="two_hop_chain",
        lang="en",
        required_hops=2,
        labelled_by=labelled_by,
    )


def concept(name: str, case_id: str = "synthetic") -> str:
    """A concept as `parse_motifs` lowercases it."""
    return f"{name} {case_id}".lower()


# ---- AC: the MDP is stated explicitly --------------------------------------


def test_the_decision_process_is_stated_in_full():
    """#102 insists existing traversal is not RL. This is the difference."""
    contract = environment_contract()
    for key in ("state", "actions", "transition", "episode_limit", "terminal_conditions", "reward"):
        assert contract[key], key
    assert contract["environment_version"] == POLICY_ENV_VERSION
    assert set(contract["terminal_conditions"]) == {"stopped", "hop_limit", "no_actions"}
    assert "online learning from live users" in contract["not_implemented_here"]


def test_actions_are_typed_directed_edges_plus_exactly_one_stop():
    env = WalkEnvironment(synthetic_case())
    actions = env.actions(env.initial_state(concept("start")))

    assert actions[-1] == STOP
    assert len([a for a in actions if a.is_stop]) == 1
    traversals = [a for a in actions if not a.is_stop]
    assert {(a.relation, a.target) for a in traversals} == {
        ("causes", concept("middle")),
        ("causes", concept("decoy")),
    }


def test_two_relation_types_to_one_target_are_two_actions():
    """Relation type is part of the action, so `causes` and `buffers` to the same
    concept are two decisions rather than one."""
    case = dataclasses.replace(
        synthetic_case(),
        evidence=(
            EvidenceDay(
                "d1",
                "2026-05-01",
                "one",
                ("Trigger:start synthetic -> causes -> State:middle synthetic",
                 "Trigger:start synthetic -> buffers -> State:middle synthetic"),
            ),
        ),
    )
    env = WalkEnvironment(case)
    traversals = [a for a in env.actions(env.initial_state(concept("start"))) if not a.is_stop]
    assert sorted(a.relation for a in traversals) == ["buffers", "causes"]


def test_the_transition_is_deterministic():
    env = WalkEnvironment(synthetic_case())
    state = env.initial_state(concept("start"))
    action = Action(ActionKind.TRAVERSE, "causes", concept("middle"))

    first = env.step(state, action)
    second = env.step(state, action)
    assert first[0] == second[0] and first[1] == second[1]
    assert first[0].current == concept("middle") and first[0].hops == 1


def test_every_terminal_condition_is_reachable_and_distinguishable():
    env = WalkEnvironment(synthetic_case(), max_hops=1)

    stopped = env.step(env.initial_state(concept("start")), STOP)
    assert stopped[2] is TerminalReason.STOPPED

    hopped = env.step(env.initial_state(concept("start")), Action(ActionKind.TRAVERSE, "causes", concept("middle")))
    assert hopped[2] is TerminalReason.HOP_LIMIT

    deep = WalkEnvironment(synthetic_case(), max_hops=9)
    walked = deep.step(deep.initial_state(concept("start")), Action(ActionKind.TRAVERSE, "causes", concept("decoy")))
    assert walked[2] is TerminalReason.NO_ACTIONS, "a leaf ends the episode without the policy deciding"


def test_the_episode_limit_reaches_the_deepest_curated_chain():
    """Four hops is `academic_pressure.benchmark_chain`. A shorter limit would
    make every method fail for the same reason."""
    assert DEFAULT_MAX_HOPS == 4
    assert environment_contract()["episode_limit"] == 4
    assert "four hops" in environment_contract()["episode_limit_rationale"]


def test_an_anchor_with_no_edges_is_dropped_rather_than_walked():
    case = dataclasses.replace(synthetic_case(), query_anchors=(concept("start"), "nowhere at all"))
    assert WalkEnvironment(case).anchors == (concept("start"),)


# ---- AC: reward is human-labelled evidence and nothing else ----------------


def test_reward_is_paid_for_reaching_target_evidence_only():
    env = WalkEnvironment(synthetic_case())
    state = env.initial_state(concept("start"))

    # `middle` is on the path but only `d2` is a target, and `middle` appears in
    # both d1 and d2, so it is rewarding; `decoy` appears only in d3 and is not.
    _, decoy_reward, _, _ = env.step(state, Action(ActionKind.TRAVERSE, "causes", concept("decoy")))
    assert decoy_reward == pytest.approx(DEFAULT_REWARD.step_penalty)

    _, reward, _, record = env.step(state, Action(ActionKind.TRAVERSE, "causes", concept("middle")))
    assert reward == pytest.approx(DEFAULT_REWARD.evidence_reward + DEFAULT_REWARD.step_penalty)
    assert "reached target evidence" in record.reward_reason


def test_reward_is_paid_once_per_concept_so_a_walk_cannot_farm_a_node():
    env = WalkEnvironment(synthetic_case(), max_hops=9)
    state = env.initial_state(concept("start"))
    state, first, _, _ = env.step(state, Action(ActionKind.TRAVERSE, "causes", concept("middle")))
    back = Action(ActionKind.TRAVERSE, "co_occurs", concept("answer"))
    state, _, _, _ = env.step(state, back)

    # Re-entering `middle` is a revisit: penalised, and no second evidence reward.
    _, second, _, record = env.step(state, Action(ActionKind.TRAVERSE, "co_occurs", concept("middle")))
    assert record.was_revisit
    assert second < first
    assert second == pytest.approx(DEFAULT_REWARD.step_penalty + DEFAULT_REWARD.revisit_penalty)


def test_no_clinical_or_safety_field_may_ever_be_a_reward_signal():
    """#98's non-goal, enforced rather than promised.

    The failure mode is a plausible commit that adds a safety bonus, so the
    forbidden list is data with a stated reason per entry and is carried into
    every serialisation of the reward.
    """
    assert set(FORBIDDEN_REWARD_SIGNALS) >= {
        "expected_safety",
        "safety_label",
        "expected_policy",
        "raw_text",
        "clinical_outcome",
    }
    for name, reason in FORBIDDEN_REWARD_SIGNALS.items():
        assert reason.strip(), name

    serialised = json.dumps(DEFAULT_REWARD.as_dict())
    assert "human-labelled target evidence only" in serialised
    for name in FORBIDDEN_REWARD_SIGNALS:
        assert name in serialised


def test_the_environment_reward_set_is_built_from_expected_evidence_not_safety():
    """A case whose safety label changes must not change the reward."""
    normal = synthetic_case()
    alarming = dataclasses.replace(normal, expected_safety="crisis")
    assert WalkEnvironment(normal).rewarding_concepts == WalkEnvironment(alarming).rewarding_concepts


def test_a_reward_spec_refuses_an_inverted_incentive():
    with pytest.raises(ValueError, match="only positive term"):
        RewardSpec(evidence_reward=0.0)
    with pytest.raises(ValueError, match="cannot be positive"):
        RewardSpec(step_penalty=0.5)
    with pytest.raises(ValueError, match="cannot be positive"):
        RewardSpec(revisit_penalty=0.1)


def test_the_reward_is_pre_registered_and_travels_with_every_result():
    assert DEFAULT_REWARD.as_dict()["declared_before_results"] is True
    assert evaluate("train").as_dict()["reward"]["declared_before_results"] is True


# ---- AC: the comparison set ------------------------------------------------


def test_all_four_named_baselines_walk_the_same_environment():
    names = [policy.name for policy in baseline_policies()]
    assert names == ["random", "keyword", "undirected_bfs", "relation_aware"]

    env = WalkEnvironment(CHAIN)
    for policy in baseline_policies():
        episode = run_episode(env, policy, env.anchors[0], seed=1)
        assert episode.case_id == CHAIN.case_id
        assert episode.terminal_reason in set(TerminalReason)


def test_the_keyword_walker_is_actively_misled_rather_than_merely_uninformative():
    """The cases make distractors reuse the query's wording. A lexical walker
    that merely looked uninformative would not be a baseline."""
    report = evaluate("train")
    keyword = next(s for s in report.summaries if s.policy == "keyword")
    chance = report.chance

    assert chance is not None
    assert keyword.ndcg_at_5 < chance.ndcg_at_5, (
        "on the chain family the lexical walk should score BELOW the random walk"
    )
    assert report.beats_chance("keyword") is False


def test_the_deterministic_baselines_have_no_seed_variance():
    """A non-zero spread on a deterministic policy is a defect, not noise."""
    for policy in (KeywordPolicy(), UndirectedBfsPolicy(), RelationAwarePolicy()):
        result = evaluate_case(CHAIN, policy, seeds=DEFAULT_SEEDS)
        assert result.seed_variance == 0.0, policy.name


def test_the_random_walk_does_vary_with_the_seed():
    result = evaluate_case(CHAIN, RandomPolicy(), seeds=DEFAULT_SEEDS)
    assert result.seed_variance > 0.0


def test_a_relation_aware_walk_follows_the_rule_table_rather_than_a_copy_of_it():
    from app.traversal import rule_for

    env = WalkEnvironment(synthetic_case())
    chosen = RelationAwarePolicy().choose(env, env.initial_state(concept("start")), env.actions(env.initial_state(concept("start"))))

    assert not chosen.is_stop
    assert rule_for(chosen.relation).strength_rank <= rule_for("co_occurs").strength_rank


# ---- AC: metrics reported by family and language ---------------------------


def test_every_metric_the_issue_names_is_reported():
    report = evaluate("train").as_dict()
    summary = report["summaries"][0]

    for key in (
        "success_rate",
        "ndcg_at_5",
        "mean_path_length",
        "invalid_action_rate",
        "max_seed_variance_ndcg",
        "ndcg_by_case_family",
        "ndcg_by_lang",
    ):
        assert key in summary, key
    assert report["ndcg_k"] == 5


def test_results_are_reported_per_language():
    report = evaluate("train")
    for summary in report.summaries:
        assert set(summary.by_lang) == {"en", "ja"}, summary.policy


def test_japanese_and_english_matched_pairs_score_the_same():
    """Language must not be confounded with difficulty. The chain cases are
    matched pairs, so a per-language gap here would be a defect in the
    environment rather than a finding about language."""
    report = evaluate("train")
    for summary in report.summaries:
        assert summary.by_lang["en"] == pytest.approx(summary.by_lang["ja"]), summary.policy


def test_an_invalid_action_is_charged_and_counted_rather_than_raising():
    """A learner will emit illegal actions; the rate is a reported metric, and an
    exception would make it unmeasurable."""
    env = WalkEnvironment(synthetic_case())
    state = env.initial_state(concept("start"))
    bogus = Action(ActionKind.TRAVERSE, "causes", "nowhere at all")

    next_state, reward, terminal, record = env.step(state, bogus)
    assert next_state == state, "an illegal action does not move the walk"
    assert reward == DEFAULT_REWARD.invalid_action_penalty
    assert terminal is None and record.was_invalid


def test_a_policy_emitting_only_invalid_actions_terminates():
    class Broken(RandomPolicy):
        name = "broken"

        def choose(self, env, state, actions):
            return Action(ActionKind.TRAVERSE, "causes", "nowhere at all")

    episode = run_episode(WalkEnvironment(synthetic_case()), Broken(), concept("start"))
    assert episode.invalid_actions == len(episode.steps)
    assert episode.path_length == 0
    assert not episode.found_evidence


# ---- AC: a red-herring family lets the policy fail --------------------------


def test_a_red_herring_case_exists_and_is_not_solved_by_every_policy():
    """#98 requires at least one family where the learned policy may fail. A
    benchmark the graph method can only win is as uninformative as one where
    everything wins."""
    red_herrings = [case for case in BENCHMARK_CASES if "red_herring" in case.case_id]
    assert red_herrings, "the red-herring family must exist"

    scores = {
        policy.name: evaluate_case(red_herrings[0], policy).ndcg_at_5
        for policy in baseline_policies()
    }
    assert min(scores.values()) < 1.0, f"every policy solved the red herring: {scores}"


# ---- AC: splits, and honesty about what they can support --------------------


def test_evaluation_requires_a_named_split():
    """A number reported as held-out had to be asked for as held-out."""
    train_ids = set(evaluate("train").case_ids)
    test_ids = set(evaluate("test").case_ids)
    assert train_ids and test_ids
    assert not (train_ids & test_ids), "no case appears in two splits"


def test_splits_are_never_pooled_into_one_number():
    everything = evaluate_all_splits()
    assert set(everything["splits"]) == {"train", "validation", "test"}
    assert "combined" not in everything and "overall" not in everything


def test_a_split_that_separates_nothing_says_so_rather_than_reporting_a_ceiling():
    """The saturation failure #86 removed from the retrieval harness.

    This used to assert against the real `test` split, because before #88 that
    split held only one-hop `vocab_disjoint` cases and every policy including
    the random walk scored 1.0 on it. The real splits all discriminate now, so
    the check is made against a split constructed to be degenerate — which is
    the right target anyway: what must not regress is the *reporting* of
    saturation, and pointing the assertion at whichever split happens to be
    saturated made it a test of the case set instead.
    """
    one_hop = [
        case
        for case in BENCHMARK_CASES
        if case.family == "vocab_disjoint"
        and case.required_hops <= 1
        and case.split == "test"
    ][:4]
    assert one_hop, "the fixture for this test needs one-hop cases in the test split"
    report = evaluate("test", cases=one_hop)
    assert report.discriminates is False
    assert any("does not discriminate" in warning for warning in report.warnings)
    assert report.as_dict()["discriminates"] is False


def test_the_real_splits_do_discriminate():
    """The state #88 delivered, asserted so that losing it is a failure.

    A split where every policy scores alike cannot rank policies, which is the
    only thing #98 will ask of it.
    """
    for split in ("train", "validation", "test"):
        assert evaluate(split).discriminates is True, split


def test_the_training_family_does_discriminate():
    report = evaluate("train")
    assert report.discriminates is True
    assert report.beats_chance("relation_aware") is True


def test_the_dataset_shortfall_is_carried_into_every_report():
    report = evaluate("train")
    joined = " ".join(report.warnings)
    assert "human label" in joined
    assert "#88" in joined
    # Reported on every run now, not only when a split could not be filled —
    # 82 cases are 12 independent groups, and the group count is what any
    # held-out claim rests on.
    assert any("effective sample size" in warning for warning in report.warnings)


# ---- AC: training is gated, reproducible, and versioned --------------------


def test_the_training_gate_is_shut_on_this_dataset():
    gate = training_gate()
    assert gate.open is False
    assert gate.human_labelled_cases == 0
    joined = " ".join(gate.blocking_reasons)
    assert "human-labelled" in joined
    assert "inter-rater agreement" in joined
    # The group-count blocker is SATISFIED now — #88 took the set from 1
    # independent group to 12 — so it is no longer among the reasons. The gate
    # stays shut on the two that matter and that #88 could not clear from a
    # keyboard: labels have to come from people, and their agreement has to be
    # measured.
    assert "independent leakage group" not in joined
    assert gate.independent_groups >= 3


def test_fitting_raises_rather_than_returning_an_unfitted_policy():
    """A caller that got a `LinearPolicy` back would have something that walks,
    and the fact that its weights mean nothing would live in a flag."""
    with pytest.raises(TrainingBlocked, match="data gate is shut"):
        fit_linear_policy()


def test_the_default_learned_policy_is_marked_unfitted():
    policy = LinearPolicy()
    assert policy.is_fitted is False
    assert policy.fitted_on == "not fitted"
    assert policy.as_dict()["is_fitted"] is False


def test_the_search_works_and_is_reproducible_when_the_gate_is_bypassed():
    """The fitting code is exercised against synthetic cases so it works the day
    #88 lands, and a gate-bypassed run says so in its own metadata."""
    cases = [synthetic_case(f"s{index}") for index in range(6)]

    first = fit_linear_policy(cases, seed=7, search_steps=25, enforce_gate=False)
    second = fit_linear_policy(cases, seed=7, search_steps=25, enforce_gate=False)

    assert first.policy.weights == second.policy.weights, "same seed, same weights"
    assert first.policy.is_fitted is True
    assert "gate bypassed" in first.method
    assert first.environment_version == POLICY_ENV_VERSION
    assert first.dataset_version
    assert first.train_case_ids


def test_a_different_seed_can_reach_different_weights():
    cases = [synthetic_case(f"s{index}") for index in range(6)]
    a = fit_linear_policy(cases, seed=1, search_steps=40, enforce_gate=False)
    b = fit_linear_policy(cases, seed=99, search_steps=40, enforce_gate=False)
    assert a.policy.weights != b.policy.weights or a.best_mean_return == b.best_mean_return


def test_fitting_never_improves_by_reading_the_answer_key():
    """No feature may see the target evidence ids. A feature that did would let
    the policy see the answer at inference and make every number meaningless."""
    env = WalkEnvironment(synthetic_case())
    state = env.initial_state(concept("start"))
    for action in env.actions(state):
        vector = features(env, state, action)
        assert len(vector) == len(FEATURE_NAMES)
        assert all(isinstance(value, float) for value in vector)

    # Changing which evidence is the target must not change any feature value.
    other = dataclasses.replace(synthetic_case(), expected_evidence_ids=("d3",))
    other_env = WalkEnvironment(other)
    assert features(env, state, env.actions(state)[0]) == features(
        other_env, other_env.initial_state(concept("start")), other_env.actions(other_env.initial_state(concept("start")))[0]
    )


def test_the_search_finds_weights_at_least_as_good_as_the_zero_vector():
    cases = [synthetic_case(f"s{index}") for index in range(4)]
    run = fit_linear_policy(cases, seed=3, search_steps=60, enforce_gate=False)
    baseline = mean_return(LinearPolicy(weights=(0.0,) * len(FEATURE_NAMES)), cases)
    assert run.best_mean_return >= baseline


# ---- AC: provenance on every path -----------------------------------------


def test_every_step_retains_its_observation_and_provenance_trace():
    env = WalkEnvironment(CHAIN)
    episode = run_episode(env, RelationAwarePolicy(), env.anchors[0])
    payload = episode.as_dict()

    assert payload["steps"], "a walk that took no step cannot be attributed to"
    for step in payload["steps"]:
        assert step["from"] and step["to"]
        assert step["action"]["kind"] in {"traverse", "stop"}
        assert "reward_reason" in step and step["reward_reason"]
        assert isinstance(step["evidence_ids"], list)

    reached = [eid for step in payload["steps"] for eid in step["evidence_ids"]]
    assert set(payload["reached_evidence_ids"]) <= set(reached), (
        "every reported evidence id is traceable to the step that reached it"
    )


def test_product_integration_stays_out_of_scope():
    """#98's last criterion. Both halves are checked — beating the baseline is
    not enough if attribution is lost — and integration is blocked regardless."""
    verdict = integration_gate(evaluate("train"))
    assert verdict["eligible_for_product_integration"] is False
    assert verdict["reasons_blocking"]
    assert "attribution" in verdict["requirement"]


def test_documentation_states_the_gate_and_what_this_is_not():
    doc = BACKEND.parent / "docs" / "graph_walk_policy.md"
    assert doc.exists(), f"documentation missing at {doc}"
    text = doc.read_text(encoding="utf-8").lower()
    for required in ("mdp", "reward", "#88", "not reinforcement learning", "clinical"):
        assert required in text, required


# ---- the read-only endpoint ------------------------------------------------


def test_the_endpoint_serves_the_decision_process_and_the_shut_gate():
    """The gate is the thing a reader needs to see first, so it travels with the
    numbers rather than being findable only in a doc."""
    from fastapi.testclient import TestClient

    from app.main import app

    payload = TestClient(app).get("/api/research/graph-walk-policy").json()

    assert payload["environment"]["environment_version"] == POLICY_ENV_VERSION
    assert payload["training_gate"]["open"] is False
    assert payload["training_gate"]["human_labelled_cases"] == 0
    assert [p["name"] for p in payload["policies"]] == [
        "random",
        "keyword",
        "undirected_bfs",
        "relation_aware",
    ]

    splits = payload["evaluation"]["splits"]
    assert set(splits) == {"train", "validation", "test"}
    # Was False before #88, when the held-out split held only one-hop cases and
    # every policy scored 1.0 on it.
    assert splits["test"]["discriminates"] is True
    assert splits["train"]["discriminates"] is True
    assert any("#88" in warning for warning in splits["train"]["warnings"])
