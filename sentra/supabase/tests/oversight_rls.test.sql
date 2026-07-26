-- RLS policy tests for educator oversight foundations (issue #26) and
-- student-granted consent gating (issue #27).
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
-- Default-deny (issue #27): roster alone grants NOTHING until the student
-- consents.
-- ---------------------------------------------------------------------------

set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000e", "role": "authenticated"}';

do $$
declare
  visible integer;
begin
  select count(*) into visible from public.insights;
  if visible <> 0 then
    raise exception 'FAIL: educator sees % insights BEFORE consent (default-deny broken)', visible;
  end if;
  select count(*) into visible from public.model_runs;
  if visible <> 0 then
    raise exception 'FAIL: educator sees % model_runs BEFORE consent', visible;
  end if;
end $$;

-- An educator cannot forge a consent on the student's behalf.
do $$
begin
  begin
    insert into public.oversight_consents (participant_id, owner_user_id, org_id)
    values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000000a',
            '00000000-0000-0000-0000-000000000001');
    raise exception 'FAIL: educator forged a consent row';
  exception
    when insufficient_privilege then null; -- expected
  end;
end $$;

-- Student A grants org-wide consent, through RLS.
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';

insert into public.oversight_consents (participant_id, owner_user_id, org_id)
values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000000a',
        '00000000-0000-0000-0000-000000000001');

-- ---------------------------------------------------------------------------
-- Educator: may read ONLY the consented, actively-rostered student's
-- derived data.
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
  -- Transparency: B has a roster row, so B may read the org's NAME (to know
  -- who is requesting oversight) — but nothing else about the org.
  select count(*) into visible from public.organizations;
  if visible <> 1 then
    raise exception 'FAIL: rostered student should see the org name row, saw %', visible;
  end if;
  select count(*) into visible from public.organization_members;
  if visible <> 0 then
    raise exception 'FAIL: student sees % org membership rows', visible;
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
-- Access accountability (issue #31) + minimized roster reads (issue #29).
-- Runs as the educator while consent is ACTIVE.
-- ---------------------------------------------------------------------------

set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000e", "role": "authenticated"}';

do $$
declare
  visible integer;
  seen_code text;
begin
  -- Column-minimized roster read returns only the consented student.
  select count(*) into visible from public.overseen_participants();
  if visible <> 1 then
    raise exception 'FAIL: overseen_participants should return 1 row, got %', visible;
  end if;
  select code into seen_code from public.overseen_participants();
  if seen_code <> 'STUDENT_A' then
    raise exception 'FAIL: overseen_participants returned wrong code %', seen_code;
  end if;
end $$;

-- Educator logs a view of the overseen student (allowed)...
insert into public.educator_access_log (educator_user_id, org_id, participant_id, owner_user_id, view_type)
values ('00000000-0000-0000-0000-00000000000e', '00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000000a', 'roster');

-- ...but cannot log (or fabricate) access to the non-consented student B.
do $$
begin
  begin
    insert into public.educator_access_log (educator_user_id, org_id, participant_id, owner_user_id, view_type)
    values ('00000000-0000-0000-0000-00000000000e', '00000000-0000-0000-0000-000000000001',
            '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-00000000000b', 'roster');
    raise exception 'FAIL: educator logged access to a non-overseen student';
  exception
    when insufficient_privilege then null; -- expected
  end;
end $$;

-- The log is append-only: educators cannot rewrite their trail.
do $$
declare
  touched integer;
begin
  update public.educator_access_log set view_type = 'alerts' where true;
  get diagnostics touched = row_count;
  if touched <> 0 then
    raise exception 'FAIL: educator mutated % access log rows', touched;
  end if;
  delete from public.educator_access_log where true;
  get diagnostics touched = row_count;
  if touched <> 0 then
    raise exception 'FAIL: educator deleted % access log rows', touched;
  end if;
end $$;

-- The student sees who viewed their data.
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';

do $$
declare
  visible integer;
begin
  select count(*) into visible from public.educator_access_log;
  if visible <> 1 then
    raise exception 'FAIL: student should see 1 access log row, saw %', visible;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Support-summary sharing: counselor read requires all four gates
-- (membership + roster + consent + ACTIVE share).
-- ---------------------------------------------------------------------------

set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';

insert into public.shared_support_summaries
  (id, participant_id, owner_user_id, org_id, summary_id, summary_json, evidence_event_ids, reflection_count)
values
  ('00000000-0000-0000-0000-0000000000f1',
   '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000000a',
   '00000000-0000-0000-0000-000000000001', 'summary-1',
   '{"sections": [{"key": "recent_themes", "items": ["anxious (2 reflections)"]}]}',
   '["event-1", "event-2"]', 2);

-- A share scoped to a DIFFERENT counselor must stay invisible to educator E.
insert into public.shared_support_summaries
  (participant_id, owner_user_id, org_id, counselor_user_id, summary_id, summary_json)
values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000000a',
   '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000d',
   'summary-2', '{}');

