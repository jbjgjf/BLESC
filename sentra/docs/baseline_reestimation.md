# The population baseline (D-04) — removed, not re-estimated

Raised as D-04 in the external technical review of `d7b33e8`. Closed by
deleting the constant rather than measuring it.

## What was there

`app/analytics/baseline.py` carried eleven feature means and standard
deviations that were **never measured**. The comment above them always said so.
Because `RAMP_UP_DAYS = 14`, a student's first two weeks of z-scores were
computed against those invented statistics — an "anomaly" in that window was a
deviation from a number somebody guessed.

Two ways out: measure the numbers (the procedure that used to fill this
document), or stop shipping a reading that rests on them. The second was taken.

## What ships now

`POPULATION_BASELINE` and the population → blended → user ramp are gone.
`get_effective_baseline()` returns the user's own baseline or nothing at all:

- `< RAMP_UP_DAYS` of the user's own history → `(None, "none")`
- `≥ RAMP_UP_DAYS` → `(BaselineStats, "user")`

`MIN_REFLECTION_BASELINE_DAYS` in `inference_orchestrator.py` is now floored at
`RAMP_UP_DAYS`, so a day with no baseline persists a `"not_enough_data"`
explanation and returns `None` instead of scoring against a placeholder. The
env var can raise that requirement, not lower it.

**Cost of the change:** a student sees no Reflection Signal for their first 14
days, where they previously saw one built mostly from guesses. That is the
trade — a longer silence in exchange for never presenting a fabricated reading
as a measurement.

`baseline_provenance()` still travels with every score:

```json
{
  "baseline_type": "user",
  "observed_days": 21,
  "ramp_up_days": 14,
  "days_remaining": 0,
  "is_provisional": false
}
```

`is_provisional` (true for any `baseline_type` other than `"user"`) is the flag
to gate any display on. `days_remaining` is what goes in "learning this
student's baseline (11 days left)". The `population_baseline_is_measured` key
is gone with the constant it described.

**Now wired.** This used to read "not yet done: the educator surface does not
read this … there is nothing to attach the badge to until those paths meet."
Those paths have now met — but not by the backend reaching Supabase. The
baseline computation was ported to TypeScript and runs in the Supabase write
path, so `baseline_provenance` is written on every production submission and
both surfaces read it. See `production_baseline_path.md` for why the port was
the available move and what it cost.

The reason the badge had nothing to attach to was worse than "the paths have not
met yet": production was not merely missing the provenance, it was writing a
score of its own that had no baseline behind it at all.

## If a population baseline is ever reintroduced

It would need to be measured before it ships, not after. The sample floors that
were set for the re-estimation — fixed in advance so the threshold could not be
chosen to fit whatever had accumulated — were:

| requirement | minimum | why |
| --- | --- | --- |
| distinct students | **200** | eleven features; below this the standard deviations are themselves noisy |
| days per student | **≥ 14** | a student still in ramp-up contributes provisional values |
| schools | **≥ 3** | one school's cohort is not a population; school effects would be baked in as if universal |
| calendar span | **≥ 1 term** | exam weeks and holidays move every one of these features |

Exclude synthetic accounts — every address under `@synthetic.blesc.invalid`,
and any participant in an evaluation run. Their distributions come from a
language model and are not students. Floor every standard deviation at 0.01, as
`estimate_baseline` already does, to keep z-scores finite.

## Related

- **D-03** — `rumination_index`'s weights are also unsourced, and z-scores over
  that metric compound both problems. See `rumination_index_provenance.md`.
- **M-02** — no accuracy validation of any risk output exists. Removing the
  guessed baseline makes the z-scores honest as *deviation from this student's
  own typical*; it says nothing about whether deviation predicts anything.
  `data_sufficiency_study.md` narrows this: on synthetic participants with a
  known answer, `RAMP_UP_DAYS = 14` is confirmed as the point where baseline
  estimation error plateaus, and the false-positive floor is shown to come from
  the scoring terms rather than from a shortage of days. It does not restore
  `POPULATION_BASELINE`, and it says nothing about clinical validity either.
