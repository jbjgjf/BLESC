# Ontology evolution, belief revision, and graph structure learning (#101)

Three different operations that "self-changing ontology" named at once. They have
different owners, different evidence, different failure modes, and different
review requirements — and the reason to separate them before building any of them
is that the version where they are one thing has no answer to "who decided this".

| | question it answers | owner | changed by | wrong-answer cost |
| --- | --- | --- | --- | --- |
| **Ontology evolution** | what does the vocabulary contain, and what does published knowledge say? | a human curator | review, deliberately, rarely | a clinical-looking claim nobody stands behind |
| **Belief revision** | given claims that disagree, what do we hold now — and what did we hold before? | the log | every new observation or decision | history rewritten; "we always knew" |
| **Graph structure learning** | what edges might exist that nobody has written down? | a model | retraining | fabricated structure presented as knowledge |

This issue builds the **first two** and the **gate the third has to pass**. It
builds no learner. `evolution.layers.NOT_IMPLEMENTED_HERE` says so and a test
fails if that list is emptied.

**Ontology evolution** is a curation activity. Adding `escalates` to the relation
vocabulary, or accepting that `regular_sleep_schedule buffers sleep_deprivation`
belongs in the curated graph, is a decision a person makes and signs. It is slow
by design. Nothing in this repository does it automatically and nothing should.

**Belief revision** is what happens when claims arrive that disagree with claims
already held. A participant writes that the trusted adult they were supposed to
turn to makes things worse; a guideline says such contact is protective. Belief
revision is not choosing between them — it is holding both, in the right layers,
with the disagreement recorded, so that "what did we believe in March" has an
answer. That is `revision.RevisionLog`.

**Graph structure learning** is a model proposing edges from data. It is the only
one of the three that can invent a claim nobody has considered, which is why it
is the only one behind a gate (`gate.py`) and the only one that cannot reach the
curated layer without a named human signing for it.

## The three layers

```
curated     source-backed, reviewed, rarely changed        owner: a curator
personal    one participant's own entries, append-only     owner: the participant
candidate   a model's proposal, freely mutable             owner: the model
```

The rule is **one-directional**: curated knowledge freely informs how a personal
observation is read; a personal observation never edits curated knowledge, and a
candidate never enters it without a recorded human review.

Enforcement is structural, not conventional:

- the three edge types share no field that would let one be passed where another
  is expected — `CuratedEdge` has `source_refs` and `evidence_strength`,
  `PersonalEdge` has `observations` and neither of those, `CandidateEdge` has
  `model_version`/`confidence` and neither of the others;
- `MUTATION_POLICY` names exactly which `Actor` may perform which
  `RevisionOperation` on which `Layer`, and `Actor.PARTICIPANT` and `Actor.MODEL`
  are simply absent from the curated layer's writers;
- `revision.apply` calls `check_permitted` first and raises `LayerViolation`
  rather than returning quietly, because a refused write that looked like a
  success is worse than one that failed.

