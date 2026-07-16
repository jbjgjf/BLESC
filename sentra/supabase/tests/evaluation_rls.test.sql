-- RLS tests for the synthetic-user evaluation tables.
-- Run like the oversight suite:
--   docker exec -i supabase_db_sentra psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 < supabase/tests/evaluation_rls.test.sql

begin;

insert into auth.users (id, email)
values
  ('00000000-0000-0000-0000-0000000000e1', 'reviewer@test.local'),
  ('00000000-0000-0000-0000-0000000000e2', 'counselor@test.local');

-- Runner-side writes happen with the service role (bypasses RLS) — modeled
-- here as superuser inserts.
insert into public.evaluation_access (user_id, role, granted_by)
values ('00000000-0000-0000-0000-0000000000e1', 'reviewer', 'test-suite');

insert into public.evaluation_runs (id, label, mode, status, verdict)
values ('00000000-0000-0000-0000-0000000000ee', 'suite-run', 'smoke', 'completed', 'ready');

insert into public.evaluation_cases (run_id, case_key, persona_id, scenario_family, seed, status)
values ('00000000-0000-0000-0000-0000000000ee', 'case-1', 'persona-01', 'ordinary_stress', 1, 'passed');

insert into public.evaluation_artifacts (run_id, kind, content_type, content_text)
values ('00000000-0000-0000-0000-0000000000ee', 'executive_html', 'text/html', '<h1>ok</h1>');

-- Reviewer: read-only everywhere.
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000e1", "role": "authenticated"}';

do $$
declare
  visible integer;
  touched integer;
begin
  select count(*) into visible from public.evaluation_runs;
  if visible <> 1 then
    raise exception 'FAIL: reviewer should see 1 run, saw %', visible;
  end if;
  select count(*) into visible from public.evaluation_cases;
  if visible <> 1 then
    raise exception 'FAIL: reviewer should see 1 case, saw %', visible;
  end if;
  select count(*) into visible from public.evaluation_artifacts;
  if visible <> 1 then
    raise exception 'FAIL: reviewer should see 1 artifact, saw %', visible;
  end if;
  select count(*) into visible from public.evaluation_access;
  if visible <> 1 then
    raise exception 'FAIL: reviewer should see their own grant, saw %', visible;
  end if;

  begin
    insert into public.evaluation_runs (label, mode) values ('forged', 'smoke');
    raise exception 'FAIL: reviewer inserted an evaluation run';
  exception
    when insufficient_privilege then null; -- expected
  end;
  update public.evaluation_runs set verdict = 'needs_attention' where true;
  get diagnostics touched = row_count;
  if touched <> 0 then
    raise exception 'FAIL: reviewer mutated % runs', touched;
  end if;
  begin
    delete from public.evaluation_cases where true;
    get diagnostics touched = row_count;
    if touched <> 0 then
      raise exception 'FAIL: reviewer deleted % cases', touched;
    end if;
  exception
    when insufficient_privilege then null; -- also acceptable
  end;

  -- Reviewer/counselor separation: the reviewer grant conveys NO oversight
  -- access (not an org member, no roster, no consent).
  select count(*) into visible from public.shared_support_summaries;
  if visible <> 0 then
    raise exception 'FAIL: reviewer sees % shared summaries', visible;
  end if;
  select count(*) into visible from public.overseen_participants();
  if visible <> 0 then
    raise exception 'FAIL: reviewer oversees % participants', visible;
  end if;
end $$;

-- Non-reviewer (counselor-type account): evaluation data is invisible.
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000e2", "role": "authenticated"}';

do $$
declare
  visible integer;
begin
  select count(*) into visible from public.evaluation_runs;
  if visible <> 0 then
    raise exception 'FAIL: non-reviewer sees % runs', visible;
  end if;
  select count(*) into visible from public.evaluation_artifacts;
  if visible <> 0 then
    raise exception 'FAIL: non-reviewer sees % artifacts', visible;
  end if;
  select count(*) into visible from public.evaluation_access;
  if visible <> 0 then
    raise exception 'FAIL: non-reviewer sees % access grants', visible;
  end if;
end $$;

reset role;

select 'ALL EVALUATION RLS TESTS PASSED' as result;

rollback;
