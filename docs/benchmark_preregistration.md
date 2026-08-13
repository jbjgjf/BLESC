# Benchmark pre-registration

**Status:** registered before the first run on the #88 labelled case set.
**Registered:** 2026-08-13
**Harness commit:** `bc36262` (`research/rebuild-retrieval-benchmark`, PR #104)
**Issue:** #90. Depends on #86, #89.

## What this document is for

With four conditions, several metrics and a free choice of `k`, there is room to
pick the combination that happens to favour the hypothesis once the numbers
exist. Fixing the analysis in writing beforehand is the only defence that
survives a judge asking "did you decide that before or after you saw it".

## Disclosure: what has already been seen

This is registered **after** the harness was built and run on 5 author-drafted
development cases, and **before** any run on the #88 labelled set. That ordering
is weaker than a blind pre-registration and it is stated here rather than left
for someone to work out.

Concretely, the following were known when the thresholds below were chosen:

| Condition | nDCG@5 on the 5 dev cases | Chance |
|---|---|---|
| keyword | 0.1531 | 0.135 |
| semantic_proxy | 0.0 | 0.135 |
| graph_pattern | 0.8 | 0.135 |
| hf_reranker_candidate | 0.8 | 0.135 |

Consequences, binding:

1. **The 5 development cases are development data and are excluded from the
   confirmatory analysis.** They were used to build and debug the harness. A
   result on them is a result about the harness.
2. The #88 labelled set is the confirmatory set. Its cases are drafted and
   labelled without reference to the numbers above.
3. Thresholds below were chosen against the *chance* level (a property of the
   case design) rather than against the observed condition scores, so far as
   that separation can be maintained once the observed scores are known. Where
   a threshold was influenced by what was seen, it is marked.

## Hypothesis

> Retrieval that traverses the curated concept graph recovers evidence that
> spans multiple days more accurately than lexical retrieval over the same
> candidate set, and the advantage is present in both Japanese and English.

Falsifiable as stated: it fails if traversal does not beat lexical retrieval,
and it also fails if the advantage exists only in English.

## Conditions

Four, defined in `app/services/benchmark_retrieval.py`, all ranking the same
candidate set for the same query:

1. **keyword** — Jaccard over content tokens of the day's text.
2. **semantic_proxy** — `0.75 × text Jaccard + 0.25 × Jaccard over the motif
   strings as text`. Sees the graph as words; does not traverse it.
3. **graph_pattern** — `0.20 × text + 0.80 × traversal + safety bonus`, where
   traversal is `1/(1 + hops)` by breadth-first search from the query anchors
   over parsed motif triples.
4. **hf_reranker_candidate** — `0.35 × text + 0.65 × traversal + safety bonus`.
   A deterministic stand-in for a cross-encoder. It has **no** access to
   `expected_evidence_ids`; the previous implementation did, and that is the
   defect #86 fixed.

Tokenisation for all four goes through `app.analytics.tokenize`. A condition
that cannot read Japanese is not a baseline (#86, D-01).

## Fixed in advance

| Parameter | Value |
|---|---|
| Primary metric | nDCG@5 |
| Secondary metrics | recall@5, target_hit_rate, across-run variance |
| `k` | 5 |
| Traversal depth | 3, with the depth-1/2/3 sweep reported |
| Repeats | 1 — every condition is deterministic; variance across repeats is 0 by construction and is reported only if a stochastic condition is added |
| Chance estimation | 2000 random permutations per case, seed 20260813 |
| Candidates per case | 20–40 |

`k = 5` is fixed because cases carry 2–3 targets; `k = 2` was the old value and
it made the task answerable by chance at recall 0.67.

## What counts as "conditions separate"

Numerically, and all three must hold:

1. `graph_pattern` − `keyword` ≥ **0.10** nDCG@5 on the confirmatory set.
2. `keyword` ≤ **0.60** nDCG@5. A baseline above this is solving the task, and
   the case set is too easy regardless of what the graph conditions score.
3. Every condition is reported beside the measured chance level. A condition
   within ±0.02 of chance is reported as **at chance**, not as a small effect.

0.10 is roughly 0.75× the measured chance level (~0.135) and was chosen as a
margin that a handful of cases flipping cannot manufacture. *Marked: chosen with
the dev-set numbers known.* Codified in
`tests/test_benchmark_separation.py`; lowering either constant is a benchmark
design decision and requires an amendment below.

## What would falsify the hypothesis

Any one of these is a negative result and is reported as one:

- `graph_pattern` − `keyword` < 0.10 on the confirmatory set.
- `graph_pattern` is within ±0.02 of chance.
- The advantage holds in English and not in Japanese (`ja` families separated
  by less than 0.10 while `en` families exceed it), which falsifies the second
  clause and is the outcome the matched-pair design exists to detect.
- `semantic_proxy` matches `graph_pattern` within 0.05 — traversal would then be
  adding nothing over seeing the motif strings as text.
- Inter-rater agreement on the 20-case sample is below the 0.67 convention. The
  retrieval numbers are then uninterpretable and no claim is made from them,
  whatever they say.

A negative result is publishable and will be published. There is no version of
this analysis where the hypothesis cannot lose.

## Case exclusion criteria

Written before any case is excluded. A case is excluded only if:

- it contains real user content (must be zero by construction);
- its `expected_evidence_ids` are not human-labelled;
- the two raters disagree and no adjudication was recorded;
- it is a development case (the 5 listed above);
- it is malformed — no target, or a target absent from its candidate list.

**Not** grounds for exclusion: being hard, being one every condition fails, or
being one where the baseline wins.

## Analysis plan

- Report per-family and per-language separately as well as in aggregate. An
  advantage confined to one family is the finding, and an average hides it.
- Report the depth-1/2/3 sweep. The depth at which an advantage appears is the
  substantive claim; if depth 1 is as good as depth 3, multi-hop traversal is
  not what is helping.
- Report `chance_ndcg_at_k` beside every condition.
- Report the number of **independent leakage groups**, not the case count, as
  the effective sample size. Matched ja/en pairs and cases sharing a chain are
  one item of information, not two (`benchmark_labelling.leakage_groups`).
- Report inter-rater agreement with the coefficient, and report when it is
  **undefined** rather than substituting 0.
- Report `human_labelled_count`. Until it reaches the case count, every result
  is preliminary and labelled as such.

## Amendments

Any deviation is recorded here with a reason and a date. Never a silent edit.

| Date | Change | Reason |
|---|---|---|
| — | — | — |

## References

- Epic #73; issues #86, #87, #88, #89, #90; roadmap #102.
- `docs/consulting/05-decisions-and-gaps.md` (outside this repository, unversioned).
