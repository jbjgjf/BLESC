# Benchmark pre-registration

**Status:** registered before the first run on the #88 labelled case set. The
case set now exists at full size (82 cases); its labels do not. No confirmatory
run has happened.
**Registered:** 2026-08-13
**Harness commit:** `bc36262` (`research/rebuild-retrieval-benchmark`, PR #104)
**Issue:** #90. Depends on #86, #89.
**Dataset version:** `0.3.0-dev` — results from `0.2.0` are not comparable
(different cases, different splits).

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

## Known limitation: the effective sample size is 12, not 82

The 82 cases collapse into **12 independent leakage groups**. Cases that share a
target edge, a matched translation, or a verbatim chain are one item of
information however many case_ids they carry, and with 90 target-edge slots over
34 distinct curated edges, sharing is constant.

This is a property of the ontology, not of the case count. Adding cases to the
existing 42 edges raises the case count and not the group count. The number that
belongs beside any held-out claim is 12, `labelling_status()` reports it on every
run, and `assign_splits()` emits it as a warning unconditionally so it cannot be
read as an incidental detail.

What would raise it: more curated subgraph (#78 and the social-withdrawal work).
Nothing in `benchmark_cases/` can.

## Known limitation: per-language reporting exists, but the graph arms cannot show a language effect

Every case carries `lang`, families are balanced across languages, and
`by_language` is reported separately — which is what #88 asked for and what
closes the "we have not measured per-language performance" gap in §4 row 4.

What that split can and cannot detect is worth being exact about. The motif
layer is language-independent by construction (canonical concept ids, verified
by `test_a_matched_pair_has_an_identical_graph`), so `graph_pattern` and
`relation_aware` return the same number for both languages **by design** — a
difference there would be a bug, not a finding. The arms where a language effect
can appear are the lexical ones, and on the current measurement they read
`semantic_proxy` 0.0064 (en) against 0.0114 (ja), with `keyword` at 0.0 in both.

So the per-language split is interpretable and currently has very little to
resolve, because the lexical arms are near the floor by design. It will start to
carry information the moment a condition is added that reads text and works —
which is what `hf_reranker_candidate` is a placeholder for.

## `hf_reranker_candidate` is still a placeholder, but it is no longer degenerate

**Superseded 2026-08-13 (#88).** This section used to read: "on this case set it
ranks identically to `graph_pattern` on every case", reported as
`distinct_rankings: 3` against `reported_conditions: 4`.

That is no longer true. On the 82-case set `condition_independence` reports
**5 distinct rankings against 5 reported conditions, with no identical pairs**.
The anchor-reachable decoys are what separated them: the two conditions differ
only in how much weight they put on traversal against text, and until there was
wrong material *inside* the traversable set, that difference had nothing to act
on.

The original caution stands in a weaker form and is worth keeping: it remains a
deterministic stand-in for a cross-encoder that has not been built. Ranking
differently from `graph_pattern` does not make it a model. Nothing in this
document treats its score as evidence about a learned reranker, and the fix is
still to implement one or drop the arm.

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
| 2026-08-13 | **The case set grew from 6 to 82** (#88), in four families: `two_hop_chain` 26, `vocab_disjoint` 26, `low_frequency_high_severity` 16, `heavy_decoy` 14. 41 ja / 41 en, every case a matched pair. | The composition #88 fixed in advance, pinned by `test_the_composition_matches_what_the_issue_fixed_in_advance` so a family that shrinks is a failure rather than a footnote. `low_frequency_high_severity` is 16 rather than the 14 sketched: the severity material clusters on the social subgraph, and an eighth draft on academic-pressure edges was needed to stop the validation split holding no high-severity cases at all. |
| 2026-08-13 | **`expected_evidence_ids` on the 76 new cases is `labelled_by="draft"`, not an answer key.** They are excluded from the confirmatory analysis until `benchmark_labelling.apply_human_labels()` overwrites them from a rater file. | #88's central requirement. A model that writes both the question and the answer key produces a benchmark shaped like that model's strengths, and drafting 76 of them does not change that. `labelling_status()` reports `human_labelled_count` = 0 and marks every retrieval number PRELIMINARY. |
| 2026-08-13 | **Splits moved from derived to authored**, by partitioning the curated edges into three disjoint topical pools (sleep / academic / social) in `benchmark_cases/_splits.py`. | The old rule rotated hash-ordered leakage groups through the three splits. At 82 cases that produced 8 / 48 / 24 with one group of 44 spanning two splits, because 90 target-edge slots over 34 distinct edges makes cases share edges constantly and grouping is transitive. Now 36 / 24 / 22, all four families in every split, and **zero groups spanning a split**. The grouping derived from content still has the last word: `assign_splits()` checks rather than decides, and reports a `LEAKAGE:` warning it will not resolve by moving a case. |
| 2026-08-13 | Effective sample size is reported on **every** run, not only when a split cannot be filled. | 82 cases are **12 independent leakage groups**. Partitioning bought leakage safety and balanced splits; it bought no extra independent information. The ceiling is the size of the curated ontology — 29 nodes, 42 edges — and nothing done in the case files raises it. Growing the ontology (#78) does. Any held-out claim rests on 12, not 82. |
| 2026-08-13 | **`relation_aware` is reported as a fifth condition**, and the `graph_pattern == relation_aware` exemption in `test_benchmark_separation.py` is removed. | The exemption existed because every chain in the original six cases ran forward from the anchor on one relation type, so directed typed traversal reached exactly what undirected untyped traversal reached. #88 added cases that discriminate — `heavy_decoy` puts decoys one hop from the anchor, `counsellor_offer_declined` puts the answer behind an `avoids` edge — and the two now separate by **0.945 nDCG@5** on `heavy_decoy` (`graph_pattern` 0.0, `relation_aware` 0.945). **Disclosed, not predicted:** that separation was observed after the cases were written. It is not promoted to a pre-registered hypothesis, and the confirmatory claim remains `graph_pattern` vs `keyword` as fixed above. |
| 2026-08-13 | Anchor-reachable decoys added to every family (`decoy_anchor_motif_every`). | The first 82-case draft scored 1.0 for every graph condition on three of the four families. That is the #86 saturation defect arriving through the other door: #86 fixed distractors sharing no *vocabulary* with the query, which made `keyword` a sufficient baseline; these distractors shared no *graph structure* with the anchor, so the only reachable days were the targets and traversal could not fail. A fifth of the decoys in `heavy_decoy` and a seventh elsewhere now assert a junk relation from the case's own anchor. `graph_pattern` fell from 0.825 to 0.354 and nothing sits at a ceiling. |
| 2026-08-13 | Decoy motifs name numbered placeholder concepts (`State:decoy 03`) rather than the decoy word. | With reachable decoys, traversal has to ORDER them, and the deterministic tie-break sorts on the concept term. The terms were surface words — `State:feeling` in English, `State:感じ` in Japanese — so Japanese sorted after ASCII and every matched pair diverged: `ja` scored 1.000 on cases where `en` scored 0.469. A pure sorting artifact presenting as a language effect, in the arm where language should have no effect at all. The product's graph is canonical concept ids, which carry no language, and the fixtures now match. After the fix the per-pair ja/en gap is **0.000000 on every policy**, and `by_language` differs only in the lexical arms — which is where a language effect belongs. |
| 2026-08-13 | Three `low_frequency_high_severity` fixtures rewritten to the product's own trigger phrases; `irritability_toward_others` re-declared `elevated` rather than `crisis`. | The declared `expected_safety` disagreed with what `assess_safety` actually returns for the text. A fixture its own product disagrees with is broken, not hard. `concealment_request` declared `elevated` on an entry with nothing to conceal, and the detector is right that a concealment request alone is not a risk signal. `irritability_toward_others` describes violence ideation with no imminence, and the product escalates that to crisis only when imminent — writing "tonight" into the entry to reach the branch would be authoring the fixture to hit it. Pinned by `test_low_frequency_cases_agree_with_the_safety_detector`. |
| 2026-08-13 | `fugashi` and `unidic-lite` installed into the backend environment. | Both are in `requirements.txt` and neither was installed, so `app/analytics/tokenize.py` fell back to its ASCII path and Japanese collapsed to clause-sized chunks — `またあの感じが戻ってきた。` tokenised as one token. `test_exact_lexical_matching_does_not_beat_chance_on_this_case_set` was **red on `origin/main`** as a result (`keyword` beat chance by 0.199), and every UniDic-dependent amendment below was unverifiable. Not a code change; recorded because every Japanese number in this document depends on it. |
| 2026-08-13 | `semantic_proxy` redefined from `0.75 × token Jaccard + 0.25 × motif Jaccard` to character-trigram overlap (weights above). | In its old form it produced an **identical ranking to `keyword` on all 6 cases**. Every query in this set is built to share no vocabulary with anything, so the motif term was 0 throughout and the condition reduced to a monotone transform of `keyword` — the exact defect #86 existed to remove, surviving in one arm. The ablation reported four conditions where three existed. |
| 2026-08-13 | `test_lexical_conditions_do_not_beat_chance_on_this_case_set` narrowed from `(keyword, semantic_proxy)` to `keyword` only. | Consequence of the row above, not a response to a red build. A character-trigram matcher is not "purely lexical" in the sense the assertion was written for: Japanese morphology means related words share characters, so a small lift over chance is expected and is what makes the middle condition informative — it measures how much is recoverable without traversal. `keyword` is the exact-match floor and the claim still holds there unchanged. |
| 2026-08-13 | Added `chain_red_herring_ja`; Japanese decoys rewritten as Japanese sentences. | The red-herring case was English-only, so English carried a case built to be failed and Japanese did not: `by_language` was measuring case difficulty, not language. Families now hold equal counts per language and `comparison_validity.per_language_comparison_valid` is true. The Japanese decoys had been English templates with Japanese words substituted (`"Wrote about 感じ again today"`), separable by script alone — a cue no real candidate set offers. |
| 2026-08-13 | Shared tokeniser stopped counting 動詞-非自立可能 verbs following a 接続助詞; `PIPELINE_VERSION` → `cognitive-probe-v4`. | 「戻ってきた」 and 「よくなってきた」 both yielded lemma 来る, so a lexical baseline matched two sentences sharing only the 〜てくる aspect construction and scored 0.77 on a case built to be lexically unsolvable, while its English pair scored 0.0. Grammar was being counted as vocabulary. Affects `cognitive_probe` densities (token_count is their denominator), hence the version bump; v3 and v4 values are not comparable. |
| 2026-08-13 | English closed-class words filtered for **retrieval only**, not in `app.analytics.tokenize`. | UniDic drops Japanese particles by part of speech and nothing dropped the English equivalents, so `keyword` was matching on `it` / `and` / `this` in every English case — the two languages were filtered asymmetrically and any ja/en comparison would have measured that. It is not applied in the shared tokeniser because `cognitive_probe`'s primary signal **is** first-person pronoun density (Rude et al. 2004); stripping `i` / `me` / `my` there would delete the measurement. |

## References

- Epic #73; issues #86, #87, #88, #89, #90; roadmap #102.
- `docs/consulting/05-decisions-and-gaps.md` (outside this repository, unversioned).
