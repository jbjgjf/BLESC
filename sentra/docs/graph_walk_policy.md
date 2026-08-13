# The graph-walk MDP and its policies (#98)

Stage 1 of the roadmap in #102. An explicit Markov decision process over the
benchmark's concept graph, the four comparison policies #98 names, an evaluation
harness that reports by case family and language, and the data gate that
currently refuses to fit anything.

**Nothing in this repository is trained yet, and this module does not change
that.** Every case in `benchmark_cases.BENCHMARK_CASES` carries
`labelled_by="author"` — the answer key was written by whoever wrote the
question. #98 requires reward to come from human-labelled evidence, so
`training_gate()` is shut and `fit_linear_policy` raises. The environment, the
baselines and the harness exist now so that the day #88 lands is a data event
rather than a project.

## Why an MDP at all

#102 is emphatic that the repository's existing storage, BFS and fixed ranking
weights are **not reinforcement learning**, and that calling them so is the
failure mode the roadmap exists to prevent. This is the first thing here that is
actually a decision process, so the whole of it is written down rather than
implied — a BFS with a `reward` variable bolted on would look identical in a
summary and be exactly the thing #102 warns about.

| | |
| --- | --- |
| **State** | the case, the concept the walk stands on, the concepts visited this episode, the hop count |
| **Actions** | one per typed directed edge leaving the current concept, plus a single `STOP` |
| **Transition** | deterministic; the graph is fixed for the episode |
| **Episode limit** | 4 hops |
| **Terminal** | `STOPPED`, `HOP_LIMIT`, or `NO_ACTIONS` |
| **Reward** | reaching a concept in a human-labelled target evidence day, plus pre-registered penalties |

The visited set is part of the state rather than bookkeeping outside it, because
the cycle penalty is a function of the state and a Markov property that depended
on hidden history would not be one.

Relation type is part of the action, so `causes` and `buffers` to the same
concept are two different decisions. A relation outside the ontology vocabulary
is not an action at all — the same refusal `traversal/walk.py` makes.

**Four hops** is the length of the longest curated chain
(`academic_pressure.benchmark_chain`: exam_pressure → sleep_deprivation →
cognitive_impairment → depressed_mood → anhedonia). An episode can traverse the
deepest real answer and no further. A shorter limit would make every method fail
for the same reason and the comparison would measure the limit.

**Three terminal conditions, not one flag.** A policy that never chooses `STOP`
and one that stops at the right moment can otherwise report the same success
rate, and they are not the same policy.

The graph is built **per case**, from that case's own evidence-day motifs.
Sharing one graph across cases would leak the answer key through the topology.

## What may be a reward, and what may never be

Reaching a concept that appears in a human-labelled **target** evidence day.
That is the entire positive signal. It is paid once per concept, so a walk
cannot farm one node by bouncing.

```
evidence_reward          +1.00   reaching a target concept, once
step_penalty             -0.05   per traversal; a shorter path is worth more
revisit_penalty          -0.25   entering a concept already visited
invalid_action_penalty   -1.00   choosing an action outside the legal set
stop_without_evidence     0.00   stopping early is not worse than wandering
```

Pre-registered and echoed into every result with `declared_before_results: true`,
so a run with different numbers is visibly a different run.

`FORBIDDEN_REWARD_SIGNALS` names what may never contribute, with a reason each:

- `expected_safety` — a case's safety label is a clinical judgement, and
  rewarding a walk for reaching it trains a policy on clinical outcome;
- `safety_label` — the same, at the evidence-day level;
- `expected_policy` — rewarding it would train the walk to produce a
  recommendation rather than to find evidence;
- `raw_text` — real participant content is never a reward signal;
- `clinical_outcome` — none exists in this dataset and none may be introduced.

This is enforced rather than promised. The failure mode is a plausible-looking
commit that adds a safety bonus and passes review, so the list is data, it is
carried into every serialisation of the reward, and a test asserts that changing
a case's `expected_safety` does not change the reward set.

No feature the learned policy scores with may read the target evidence ids
either. A feature that did would let the policy see the answer key at inference,
and a test asserts that changing which evidence is the target leaves every
feature value untouched.

## The comparison set

Every baseline is a **policy over the same environment**, not a number computed
some other way. A learned policy that beat a differently-computed baseline would
be beating a different measurement.

| policy | family | uses |
| --- | --- | --- |
| `RandomPolicy` | chance | nothing; uniform over legal actions, seeded |
| `KeywordPolicy` | lexical | word overlap between query and target concept |
| `UndirectedBfsPolicy` | untyped traversal | nearest unvisited, ignoring type and direction |
| `RelationAwarePolicy` | fixed-rule traversal | `traversal.RELATION_RULES` — the #96 table, read not copied |
| `LinearPolicy` | learned | six weights over `FEATURE_NAMES`; fitted by `train.py` |

`RelationAwarePolicy` reads the #96 rule table rather than restating it. If that
table changes this policy changes with it, which is the intended coupling: it
exists to answer "does a learner beat the deterministic rule we actually ship",
and a frozen copy would stop answering that.