set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000e", "role": "authenticated"}';

do $$
declare
  visible integer;
  touched integer;
begin
  -- Sees the org-wide share, not the one scoped to another counselor.
  select count(*) into visible from public.shared_support_summaries;
  if visible <> 1 then
    raise exception 'FAIL: counselor should see exactly 1 share, saw %', visible;
  end if;
  if not exists (select 1 from public.shared_support_summaries where summary_id = 'summary-1') then
    raise exception 'FAIL: counselor cannot see the org-wide share';
  end if;

  -- Counselors cannot create or mutate shares.
  begin
    insert into public.shared_support_summaries
      (participant_id, owner_user_id, org_id, summary_id, summary_json)
    values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000000a',
            '00000000-0000-0000-0000-000000000001', 'forged', '{}');
    raise exception 'FAIL: counselor forged a summary share';
  exception
    when insufficient_privilege then null; -- expected
  end;
  update public.shared_support_summaries set status = 'active' where true;
  get diagnostics touched = row_count;
  if touched <> 0 then
    raise exception 'FAIL: counselor mutated % share rows', touched;
  end if;
end $$;

-- Counselor directory: rostered students may list active counselors of the
-- requesting org (minimized); users without a roster row get nothing.
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';

do $$
declare
  visible integer;
begin
  select count(*) into visible from public.org_counselors('00000000-0000-0000-0000-000000000001');
  if visible <> 1 then
    raise exception 'FAIL: rostered student should see 1 counselor, saw %', visible;
  end if;
end $$;

set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000d", "role": "authenticated"}';

do $$
declare
  visible integer;
begin
  -- The org admin has no roster row as a STUDENT, so the directory is empty.
  select count(*) into visible from public.org_counselors('00000000-0000-0000-0000-000000000001');
  if visible <> 0 then
    raise exception 'FAIL: non-rostered caller sees % counselors', visible;
  end if;
end $$;

-- Student revokes the share: counselor loses it immediately (consent intact).
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';

update public.shared_support_summaries set status = 'revoked'
where id = '00000000-0000-0000-0000-0000000000f1';

do $$
begin
  if not exists (select 1 from public.shared_support_summaries
                 where id = '00000000-0000-0000-0000-0000000000f1'
                   and status = 'revoked' and revoked_at is not null) then
    raise exception 'FAIL: share revocation did not stamp revoked_at';
  end if;
end $$;

set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000e", "role": "authenticated"}';

do $$
declare
  visible integer;
begin
  select count(*) into visible from public.shared_support_summaries;
  if visible <> 0 then
    raise exception 'FAIL: counselor still sees % shares after share revocation', visible;
  end if;
end $$;

-- Re-activate so the consent-revocation stage below can prove that consent
-- revocation ALSO hides an active share.
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';
update public.shared_support_summaries set status = 'active'
where id = '00000000-0000-0000-0000-0000000000f1';

-- ---------------------------------------------------------------------------
-- Consent revocation by the student cuts educator access immediately,
-- and re-granting restores it (issue #27).
-- ---------------------------------------------------------------------------

set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';

update public.oversight_consents set status = 'revoked'
where participant_id = '00000000-0000-0000-0000-0000000000a1';

do $$
begin
  if not exists (select 1 from public.oversight_consents
                 where participant_id = '00000000-0000-0000-0000-0000000000a1'
                   and status = 'revoked' and revoked_at is not null) then
    raise exception 'FAIL: consent revocation did not stamp revoked_at';
  end if;
end $$;

set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000e", "role": "authenticated"}';

do $$
declare
  visible integer;
begin
  select count(*) into visible from public.insights;
  if visible <> 0 then
    raise exception 'FAIL: educator still sees % insights after consent revocation', visible;
  end if;
  select count(*) into visible from public.overseen_participants();
  if visible <> 0 then
    raise exception 'FAIL: overseen_participants leaks % rows after consent revocation', visible;
  end if;
  -- The still-active share must also disappear once consent is revoked.
  select count(*) into visible from public.shared_support_summaries;
  if visible <> 0 then
    raise exception 'FAIL: consent revocation left % shares visible', visible;
  end if;
end $$;

set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';

update public.oversight_consents set status = 'active'
where participant_id = '00000000-0000-0000-0000-0000000000a1';

set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000e", "role": "authenticated"}';

do $$
declare
  visible integer;
begin
  select count(*) into visible from public.insights;
  if visible <> 1 then
    raise exception 'FAIL: educator should see 1 insight after re-grant, saw %', visible;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Roster revocation (by the org admin) also cuts educator access.
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
