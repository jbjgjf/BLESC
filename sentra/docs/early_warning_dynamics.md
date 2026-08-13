# Exploratory time-series dynamics (#97)

Measures two properties of a participant's own series — how much it varies, and
how much each day resembles the one before — and reports them with the window
they were measured over.

**This is not an early-warning system.** It does not classify, does not predict,
and produces no risk band. The framing is *critical-slowing-inspired*: the
statistics are the ones that literature associates with slowed recovery from
perturbation. They are computed here on synthetic and personal data with **no
validation that they mean anything clinical for this population**, and the
distance between "inspired by" and "validated as" is the whole of this section.

`NOT_VALIDATED_HERE` carries that into every serialisation:

```
clinical early warning or transition prediction
a risk band, a diagnosis, or a screening decision
any comparison against a population distribution
evidence that these indicators generalise beyond this participant's own series
```

## Personal only

Nothing consults a population distribution. #91 deleted `POPULATION_BASELINE`; a
"typical variance for a student" would reintroduce it under a new name, and
`test_nothing_here_consults_a_population` fails if one appears — checked against
the module's *executed identifiers*, not its prose, because the docstring says
the forbidden words in order to forbid them.

Even the calibration's null is built from the participant's own values.

## Three defects this layer does not repeat

`research_pipeline.recompute_longitudinal_features` produced the volatility
figures this replaces. All three are fixed there too, in the same change.

### A missing day was a zero

```python
values = [float(vector.get(name) or 0.0) for vector in vectors]   # before
```

A feature absent on a day entered the mean and the variance as a *measurement of
zero*. Here, absence is absence: excluded from every calculation, counted in
`spacing.observation_count`, and reported per feature as `observed_days` in the
longitudinal table.

### One observation was perfect stability

Population variance over `n = 1` is 0, so `volatility` was 0 and `consistency`
was `1/(1+0) = 1.0`. A student who wrote once was reported as maximally
consistent. This uses the **sample** variance and returns `None` below two
observations.

### Consecutive rows were consecutive days

```python
deltas = [b - a for a, b in zip(values, values[1:])]              # before
```

A student who wrote on the 1st, 2nd and 9th had the 2nd differenced against the
9th as a one-step change. **A lag-1 autocorrelation computed that way is not
lag-1 in time**, and the entire critical-slowing framing depends on the lag
meaning what it appears to mean.

So the decision is made explicitly, and the two quantities are reported under
different names:

| | pairs | what it is |
|---|---|---|
| `lag1_autocorrelation` | days exactly 1 apart | the critical-slowing quantity |
| `successive_observation_correlation` | consecutive observations, any gap | a descriptive statistic, travelling with `spacing.median_gap_days` |

Where a participant writes too irregularly to supply `min_lag_pairs` adjacent
days, `lag1_autocorrelation` is `not_enough_data`. That is frequent, and it is
information about the data rather than a gap to fill.

`trend` and `change_rate` in the longitudinal table are now **per day**, divided
by elapsed calendar days rather than by row count.

## Pre-declared parameters

Fixed before any output was inspected, in the spirit of the #90 pre-registration.
Changing one after seeing a result is the move pre-registration exists to
prevent, and belongs in this document rather than in a quiet edit.

```
window_days           14    matches analytics.baseline.RAMP_UP_DAYS — the repo's
                            existing answer to "how much of this student's own
                            history is enough"
min_observations       8    of 14: "wrote more days than not"
min_lag_pairs          5    adjacent-day pairs
min_successive_pairs   5
min_trend_points       5    tau on three points takes four values
variance_floor      1e-9    below this a series is constant
```

They are echoed into every payload with `declared_before_results: true`, so an
analysis run with looser minimums is visibly one.

## The feature selection

Explicit, not "every key in the vector" — the choice changes what the variance
means.

**Selected**, all four of them ratios normalised by the size of that day's own
extraction: `protective_ratio`, `protective_buffer_ratio`, `relation_density`,
`event_transition_signal`.

**Excluded**, with the reason recorded next to each: every raw count
(`state_count`, `trigger_count`, `protective_count`, `behavior_count`,
`event_count`) scales with how much the student wrote that day, so its variance
is confounded with variance in entry length — a rising variance would read as a
destabilising student when it may be a student writing longer entries.

