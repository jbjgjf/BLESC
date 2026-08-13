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
2. **semantic_proxy** — `0.60 × character-trigram Jaccard + 0.25 × token
   Jaccard + 0.15 × Jaccard over the motif strings as text`. A fuzzy lexical
   matcher: tolerates morphological variation, does not traverse the graph, and
   cannot match a paraphrase that shares no characters. *(Amended 2026-08-13 —
   see Amendments.)*
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

## Known limitation: `hf_reranker_candidate` is not an independent arm

On this case set it ranks **identically to `graph_pattern` on every case**.
It is a deterministic placeholder for a cross-encoder that has not been built,
differing only in weights, and traversal dominates both. Reported in
`condition_independence` (`distinct_rankings: 3` against
`reported_conditions: 4`) so the ablation is never read as four independent
arms. Inventing a different formula to separate them would be manufacturing a
result; the fix is to implement the reranker or drop the arm.

## Known limitation: the case set is adversarial to lexical retrieval by design

Targets share no content word with their query and decoys reuse the query's
vocabulary. That is deliberate — it is what makes the hypothesis falsifiable —
but it means `keyword` sitting at chance is partly a property of the design
rather than a finding about lexical retrieval in general.

What this set can establish: traversal **can** recover multi-day chains that
lexical retrieval cannot. What it cannot establish: **how often** that situation
arises in real use. That requires cases representative of actual product
queries, which is #88's job and is not claimed here.

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
| 2026-08-13 | `semantic_proxy` redefined from `0.75 × token Jaccard + 0.25 × motif Jaccard` to character-trigram overlap (weights above). | In its old form it produced an **identical ranking to `keyword` on all 6 cases**. Every query in this set is built to share no vocabulary with anything, so the motif term was 0 throughout and the condition reduced to a monotone transform of `keyword` — the exact defect #86 existed to remove, surviving in one arm. The ablation reported four conditions where three existed. |
| 2026-08-13 | `test_lexical_conditions_do_not_beat_chance_on_this_case_set` narrowed from `(keyword, semantic_proxy)` to `keyword` only. | Consequence of the row above, not a response to a red build. A character-trigram matcher is not "purely lexical" in the sense the assertion was written for: Japanese morphology means related words share characters, so a small lift over chance is expected and is what makes the middle condition informative — it measures how much is recoverable without traversal. `keyword` is the exact-match floor and the claim still holds there unchanged. |
| 2026-08-13 | Added `chain_red_herring_ja`; Japanese decoys rewritten as Japanese sentences. | The red-herring case was English-only, so English carried a case built to be failed and Japanese did not: `by_language` was measuring case difficulty, not language. Families now hold equal counts per language and `comparison_validity.per_language_comparison_valid` is true. The Japanese decoys had been English templates with Japanese words substituted (`"Wrote about 感じ again today"`), separable by script alone — a cue no real candidate set offers. |
| 2026-08-13 | Shared tokeniser stopped counting 動詞-非自立可能 verbs following a 接続助詞; `PIPELINE_VERSION` → `cognitive-probe-v4`. | 「戻ってきた」 and 「よくなってきた」 both yielded lemma 来る, so a lexical baseline matched two sentences sharing only the 〜てくる aspect construction and scored 0.77 on a case built to be lexically unsolvable, while its English pair scored 0.0. Grammar was being counted as vocabulary. Affects `cognitive_probe` densities (token_count is their denominator), hence the version bump; v3 and v4 values are not comparable. |
| 2026-08-13 | English closed-class words filtered for **retrieval only**, not in `app.analytics.tokenize`. | UniDic drops Japanese particles by part of speech and nothing dropped the English equivalents, so `keyword` was matching on `it` / `and` / `this` in every English case — the two languages were filtered asymmetrically and any ja/en comparison would have measured that. It is not applied in the shared tokeniser because `cognitive_probe`'s primary signal **is** first-person pronoun density (Rude et al. 2004); stripping `i` / `me` / `my` there would delete the measurement. |

## References

- Epic #73; issues #86, #87, #88, #89, #90; roadmap #102.
- `docs/consulting/05-decisions-and-gaps.md` (outside this repository, unversioned).
