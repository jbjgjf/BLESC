# LP claim alignment — decision record

Raised as M-01 in the external technical review of `d7b33e8`.
**Decided 2026-08-06.**

Four claims on the landing page were checked against the implementation. Two
are being brought into line by changing the product (option B), two by changing
the page (option A).

| # | claim | decision | state |
| --- | --- | --- | --- |
| ① | 医学的研究にもとづき構造化したオントロジー知識グラフ | **B** — build it | open, deadline below |
| ② | 入力のためらいから心理的リスクを検知 | split | **done** |
| ③ | 科学的な裏付けが解析に厳密な根拠を与える | **B** — wire it | open, deadline below |
| ④ | 教員画面のリスク判定（高/中/低） | **A** — change the page | **done** |

## ② — split, because the two clauses are not the same kind of claim

- *"入力のためらいを捉える"* — **kept.** `writing_dynamics.py` implements it, it
  is wired into the pipeline, and its Japanese path was repaired in D-01. This
  half is a statement of fact.
- *"そこから心理的リスクを検知する"* — **changed**, for the same reason as ④. It
  is an inference about internal state, and leaving it would reproduce the ④
  problem in a different place on the same page.

Now reads: 「AIが捉えて可視化します。心理的リスクの判定は行いません」.

## ④ — option A

The mock educator screen showed 高/中/低 bands. The product no longer produces
them; see `educator_display_policy.md` for why that is arithmetic rather than a
validation gap. The mock now shows the observation layout the product actually
renders.

Both breakpoints carried the mock. Both were changed.

## ①③ — option B, with a deadline

Both require a clinical collaborator, not a supervisor lending a name:

- **①** needs a curated causal graph derived from WHO/NICE material. Today
  `ontology/validator.py` holds a 5-category × 6-relation schema and the graph
  is generated per conversation by an LLM. There is no pre-built medical causal
  graph, and the LP's own example (睡眠不足 → 認知機能の低下 → 抑うつ傾向) is
  encoded nowhere.
- **③** needs WHO/NICE material connected to the scoring weights. It also
  depends on D-03: weights with no provenance cannot be described as giving
  the analysis a rigorous basis, whatever they are connected to.

### Deadline: 2026-09-30

If a clinical collaborator is not secured **and work started** by
**2026-09-30**, ①③ convert to option A on **2026-10-01** — the LP text changes
to describe the schema and the retrieval as they actually are.

Eight weeks is chosen as long enough to find and engage a collaborator, and
short enough that the page is not describing an intention for a whole term. A
deadline-free option B is option C, which the review recommended against and
which nobody chose.

**Conversion is automatic.** It does not need a further decision on
2026-10-01; it needs a decision *before* then to avoid it.

### What "started" means

Not a meeting. A named clinical collaborator, a written scope, and either a
first curated subgraph (①) or a documented mapping from source to weight (③).

## Related

- `educator_display_policy.md` — why ④ became A and what the product shows now
- `rumination_index_provenance.md` — D-03, which ③ depends on
- M-02 — clinical validation, still open, no longer blocking the educator
  surface
