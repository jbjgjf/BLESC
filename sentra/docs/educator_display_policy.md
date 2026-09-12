# Educator display policy

**Decided 2026-08-06.** The educator surface shows observations. It does not
show a risk classification.

## The distinction

Two different products can be built from the same data:

| | claim | what it needs |
| --- | --- | --- |
| **triage aid** | "the student wrote a direct statement about self-harm at 22:14" | nothing — it is constitutively true |
| **screening instrument** | "depression risk: high" | ground-truth labels, IRB, prospective study, sensitivity and specificity |

"They wrote 死にたい" is a fact. "Risk: high" is an inference about a minor's
internal state. Both come from the same data; they are not the same object, and
only one of them needs validating.

## Why the band was removed rather than validated

Not a validation deficiency — arithmetic. A school of 1000 students at 5%
prevalence of serious depression:

| sensitivity / specificity | flagged | true | false | PPV |
| --- | --- | --- | --- | --- |
| 80% / 90% | 135 | 40 | 95 | **30%** |
| 90% / 95% | 93 | 45 | 48 | **49%** |
| 95% / 99% | 57 | 48 | 10 | **83%** |

Established instruments such as PHQ-9 reach roughly 80–90% sensitivity and
specificity against structured interview, so the realistic row is the first:
**seven in ten students shown "risk: high" would not be cases.** The third row
is not reachable from conversational text at all.

Better models move these numbers. They do not fix them. Any binary judgement
imposed on a low-prevalence population carries this, so completing the clinical
validation in M-02 would not make the band safe to display — which is why the
display change does not wait on M-02, and why M-02 finishing would not
retroactively justify the band.

## Rules

1. **No risk classification is rendered.** `state_band` and `latest_score` are
   still computed and stored; they are not shown, not counted in a tile, and
   not used to order a list. Ordering by band would put the classification back
   into the interface through the sort.
2. **Every observation carries its evidence and timestamp.** An observation
   with no reasons is not displayed at all — a flag an educator cannot trace
   back to something the student wrote is worse than no flag.
3. **Provenance is stated.** "safety.py の決定的マッチ / 推論なし" appears under
   each observation, so an educator can tell a lexicon match from a model
   judgement.
4. **Context only against a settled baseline.** While
   `baseline_provenance.is_provisional` is true, the comparison line is
   replaced by "基準値の学習中（残り N 日）", and no score reaches the band or
   the alert list. Originally this was because the ramp-up comparison ran
   against guessed population statistics (D-04). Those were deleted in #91, so
   there is now no comparison at all during ramp-up — the rule stands unchanged
   and its reason is simpler: there is nothing to compare against yet.
5. **Every educator surface states that the tool does not diagnose.**

## What is still written

`anomaly_score` is **no longer written** to `insights` as of this change; the
column and existing rows remain. Retention of a risk classification attached to
an identifiable minor is the compliance question, and it is not answered by
hiding the value — so new writes stopped at the same time as the display
change. Deleting historical rows is irreversible and waits on legal advice.

**Correction, and how long it took to notice.** "New writes stopped" was true
only of the FastAPI backend, which honoured `PERSIST_ANOMALY_SCORE = False` from
2026-08-06. Production does not use that backend: submissions go to the Next.js
route handler and every row lands in Supabase. That path went on writing a score
on every submission for the two months after this policy was decided — and the
value it wrote had no baseline behind it, being
`1 + triggers*0.8 - protective*0.25 + relations*0.05` over a single entry.
`longitudinal_features.latest_anomaly_score` accumulated the same value into a
time series. Both are now gated on the same constant, and reads are gated too,
so rows written during that window stop rendering as measurements. See
`production_baseline_path.md`.

The general lesson is worth keeping: a policy enforced in one of two
implementations is not enforced. This one was written as a decision about the
product and applied to the codebase that happened to be in front of the person
applying it.

`state_band` is derived client-side from `anomaly_score` and was never stored.

### Second instance: the demo educator screens (#175)

The same failure, in the same shape, found on 2026-09-10 during the #116
message-catalogue migration and fixed in #175.

This policy was applied to `src/app/educator/` — the screens that read real
data — and not to `src/lib/blesc/`, the fixtures the demo screens are built
from. `/educator/class` went on painting a three-way band (`calm` / `watch` /
`alert`) across all 33 students of the demo class: rendered as a colour, counted
in a legend, and carried in each cell's `title`. `TRENDS` went further than the
band, offering 悪化傾向 / 改善傾向 — not a classification of the state but a
judgement about its direction, which is the inference about a minor's internal
state this document is named after.

No real student data flowed through those screens; they are reachable only under
`next dev`, `NEXT_PUBLIC_DEMO_MODE=1` or `?demo=1`. That is what made it a P1
rather than a P0, and it is also what made it worse than a display bug: **the
demo is the artefact shown to schools.** The demo's own narration told the
viewer 「リスクの判定は表示しません」 while the next screen displayed one.

What changed:

- `BANDS`, `BAND_ORDER` and `TRENDS` deleted from `lib/blesc/labels.ts`;
  `RiskBand`, `Trend`, `StudentSummary.band`, `StudentSummary.trend` and
  `TimelineItem.direction` deleted from `lib/blesc/types.ts`.
- The fixtures no longer derive anything from a band. Support status and
  follow-up presence are explicit tables again — deriving "a meeting was held"
  from a model's judgement meant the judgement survived in the shape of an
  operational record even after the colour was removed.
- `/educator/class` rebuilt as observations (what, when, which surface, on what
  grounds) over a roster ordered by last submission, with the ordering stated on
  the screen. Rule 1 is about the sort order as much as the colour.
- The band's CSS — the dot modifiers and a set of dead `[data-band]` rules still
  sitting in the real roster's stylesheet — removed. The rules rendered nothing,
  because that page emits no such attribute; they were one attribute away from
  rendering again.

**Why a scan now exists.** Two instances is a pattern, and both were found by
accident while doing something else. Review does not catch the third instance
either, because the third instance will also be in the file nobody thought to
open. `sentra/frontend/tests/educator-display-policy.test.mjs` scans every
source file for the classification vocabulary and for the `data-band` attribute,
and fails on it. The equivalent guard on the landing page is
`jbjgjf/BLESC-website#15`.

## Relationship to the landing page

Rows ② (second clause) and ④ of the LP's technical claims are changed to match
this policy. Leaving the LP claiming a risk judgement the product no longer
makes would be the least defensible of the available states. See
`M-01` in the external review and `docs/lp_claim_alignment.md`.

## Open

- Legal review of retention and SaMD applicability, before deployment.
- M-02 remains open, but is no longer a blocker for the educator surface.
