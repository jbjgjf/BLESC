# `negative_self_focus_score` — provenance dossier for clinical review

*Formerly `rumination_index`. Renamed 2026-08-09 (#82); the old name is kept in
this filename and in the history below so the trail is followable.*

**Status: PARTIALLY RESOLVED. Two of five checklist items closed by #81–#83;
three still need a clinician.**
Raised as D-03 in the external technical review of `d7b33e8` (2026-08-06).
This document exists so a qualified reviewer can decide; it is not itself a
justification, and nothing here should be read as one.

## What the code does

`app/analytics/cognitive_probe.py`:

As of #81–#83 (2026-08-09):

```python
brooding_like   = (negative_density + self_ref_density + perseveration) / 3
reflection_like = reflection_density
# emitted as negative_self_focus_score and reflective_focus_score, 0.0-1.0.
# No combined scalar.
```

Previously, and the reason this document exists:

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

| | RRS | `negative_self_focus_score` |
| --- | --- | --- |
| modality | self-report questionnaire | lexical density over free text |
| response | person rates statements about themselves | inferred from word choice |
| scoring | unweighted mean of items | unweighted mean (#81) — now matching |
| structure | two factors reported separately | two components reported separately (#83) — now matching |
| validation | published psychometrics | none in this repository |
| population | validated adult and adolescent samples | none |

**No component of the current implementation maps onto an RRS item, subscale or
scoring rule.** The correspondence is nominal — the two share a word.

This is not an argument that lexical markers are uninformative about rumination;
there is a research literature on linguistic correlates of rumination, and
first-person pronoun density in particular has been studied. It is an argument
that *this* formula, with *these* weights, is not an implementation of *that*
instrument, and cannot cite it.

## Checklist status

- [x] **A defensible basis for the weights.** Closed by #81. The three
      components are now an **unweighted mean**, which is the rule the RRS
      itself uses — its subscales are the average of their items, with no
      factor weights. Equal weighting is not a placeholder: it replaces three
      numbers that cannot be justified with one that can. The old
      0.45/0.30/0.25 are gone, and a test walks the module's AST to keep them
      out.
- [x] **Whether a single scalar is appropriate.** Closed by #83, in the
      direction the literature indicates: **two components, reported
      separately**. All three original inputs were brooding-side, so the old
      scalar was brooding-only under a name covering both factors. A
      reflection-side vocabulary now exists and `reflective_focus_score` is
      emitted alongside `negative_self_focus_score`. **No combined scalar is
      produced** — averaging them would reproduce the collapse, and there is no
      basis for weighting one against the other.
- [ ] **The construct the score claims to estimate**, stated precisely enough
      to be falsifiable. Open. Needs a clinician.
- [ ] **Whether free recall is a valid elicitation** for that construct. Open.
      Needs a clinician.
- [ ] **Behaviour for Japanese specifically.** Partially addressed: the
      tokenisation was repaired in D-01 and the vocabularies now declare their
      provenance in the payload (`vocabulary_provenance`), which records them
      as `author_judgement_unsourced`. Still open: no Japanese lexical-marker
      literature has been consulted for the term lists. See #84.

## What #81–#83 did and did not establish

**Did:** replaced an indefensible scoring rule with a defensible one, stopped a
clinical name from travelling into the API and the graph payload, and stopped a
brooding-only signal being presented as covering both factors.

**Did not:** make the metric validated. Two lexical densities are not two RRS
subscales. The correspondence table above is unchanged — the modality is still
lexical density against a self-report instrument, and there is still no
validation and no population. The metric is exploratory either way; it is now
exploratory with a defensible scoring rule instead of an indefensible one.

## Reviewer answers

Packet: `clinical_reviewer_packet.md` — two questions, one hour.
Recorded here on return, **as a dated expert judgement, not as a published
source**. An expert's answer is evidence about a design decision; it is not a
citation, and writing it up as one would repeat the error this whole dossier
exists to correct.

```
Reviewer:            [ 未記入 ]
Date:                [ 未記入 ]
Agreed description:  [ 助言 / レビュー / 共同研究 / 名前を出さない ]

Q1 — is a 30-second free recall a valid elicitation for this construct?
     [ 未記入 ]

Q2 — is the two-component split the right one?
     [ 未記入 ]
```

Until these are filled in, the two open checklist items above stay open, and
nothing on the site or in any submission may describe the metric as reviewed.

## Interim position

**This dossier is not sign-off.** The score must not be presented to educators
as a clinical measure while the three open items stand. `focus_scores_status`
travels with the values in the payload for exactly that reason.

Related: D-04 (the guessed `POPULATION_BASELINE` has been removed, so z-scores
over this metric are now withheld rather than computed against invented
statistics during the first 14 days) and M-02 (no accuracy
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
