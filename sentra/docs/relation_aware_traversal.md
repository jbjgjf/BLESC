# Relation-aware traversal (#96)

Stage 0 of the roadmap in #102. Typed, directed traversal over the participant
temporal graph, with fixed parameters and a complete evidence trace.

**Nothing here is learned.** Every number is a hand-written constant. It is not
attention, it was not fitted, and no result produced by it may be described as
learned — that is #100, and it has an entry gate this layer does not meet. The
parameter table is serialised into every result so a stored answer can be checked
against the rule that produced it.

## Why a new module rather than a change to `graph_index`

`analytics/graph_index.traverse_graph` inserts both directions into its adjacency
for every edge:

```python
adjacency.setdefault(source_id, set()).add(target_id)
adjacency.setdefault(target_id, set()).add(source_id)
```

and returns `{node_id: hop_distance}`. Its docstring is honest — it says it treats
edges as undirected "for hop-distance purposes" — and it is a fine hop-distance
helper. It is simply not a relation-aware traversal: `causes` and `buffers` are
one edge to it, and its return type has no room for a path.

It is left exactly as it is, because #96 requires the undirected walk as a
comparison baseline. Fixing it would delete the baseline. `app/traversal` is
additive, and a test in `test_relation_aware_traversal.py` fails if someone later
"corrects" the baseline into directedness.

## The layer it walks

