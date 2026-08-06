# `rumination_index` — provenance dossier for clinical review

**Status: UNRESOLVED. Awaiting expert sign-off.**
Raised as D-03 in the external technical review of `d7b33e8` (2026-08-06).
This document exists so a qualified reviewer can decide; it is not itself a
justification, and nothing here should be read as one.

## What the code does

`app/analytics/cognitive_probe.py`:

```python
rumination_index = min(1.0, (negative_density * 0.45)
                          + (self_ref_density  * 0.30)
                          + (perseveration     * 0.25))
```

where, over the tokens of a student's 30-second free recall:

| term | definition |
| --- | --- |
| `negative_density` | share of tokens in a hand-written negative-affect vocabulary |
| `self_ref_density` | share of tokens in a first-person vocabulary |
| `perseveration` | share of token positions that are repeats (`1 - unique/total`) |

## The question D-03 asks

Where do 0.45, 0.30 and 0.25 come from?

**They have no source.** They appear in no commit message, comment, document or
issue. They were chosen, not derived. The metric nevertheless carries the name
of a clinical construct and, through the educator surface, informs decisions
about identifiable minors.

## What the literature actually specifies

The reference instrument for rumination is the **Ruminative Responses Scale
(RRS)**, and its short form from Treynor, Gonzalez & Nolen-Hoeksema (2003),
which removed items overlapping with depressive symptoms and resolved into two
factors:

- **Brooding** — passive focus on the reasons for one's distress; self-critical
  comparison against a standard
- **Reflection** — cognitive problem-solving directed at improving mood

Three properties of the RRS bear directly on this metric:

1. **It is a self-report questionnaire.** Ten Likert items that a person answers
   about themselves.
2. **Scoring is an unweighted mean** of the items in each subscale. There are no
   factor weights of the kind used here.
3. **Brooding and Reflection are reported separately**, and carry different
   clinical significance — brooding is the component associated with depressive
   outcomes. A single scalar collapses that distinction.

Reported reliabilities: brooding α = .77, reflection α = .72 (Treynor et al.,
2003).

## Correspondence analysis

| | RRS | `rumination_index` |
| --- | --- | --- |
| modality | self-report questionnaire | lexical density over free text |
| response | person rates statements about themselves | inferred from word choice |
| scoring | unweighted mean of items | weighted sum, weights unsourced |
| structure | two factors reported separately | one scalar |
| validation | published psychometrics | none in this repository |
| population | validated adult and adolescent samples | none |

**No component of the current implementation maps onto an RRS item, subscale or
scoring rule.** The correspondence is nominal — the two share a word.

This is not an argument that lexical markers are uninformative about rumination;
there is a research literature on linguistic correlates of rumination, and
first-person pronoun density in particular has been studied. It is an argument
that *this* formula, with *these* weights, is not an implementation of *that*
instrument, and cannot cite it.

## What sign-off would require

For the clinical name to stand, a reviewer would need to establish at least:

- [ ] A defensible basis for the three components and their relative weights —
      derived from data, from a published linguistic-marker model, or from
      documented expert judgement recorded as such
- [ ] Whether a single scalar is appropriate, or whether brooding-like and
      reflection-like signals must be reported separately
- [ ] The construct the score claims to estimate, stated precisely enough to be
      falsifiable
- [ ] Whether the free-recall probe is a valid elicitation for that construct
- [ ] Behaviour for Japanese text specifically. The vocabulary is hand-written
      and the tokenisation was only fixed on 2026-08-06 (D-01); no Japanese
      lexical-marker literature has been consulted for the term lists.

Absent that, the review's B option applies: rename to a descriptive term such as
`negative_self_focus_score` and state in the docstring, the API response and the
educator UI that it is exploratory and carries no clinical interpretation.

## Interim position

Until a reviewer signs the above, the code must not imply provenance it does not
have. The docstring records that the weights are unsourced. **This dossier is
not sign-off**, and the metric should not be presented to educators as a
clinical measure while it stands unresolved.

Related: D-04 (`POPULATION_BASELINE` is guessed, so z-scores over this metric are
not statistically meaningful during the 14-day ramp-up) and M-02 (no accuracy
validation of any risk output exists — no PHQ-9, K6, GAD-7, sensitivity,
specificity or AUROC appears anywhere in the repository).

## References

- Treynor, W., Gonzalez, R., & Nolen-Hoeksema, S. (2003). Rumination
  reconsidered: A psychometric analysis. *Cognitive Therapy and Research*,
  27(3), 247–259.
- Whitmer, A. J., & Gotlib, I. H. (2011). Brooding and reflection reconsidered:
  A factor analytic examination of rumination in currently depressed,
  formerly depressed, and never depressed individuals.
  <https://web.stanford.edu/group/mood/cgi-bin/wordpress/wp-content/uploads/2012/02/whitmer_gotlib_CTR_2011.pdf>
- RRS instrument documentation, Nathan Kline Institute / Rockland Sample.
  <http://fcon_1000.projects.nitrc.org/indi/enhanced/assessments/RRS.html>

These are cited as *what the construct's literature says*, to enable the
comparison above. **They are not sources for the current weights.**
