-- `pilot_studies.study_days`: one collection period instead of two (#315).
--
-- ===========================================================================
-- APPLY THIS BEFORE DEPLOYING THE CODE. It is step 1 of 3.
--
--   1. this migration        — additive only; the running code keeps reading
--                              `baseline_days` / `observation_days`
--   2. deploy the app        — it reads `study_days` and nothing else
--   3. 20261004000100        — drops the two old columns, which the OLD code
--                              still selects
-- ===========================================================================
--
-- ## What changed
--
-- The study period was 21 days in two named halves, 14 baseline + 7
-- observation, and the original Google Doc said 「1ヶ月」. On 2026-10-04 the owner
-- settled both questions: the period is **28 days, fixed**, and it is **one
-- collection period with no baseline / observation split** (`pilot-protocol-v3`,
-- `research-consent-doc-v3`). Whether the analysis divides the 28 days is now
-- a question for the analysis plan, not a column a participant's consent text
-- has to describe.
--
-- So the study carries a single length. The default is the real pilot's 28; a
-- dry run sets its own (the seed uses 3).
--
-- ## Existing rows
--
-- Each existing study keeps the length it was configured with —
-- `study_days = baseline_days + observation_days`, so a dry run stays 3 and a
-- study configured under v2 stays 21. Rewriting an existing study to 28 here
-- would change the protocol under people who may already have read it; a study
-- moves to v3 by being reconfigured, with its `protocol_version` and
-- `consent_document_version`, not by a migration.
--
-- ## Idempotence
--
-- Re-applying is a no-op. The backfill only touches rows still null, and it
-- runs only while the old columns exist, so it is also safe after step 3.

alter table public.pilot_studies
  add column if not exists study_days integer;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'pilot_studies'
      and column_name = 'baseline_days'
  ) then
    execute 'update public.pilot_studies
               set study_days = baseline_days + observation_days
             where study_days is null';
  end if;
end
$$;

alter table public.pilot_studies
  alter column study_days set default 28;

alter table public.pilot_studies
  alter column study_days set not null;

alter table public.pilot_studies
  drop constraint if exists pilot_studies_study_days_check;
alter table public.pilot_studies
  add constraint pilot_studies_study_days_check
  check (study_days > 0);

comment on column public.pilot_studies.study_days is
  'Days of collection, counted from the first day of a participant''s window. One period with no '
  'baseline/observation split (#315, pilot-protocol-v3). Default 28 = the real pilot; a dry run sets '
  'its own. Replaces baseline_days + observation_days.';
