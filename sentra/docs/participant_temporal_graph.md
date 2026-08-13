# The participant temporal graph (#95)

**This is a data model, not a learned one.**

No temporal graph network (TGN), no TGAT, no Hawkes or other point-process
intensity model, no learned attention over relations, no graph structure
learning, and no clinical prediction or risk band. Nothing in
`sentra/backend/app/temporal/` is trained and nothing in it forecasts. It turns
day-ordered extraction snapshots into a typed, directed, provenance-preserving
structure, deterministically, and stops there.

That boundary is enforced rather than promised: `model.NOT_IMPLEMENTED_HERE`
lists the excluded methods, `ParticipantTemporalGraph.as_dict()` carries the
list into every serialisation, and `test_the_contract_is_a_data_model_and_says_so`
fails if the list is emptied. Learning stages (#98, #100) consume this layer;
they do not live in it.

## Why this layer exists

BLESC already stored `graph_snapshots` and `temporal_diff_json` before this
work. A sequence of snapshots is not a temporal graph:

- **Nothing defined "the same node on two days."** Traversal (#96), dynamics
  (#97) and any later learning would each have invented their own rule, and
  three rules that disagree produce three different answers to "has this
  recurred".
- **A stored diff is not a history.** `temporal_diff_json` says what changed
  between two rows. It does not say that a concept has appeared in three
  separate runs with two gaps between them, which is the shape recurrence,
  remission and relapse actually have.
- **Provenance had nowhere to go.** #80 carried curated source refs into the
  stored snapshots. Without a temporal contract there was no field for them to
  land in on the other side, and no structural guarantee that a curated
  citation and a participant's own words stay apart.

## The shape

`ParticipantTemporalGraph` (in `app/temporal/model.py`):

| Piece | What it holds |
| --- | --- |
| `TemporalNode` | canonical label, every surface form seen, category **history**, observation intervals, personal observations, curated provenance, identity rules, unresolved ambiguities |
| `TemporalEdge` | source, target, **relation type** — all three are the identity — directed by construction, intervals, per-day confidence, personal observations, curated provenance |
| `ObservationInterval` | the days something was actually seen, plus the snapshot ids that saw it |
| `TemporalEvent` | append-only record of every change (see below) |
| `AssemblyReport` | what the assembler could not do: legacy ids, dangling relations, ambiguities, contradictions, diff cross-checks, warnings |

### Observation intervals, not spans

A concept seen on Monday and Friday but not Wednesday has **two intervals**,
not one four-day span. Collapsing them erases the gap, and the gap is the
phenomenon. `ObservationInterval.observed_days` lists the days it was actually
seen and `first_day`/`last_day` are derived from that list, so an interval can
never claim a span its observations do not cover. `is_dense` tells a caller
whether every calendar day in the span carries an observation — normally it
does not, because students do not write daily.

`max_gap_days` counts **skipped entry days**, not calendar days. A student who
writes Monday and Wednesday has no gap in their own series; treating calendar
absence as disappearance would render every weekend as a remission.

### Directed, typed edges

`(source_id, target_id, relation_type)` is the edge key. `causes` and `buffers`
are not symmetric, and a retyping is not the same event as an unrelated edge
appearing — the shared diff contract
(`sentra/shared/temporal_diff_conformance.json`) reports a retype as an add plus
a remove and names #95 as the layer responsible for telling those apart. The
assembler emits `EDGE_RETYPED` alongside the add and the remove; it does not
suppress either.

`analytics/graph_index.traverse_graph` deliberately discards direction. That is
a hop-distance helper for retrieval, not this.

## Node identity

An explicit ladder, strongest first. The rungs a node actually needed are stored
on it (`identity_rules`), and `identity_rule` reports the **weakest** of them —
a node held together by one label match is not an exact-id node just because
most of its days were exact. A caller that only trusts exact matches can filter;
nothing forces it to accept the whole ladder.

| Rung | Rule |
| --- | --- |
| `exact_id` | the extraction id seen before |
| `declared_alias` | a curator-supplied alias table maps this label to a node id |
| `normalised_label` | NFKC + casefold + strip matches exactly one existing node |
| `ambiguous` | more than one node answers to the label, **or** the only candidate is already claimed by a different id in the same day's extraction |
| `no_match` | nothing matched; a new node, and nothing has ever been matched to it |

Deliberately **not** on the ladder: stemming, synonym expansion, embedding
similarity. Each needs a threshold to be falsifiable, and a threshold chosen
without a distribution to look at is a number picked to produce a result. A
wrong guess here merges two things a student said and reports them as one.

### Ambiguity is recorded, never resolved

When two ids in one day's extraction share a normalised label, both survive.
The extraction distinguished them; overriding that on a label match would delete
a distinction the data made. An `IDENTITY_AMBIGUOUS` event records the
candidates and the reason, and the nodes point at each other through
`ambiguous_with`. A silent merge produces a graph that looks more confident than
the data behind it.

The one case the assembler declines to undo: two ids merged by a label match on
an earlier day that later turn up in the same day's extraction. The merge is now
suspect, and it is recorded as such — but unwinding it would rewrite days
already assembled, and this module does not rewrite.

### Category changes

A node is not "a State" — it is a thing that was called a State on these days.
`category_history` is a list of `CategoryAssignment`, a `CATEGORY_REASSIGNED`
event marks each change, and `TemporalNode.category` is a property over the
history so it cannot drift from what it summarises.

### When identity is unavailable

Before #107 a Japanese label produced an empty slug and the node id fell back to
`node_${index}` — an array position. `node_1` on Monday and `node_1` on Friday
are unrelated observations that happened to be listed first, so every temporal
claim over such a participant is void. Those snapshots are detected,
`AssemblyReport.identity_is_usable` goes false, an `IDENTITY_UNAVAILABLE` event
names the rows, and a warning says what it means. They are not silently dropped
and not silently used.

## Provenance: two kinds, two fields, two types

The acceptance criterion is that curated-source provenance and
personal-observation provenance remain separate fields. They are separate
**types**:

- `PersonalObservation` — one appearance in one participant's own data. Always
  carries a `SnapshotRef` (snapshot id, day, entry id, extraction provider,
  model, extractor version). Deliberately carries no `source_refs`: the only
  citation a journal entry supports is a pointer back to what was written.
- `CuratedProvenance` — population-level evidence: `source_refs` into the
  registry in `app/ontology/sources.py`, the matched seed subgraph, and the
  curated edge's `evidence_strength`. Deliberately carries no day, entry or
  snapshot: a guideline is not an observation of this person on this date.

The two dataclasses share **no field name**, checked by
`test_personal_and_curated_provenance_share_no_field`. That is what stops a
curated citation reaching the record of what a participant wrote through a dict
merge or a `**` splat. A student's journal is evidence about that student; a
guideline is evidence about a population. Conflating the namespaces is how a
personal observation ends up looking like published knowledge.

Curated provenance is populated from the `provenance` annotation that #80 writes
onto stored nodes and relations, plus an optional curator-supplied table passed
to the assembler. Nothing a participant writes can reach it.

### Traceability

`ParticipantTemporalGraph.provenance_chain(subject)` returns, for any node id or
edge subject, every `(day, snapshot_id, entry_id, extraction_provider,
extraction_model, extractor_version)` that produced it.
`TemporalNode.source_snapshot_ids` and `ObservationInterval.snapshot_ids` are
the same handle in narrower form.

## Events: nothing is overwritten

The log is the graph; nodes and edges are projections of it. Every change is an
append-only `TemporalEvent`:

`node_observed`, `node_absent`, `node_reappeared`, `edge_observed`,
`edge_absent`, `edge_reappeared`, `edge_retyped`, `edge_confidence_shifted`,
`category_reassigned`, `identity_ambiguous`, `identity_unavailable`,
`contradiction`.

A deletion is `node_absent` / `edge_absent` — an event on the day the absence
was noticed, carrying the day it was last observed. Nothing is removed from the
graph, so a node that disappeared in May is still in `nodes` in August with two
intervals and the events that separate them.

`test_a_longer_window_never_rewrites_the_days_it_shares` pins this: assembling
four days and then seven produces byte-identical events for the four they share.

### Contradictions

Narrow on purpose, and an engineering reading of the relation vocabulary's own
scope notes (`app/ontology/schema.py`) rather than a clinical claim:

- **`opposite_polarity`** — the same ordered pair carrying a raising relation
  (`causes`, `escalates`) and a lowering one (`buffers`, `avoids`). Either on
  one day, or a raising one the last time the pair was asserted and a lowering
  one now. The across-days check is against the pair's last observed types, not
  against yesterday, because a student who says the club makes it worse in May
  and better in July has contradicted themselves whether or not those entries
  were consecutive.
- **`mutual_causation`** — A→B and B→A both raising on the same day.

`co_occurs` and `precedes` contradict nothing. They assert no direction of
influence — `co_occurs` is the vocabulary's weakest claim and `precedes` is
explicitly ordering-only — so treating them as conflicting with a causal claim
would manufacture conflict out of the vocabulary's own hedge.

**Nothing is adjudicated.** Both edges stay in the graph with their own
provenance. A contradiction across two months is ordinary; one inside a single
day is a signal about the extraction. Neither is an error the assembler is
entitled to fix.

## Time travel

Two projections, answering different questions:

- `graph.at(day)` replays the event log and returns the graph **as believed at
  the end of that day** — including nodes that had already disappeared, and
  labels and categories as they read then rather than as they read now.
- `graph.nodes_present_on(day)` returns what was **literally observed** that day,
  and is empty on a day with no entry.

Conflating them is how "the student stopped writing" becomes "the student got
better", so they are separate methods with separate docstrings and a test
(`test_a_slice_and_a_day_of_observations_answer_different_questions`) that
asserts they disagree on a quiet day.

## Determinism

Same input, same graph, byte for byte. Every iteration is over a sorted
sequence, no wall-clock is read, and every event carries a total sort key that
includes its detail rendered as canonical JSON.

Set iteration order in Python is hash-randomised per process, so an in-process
comparison cannot catch a set leaking into the output — both assemblies would
share one seed. `test_determinism_survives_a_different_hash_seed` runs the
assembly in separate interpreters under three `PYTHONHASHSEED` values and
compares the bytes. The retyping and contradiction passes both walk sets of edge
keys; this is what holds them to sorting first.

## What the assembler does with `temporal_diff_json`

#95 asks for an assembler over "day-ordered `graph_snapshots` plus
`temporal_diff_json`". **The stored diff is cross-checked, not consumed**, and
that is a deliberate departure worth stating plainly.

Consuming it as the source of change would be wrong for this data:

- Until #107 the production writer emitted a fixed placeholder — every node and
  relation marked newly added, every day, with no comparison performed (#106).
  A diff-consuming assembler over historical rows would conclude that nothing
  ever recurred, which is the exact defect this layer exists to make visible.
- The diff is computed correctly going forward and records a `diff_basis`, but
  historical rows have no basis field, and the FastAPI research writer
  (`summarize_temporal_diff`) still records none. A field that is right for some
  rows and wrong for others, with no way to tell which, cannot be a source of
  truth.

So change is **recomputed** from `nodes_json` / `relations_json`, which were
correct throughout, and the stored diff is compared against the recomputation.
Every snapshot gets a `DiffCrossCheck` in the report:

| `status` | When |
| --- | --- |
| `agreed` | trustworthy basis, and the stored arrays match the recomputation |
| `disagreed` | trustworthy basis, arrays differ — or the row claims to be the participant's first snapshot while an earlier day is present |
| `not_comparable` | `no_previous_lookup`, `lookup_failed`, `legacy_id_scheme_boundary`, no basis at all, or the previous day holds more than one snapshot so the basis row cannot be identified |
| `absent` | no `temporal_diff_json` was supplied |

`not_comparable` always carries the reason. A disagreement is reported, never
silently preferred in either direction, and it raises a warning on the report.

The recomputation goes through
`analytics/graph_features.build_temporal_graph_diff` rather than a private copy,
so this does not become a third implementation of the contract that #106 was
about. `test_the_recomputed_diff_matches_the_shared_contract` replays every
shared fixture case through the assembler.

## The day is the unit

A participant who writes twice on Tuesday produces two `graph_snapshots` rows
and one Tuesday. The assembler unions a day's snapshots into one
day-observation, so a concept in the morning entry and not the evening one is
not a disappearance. Every individual snapshot still appears in
`personal_observations`, so nothing is lost by the union — only the absence
arithmetic is done at day granularity, which is the granularity
`temporal_diff_json` is written at (`_latest_graph_snapshot` selects on `day <`).

## Using it

```python
from app.temporal import assemble_participant_graph, snapshot_inputs

graph = assemble_participant_graph(
    participant_id,
    snapshot_inputs(rows),          # GraphSnapshot rows or plain dicts
    aliases={"不眠": "眠れない"},    # curator-declared, never inferred
)

graph.at(date(2026, 8, 3))          # the graph as believed that day
graph.recurring_nodes(2)            # went away and came back
graph.outgoing("眠れない", ["causes"])
graph.provenance_chain("眠れない")   # back to snapshots and entries
graph.report.identity_is_usable     # False if any row predates #107
```

`GET /api/research/temporal-graph?user_id=…` returns `graph.as_dict()` for a
participant, read-only, assembled from stored snapshots on each call. There is
no new table: this layer is derived, and materialising it would create a second
copy of the history to keep in sync.

## Fixtures

`sentra/backend/tests/fixtures/participant_temporal_graph.json` holds two
structurally identical seven-day series, one Japanese and one English, covering
recurrence, disappearance, reappearance, a changed relation (both a confidence
shift and a retyping), an ambiguous identity, a declared alias, a category
change, contradictions in both scopes, curated and uncurated provenance, and
four different `diff_basis` values including one row that is deliberately wrong.

`test_japanese_and_english_series_assemble_identically` compares the two
assembled event streams after mapping node ids. The defect this work follows
from was Japanese-only; an English-only suite could not have caught it.

## Out of scope

Named again because roadmap items nearby do involve learning:

- learned attention over relations
- graph structure learning
- temporal graph networks (TGN/TGAT)
- Hawkes or other point-process intensity models
- any clinical prediction or risk band
