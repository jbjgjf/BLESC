-- 書きぶりの変化の観測 (#468) の RLS・権限テスト。
--
-- 20261018000000_writing_change_observations.sql が約束していること:
--
--   writing_features
--     1. 生徒本人は自分の行を select できるが、insert / update / delete はできない
--        （本人の基準を書き換えて観測を出したり消したりできないように）。
--     2. 他人の行は見えない。
--   writing_change_observations
--     3. 本人と、educator_oversees(participant_id) が真の教員だけが読める。
--        担当でない教員と、別の生徒は読めない。
--     4. authenticated は一切書けない。anon は何もできない。
--     5. service_role は書ける。
--     6. 根拠（evidence）が空の行と、baseline_window_days < 14 の行は check 制約で入らない。
--
-- Run against a local Supabase database with all migrations applied:
--   supabase db reset   (from sentra/)
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/writing_change_rls.test.sql
--
-- One transaction, rolled back. Every assertion raises on violation.

begin;

-- ---------------------------------------------------------------------------
-- Fixtures (as superuser): students A and B, educator E (oversees A),
-- unrelated educator U, org admin D.
-- ---------------------------------------------------------------------------

insert into auth.users (id, email)
values
  ('46800000-0000-0000-0000-00000000000a', 'student-a@test.local'),
  ('46800000-0000-0000-0000-00000000000b', 'student-b@test.local'),
  ('46800000-0000-0000-0000-00000000000e', 'educator@test.local'),
  ('46800000-0000-0000-0000-00000000000f', 'unrelated-educator@test.local'),
  ('46800000-0000-0000-0000-00000000000d', 'org-admin@test.local');

insert into public.participants (id, owner_user_id, code)
values
  ('46800000-0000-0000-0000-0000000000a1', '46800000-0000-0000-0000-00000000000a', 'WRITING_A'),
  ('46800000-0000-0000-0000-0000000000b1', '46800000-0000-0000-0000-00000000000b', 'WRITING_B');

insert into public.entries (id, owner_user_id, participant_id, client_submission_id)
values
  ('46800000-0000-0000-0000-0000000000e1', '46800000-0000-0000-0000-00000000000a',
   '46800000-0000-0000-0000-0000000000a1', 'w468-a'),
  ('46800000-0000-0000-0000-0000000000e2', '46800000-0000-0000-0000-00000000000b',
   '46800000-0000-0000-0000-0000000000b1', 'w468-b');

insert into public.entry_sessions (id, owner_user_id, participant_id, client_session_id, started_at, submitted_at)
values
  ('46800000-0000-0000-0000-0000000005a1', '46800000-0000-0000-0000-00000000000a',
   '46800000-0000-0000-0000-0000000000a1', 'w468-session-a', now() - interval '5 minutes', now()),
  ('46800000-0000-0000-0000-0000000005b1', '46800000-0000-0000-0000-00000000000b',
   '46800000-0000-0000-0000-0000000000b1', 'w468-session-b', now() - interval '5 minutes', now());

-- ---------------------------------------------------------------------------
-- The school, through RLS: org, educator E, roster for A and B. Only A consents.
-- ---------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub": "46800000-0000-0000-0000-00000000000d", "role": "authenticated"}';

insert into public.organizations (id, name, created_by)
values ('46800000-0000-0000-0000-000000000001', 'Test School 468', '46800000-0000-0000-0000-00000000000d');

insert into public.organization_members (org_id, member_user_id, role)
values ('46800000-0000-0000-0000-000000000001', '46800000-0000-0000-0000-00000000000e', 'educator');

insert into public.oversight_roster (org_id, educator_user_id, participant_id, owner_user_id, status)
values
  ('46800000-0000-0000-0000-000000000001', '46800000-0000-0000-0000-00000000000e',
   '46800000-0000-0000-0000-0000000000a1', '46800000-0000-0000-0000-00000000000a', 'active'),
  ('46800000-0000-0000-0000-000000000001', '46800000-0000-0000-0000-00000000000e',
   '46800000-0000-0000-0000-0000000000b1', '46800000-0000-0000-0000-00000000000b', 'active');

set local request.jwt.claims = '{"sub": "46800000-0000-0000-0000-00000000000a", "role": "authenticated"}';
insert into public.oversight_consents (participant_id, owner_user_id, org_id)
values ('46800000-0000-0000-0000-0000000000a1', '46800000-0000-0000-0000-00000000000a',
        '46800000-0000-0000-0000-000000000001');

-- The unrelated educator runs their own org, with no roster link to anyone here.
set local request.jwt.claims = '{"sub": "46800000-0000-0000-0000-00000000000f", "role": "authenticated"}';
insert into public.organizations (id, name, created_by)
values ('46800000-0000-0000-0000-000000000002', 'Other Org 468', '46800000-0000-0000-0000-00000000000f');

-- ---------------------------------------------------------------------------
-- 5. service_role writes both tables (the server's path).
-- ---------------------------------------------------------------------------

reset role;
set local role service_role;

insert into public.writing_features (id, owner_user_id, participant_id, entry_id, entry_session_id, field_name, feature_json)
values
  ('46800000-0000-0000-0000-0000000f0a01', '46800000-0000-0000-0000-00000000000a',
   '46800000-0000-0000-0000-0000000000a1', '46800000-0000-0000-0000-0000000000e1',
   '46800000-0000-0000-0000-0000000005a1', 'journal', '{"max_pause_ms": 4200}'),
  ('46800000-0000-0000-0000-0000000f0b01', '46800000-0000-0000-0000-00000000000b',
   '46800000-0000-0000-0000-0000000000b1', '46800000-0000-0000-0000-0000000000e2',
   '46800000-0000-0000-0000-0000000005b1', 'journal', '{"max_pause_ms": 900}');

insert into public.writing_change_observations
  (id, owner_user_id, participant_id, entry_id, entry_session_id, field_name, observed_at, evidence, baseline_window_days, pipeline_version)
values
  ('46800000-0000-0000-0000-0000000c0a01', '46800000-0000-0000-0000-00000000000a',
   '46800000-0000-0000-0000-0000000000a1', '46800000-0000-0000-0000-0000000000e1',
   '46800000-0000-0000-0000-0000000005a1', 'journal', now(),
   '[{"feature": "max_pause_ms", "direction": "higher"}]', 14, 'writing-dynamics-v1'),
  ('46800000-0000-0000-0000-0000000c0b01', '46800000-0000-0000-0000-00000000000b',
   '46800000-0000-0000-0000-0000000000b1', '46800000-0000-0000-0000-0000000000e2',
   '46800000-0000-0000-0000-0000000005b1', 'journal', now(),
   '[{"feature": "revision_count", "direction": "higher"}]', 21, 'writing-dynamics-v1');

update public.writing_change_observations set pipeline_version = 'writing-dynamics-v1b'
 where id = '46800000-0000-0000-0000-0000000c0b01';
update public.writing_features set feature_json = '{"max_pause_ms": 950}'
 where id = '46800000-0000-0000-0000-0000000f0b01';

do $$
begin
  if (select pipeline_version from public.writing_change_observations
       where id = '46800000-0000-0000-0000-0000000c0b01') <> 'writing-dynamics-v1b' then
    raise exception 'FAIL: service_role could not update an observation';
  end if;
end $$;

-- 6. The check constraints: no observation without evidence, none before a
--    14-day baseline.
do $$
begin
  begin
    insert into public.writing_change_observations
      (owner_user_id, participant_id, entry_id, field_name, observed_at, evidence, baseline_window_days, pipeline_version)
    values ('46800000-0000-0000-0000-00000000000a', '46800000-0000-0000-0000-0000000000a1',
            '46800000-0000-0000-0000-0000000000e1', 'journal_empty', now(), '[]', 14, 'writing-dynamics-v1');
    raise exception 'FAIL: an observation with empty evidence was stored';
  exception
    when check_violation then null; -- expected
  end;

  begin
    insert into public.writing_change_observations
      (owner_user_id, participant_id, entry_id, field_name, observed_at, evidence, baseline_window_days, pipeline_version)
    values ('46800000-0000-0000-0000-00000000000a', '46800000-0000-0000-0000-0000000000a1',
            '46800000-0000-0000-0000-0000000000e1', 'journal_object', now(),
            '{"feature": "max_pause_ms"}', 14, 'writing-dynamics-v1');
    raise exception 'FAIL: an observation whose evidence is not an array was stored';
  exception
    when check_violation then null; -- expected
  end;

  begin
    insert into public.writing_change_observations
      (owner_user_id, participant_id, entry_id, field_name, observed_at, evidence, baseline_window_days, pipeline_version)
    values ('46800000-0000-0000-0000-00000000000a', '46800000-0000-0000-0000-0000000000a1',
            '46800000-0000-0000-0000-0000000000e1', 'journal_short', now(),
            '[{"feature": "max_pause_ms", "direction": "higher"}]', 13, 'writing-dynamics-v1');
    raise exception 'FAIL: an observation against a 13-day baseline was stored';
  exception
    when check_violation then null; -- expected
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 1-2. Student A: reads own writing_features, cannot write them, cannot see B's.
-- ---------------------------------------------------------------------------

reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub": "46800000-0000-0000-0000-00000000000a", "role": "authenticated"}';

do $$
begin
  if (select count(*) from public.writing_features) <> 1
     or not exists (select 1 from public.writing_features where id = '46800000-0000-0000-0000-0000000f0a01') then
    raise exception 'FAIL: student A should see exactly their own writing_features row';
  end if;

  begin
    insert into public.writing_features (owner_user_id, participant_id, entry_session_id, field_name)
    values ('46800000-0000-0000-0000-00000000000a', '46800000-0000-0000-0000-0000000000a1',
            '46800000-0000-0000-0000-0000000005a1', 'journal');
    raise exception 'FAIL: a student inserted their own writing_features row';
  exception
    when insufficient_privilege then null; -- expected
  end;

  begin
    update public.writing_features set feature_json = '{}'
     where id = '46800000-0000-0000-0000-0000000f0a01';
    raise exception 'FAIL: a student updated their own writing_features row';
  exception
    when insufficient_privilege then null; -- expected
  end;

  begin
    delete from public.writing_features where id = '46800000-0000-0000-0000-0000000f0a01';
    raise exception 'FAIL: a student deleted their own writing_features row';
  exception
    when insufficient_privilege then null; -- expected
  end;

  -- Someone else's row: no privilege at all, so the same refusal.
  begin
    update public.writing_features set feature_json = '{}'
     where id = '46800000-0000-0000-0000-0000000f0b01';
    raise exception 'FAIL: a student updated another student''s writing_features row';
  exception
    when insufficient_privilege then null; -- expected
  end;
  begin
    delete from public.writing_features where id = '46800000-0000-0000-0000-0000000f0b01';
    raise exception 'FAIL: a student deleted another student''s writing_features row';
  exception
    when insufficient_privilege then null; -- expected
  end;

  -- 3. A reads their own observation and not B's.
  if (select count(*) from public.writing_change_observations) <> 1
     or not exists (select 1 from public.writing_change_observations
                     where id = '46800000-0000-0000-0000-0000000c0a01') then
    raise exception 'FAIL: student A should see exactly their own observation';
  end if;

  -- 4. ... and cannot write one, theirs or anyone's.
  begin
    insert into public.writing_change_observations
      (owner_user_id, participant_id, entry_id, field_name, observed_at, evidence, baseline_window_days, pipeline_version)
    values ('46800000-0000-0000-0000-00000000000a', '46800000-0000-0000-0000-0000000000a1',
            '46800000-0000-0000-0000-0000000000e1', 'journal_forged', now(),
            '[{"feature": "max_pause_ms", "direction": "lower"}]', 14, 'writing-dynamics-v1');
    raise exception 'FAIL: a student inserted a writing change observation';
  exception
    when insufficient_privilege then null; -- expected
  end;
  begin
    update public.writing_change_observations set baseline_window_days = 30
     where id = '46800000-0000-0000-0000-0000000c0a01';
    raise exception 'FAIL: a student updated their own observation';
  exception
    when insufficient_privilege then null; -- expected
  end;
  begin
    delete from public.writing_change_observations where id = '46800000-0000-0000-0000-0000000c0a01';
    raise exception 'FAIL: a student deleted their own observation';
  exception
    when insufficient_privilege then null; -- expected
  end;
end $$;

-- Student B: own rows only.
set local request.jwt.claims = '{"sub": "46800000-0000-0000-0000-00000000000b", "role": "authenticated"}';

do $$
begin
  if (select count(*) from public.writing_features) <> 1
     or not exists (select 1 from public.writing_features where id = '46800000-0000-0000-0000-0000000f0b01') then
    raise exception 'FAIL: student B should see exactly their own writing_features row';
  end if;
  if (select count(*) from public.writing_change_observations) <> 1
     or exists (select 1 from public.writing_change_observations
                 where id = '46800000-0000-0000-0000-0000000c0a01') then
    raise exception 'FAIL: student B sees another student''s observation';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Educator E oversees A (roster + consent) but not B (roster, no consent).
-- ---------------------------------------------------------------------------

set local request.jwt.claims = '{"sub": "46800000-0000-0000-0000-00000000000e", "role": "authenticated"}';

do $$
begin
  if (select count(*) from public.writing_change_observations) <> 1
     or not exists (select 1 from public.writing_change_observations
                     where id = '46800000-0000-0000-0000-0000000c0a01') then
    raise exception 'FAIL: educator E should see exactly the overseen student''s observation';
  end if;
  -- The research record behind it stays out of reach (no educator policy).
  if (select count(*) from public.writing_features) <> 0 then
    raise exception 'FAIL: an educator reads writing_features (z-scores and baseline)';
  end if;
  begin
    insert into public.writing_change_observations
      (owner_user_id, participant_id, entry_id, field_name, observed_at, evidence, baseline_window_days, pipeline_version)
    values ('46800000-0000-0000-0000-00000000000a', '46800000-0000-0000-0000-0000000000a1',
            '46800000-0000-0000-0000-0000000000e1', 'journal_educator', now(),
            '[{"feature": "max_pause_ms", "direction": "higher"}]', 14, 'writing-dynamics-v1');
    raise exception 'FAIL: an educator inserted a writing change observation';
  exception
    when insufficient_privilege then null; -- expected
  end;
end $$;

-- Unrelated educator U: nothing.
set local request.jwt.claims = '{"sub": "46800000-0000-0000-0000-00000000000f", "role": "authenticated"}';

do $$
begin
  if (select count(*) from public.writing_change_observations) <> 0 then
    raise exception 'FAIL: an unrelated educator reads writing change observations';
  end if;
  if (select count(*) from public.writing_features) <> 0 then
    raise exception 'FAIL: an unrelated educator reads writing_features';
  end if;
end $$;

-- Consent revoked: E loses A's observation on the next read.
set local request.jwt.claims = '{"sub": "46800000-0000-0000-0000-00000000000a", "role": "authenticated"}';
update public.oversight_consents set status = 'revoked', revoked_at = now()
 where participant_id = '46800000-0000-0000-0000-0000000000a1';

set local request.jwt.claims = '{"sub": "46800000-0000-0000-0000-00000000000e", "role": "authenticated"}';
do $$
begin
  if (select count(*) from public.writing_change_observations) <> 0 then
    raise exception 'FAIL: educator still reads observations after consent was revoked';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. anon: no access to either table.
-- ---------------------------------------------------------------------------

reset role;
set local role anon;
set local request.jwt.claims = '{"role": "anon"}';

do $$
begin
  begin
    perform 1 from public.writing_change_observations;
    raise exception 'FAIL: anon can select writing_change_observations';
  exception
    when insufficient_privilege then null; -- expected
  end;
  begin
    perform 1 from public.writing_features;
    raise exception 'FAIL: anon can select writing_features';
  exception
    when insufficient_privilege then null; -- expected
  end;
  begin
    insert into public.writing_change_observations
      (owner_user_id, participant_id, entry_id, field_name, observed_at, evidence, baseline_window_days, pipeline_version)
    values ('46800000-0000-0000-0000-00000000000a', '46800000-0000-0000-0000-0000000000a1',
            '46800000-0000-0000-0000-0000000000e1', 'journal_anon', now(),
            '[{"feature": "max_pause_ms", "direction": "higher"}]', 14, 'writing-dynamics-v1');
    raise exception 'FAIL: anon inserted a writing change observation';
  exception
    when insufficient_privilege then null; -- expected
  end;
end $$;

-- And by grant, not only by behaviour.
reset role;
do $$
begin
  if exists (select 1 from information_schema.role_table_grants
              where table_schema = 'public'
                and table_name in ('writing_features', 'writing_change_observations')
                and grantee = 'anon') then
    raise exception 'FAIL: anon holds a privilege on a writing table';
  end if;
  if exists (select 1 from information_schema.role_table_grants
              where table_schema = 'public'
                and table_name in ('writing_features', 'writing_change_observations')
                and grantee = 'authenticated'
                and privilege_type <> 'SELECT') then
    raise exception 'FAIL: authenticated holds a write privilege on a writing table';
  end if;
end $$;

select 'ALL WRITING CHANGE RLS TESTS PASSED' as result;

rollback;
