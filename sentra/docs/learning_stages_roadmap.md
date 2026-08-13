# Category 1 implementation roadmap — #95–#101

Scope: the learning-algorithm and graph-structure half of epic #102 (#95, #96, #97,
#98, #99, #100, #101). The provenance / benchmark / foundation half (#77, #78, #79,
#88, #90, #62, #17, #1, #2, #7) is owned elsewhere and appears here only where it
gates one of these issues.

Written against `feat/participant-temporal-graph` @ `4b9e4c8`. Every claim below
cites the code it is derived from; where an issue's acceptance criterion is already
met, the file that meets it is named.

---

## Status at a glance

| Issue | State | Actually blocked by | Verdict |
|---|---|---|---|
| #95 Temporal graph | **Implemented, unmerged** | PR #109 review | Merge it — it is the dependency for four other issues |
| #96 Deterministic traversal | Not started | nothing | **Start here** |
| #97 Early-warning dynamics | Not started | nothing (#91 already cleared its blocker) | Can run in parallel with #96 |
| #98 Stage 1 policy | Not started | **#88 (category 2)** | Environment buildable now; training is not |
| #99 Stage 2 Bayesian | Not started | real consented data + governance + #62 | Out of scope; needs one regression guard |
| #100 Stage 3 attention | Not started | #96, #88, data volume | Out of scope this cycle |
| #101 Layer separation | **~40% already true** | nothing for the schema work | Second half of the cycle |

---

## #95 — done, waiting on a merge

The issue is still OPEN, but the work exists. `4b9e4c8` on
`feat/participant-temporal-graph` adds `app/temporal/{model,assemble,load}.py`
(2,118 lines) and `GET /api/research/temporal-graph`, and the commit message ends
`Closes #95`.

PR #109: `MERGEABLE / CLEAN`, no requested changes. Checks: Backend research
contracts SUCCESS, Frontend lint and build SUCCESS, Vercel SUCCESS, Supabase
SKIPPED. The one review is the Codex bot's boilerplate "here are some automated
suggestions" comment with no findings attached. Locally, 63 tests pass across
`test_participant_temporal_graph.py`, `test_temporal_graph_endpoint.py` and
`test_graph_index.py`.

Its blocker #106 (production wrote a `temporal_diff_json` containing no temporal
information) was fixed and merged as #107, and the assembler now treats stored
diffs as *cross-checked, not consumed* — change is recomputed from
`nodes_json`/`relations_json` and every row gets an agreed / disagreed /
not_comparable / absent verdict (`TRUSTED_DIFF_BASES`,
`assemble.py:109–125`).

**Action: merge PR #109 before starting anything else.** #96, #97, #100 and #101
all name it as a dependency, and three of them consume its types directly.

---

## #96 — deterministic relation-aware traversal

The unblocked next step, and the one everything downstream leans on.

### What exists

`analytics/graph_index.py` maintains `graph_nodes`/`graph_edges` and provides
`traverse_graph` + `hybrid_rank`; `research_pipeline.search_similar_graph_patterns`
(`:960–1075`) is the production caller.

### The four gaps, precisely

**1. Traversal is undirected by construction.** `graph_index.py:231–232` inserts
both directions into the adjacency for every edge:

```python
adjacency.setdefault(source_id, set()).add(target_id)
adjacency.setdefault(target_id, set()).add(source_id)
```

So `A --causes--> B` is walked B→A as freely as A→B. The docstring is honest about
it ("treated as undirected for hop-distance purposes") — this is a hop-distance
helper that got used as a retrieval traversal.

**2. Relation type never enters the walk or the score.** `traverse_graph` reads only
`source_node_id`/`target_node_id` from each edge dict — and
`research_pipeline.py:988` builds those dicts with exactly those three keys, so
`relation_type` is not even in scope at the traversal site. `DEFAULT_WEIGHTS`
(`graph_index.py:39–46`) has six components — semantic, distance, confidence,
recency, recurrence, memory_importance — and none of them is relation-aware. This is
the "not relation-aware attention" the issue names.

**3. There is no evidence trace.** Each result
(`research_pipeline.py:1040–1053`) carries `score_breakdown` and `match_reasons`,
which is more than nothing, but:

```python
"graph_snapshot_id": None,
"entry_id": None,
...
"temporal_diff": {},
```

No path, no hop chain, no relation types traversed, no source snapshot ids, no
evidence strength. #96's central AC — "every result returns the complete path, hop
count, relation types, component scores, source snapshot ids, source refs, and
evidence strength" — is currently met on exactly one of eight fields.

**4. Fixed relation parameters do not exist yet**, but their raw material does.
`ontology/schema.py:115–180` defines all six relations with a scope note, source
refs and an `evidence_strength`; `temporal/assemble.py:100–107` already declares
polarity:

