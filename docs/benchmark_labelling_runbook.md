# Labelling the benchmark — runbook

How to get human `expected_evidence_ids` onto the 82 cases (#127), and how those
labels reach a benchmark result (#126).

**Read [`benchmark_preregistration.md`](benchmark_preregistration.md) first.**
The analysis plan and the exclusion criteria were written before any case was
excluded. This runbook follows them; where the two disagree, the
pre-registration wins and this file is wrong.

All commands run from `sentra/backend`.

## What state things are in

```bash
python scripts/run_benchmark_labelling.py status
```

Reports how many cases carry a human label, whether agreement has been measured,
and who signed the labels off. Today: 0 of 82 human-labelled, 76 drafted, 6
authored during development. Every retrieval number the benchmark prints is
PRELIMINARY until that changes.

## 1. Hand the cases out

```bash
# the main pass — one rater takes the whole set, or one split at a time
python scripts/run_benchmark_labelling.py export --rater ayaka --out ./outbox
python scripts/run_benchmark_labelling.py export --rater ayaka --split train --out ./outbox

# the agreement pass — a second rater takes the 20 pre-drawn cases
python scripts/run_benchmark_labelling.py export --rater kenji --sample --out ./outbox
```

The file holds the query and the shuffled candidates and **nothing else**: no
`expected_evidence_ids`, no `research_note`, no `family`, no `required_hops`. A
rater shown the intended answer produces a confirmation rather than a label, and
a test fails if any of those fields reaches the file.

Two things worth deciding before sending anything out:

- **Leave the test split for last.** `--split train`, then `validation`, then
  `test`. Nobody has to see the held-out cases while the earlier ones are still
  being argued about.
- **The agreement sample is fixed in advance** and drawn stratified by family
  and language. Choosing which cases to double-label after seeing the labels
  would let the coefficient be selected rather than measured.

## 2. The rater fills it in

For each case, `selected_evidence_ids` gets the days that help answer the query.
A day can help by saying the same thing in other words, or by being one link in
a chain that reaches it.

- `[]` — **not labelled**. The case is skipped and keeps its drafted key.
- `["none"]` — **labelled, and nothing helps**. This is a judgement and counts.

The two are different claims, so the format keeps them apart.

Budget, measured from the files themselves: 76 cases at 26–40 candidates each is
**2,252 judgements** for the main pass, plus about 560 for the agreement pass.

## 3. Take the files back

```bash
python scripts/run_benchmark_labelling.py import ./outbox/ayaka.json
python scripts/run_benchmark_labelling.py import ./outbox/kenji.json
```

Validation reports every fault in one pass — an unknown case id, a selection
that is not one of that case's candidates, `"none"` combined with a selection, a
case appearing twice. A rater works through a file once; sending them back for
one fault at a time would be the wrong shape of feedback.

Accepted files land in `benchmark_labels/raters/<rater_id>.json`, which is
version-controlled. It is the answer key to a synthetic benchmark, and a result
that cannot be regenerated from the repository is not reproducible.

## 4. Agreement, then disagreement

```bash
python scripts/run_benchmark_labelling.py agreement
```

Cohen's kappa over the pre-drawn sample. Two outcomes are both fine and mean
different things:

- **`is_defined: false`** — kappa cannot be computed here, because both raters
  marked nearly every candidate the same way and chance agreement is already
  ~100%. That is the expected shape when most candidates are decoys. Report it
  as undefined. **Do not report it as 0**, which reads as "the raters disagreed".
- **`meets_threshold: false`** — kappa is below the 0.67 convention fixed in
  advance. The labels are not yet reliable enough to interpret a result.

```bash
python scripts/run_benchmark_labelling.py adjudicate
python scripts/run_benchmark_labelling.py adjudicate --resolve sleep_chain_ja=c1,c2
```

An unresolved disagreement **stays unresolved**: the case keeps its drafted key
and stays out of the confirmatory analysis. Taking the union or the intersection
would manufacture an answer key out of a disagreement, and there would be
nothing left for the pre-registration's exclusion criterion to exclude.

## 5. Sign off

```bash
python scripts/run_benchmark_labelling.py apply --reviewer "Name"
```

Writes the reviewer into `benchmark_labels/adjudication.json`. Required: a
labelled dataset with nobody's name on it cannot be cited.

## 6. Run the benchmark

Nothing extra to do. `run_hf_research_benchmark()` resolves its case set through
the store on every run, so the next run scores against the human keys and
reports where they came from:

```json
"label_provenance": {
  "source": "store",
  "raters": ["ayaka", "kenji"],
  "reviewer": "Name",
  "unresolved_disputes": []
}
```

With no rater file the same call returns `"source": "drafted"` and the
PRELIMINARY warnings, which is what it has always done.

## What this does not change

**The effective sample size is 12 independent leakage groups, not 82 cases.**
Labelling raises the quality of the key, not the amount of independent
information. Any held-out claim rests on 12. The ceiling is the size of the
curated ontology; growing the case set does not raise it, and growing the
ontology does.
