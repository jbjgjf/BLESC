-- Drop `pilot_studies.baseline_days` / `observation_days` (#315).
--
-- ===========================================================================
-- APPLY THIS ONLY AFTER THE NEW CODE IS LIVE. It is step 3 of 3.
--
--   1. 20261004000000        — adds `study_days`, backfilled from these two
--   2. deploy the app        — reads `study_days` only
--   3. this migration        — safe only once (2) is done
--
-- The old code selects both columns by name on the guardian page, the pilot
-- dashboard and the research export. Applied before (2), those requests fail
-- with PostgREST 42703 rather than reading a wrong period — loud, but an
-- outage all the same.
-- ===========================================================================
--
-- The study no longer has two halves (`pilot-protocol-v3`): the period is one
-- `study_days`. Keeping the old columns would leave two descriptions of the
-- same study that can disagree — a `study_days` of 28 next to a 14 + 7 that
-- the column defaults would keep writing into every new row.
--
-- Nothing is lost. Step 1 copied each row's `baseline_days + observation_days`
-- into `study_days`, and no SQL function, policy or view reads either column.
--
-- Idempotent: `drop column if exists`.

alter table public.pilot_studies
  drop column if exists baseline_days,
  drop column if exists observation_days;
