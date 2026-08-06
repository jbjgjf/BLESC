# Re-estimating `POPULATION_BASELINE`

Raised as D-04 in the external technical review of `d7b33e8`.

## The problem this closes

`app/analytics/baseline.py` carries eleven feature means and standard
deviations that were **never measured**. The comment above them has always said
so. Because `RAMP_UP_DAYS = 14`, a student's first two weeks of z-scores are
computed against those invented statistics — an "anomaly" in that window is a
deviation from a number somebody guessed.

The ramp-up design itself (population → blended → user) is the right shape. Only
the population numbers are placeholders, and until they are replaced this
document is the record of what it would take.

## What ships now

`baseline_provenance()` returns, alongside every score:

```json
{
  "baseline_type": "population",
  "observed_days": 3,
  "ramp_up_days": 14,
  "days_remaining": 11,
  "is_provisional": true,
  "population_baseline_is_measured": false
}
```

`is_provisional` is the flag to gate any display on. `days_remaining` is what
goes in "learning this student's baseline (11 days left)".

**Not yet done:** the educator surface does not read this. That UI is the
Next.js app fed from Supabase; it does not consume this backend's inference
output at all, so there is nothing to attach the badge to until those paths
meet. Wiring it is a separate piece of work and is not claimed here.

## Minimum sample before re-estimating

Fix these before looking at any data, so the threshold is not chosen to fit
whatever has accumulated.

| requirement | minimum | why |
| --- | --- | --- |
| distinct students | **200** | eleven features; below this the standard deviations are themselves noisy |
| days per student | **≥ 14** | a student still in ramp-up contributes blended values, which would fold the current guesses back in |
| schools | **≥ 3** | one school's cohort is not a population; school effects would be baked in as if universal |
| calendar span | **≥ 1 term** | exam weeks and holidays move every one of these features |

A re-estimate on fewer than 200 students should be recorded as a second
provisional baseline, not promoted to `"measured"`.

## Procedure

1. Select `DailyFeatureAggregation` rows where the owning student has ≥ 14 days
   of history, so no blended values enter the estimate.
2. Exclude synthetic accounts — every address under `@synthetic.blesc.invalid`,
   and any participant in an evaluation run. Their distributions come from a
   language model and are not students.
3. Per feature, compute mean and standard deviation across student-days.
4. Compare against the current guesses and **record the delta**. A feature that
   moves by more than roughly 2× tells you how wrong the corresponding
   historical z-scores were, and how far back to distrust them.
5. Floor every standard deviation at 0.01, as `estimate_baseline` already does,
   to keep z-scores finite.
6. Replace the table, set `population_baseline_is_measured` to `true`, and
   record in this document: date, student count, school count, span, and the
   before/after table.
7. Historical z-scores are **not** retroactively valid. Either recompute them
   or mark the pre-re-estimation period provisional in whatever consumes them.

## Related

- **D-03** — `rumination_index`'s weights are also unsourced, and z-scores over
  that metric compound both problems. See `rumination_index_provenance.md`.
- **M-02** — no accuracy validation of any risk output exists. Re-estimating
  the baseline makes the z-scores meaningful as *deviation from typical*; it
  says nothing about whether deviation predicts anything.
