-- RLS policy tests for educator oversight foundations (issue #26).
--
-- Run against a local Supabase database with all migrations applied:
--   supabase db reset   (from sentra/, applies migrations)
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/oversight_rls.test.sql
--
-- The whole script runs in one transaction and rolls back: it leaves no data.
-- Every assertion raises an exception (failing the script) when violated.

begin;

-- ---------------------------------------------------------------------------
-- Fixtures (as superuser): two students with data, one educator, one admin.
-- ---------------------------------------------------------------------------

insert into auth.users (id, email)
values
  ('00000000-0000-0000-0000-00000000000a', 'student-a@test.local'),
  ('00000000-0000-0000-0000-00000000000b', 'student-b@test.local'),
  ('00000000-0000-0000-0000-00000000000e', 'educator@test.local'),
  ('00000000-0000-0000-0000-00000000000d', 'org-admin@test.local');

insert into public.participants (id, owner_user_id, code)
values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000000a', 'STUDENT_A'),
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-00000000000b', 'STUDENT_B');

insert into public.entries (id, owner_user_id, participant_id, raw_text, is_masked)
values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-00000000000a',
   '00000000-0000-0000-0000-0000000000a1', 'RAW-SECRET-JOURNAL-TEXT', false);

insert into public.insights (owner_user_id, participant_id, day, anomaly_score)
values
  ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1', '2026-07-14', 2.5),
  ('00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000b1', '2026-07-14', 3.5);

insert into public.model_runs (owner_user_id, participant_id, artifact_type, provider, model)
values
  ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1', 'safety_assessment', 'rules', 'safety-assessment-v1'),
  ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1', 'extraction', 'openai', 'gpt-4.1-mini');

-- ---------------------------------------------------------------------------
-- Org admin bootstraps the org, membership, and roster THROUGH RLS.
-- ---------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000d", "role": "authenticated"}';

insert into public.organizations (id, name, created_by)
values ('00000000-0000-0000-0000-000000000001', 'Test School', '00000000-0000-0000-0000-00000000000d');

do $$
begin
  -- Creator was auto-added as org_admin by the bootstrap trigger.
  if (select count(*) from public.organization_members
      where org_id = '00000000-0000-0000-0000-000000000001'
        and member_user_id = '00000000-0000-0000-0000-00000000000d'
        and role = 'org_admin' and status = 'active') <> 1 then
    raise exception 'FAIL: org creator was not bootstrapped as org_admin';
  end if;
end $$;

insert into public.organization_members (org_id, member_user_id, role)
values ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000e', 'educator');

insert into public.oversight_roster (org_id, educator_user_id, participant_id, owner_user_id, status)
values
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000e',
   '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000000a', 'active'),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000e',
   '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-00000000000b', 'revoked');

-- ---------------------------------------------------------------------------
-- Educator: may read ONLY the actively-rostered student's derived data.
-- ---------------------------------------------------------------------------

set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000e", "role": "authenticated"}';

do $$
declare
  visible integer;
begin
  -- Sees student A's insight (active roster) and nothing of student B (revoked).
  select count(*) into visible from public.insights;
  if visible <> 1 then
    raise exception 'FAIL: educator should see exactly 1 insight, saw %', visible;
  end if;
  if not exists (select 1 from public.insights
                 where participant_id = '00000000-0000-0000-0000-0000000000a1') then
    raise exception 'FAIL: educator cannot see the actively-rostered student insight';
  end if;

  -- Sees the safety assessment run, but NOT the extraction run.
  select count(*) into visible from public.model_runs;
  if visible <> 1 then
    raise exception 'FAIL: educator should see exactly 1 model_run, saw %', visible;
  end if;
  if not exists (select 1 from public.model_runs where artifact_type = 'safety_assessment') then
    raise exception 'FAIL: educator cannot see the safety assessment';
  end if;

  -- Raw journal text is unreachable: no entries policy matches an educator.
  select count(*) into visible from public.entries;
  if visible <> 0 then
    raise exception 'FAIL: educator can see % entries rows (raw text leak!)', visible;
  end if;

  -- Sees own roster assignment.
  select count(*) into visible from public.oversight_roster;
  if visible <> 2 then
    raise exception 'FAIL: educator should see their 2 roster rows, saw %', visible;
  end if;
end $$;

-- Educator writes to student data are denied by RLS.
do $$
begin
  begin
    insert into public.insights (owner_user_id, participant_id, day, anomaly_score)
    values ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1', '2026-07-15', 9.9);
    raise exception 'FAIL: educator was able to INSERT into insights';
  exception
    when insufficient_privilege then null; -- expected: RLS rejected the write
  end;
end $$;

-- Educator cannot self-promote their roster (only org_admins update it).
do $$
declare
  touched integer;
begin
  update public.oversight_roster set status = 'active'
  where participant_id = '00000000-0000-0000-0000-0000000000b1';
  get diagnostics touched = row_count;
  if touched <> 0 then
    raise exception 'FAIL: educator updated % roster rows (admin-only)', touched;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Outsider (student B is not org staff): sees nothing of the org or student A.
-- ---------------------------------------------------------------------------

set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000b", "role": "authenticated"}';

do $$
declare
  visible integer;
begin
  select count(*) into visible from public.organizations;
  if visible <> 0 then
    raise exception 'FAIL: outsider sees % organizations', visible;
  end if;

  -- Student B still sees their own insight (owner policy) and none of A's.
  select count(*) into visible from public.insights
  where participant_id = '00000000-0000-0000-0000-0000000000a1';
  if visible <> 0 then
    raise exception 'FAIL: outsider sees another student''s insights';
  end if;

  -- Transparency: B sees the roster row that points at THEIR participant.
  select count(*) into visible from public.oversight_roster;
  if visible <> 1 then
    raise exception 'FAIL: student should see exactly the roster row about them, saw %', visible;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Revocation cuts educator access immediately.
-- ---------------------------------------------------------------------------

set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000d", "role": "authenticated"}';

update public.oversight_roster set status = 'revoked'
where participant_id = '00000000-0000-0000-0000-0000000000a1';

set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000e", "role": "authenticated"}';

do $$
declare
  visible integer;
begin
  select count(*) into visible from public.insights;
  if visible <> 0 then
    raise exception 'FAIL: educator still sees % insights after revocation', visible;
  end if;
  select count(*) into visible from public.model_runs;
  if visible <> 0 then
    raise exception 'FAIL: educator still sees % model_runs after revocation', visible;
  end if;
end $$;

reset role;

select 'ALL OVERSIGHT RLS TESTS PASSED' as result;

rollback;