`PersonalEdge` deliberately has no `source_refs` and no `evidence_strength`. A
journal entry is not a citation, and grading it on the scale used for published
material would put a student's Tuesday on the same axis as NICE NG134. It is the
same separation `temporal.model` enforces between `PersonalObservation` and
`CuratedProvenance` (#95), one level up.

## Revision operations

| operation | layer | effect |
| --- | --- | --- |
| `observe` | personal | append what an entry said |
| `add_candidate` | candidate | a model proposes an edge |
| `weaken` | candidate | lower confidence or attach counterevidence, without rejecting |
| `supersede` | candidate | a different claim now covers this one |
| `reject` | candidate | ruled out, with a recorded reason |
| `restore` | candidate | undo a rejection or supersession |
| `promote` | curated | a **reviewed** candidate enters curated knowledge |
| `record_contradiction` | — | two claims disagree; nothing is changed |

`weaken` exists because a claim can lose support without becoming false, and a
system whose only options were keep and delete would force one of those.

`restore` returns a candidate to `proposed`, not to whatever state it held
before. A restore is a fresh decision to reconsider; reinstating an earlier
confidence would carry forward a number nobody has re-examined. The *weakened*
confidence stands until someone re-examines it.

Every operation that lowers or removes a claim requires a written reason.
A rejection with no recorded reason cannot be argued with later, which makes the
log a record of decisions nobody is allowed to have been wrong about.

`record_contradiction` changes nothing on purpose. A curated edge and a
participant's entry pointing opposite ways is not an error to resolve; a system
that resolved it would be picking between a guideline and a student without
being told how.

## Precedence

Precedence returns **two answers, not a winner**:

- `general` — what published knowledge says about people;
- `about_participant` — what is known about this person.

A participant's own account outranks a guideline *for describing that
participant*, and never for anybody else. Collapsing those into one ranking means
either generalising from one student or overriding a student's own account with a
population statement — wrong in opposite directions, which is why the resolution
has two fields instead of a sort order.

Within a scope, strongest first:

1. **Reviewer decision** — a curated edge is by definition one a human accepted.
2. **Layer** — curated, personal, candidate. A proposal never outranks a record
   of something that happened.
3. **Evidence strength** among curated claims — causal, association, expert
   judgement.
4. **Recency**, as a tie-break only. A newer claim of the same kind supersedes an
   older one; a newer claim of a *weaker* kind does not.

### Association is never causation

`Resolution.causal_support` is true only where a claim's `evidence_strength` is
`CAUSAL`. It is **never** inferred from the relation type. `causes` +
`ASSOCIATION` is the normal, legitimate combination this repository deliberately
preserves (`ontology/schema.py`): the graph models a direction, the literature
reports a correlation, and the gap stays visible.

`PersonalEdge.asserts_causation` and `CandidateEdge.asserts_causation` return
`False` unconditionally. A participant reporting a link is not evidence of one,
and a model's confidence is not evidence strength at any value — including 1.0.

## The audit log

The log is the ontology; the layers are a projection of it. `state_at(n)` replays
the first *n* events, so "what did the ontology hold at version 12" is answered by
replay rather than by memory. Nothing is edited and nothing is removed — a later
event cannot change an earlier version, which is asserted directly.

An operation naming an edge the projection has not seen is ignored rather than
raising: a log loaded from a longer history may legitimately begin mid-story, and
refusing to replay it would make partial audits impossible.

This is a different log from `graph_change_events` in the research schema, which
records changes to one participant's *extracted* graph. This one records changes
to the *ontology* — to what is held as knowledge, across all three layers.

## The gate on structure learning

`gate.py` is what #99 and #100 are blocked on. It does no learning: it scores a
set of proposed edges against cases declared in `held_out_edges.yaml` before any
learner existed.

Three kinds of case, and the second is the one that decides:

- **held-out true** — real curated edges withheld from training. Recall over
  these says the learner can find structure that is actually there.
- **red herring** — plausible and *not* curated. Every one is a pair a human
  might well propose: two nodes at either end of a real chain, or a pair the
  curation deliberately types as `co_occurs` rather than `causes`. A learner
  proposing these is not "nearly right"; it is manufacturing clinical-looking
  claims, which is worse than proposing nothing.
- **negative** — unrelated pairs. The easy case, present so a red-herring failure
  cannot be dismissed as the gate being uniformly harsh.

The thresholds are asymmetric on purpose — missing a real edge costs a feature,
adding a plausible wrong one adds a clinical-looking claim to a product shown to
people who support children:

```
min_recall                    0.60
max_red_herring_rate          0.10
max_false_positive_rate       0.20
min_labelled_edges              20
max_unlabelled_proposal_rate  0.30
```

**The gate fails closed.** Too few labelled cases, proposals from mixed model
versions, or too much output the labelled set says nothing about, and the result
is `passed = False` with the reason. A learner is not cleared by an evaluation
set too small to catch it. A learner that proposes nothing fails on recall rather
than passing by silence.

Confidence is deliberately not used as a filter. A learner that wants a threshold
applies it before calling, so "we would have passed at 0.9" is a claim someone has
to make out loud rather than one the gate makes for them.

**Passing is not a certificate.** It is a threshold comparison over ~24
hand-labelled edges from three curated subgraphs — enough to catch a learner that
fabricates, nowhere near enough to establish that one works. Passing makes a
candidate eligible for a human to look at; `revision.promote` still requires a
named reviewer, and the reviewer named on the promotion must be the same person
named on the edge.

## What is loaded from where

`bridge.py` fills the layers from what already exists, and invents nothing:

- `curated_edges_from_seed()` reads the seed YAML. The seed files carry no
  reviewer, which is the honest state of things — they were written by one person
  and reviewed by nobody else. Rather than leave `reviewed_by` blank, which
  `CuratedEdge` refuses, they are attributed to `blesc-ontology-seed` and
  `seed_attribution()` says what that does and does not mean. A curated layer
  claiming a review nobody performed would be worse than one admitting the review
  is outstanding.
- `personal_edges_from_graph()` reads the participant temporal graph (#95). The
  curated provenance on a temporal edge is deliberately **not** carried across: an
  edge that matched a seed edge is still a record of what one participant wrote,
  and copying the seed's citations onto it is exactly the merge these layers exist
  to prevent.

## Limits

- **Nothing is persisted.** The log is built from events on read, following #95's
  "derived, not stored" decision. A durable audit trail needs a table and a
  migration; the contract is defined here so that the table has something to
  store.
- **The seed graph has not been clinically reviewed.** Every curated edge is
  attributed rather than reviewed, and `promote` cannot retroactively supply a
  review for edges that were already there.
- **The held-out set is small and hand-written.** 24 cases from three subgraphs,
  chosen by the same people who wrote the subgraphs. It catches fabrication; it
  does not establish coverage.
- **The gate is not run automatically** against anything, because there is nothing
  to run it against yet. That is the point: #99 and #100 have somewhere to report
  to before either exists.
