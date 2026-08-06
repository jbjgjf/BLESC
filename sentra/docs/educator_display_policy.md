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
   replaced by "基準値の学習中（残り N 日）". During ramp-up the comparison is
   against guessed population statistics (D-04) and would read as evidence
   while carrying none.
5. **Every educator surface states that the tool does not diagnose.**

## What is still written

`anomaly_score` is **no longer written** to `insights` as of this change; the
column and existing rows remain. Retention of a risk classification attached to
an identifiable minor is the compliance question, and it is not answered by
hiding the value — so new writes stopped at the same time as the display
change. Deleting historical rows is irreversible and waits on legal advice.

`state_band` is derived client-side from `anomaly_score` and was never stored.

## Relationship to the landing page

Rows ② (second clause) and ④ of the LP's technical claims are changed to match
this policy. Leaving the LP claiming a risk judgement the product no longer
makes would be the least defensible of the available states. See
`M-01` in the external review and `docs/lp_claim_alignment.md`.

## Open

- Legal review of retention and SaMD applicability, before deployment.
- M-02 remains open, but is no longer a blocker for the educator surface.