`isolation_signal` is excluded for a different reason worth naming: it matches
the literal English label `"isolation"` in `aggregation.py`, so it is
structurally near-zero for Japanese entries. Measuring its variance would measure
the language of the entry. Same class of defect as #107 and D-01.

## Three states, never a substitute number

```
computed          a value
not_enough_data   fewer observations or pairs than the declared minimum
not_computable    enough data, calculation undefined on it
```

`not_computable` exists for the constant series. A correlation over a constant
series has a zero denominator; returning 0 would report "no persistence" and 1
"perfect persistence", and both are inventions. A student whose ratio sat at the
same value all fortnight is a case this will meet.

## The measured finding: a bare Kendall tau is unusable

Critical slowing is about a *trend* in variance, so the module computes Kendall's
tau over the rolling series. Measuring its behaviour on stable input is what #97
asks for, and the result changed the design.

**On 400 synthetic stable series, |tau| exceeded 0.5 in 51% of them.** The mean
was ≈0, so tau is not biased — its spread is the problem. The cause is
structural: rolling windows overlap, so consecutive rolling-variance values share
most of their observations and long runs appear by construction. The effective
sample size is far below the number of points.

A tau read against a threshold was therefore reporting a direction that flat
noise produces a quarter of the time.

### The calibration

Every trend now carries a null built by permuting **this participant's own
values across their own observed days**. That preserves the marginal
distribution and the spacing pattern and destroys temporal order — the null for
"is there more temporal structure here than this series' own values in a random
arrangement". Seeded (`SURROGATE_SEED`), because a calibration that moves between
runs is not a calibration.

| | bare tau ≥ 0.5 | `calibration.exceeds_p95` |
|---|---|---|
| false positives on stable series | 24.5% | **7.3%** |
| detection on destabilising series | — | **94.7%** |

`exceeds_p95` is not a significance test and not a decision rule: one
participant, one series, one uncorrected comparison, and no evidence the quantity
means anything clinical. It is a scale for reading the tau. But a tau is never
reported without it, and `test_a_trend_is_never_reported_without_its_calibration`
enforces that.

`false_positive_profile()` returns both rates side by side, because the
comparison is the finding. It generates nothing itself — the caller supplies the
series it declares stable — so it cannot grade its own homework on a distribution
it chose.

## Quality flags, not a quality score

```
no_observations
mostly_non_consecutive_observations
gap_longer_than_a_week
no_calendar_lag1_autocorrelation
no_rolling_variance
```

Flags rather than a number, because a single score would have to weigh
irregularity against sparsity and there is no basis for that weighting.

## Using it

```python
from app.analytics.dynamics import analyse_participant

result = analyse_participant(user_id, [(row.day, row.feature_vector_json) for row in rows])
```

```
GET /api/research/dynamics?user_id=…&days=90
```

Computed on read. Pure functions over plain `(day, vector)` tuples — no database,
no clock, no population — following the convention in `pattern_mining.py` and
`memory_objects.py`. `test_analysis_does_not_read_the_wall_clock` asserts the
absence of `date.today()`, so a result computed in December from an August series
matches the one computed in August.

## Wording

API and UI report **variability and persistence only**. No diagnosis, no risk
band, no predicted transition. `docs/educator_display_policy.md` is the standard
this has to clear, and
`test_the_output_reports_variability_and_persistence_and_claims_nothing_else`
scans the measured fields — not the disclaimers, which legitimately contain the
words a classifier would.

Narration is affected too: `pattern_mining.summarize_feature_trends` used to read
`float(volatility.get(name) or 0.0)`, so a window with too few observations to
have a spread rendered to a reader as a spread of zero. It now passes `None`
through and skips a feature whose trend is not computable, rather than narrating
"no change" when the truthful answer is "not enough to say".

## Out of scope

- clinical alerting
- treatment or outcome optimisation
- any threshold that decides something about a student
- generalising a synthetic false-positive rate to real users — #62's
  data-sufficiency study and a governance review come first

## Test-environment note

`tests/conftest.py` was added in this change. `app.database` reads `DATABASE_URL`
once at import, so the first test module to import `app.main` fixes the database
for every module after it. That worked by alphabetical luck until
`test_dynamics_endpoint` sorted ahead of the modules that set the variable, and
every pipeline test after it failed with `no such table: entry`. pytest loads
`conftest.py` before collection, which makes the guarantee structural rather than
a property of the filenames.
