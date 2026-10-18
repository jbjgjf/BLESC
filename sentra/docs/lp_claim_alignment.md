# LP claim alignment — decision record

Raised as M-01 in the external technical review of `d7b33e8`.
**Decided 2026-08-06.**

Four claims on the landing page were checked against the implementation. Two
are being brought into line by changing the product (option B), two by changing
the page (option A).

| # | claim | decision | state |
| --- | --- | --- | --- |
| ① | 医学的研究にもとづき構造化したオントロジー知識グラフ | **B** — build it | open, deadline below |
| ② | 入力のためらいから心理的リスクを検知 | split | **done** in the repository; in production only from #468 — see ⑧ |
| ③ | 科学的な裏付けが解析に厳密な根拠を与える | **B** — wire it | open, deadline below |
| ④ | 教員画面のリスク判定（高/中/低） | **A** — change the page | **done**, after regressing — see below |

## ② — split, because the two clauses are not the same kind of claim

> **2026-10-18 (#468).** This row said **done** while blesc.online computed
> none of it: `writing_dynamics.py` runs in the FastAPI pipeline, which is
> local-only (ADR 0001). "Done" was true of the repository and false of the
> product — the ④ failure again. The kept half became true in production with
> ⑧ below; read the bullets that follow as describing the repository until then.

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

### It came back, and this table said it had not — 2026-09-10

The band was live on the landing page again while this row read **done**.

The LP was rebuilt in a separate repository (`jbjgjf/BLESC-website`). The
decision lived here, the copy moved there, and nothing compared the two, so the
rewrite reproduced the original page including the part that had been removed
from it. Both mocks carried the band again — `Product.tsx`, which renders, and
`StepMockups.tsx`'s `ReportMock`, which does not.

Removed a second time in `jbjgjf/BLESC-website#16`, along with the
`--risk-high/mid/low` tokens, so `bg-risk-high` no longer resolves to anything.

**The more useful finding is not the band.** A decision record that reported
`done` for a state that had reverted is a record that cannot be used to answer
"is the page correct" — which is what it exists for. Marking ④ done was true of
the repository it was written about, and nobody re-checked it after the code
moved. The same is true of any row here.

So the check is no longer a memory. `jbjgjf/BLESC-website` now holds
`docs/claims.md` — what the page may and may not say, sourced from
`product_policy.md`, `educator_display_policy.md` and this file by link and
summary rather than by copy — and `scripts/check-claims.mjs` fails CI on
band vocabulary, the band's own colour tokens, a condition named as the object
of 検知/判定/診断/解析, and institution names not on a permission list. Run
against the pre-fix page it reports 14 violations. It does not know whether
*this* document is current; it does know whether the page contradicts it.

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

### Progress against that definition, 2026-09-10

| requirement | status |
| --- | --- |
| first curated subgraph (①) | **done** — three now: `backend/app/ontology/seed/{sleep,social_withdrawal,academic_pressure}.yaml`, 40 nodes / 50 edges, each carrying a source id into `ontology/sources.py` |
| written scope | **done** — `clinical_reviewer_packet.md`, two questions, one hour, with what is explicitly not being asked |
| named clinical collaborator | **open** — the packet is ready to send; the name is not filled in. Tracked in #128 |
| documented source → weight mapping (③) | **open** — depends on the reviewer's answers |

Still two of four. The subgraph requirement is now met three times over; the
remaining blocker on ① is a name, not engineering.

```
Collaborator:  [ 未記入 ]
Scope agreed:  [ 未記入 ]
Sent on:       [ 未記入 ]
```

### The institution names came off the page early — 2026-09-10

Separate from the ①③ deadline, and not waiting for it.

The LP named 京都大学 and 株式会社Hatapro as settled collaborations — "このモデル
は京都大学の臨床心理学研究との協働によって開発しています" — while the block
above was blank. Confirmed with the owner on 2026-09-10: the university
discussion is **verbal and ongoing**, and Hatapro has given **no permission**
for its name. Naming either in B2B copy aimed at schools and boards of
education is an unagreed use of their name, so both were removed in
`jbjgjf/BLESC-website#16` (`jbjgjf/BLESC-website#14`). They go back the day the
permission is on file, with the scope of the collaboration written alongside —
"協働によって開発しています" reads as supervision, joint research or advice
equally, so it does not go back in that form.

Removing the names is **not** the ①③ conversion. ① is now carried by the
artifact rather than by a collaborator: the page describes three curated
subgraphs sourced to WHO adolescent MH, NICE NG134, WHO mhGAP and 文科省
生徒指導提要, with unsourced edges marked `expert_judgement` rather than left to
imply a source. What was dropped alongside the names is 「臨床心理士の思考
プロセスを機械可読な形で再現」, which 40 nodes does not support at any level of
provenance. ③ is untouched and still open.

The 2026-09-30 deadline therefore still stands for ③, and the automatic
conversion on 10-01 still applies to it.

## 2026-10-18 — the site against production, not against the repository

Raised by comparing blesc.jp (`jbjgjf/BLESC-website` `77ab1b6`) with what
blesc.online actually runs (`a55ef83`), rather than with what this repository
contains. Five gaps; four needed an owner decision, taken on 2026-10-18.

| # | claim on blesc.jp | decision | state |
| --- | --- | --- | --- |
| ⑤ | 危機時、生徒の画面に相談窓口（24時間子供SOSダイヤル）が出る | fix (#465) — product | **done** |
| ⑥ | 先生に表示されるのはクラス・出席番号・表現の種類・時刻だけ | **B** — change the product (#466) | see below |
| ⑦ | AIが日記を受けて短い問いをひとつ返す | **A** — change the page (#467) | **done** |
| ⑧ | 書きぶりの変化と、これまでと比べた変化を捉える | **B** — change the product (#468) | **done**, thresholds unvalidated |
| ⑨ | 日記をAIモデルの学習に使うことはありません | **A**, with disclosure added (#469) | **done** |

### ⑤ — the promised line was nowhere in the product (#465)

The page names 文部科学省「24時間子供SOSダイヤル」 0120-0-78310. The product's
crisis and elevated responses named no line and no number, glossed half their
words in English, and the journal screen did not render them at all.

The lines now live in `sentra/shared/crisis_contacts.json` and
`frontend/src/lib/crisisContacts.ts` (pinned to each other by
`crisis-contacts.test.mjs`). Both responses are built from them; chat, the
journal card and voice all carry them; and `jbjgjf/BLESC-website`'s
`scripts/check-crisis-contacts.mjs` fails that repository's CI when the site's
`SOS_DIAL` and this file disagree.

**Still open:** the number and hours have not been read off the official page
by a person. `verification` in `crisis_contacts.json` says so, and stays
`unverified` until someone fills in who and when.

### ⑧ — option B (#468)

The page says Blesc captures changes in how a student writes — hesitation and
rewriting — relative to that student's own past. Production now does:

- `frontend/src/lib/writingDynamics.ts` ports `writing_dynamics.py` to the
  Next.js path, pinned to it by `shared/writing_dynamics_conformance.json`
  (both suites run it).
- Each journal submission with telemetry consent writes `writing_features`;
  once a student has 14 qualifying days of their own, the entry is compared
  with them, and a feature beyond 2 of the student's own SDs is stored as a
  `writing_change_observations` row (feature + direction only).
- Educators see 「観測（書きぶりの変化）」 with the time, the input source and the
  basis — no number, no text, no inferred state. It does not raise 要確認.
- Nothing is compared or observed in a collection window.

**Still open:** the 2.0 SD threshold and the 5-edit floor for a qualifying day
are engineering choices with no validation; there is no backfill, so the first
observations appear about 14 qualifying days after deploy; days are bucketed
in UTC.

### ⑦ — option A (#467)

The journal asks a fixed script (`followup-script-v1`) of up to three
questions, only on hard days or short entries, and not at all in a pilot's
collection window. None of it is generated from the entry. The page said an AI
read the diary and returned one question. The page now describes the script;
generating a question per entry would need its own cost, safety-review and
versioning decisions (#133), none of which were wanted for this.

### ⑨ — option A, and the page now says where the text goes (#469)

The optional, opt-in model-training consent (consent pack §15,
`consent_records.model_training_use`) stays. 「学習に使うことはありません」 could not
stand beside it, so the page now says a diary is never used for training
without that separate consent. The page also now states, which it did not,
that outside a collection window the text is sent to an external AI provider
(OpenAI, United States) for extraction, and that data is stored with Supabase
(Singapore). The site, the consent pack and the export's
`model_training_use` column take the same position.

## Related

- `educator_display_policy.md` — why ④ became A and what the product shows now
- `rumination_index_provenance.md` — D-03, which ③ depends on
- M-02 — clinical validation, still open, no longer blocking the educator
  surface
- `jbjgjf/BLESC-website` `docs/claims.md` — the same rules, stated where the
  copy is written, and checked in that repository's CI. Where the two disagree,
  this file wins; it is the decision record and that one is its enforcement
- #128 — the remaining ①③ blocker: sending the packet and filling in the name
