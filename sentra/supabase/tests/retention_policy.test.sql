-- Retention deadlines exist only for an ended study and an approved period (#318).
--
-- Run against a local Supabase database with all migrations applied:
--   supabase db reset   (from sentra/)
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/retention_policy.test.sql
--
-- Runs in one transaction and rolls back.
--
-- 20261010010000 adds the study's end date and the table of retention periods.
-- The periods are proposals until ethics review approves them, so what matters
-- most here is what does NOT happen: no deadline is produced from an unapproved
-- period or for a study nobody has declared finished. A purge keyed on these
-- deadlines then has nothing to act on until two people have each recorded a
-- decision.

begin;

insert into auth.users (id, email)
values ('00000000-0000-0000-0000-000000031801', 'retention-approver@test.local');

insert into public.pilot_studies (id, slug, title, status)
values ('00000000-0000-0000-0000-000000031802', 'retention-test', 'Retention', 'collecting');

do $$
declare
  study constant uuid := '00000000-0000-0000-0000-000000031802';
  ended constant timestamptz := '2026-12-01T00:00:00Z';
  n integer;
  due timestamptz;
begin
  -- The proposed periods are the ones `/legal` states.
  select count(*) into n from public.pilot_retention_policy
   where (category, keep_for) in (
     ('research_records', interval '1 year'),
     ('identity_map', interval '90 days'),
     ('audit_trail', interval '5 years'));
  if n <> 3 then
    raise exception 'FAIL: the seeded periods are not the ones /legal states (% of 3 match)', n;
  end if;

  -- They ship unapproved.
  select count(*) into n from public.pilot_retention_policy where approved_at is not null;
  if n <> 0 then raise exception 'FAIL: % period(s) ship already approved', n; end if;

  -- A study that is still running cannot be given an end date.
  begin
    update public.pilot_studies set ended_at = ended where id = study;
    raise exception 'FAIL: an end date was recorded on a study that is not closed';
  exception when check_violation then null;
  end;

  -- Running study, unapproved periods: three rows, no deadline.
  select count(*) into n from public.pilot_retention_deadlines(study) where deadline is not null;
  if n <> 0 then raise exception 'FAIL: a running study has % deadline(s)', n; end if;
  select count(*) into n from public.pilot_retention_deadlines(study);
  if n <> 3 then raise exception 'FAIL: expected one row per category, got %', n; end if;

  -- Ended, but nothing approved: still no deadline.
  update public.pilot_studies set status = 'closed', ended_at = ended where id = study;
  select count(*) into n from public.pilot_retention_deadlines(study) where deadline is not null;
  if n <> 0 then raise exception 'FAIL: an unapproved period produced a deadline'; end if;

  -- An approval has to say what it rests on.
  begin
    update public.pilot_retention_policy set approved_at = now() where category = 'identity_map';
    raise exception 'FAIL: a period was approved with no reference';
  exception when check_violation then null;
  end;

  -- Approved and ended: that category, and only that one, has its deadline.
  update public.pilot_retention_policy
     set approved_at = now(), approved_by = '00000000-0000-0000-0000-000000031801',
         approval_reference = 'IRB-TEST-001'
   where category = 'identity_map';

  select deadline into due from public.pilot_retention_deadlines(study) where category = 'identity_map';
  if due is distinct from ended + interval '90 days' then
    raise exception 'FAIL: identity_map deadline is %, expected %', due, ended + interval '90 days';
  end if;
  select count(*) into n from public.pilot_retention_deadlines(study) where deadline is not null;
  if n <> 1 then raise exception 'FAIL: approving one category gave % deadlines', n; end if;

  -- The approved value is what counts, not the proposal.
  update public.pilot_retention_policy set keep_for = interval '180 days' where category = 'identity_map';
  select deadline into due from public.pilot_retention_deadlines(study) where category = 'identity_map';
  if due is distinct from ended + interval '180 days' then
    raise exception 'FAIL: the deadline did not follow the approved period';
  end if;

  -- A period of zero or less would delete on the day the study ends.
  begin
    update public.pilot_retention_policy set keep_for = interval '0' where category = 'audit_trail';
    raise exception 'FAIL: a zero retention period was accepted';
  exception when check_violation then null;
  end;

  -- Re-applying the migration's seed does not turn an approval back into a proposal.
  insert into public.pilot_retention_policy (category, keep_for, description)
  values ('identity_map', interval '90 days', 'x') on conflict (category) do nothing;
  select count(*) into n from public.pilot_retention_policy
   where category = 'identity_map' and approved_at is not null and keep_for = interval '180 days';
  if n <> 1 then raise exception 'FAIL: re-seeding overwrote an approved period'; end if;
end;
$$;

-- Nobody but service_role reads or changes the periods, or asks for deadlines.
do $$
declare
  role_name text;
begin
  foreach role_name in array array['anon', 'authenticated'] loop
    if has_table_privilege(role_name, 'public.pilot_retention_policy', 'SELECT')
       or has_table_privilege(role_name, 'public.pilot_retention_policy', 'UPDATE')
       or has_table_privilege(role_name, 'public.pilot_retention_policy', 'INSERT')
       or has_table_privilege(role_name, 'public.pilot_retention_policy', 'DELETE') then
      raise exception 'FAIL: % holds a privilege on pilot_retention_policy', role_name;
    end if;
    if has_function_privilege(role_name, 'public.pilot_retention_deadlines(uuid)', 'EXECUTE') then
      raise exception 'FAIL: % may execute pilot_retention_deadlines', role_name;
    end if;
  end loop;
  -- A period cannot be removed, by anyone: an absent row would read as "no rule".
  if has_table_privilege('service_role', 'public.pilot_retention_policy', 'DELETE') then
    raise exception 'FAIL: service_role can delete a retention period';
  end if;
end;
$$;

rollback;