| relation | polarity | evidence_strength | source |
|---|---|---|---|
| `causes` | raises | ASSOCIATION | nice_ng134 |
| `escalates` | raises | EXPERT_JUDGEMENT | expert judgement |
| `buffers` | lowers | ASSOCIATION | who_adolescent_mh |
| `avoids` | lowers | ASSOCIATION | nice_ng134 |
| `co_occurs` | — | EXPERT_JUDGEMENT | expert judgement |
| `precedes` | — | EXPERT_JUDGEMENT | expert judgement |

The per-relation traversal parameter table should be derived from and cite these,
not invented next to them. `precedes` in particular is documented as explicitly *not*
causal, so it must not accumulate the same traversal weight as `causes` — and the
table is the place that distinction becomes executable.

### The architectural decision this issue actually turns on

**There are two graphs with two different node identities, and #96 has to pick one.**

- `graph_nodes.node_key` = `normalize(category):normalize(label)`
  (`graph_index.py:56`). Flat, has embeddings, is what production queries.
- The temporal assembler's identity ladder — exact id → declared alias → normalised
  label — which *records which rung it needed* and refuses to merge ambiguous
  matches (`docs/participant_temporal_graph.md`, "Node identity"). Directed, typed,
  provenance-carrying, has `intervals`, has no embeddings.

Recommendation: **traverse the `ParticipantTemporalGraph`, seed from the SQL index.**
The temporal layer is the only one with direction, relation type and provenance, so
it is the only one on which #96's ACs are expressible at all. The SQL index keeps
its job as the semantic entry point, because it holds the vectors.

That makes the seed step a real, documented component: `graph_node.id → temporal
node id`. It will sometimes fail to map, and the failure must be reported, not
dropped — the same discipline `AssemblyReport` already applies to identity.

`ParticipantTemporalGraph` already gives the primitives: `outgoing(node_id,
["causes"])`, `incoming(...)`, `provenance_chain(subject)` returning
day / snapshot_id / entry_id / extraction_provider / extractor_version
(`temporal/model.py:695–741`).

### Work items

1. `app/traversal/relations.py` — the fixed per-relation parameter table (traversable
   direction, cost or damping, whether it may terminate a path), each row citing
   `ontology/schema.py` and labelled an engineering choice where it is one.
2. `app/traversal/walk.py` — directed, typed, bounded traversal over
   `ParticipantTemporalGraph`, returning **paths**, not a `{node: distance}` dict.
   This is the shape change: `traverse_graph`'s return type cannot carry a path, so
   #96 is a new function, not an edit to that one.
3. `EvidenceTrace` — path, hop count, relation types in order, component scores,
   source snapshot ids, curated source refs, evidence strength. Assembled from
   `provenance_chain` + `TemporalEdge.curated_provenance`.