## Measured now, on the current six cases

Baselines only — there is no trained policy to report. Five seeds, nDCG@5 over
the order in which a walk reached target evidence.

**train** (`sleep_chain_en/ja`, `chain_red_herring_en/ja`) — discriminates:

| policy | nDCG@5 | success | path len | invalid | seed variance |
| --- | --- | --- | --- | --- | --- |
| random | 0.347 | 0.50 | 1.8 | 0.0 | 0.202 |
| keyword | **0.235** | 0.50 | 1.0 | 0.0 | 0.0 |
| undirected_bfs | 0.500 | 0.50 | 3.0 | 0.0 | 0.0 |
| relation_aware | 0.500 | 0.50 | 3.0 | 0.0 | 0.0 |

**test** (`vocab_disjoint_en/ja`) — **does not discriminate**: every policy,
including the random walk, scores 1.000.

**validation** — empty.

Three things worth reading off that table, none of them flattering:

**The lexical walker scores below chance.** 0.235 against random's 0.347. That is
the intended behaviour and it is what makes it a baseline: `benchmark_cases`
builds distractors that reuse the query's wording and targets that paraphrase it,
so a lexical walk is actively steered wrong rather than merely uninformed.

**Typing currently buys nothing.** `relation_aware` and `undirected_bfs` are
identical at 0.500. On these four cases the curated chain is the only path, so
following relation types and following any edge reach the same place. That is a
fact about the dataset, not a finding about typing — and it is the reason a
learned policy could not be evaluated meaningfully here even with labels.

**The held-out split is saturated.** On the `vocab_disjoint` cases the answer
sits one hop from the anchor, so the walk is solved before the policy matters.
`EvaluationReport.discriminates` is false and a warning says so, because a 1.000
read off that split says nothing about any method. This is the same failure #86
removed from the retrieval harness, reappearing in a different metric — it is
not a regression of that fix, it is the walk formulation meeting cases that were
designed for ranking.

## Splits, and what they can support

Splits come from `benchmark_labelling.assign_splits`, which groups cases by
shared target text and shared target motif triple before assigning — so a
matched ja/en pair, whose translations share no words but whose graph structure
is identical, stays in one split.

`evaluate(split)` requires a named split and has no "everything" value. A number
reported as held-out has to have been asked for as held-out, and
`evaluate_all_splits` returns a mapping rather than a pooled figure.

**The effective sample size is the group count, not the case count.** Six cases
form **two** independent groups, which cannot fill three splits — hence the empty
validation split, and hence a warning in every report.

## The training gate

`training_gate()` fails closed. All four must be true:

1. at least 40 cases with `labelled_by == "human"` — currently **0**;
2. a non-empty train split and a non-empty held-out test split;
3. at least 12 independent leakage groups — currently **2**;
4. inter-rater agreement recorded on the labels — currently **absent**.

40 rather than #88's 60–100 because 40 is the floor at which a three-way split
leaves enough in each part to mean anything. 12 groups because the group count is
what bounds a held-out claim.

`fit_linear_policy` raises `TrainingBlocked` rather than returning an unfitted
policy: a caller that got a `LinearPolicy` back would have something that walks,
and the fact that its weights mean nothing would live only in a flag somebody has
to check.

### The fitting method, when the gate opens

A seeded random search over the six weights, keeping the best mean training
return. Deliberately **not** a gradient method: the action space is a handful of
typed edges, the episode is at most four steps, and the dataset is a few dozen
cases. A policy-gradient implementation here would be more machinery than the
data can justify and would invite the reading that this is a deep RL result. It
is a search over six weights, and `TrainingRun` records the method, seed,
environment version and dataset version so that what was done is on the record.

`enforce_gate=False` exists so the search is tested against synthetic cases
today. It is not a way to train early: a run made that way records
`method="random_search (gate bypassed)"` and says so in its own metadata.

## Attribution

Every step carries the concept it left, the typed edge it took, the evidence days
the arrival concept appears in, and the reward with its reason. Every reported
evidence id is traceable to the step that reached it.

`integration_gate()` returns `eligible_for_product_integration: False`
unconditionally. #98 keeps product integration out of scope until the policy
beats the deterministic baselines **without losing attribution**, and both halves
are checked — a policy scoring higher while producing paths with no evidence
trace has not met the bar, and that is the half that would otherwise be
forgotten.

## What this is not

- not reinforcement learning results — nothing is trained;
- not online learning from live users, ever;
- not a clinical, safety, or diagnostic reward;
- not educator-facing output;
- not a claim that any policy works, since the only split with a trained-policy
  slot is empty and the held-out split is saturated.

## What #88 unblocks, and what it does not

#88 lands 60–100 human-labelled cases with agreement reported. That opens the
training gate. It does **not** by itself fix the two dataset problems this
harness surfaced: the saturated `vocab_disjoint` family needs cases where the
answer is more than one hop from the anchor, and two leakage groups need to
become at least twelve. Both are properties of case composition rather than of
case count, so growing the set without changing its shape would open the gate
onto a measurement that still cannot discriminate.
