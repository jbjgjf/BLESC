# Provenance coverage

**Issue:** #79. Depends on #74–#78 (source registry, schema provenance, seed
subgraphs) and #80 (annotation on the extraction path).

## The question

> What share of an LLM-generated psychological graph can be tied to a published
> source?

As far as we can tell nobody reports this number. It is measurable here, it does
not depend on the central hypothesis holding, and it is reportable on its own —
which is the argument for measuring it now rather than after the hypothesis
resolves.

## What the number is

For a graph of nodes and relations, coverage is the share of its elements that
the curated seed subgraphs (`app/ontology/seed/*.yaml`) recognise under the
match rules below. Computed by `provenance_coverage(graph)` in
`app/ontology/provenance.py`.

| Key | Meaning |
|---|---|
| `nodes_with_source` | matched nodes / all nodes |
| `edges_with_source` | matched edges / all edges |
| `edges_by_strength` | matched edges split by the curated edge's `evidence_strength`: `causal` / `association` / `expert_judgement` |
| `unsourced_rate` | 1 − (matched nodes + matched edges) / (nodes + edges) |
| `matched_seed_subgraphs` | which curated subgraphs the graph touched |
| `edges_between_curated_nodes_not_in_seed` | edges the model asserted between two curated nodes that the curation does not carry |
| `node_count`, `edge_count`, `matched_node_count`, `matched_edge_count` | denominators, so a set of these can be pooled rather than averaged |

Every `EvidenceStrength` appears in `edges_by_strength` even at zero. An absent
key reads as "not measured", and "this graph contains no causal-strength edges"
is a finding rather than a gap in the report. (Currently no seed edge anywhere
carries `causal`, by curation policy — see `test_causal_strength_is_not_claimed_anywhere_yet`.)

## What the number is **not**

**Coverage is not accuracy.** It says how much of a graph the curation
recognises. It says nothing about whether the graph is right.

- A **fully sourced graph can still be wrong about a student.** Every node and
  edge can match a curated, cited claim while the graph as a whole misreads the
  person it was extracted from — the sources support the general claim, not its
  application to this individual on this day.
- An **unsourced element is not an error.** It may be a correct observation the
  curated subgraphs do not cover. Three seed files is not a psychology
  literature; low coverage is at least as much a fact about the curation's size
  as about the model's output.
- Coverage is **not a quality score, and nothing is gated on it.** See
  "Thresholds" below.
- A high `association` count is not evidence of causation. `evidence_strength`
  records how strongly the cited material supports the edge and is deliberately
  independent of the edge's relation type: `causes` + `association` is a normal
  and honest combination.

`COVERAGE_NOTE` in `app/ontology/provenance.py` carries a short form of this
caveat inside every emitted report, so it survives the number being copied out
of the payload.

## The matching rule

An unstated matching rule makes the coverage number unfalsifiable, so it is
stated. `MATCH_RULES = ("exact_id", "normalised_label")`:

1. **`exact_id`** — the generated node's `id` equals a curated node's id after
   normalisation.
2. **`normalised_label`** — the generated node's `label` equals a curated node's
   id, `label_ja` or `label_en` after normalisation.

Normalisation removes whitespace (including `　`), `_`, `-`, `・`, and `,.、。`,
then lowercases. So `exam_pressure`, `exam pressure` and `Exam Pressure` are one
key; `睡眠不足` matches the curated `label_ja` directly.

An edge matches only when **both endpoints match into the same subgraph** and
that subgraph carries an edge between them in that direction.

### Why not embedding similarity

It was considered and rejected for now. Embedding similarity needs a stated
threshold to be falsifiable, and a threshold chosen without a distribution to
look at is a number picked to produce a coverage figure. Deterministic matching
**under-counts** — it will miss real paraphrases — and under-counting is the
safer direction for a number being reported as evidence. Revisiting this needs
the threshold, the model, and the resulting distribution reported together.

### Known limitation: first writer wins

`_label_index` is first-writer-wins over `sorted(glob)`, so a label carried by
more than one seed file resolves to whichever file sorts first
(`academic_pressure.yaml` today). That is harmless only while the files state
shared claims identically, which is enforced by
`test_shared_nodes_and_edges_are_stated_identically`.

## Where it is reported

- **Extraction path** — `validate_extraction()` returns it under `provenance`,
  beside `coercion_rate`. Same style, same reason: a number saying how much of
  this graph is the model's own invention.
- **Benchmark** — `run_hf_research_benchmark()` returns a `provenance_coverage`
  block with per-case, per-language and pooled figures.
- **CI** — `scripts/report_provenance_coverage.py` runs on every push and prints
  the table to the build log, so a regression is visible.

### Annotation never rewrites

Matching adds `source_refs` and `evidence_strength` to an element and changes
nothing else — not the category, not the relation type, not the label. Using the
seed graph to "correct" the extraction would make the graph condition score
against its own answer key and the benchmark meaningless. Where a matched edge's
curated type disagrees with the model's, the model's type stands and the
disagreement is recorded as `type_matches_seed: false`.

### Pooled, not averaged

The benchmark's aggregate pools elements (`Σ matched / Σ total`) rather than
averaging per-case rates. A mean of rates weights a 4-element case the same as a
40-element one, which for a set whose cases differ this much in size is a number
about the case mix. Per-case rates are reported alongside so the distribution is
visible, not only its summary.

## The language split

Reported by language because the aggregate would hide a gap that is itself a
finding: the curated labels are bilingual, but the guidance behind them is
mostly English-language, so Japanese coverage dropping below English is expected.

**On the current benchmark case set the split cannot show this**, and the report
says so in `by_language_validity`. The `ja` and `en` graphs are not identical —
the lexical decoys are written in each language — but the decoys match nothing
in either, and every element that *does* match comes from a curated chain whose
motifs are written in the English concept notation for both twins. The matched
set is shared by construction and only unmatched noise varies, so `by_language`
is two copies of one number. Read as: *no language effect has been measured*,
not *no language effect exists*.

The gap this split exists to expose needs coverage over graphs extracted from
Japanese **text**, where the labels reaching the matcher are Japanese. That is
the extraction path, and it is where to look next.

## Thresholds

There are none, deliberately. Nothing is gated on coverage and the CI step
reports without failing.

Measure first. A threshold set before there is a distribution to look at is a
number chosen to be passed, and it would also freeze the current curation size
into a pass mark — coverage rises by curating more seed files, which is not the
same as the extraction getting better. When there is a distribution worth
setting a gate against, the gate belongs in a test with its reasoning written
down, not in the reporting script.

## Current figures

From `scripts/report_provenance_coverage.py` on the six benchmark cases, at the
time of writing:

| | nodes | edges | unsourced | size |
|---|---|---|---|---|
| overall | 29.4% | 13.3% | 78.1% | 68n / 60e |
| en | 29.4% | 13.3% | 78.1% | 34n / 30e |
| ja | 29.4% | 13.3% | 78.1% | 34n / 30e |

All 8 matched edges are `association`; none are `causal`. These are recorded as
a starting point, not a target — and they are low substantially because the
benchmark graphs are padded with lexical decoy motifs that no curation would
ever carry, which is a property of the case design (decoys are deliberately
misleading noise) rather than a measurement of extraction quality. Coverage over
graphs from the extraction path is the number that answers the research question
above; this one establishes the harness and the reporting.