4. Seed adapter (SQL node → temporal node) with an explicit unmapped-seed report.
5. The invariant, enforced at the boundary rather than by convention: a result with
   no attributable observation or no score breakdown is not returned to an
   educator-facing consumer. Note that `AssemblyReport.identity_is_usable == False`
   (any pre-#107 row for that participant) must trip this too — every temporal claim
   over such a participant is void, and a traversal result is a temporal claim.
6. Keep undirected BFS and keyword as named comparison baselines; report fixed-rule
   traversal as its own condition in the benchmark, separate from anything learned.
7. Tests: `causes`, `buffers`, reverse-direction rejection, cycles, missing
   provenance, red herring — plus a Japanese fixture, since #107's defect was
   Japanese-only and an English-only suite did not catch it.

### Where it plugs in

`research_pipeline.search_similar_graph_patterns` is the integration point, and
`retrieval_mode` is already a versioned string (`"graph_semantic_v2"`,
`:1052`/`:1063`) — so the new traversal lands as a new mode next to the old one
rather than replacing it in place. That is also what keeps the old path available as
the comparison baseline the issue requires.

---

## #97 — early-warning dynamics

Independent of #96; can be done in parallel by a second person. Its stated blocker
(#91, the fictional population prior) is already merged — `analytics/baseline.py`
now returns `(None, "none")` below `RAMP_UP_DAYS = 14` and has no population branch
at all.

### What exists

`research_pipeline.py:1934–1957` computes per-feature `mean`, `trend`,
`consistency`, `change_rate`, `volatility`, `recurrence` over a window of
`DailyFeatureAggregation` rows. This is the "volatility-like longitudinal features"
the issue refers to. Four defects make it unusable as-is for early-warning work:

**1. Missing days are coerced to zero.** Line 1945:

```python
values = [float(vector.get(name) or 0.0) for vector in vectors]
```

A feature absent on a day becomes `0.0` and is then averaged, differenced and
variance'd as if it had been measured at zero. This is precisely the
"never coerce absence to a normal-looking zero" invariant, violated in the exact
place #97 is meant to build on.

**2. A single observation reads as perfect stability.** Line 1951 divides by
`max(1, len(values))`, so `n = 1` gives variance `0`, therefore `volatility = 0` and
`consistency = 1.0`. A student who wrote once is reported as maximally consistent.
This is the false-positive mode #97 asks to be measured, currently baked into the
input.

**3. Consecutive rows are treated as consecutive days.** Line 1949:

```python
deltas = [b - a for a, b in zip(values, values[1:])]
```

If the student wrote on the 1st, 2nd and 9th, this differences the 2nd against the
9th as a one-step change. Any lag-1 autocorrelation computed the same way is not
lag-1 *in time*. **This is the decision to make before writing code**, and it should
be written down before results are looked at: either resample onto a daily grid with
explicit gaps, or define the lag in observations and say so in the output and the
UI wording. It cannot be left implicit — the whole critical-slowing-down framing
depends on the lag meaning what it appears to mean.

**4. No minimum-observation gate.** `n_days_observed` is recorded (`:1935`) and
nothing refuses to compute on the strength of it.

### Work items

1. `app/analytics/dynamics.py` — rolling variance and lag-1 autocorrelation over an
   explicitly named, documented feature list. Not "every key present in the
   vectors"; a chosen list, since these are the quantities the early-warning claim
   rests on.
2. A pre-declared parameter block — window length, minimum observations, irregular
   spacing rule, missing-day rule — fixed *before* looking at outputs, in the spirit
   of the #90 pre-registration that is already merged. `RAMP_UP_DAYS = 14` is the
   existing precedent for a minimum, and reusing it is defensible.
3. A three-valued return: computed / `not_enough_data` / `not_computable`, never a
   number standing in for absence.
4. Output envelope: observation window, raw feature series reference, calculation
   version, quality flags. `PIPELINE_VERSION` in `writing_dynamics.py:7` is the
   convention to follow.
5. Synthetic series: stable, noisy, gradually destabilising, missing-data,
   irregularly spaced. **Report the false-positive rate on the stable series** — an
   early-warning indicator without a measured false-positive rate on flat input is
   an untested claim.
6. Wording review across API and UI: variability and persistence only. No risk band,
   no predicted transition. `docs/educator_display_policy.md` is the standard this
   has to clear.
7. Docs: "critical-slowing-inspired exploratory indicators", separated from
   validated clinical early warning, with the primary sources checked rather than
   cited from memory.

---

## #98 — Stage 1 policy training

**Gated by an issue in the other category.** The reward is defined as "reaching
human-labelled evidence", and that evidence is #88 (60–100 human-labelled cases),
which is open and not yours. Today `services/benchmark_cases.py` holds **6** cases —
`sleep_chain_{en,ja}`, `chain_red_herring_{en,ja}`, `vocab_disjoint_{en,ja}`. Six
cases cannot be split into train / validation / test without leakage, so the
"separated without paraphrase or chain leakage" AC is unreachable at current data
volume. #90 (pre-registration) is merged, so the protocol side is ready.

### What can be built now, without #88

The environment and the baseline harness — everything except training:

- The MDP written down explicitly: state, typed-edge action set, stop action,
  transition, episode limit, terminal conditions. The action set *is* #96's relation
  table, which is the strongest argument for doing #96 first and doing it cleanly.
- The four comparison policies the issue requires — keyword, undirected BFS
  (`traverse_graph`, unchanged, as the baseline it now becomes), #96 deterministic
  traversal, and random/chance. `benchmark_retrieval.py` already computes and reports
  a chance level, so the slot exists.
- The metric set: success rate, nDCG@5, path length, invalid-action rate, seed
  variance, broken out by case family and language. `METHODS`
  (`benchmark_retrieval.py:28`) is where a new condition is registered.

Then when #88 lands, only the training data changes. This is worth doing in this
cycle: it converts a hard external dependency into a data drop.

Do not start policy training on 6 cases. A policy that scores well on them has
memorised them, and the benchmark was rebuilt in #86 specifically to stop that class
of result from looking like a finding.

---

## #99 — Stage 2 hierarchical Bayesian

Out of scope. Its entry gate — a data-sufficiency analysis (#62, other category),
enough real consented data, governance approval, a written estimand — is not met on
any of the four conditions, and the issue itself says it exists to record the gate
rather than to be built now.

**One thing is worth doing now.** #91 deleted `POPULATION_BASELINE`; nothing stops it
returning under a different name. `grep -rn POPULATION app/ tests/` currently returns
nothing, and `tests/test_baseline_provenance.py` asserts the provisional-flag
behaviour but not the absence of a synthetic prior. A regression test that fails if a
population-level default reappears in the baseline path costs ten minutes and is the
entire practical content of #99 until the gate opens.

---

## #100 — Stage 3 learned attention

Out of scope this cycle, and the issue's own entry gate says so: it needs the
deterministic baseline stable (#96, not started), a labelled corpus past a
sufficiency threshold (#88, other category), and #90-style pre-registration of the
hypothesis (merged — that one is ready).

The one thing to protect while doing #96 is that the model inputs #100 will need —
node type, relation type, direction, time, provenance — survive into whatever
representation #96 produces. They all exist on `TemporalNode`/`TemporalEdge` today.
If #96's traversal flattens them into a score, #100 starts by rebuilding them.

---

## #101 — curated / personal / candidate layers

**More of this is already true than the issue implies**, because #95 built the first
two layers to be separable.

### Already satisfied

- **Layer 1, curated.** `ontology/seed/*.yaml` + `ontology/sources.py` registry +
  `ontology/seed_graph.py`, which resolves every `source_ref` at load time and treats
  an unknown id as an error, not a warning.
- **Layer 2, personal.** `PersonalObservation` (`temporal/model.py:209`) always
  carries a `SnapshotRef` and deliberately carries **no** `source_refs`.
- **The separation is enforced, not documented.** `CuratedProvenance` and
  `PersonalObservation` share no field name, and `test_provenance_separation` fails
  if they ever do — so a guideline citation cannot land where a journal entry
  belongs, at the type level.
- **Curated cannot overwrite personal.** `CuratedProvenance.relation_type` is
  "recorded, never applied — a disagreement with what the extractor produced is a
  finding, not an error to correct" (`model.py:261–263`).
- **Contradictions are retained as events.**
  `EventKind.CONTRADICTION` with `ContradictionKind.OPPOSITE_POLARITY`,
  same-day and across-day scopes, resolution recorded as "both edges kept; the
  assembler does not adjudicate" (`assemble.py:828–845`).
- **History is reconstructable.** The event log is append-only and `graph.at(day)`
  replays it to any past day (`model.py:648`).

### Genuinely missing

1. **Layer 3 — the candidate learned layer.** No schema. Needs model version, data
   version, confidence, supporting observations, counterevidence, reversible status.
2. **Revision operations.** add candidate / weaken / supersede / reject / restore are
   named in the issue and implemented nowhere.
3. **Precedence rules** across evidence strength, recency, reviewer decision and
   user-specific scope — without association becoming causation. The inputs exist
   (`EvidenceStrength` per relation, `intervals` for recency); the rule does not.
4. **Human review before promotion.** No review state, no reviewer identity, no
   promotion path.
5. **A graph-version audit log.** The temporal event log is per-participant and
   derived on read; #101 asks for reconstruction of every *graph* version, curated
   layer included.
6. **Conflict fixtures.** Curated-vs-personal conflict, bidirectional evidence, an
   erroneous high-confidence candidate. `sleep.yaml` is the only curated subgraph
   today, which is enough to write the first of these against. (#77/#78 add two
   more — other category, PRs #108 and #111 open.)

Do this after #96. Layer 3 exists to hold *learned* candidate edges, and until
there is a traversal worth learning against, the schema would be written against a
hypothetical producer.

---

## Recommended order

```
merge PR #109  (unblocks everything below)
      │
      ├── #96 deterministic traversal ──┬── #98 MDP + baselines  (training waits on #88)
      │                                 └── #101 candidate layer + revision ops
      │
      └── #97 early-warning dynamics    (parallel, different person, no overlap with #96)

#99  → one regression guard now; the rest waits on real data + governance
#100 → waits on #96 stable + #88 volume
```

Two people can work this cycle without colliding: #96 touches
`analytics/graph_index.py` and `services/research_pipeline.py:960–1075`, #97 touches
`services/research_pipeline.py:1934–1957` and a new `analytics/dynamics.py`. The
same file, but non-overlapping regions.

## What is worth saying out loud

Three of the seven issues (#98, #99, #100) are gated on work in the other category —
#88's labelled corpus, #62's sufficiency study, and real consented data. That is not
a scheduling problem to route around; it is the correct shape. But it does mean the
honest deliverable for this cycle is **#96 + #97 + #101**, with #98's environment
built ready for data, and #99/#100 explicitly deferred behind their documented gates
— which is exactly what #102's Definition of Done asks for: each layer implemented
and evaluated, *or* explicitly deferred behind its gate. "An issue mentions the
concept" does not count.