`ParticipantTemporalGraph` (#95) — the only representation carrying direction,
relation type, observation intervals and provenance on one object. Not the
`graph_nodes`/`graph_edges` SQL index, which is flat and has no relation
semantics.

The index still matters: it holds the embeddings, so it is what answers "which
node is this query about". So the two are bridged rather than merged, and the
bridge is `app/traversal/seeds.py`.

### Two node identities, one bridge

| | `graph_index.node_key` | `temporal.normalise_label` |
|---|---|---|
| rule | `normalize(category):normalize(label)` | NFKC + strip + lower |
| ladder | none | exact id → declared alias → normalised label |
| ambiguity | last write wins | recorded, never merged |
| has embeddings | yes | no |
| has direction/provenance | no | yes |

`resolve_seeds` maps candidates onto temporal node ids under the same ladder #95
used, records the rung that fired, and **fails loudly**. A `.get()` that returned
`None` would turn an unasked question into an empty answer, and
`SeedResolution.coverage` exists so a caller can tell the two apart.

Ambiguity is refused, not resolved. When two temporal nodes normalise to the same
label — which happens exactly when the assembler declined to merge them — this
declines too. Picking one would undo a decision #95 made deliberately.

## Direction: one question per walk

```
TraversalMode.DOWNSTREAM   what does the seed lead to     (source → target)
TraversalMode.UPSTREAM     what leads to the seed         (target → source)
```

A directed relation is walked in one consistent orientation per walk. `UPSTREAM`
is not a reversal of the relation's meaning — the walk still follows the asserted
direction of influence, it just starts at the consequence, and
`PathStep.walked_against_arrow` records which way it was read.

**A single walk never mixes the two**, and that is the point. With `A → B` and
`C → B`, a walk that reverses mid-path emits `A → B → C` and a reader sees "A
leads to C". They are not connected; they share a consequence.

`co_occurs` is the one symmetric relation, because its scope note defines it as
"undirected co-occurrence in the same account". Nothing else is licensed to be
walked both ways.

## The parameter table

`app/traversal/relations.py`. Six relations, one rule each.

| relation | direction | damping | rank | evidence | source |
|---|---|---|---|---|---|
| `causes` | forward | 0.90 | 0 | association | nice_ng134 |
| `buffers` | forward | 0.85 | 1 | association | who_adolescent_mh |
| `avoids` | forward | 0.80 | 2 | association | nice_ng134 |
| `escalates` | forward | 0.75 | 3 | expert judgement | — |
| `precedes` | forward | 0.60 | 4 | expert judgement | — |
| `co_occurs` | symmetric | 0.50 | 5 | expert judgement | — |

**The ordering is argued.** Each rule's `rationale` quotes the scope note in
`app/ontology/schema.py` it rests on, and a test asserts that a relation backed
only by expert judgement never outranks a sourced one — so the table cannot drift
from the ontology it claims to follow. The step from 0.75 to 0.60 is where a path
stops carrying influence and starts carrying sequence: `precedes` is documented as
"explicitly NOT a causal claim".

**The magnitudes are arbitrary.** There is no source for "a `co_occurs` hop costs
half". They were chosen so the ordering has visible consequences at the path
lengths the benchmark uses — a two-hop `causes` chain (0.81) outranks a one-hop
`co_occurs` (0.50), which is what the #87 chain family needs — and they are a
tunable constant, not a measurement. Every rule reports
`parameter_basis: "engineering_choice"`.

Deliberately **not** environment variables, unlike `graph_index.DEFAULT_WEIGHTS`.
A value that varies per deployment cannot be reported as "the fixed rule this
result used". Changing one is a code change and a version bump.

A relation outside the vocabulary raises `UnknownRelationType`. It is not coerced
to `co_occurs`: `validator.py` does that at extraction time and reports the
coercion rate, and a second silent coercion here would be invisible. The walker
catches it, refuses the edge, and records it in `report.skipped_edges`.

## Scoring

```
score = Σ component × weight        weights renormalised over what survived

relation_path      0.40   product of the step dampings
edge_confidence    0.25   min over steps
recency            0.15   min over steps
recurrence         0.10   min over steps
curated_support    0.10   fraction of steps with curated backing
```

**Every scalar component is the weakest link.** A chain is exactly as good as its
worst edge; averaging would let a strong recent edge carry a stale one. The single
exception is `relation_path`, which is a product, because relation weakness
compounds along a chain rather than being bounded by its worst member.
`curated_support` is a mean because it is a coverage measure, and is labelled as
one.

`recency_score` and `recurrence_score` are imported from `graph_index` rather than
reimplemented — two copies of a decay curve drift.

### Absence is never a number

A component that cannot be computed is dropped, the remaining weights are
renormalised, and the dropped component is named in
`score_breakdown.components_unavailable`. Substituting `0.0` would report missing
evidence as bad evidence; `1.0` would report it as perfect.

Partial data is still absence: if two of three edges record a confidence, the
component leaves entirely. A min over the documented subset would report the path
as confident as its best-documented edge.

The published breakdown reproduces the published score — asserted over every path
of an assembled fixture, because renormalisation is exactly where a breakdown
stops adding up.

### `as_of` defaults to the graph, not the clock

Recency needs a reference day. It defaults to the graph's last observed day, not
`date.today()`, so a fixture scored in December scores the way it did in August.
A default of "now" would make every stored result unreproducible.

### Influence is summarised, never multiplied

`influence_summary` is `raises`, `lowers`, `mixed` or `none`. It is deliberately
**not** the product of the step polarities. "A buffer of a cause therefore lowers
the outcome" is a causal inference, and this layer does not make one. When the
influence-bearing steps disagree, the answer is `mixed` and the reader resolves it.

## Curated knowledge guides; it never rewrites

Curated evidence has exactly one channel into the result: it raises
`curated_support`. It does not change which edge exists, its direction, or its
type.

When the curated layer types a pair differently from what the extractor produced,
the walk crosses the edge the participant's data produced, at that relation's
parameter, and the disagreement is carried on the step as
`curated_relation_type` + `curation_disagrees`. A disagreement is a finding for a
curator, not an error for traversal to silently correct — adjudicating it is
#101's business, behind a review path this layer does not have.

## The evidence trace

Every `EvidencePath` carries the eight things #96 asks for:

```
node_ids · hop_count · relation_types · score_breakdown (components + weights)
source_snapshot_ids · curated_source_refs · evidence_strength · the steps
```

plus `spans_days` — the #87 finding is that an answer can exist in no single day,
so the span is reported rather than left to be derived.

`PathStep` carries the evidence rather than a pointer to it. A step storing only
an edge key would send every consumer back to the graph to answer "why", and the
UI ones will not.

## The educator invariant

`filter_reportable(result) -> (allowed, withheld)`.

A path is withheld when any step has no source snapshot, when the breakdown is
missing, or when `AssemblyReport.identity_is_usable` is false — a participant with
a pre-#107 snapshot has array-position node ids, so `node_1` on two days are
unrelated observations and every temporal path over them is void.

A node whose every path is withheld does not appear at all: a node shown without a
route to it is the failure the invariant exists to prevent.

**Nothing is dropped silently.** Withheld paths come back with their reasons, and
caps report how many paths and nodes they removed rather than setting a
`truncated: true` flag that reads the same whether it dropped two or forty.

## The benchmark condition

`relation_aware` in `benchmark_retrieval.py`, family `fixed_rule_traversal`.
`METHOD_FAMILIES` maps every condition to a family so the #96 reporting
requirement is structural rather than a matter of how a reader groups the columns,
and `run_hf_research_benchmark()["method_families"]` states it as a block.

It shares the parameter table with the walker rather than reimplementing it, so
the benchmark measures the rule the product runs.

`graph_pattern` stays undirected and untyped, with the same 0.20/0.80 mixing
weights. The two conditions differ in **one** thing — whether traversal is
directed and typed — and a different mixing weight would confound the comparison
with a tuning choice.

### The current case set cannot tell them apart

`relation_aware` ranks identically to `graph_pattern` on all six cases, and the
degenerate pair is exempted by name in `test_benchmark_separation.py`.

The reason is a property of the cases, not the implementation: every chain runs
forward from the query anchor and uses one relation type per case, so directed
typed traversal reaches exactly what undirected untyped traversal reaches, in the
same order. `condition_independence` reports 5 conditions and 2 distinct rankings.

Two case families would discriminate, and both are written as tests in
`test_relation_aware_traversal.py` so the exemption is earned rather than assumed:

1. **A distractor reachable only against an arrow.** `distraction → causes →
   anchor`. Undirected traversal reaches it in one hop and ranks it top; directed
   traversal does not reach it at all.
2. **Two routes of equal length whose relation types differ.** Both targets one
   hop out, so hop-count traversal scores them identically and the tiebreak
   decides; relation-aware traversal ranks the `causes` route above the
   `co_occurs` one.

These belong in #88. `test_the_current_case_set_cannot_separate_directed_from_undirected`
goes red the moment a discriminating case is added, and the exemption should be
removed in the same change.

## Using it

```python
from app.traversal import SeedCandidate, TraversalMode, filter_reportable, resolve_seeds, traverse

graph = assemble_participant_graph(user_id, snapshot_inputs(rows))
seeds = resolve_seeds(graph, [SeedCandidate("q1", "眠れない")])
result = traverse(graph, seeds.resolved_node_ids, mode=TraversalMode.DOWNSTREAM)

allowed, withheld = filter_reportable(result)   # educator-facing
```

```
GET /api/research/traversal?user_id=…&seeds=眠れない,テスト前のプレッシャー
    &mode=downstream|upstream
    &audience=research|educator
```

Derived on read, like the temporal graph itself. `seed_resolution` comes back with
the paths, including anything ambiguous or unmatched — a caller cannot tell an
empty result from an unasked question without it.

## Out of scope

Named again, because the neighbouring roadmap items do involve learning:

- learned relation attention (HGT/R-GCN/GAT) — #100
- reinforcement-learned graph-walk policies — #98
- any claim that a displayed weight is a validated human explanation
- any clinical prediction or risk band
