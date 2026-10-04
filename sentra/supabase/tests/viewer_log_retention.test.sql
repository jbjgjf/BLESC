-- The record of who looked at a student's data outlives the looker's account (#256).
--
-- Run against a local Supabase database with all migrations applied:
--   supabase db reset   (from sentra/)
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/viewer_log_retention.test.sql
--
-- Runs in one transaction and rolls back.
--
-- `educator_access_log` said "Immutable by design ... Students can always see
-- who looked at their data", and `pilot_crisis_review_reads` refuses to show a
-- journal unless the read is logged. Both pointed at `auth.users` with
-- `on delete cascade`, so deleting the viewer's account deleted every row that
-- said they had looked. No DELETE policy is needed for that; the foreign key
-- does it as the table owner.

begin;

-- ---------------------------------------------------------------------------
-- Fixtures (as superuser)
-- ---------------------------------------------------------------------------

insert into auth.users (id, email)
values
  ('00000000-0000-0000-0000-0000000256a0', 'student@test.local'),
  ('00000000-0000-0000-0000-0000000256e0', 'educator@test.local'),
  ('00000000-0000-0000-0000-0000000256d0', 'org-admin@test.local'),
  ('00000000-0000-0000-0000-0000000256f0', 'operator@test.local');

insert into public.participants (id, owner_user_id, code)
values ('00000000-0000-0000-0000-0000000256a1', '00000000-0000-0000-0000-0000000256a0', 'STUDENT_256');

insert into public.entries (id, owner_user_id, participant_id, raw_text, is_masked)
values ('00000000-0000-0000-0000-0000000256e1', '00000000-0000-0000-0000-0000000256a0',
        '00000000-0000-0000-0000-0000000256a1', 'x', false);

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000256d0", "role": "authenticated"}';
insert into public.organizations (id, name, created_by)
values ('00000000-0000-0000-0000-000000025601', 'Test School 256', '00000000-0000-0000-0000-0000000256d0');
reset role;

insert into public.educator_access_log (educator_user_id, org_id, participant_id, owner_user_id, view_type, educator_ref)
values ('00000000-0000-0000-0000-0000000256e0', '00000000-0000-0000-0000-000000025601',
        '00000000-0000-0000-0000-0000000256a1', '00000000-0000-0000-0000-0000000256a0', 'student_overview',
        -- A forged reference. The trigger must ignore it.
        'forged');

insert into public.pilot_crisis_reviews (id, owner_user_id, participant_id, entry_id, assessor_version)
values ('00000000-0000-0000-0000-0000000256c1', '00000000-0000-0000-0000-0000000256a0',
        '00000000-0000-0000-0000-0000000256a1', '00000000-0000-0000-0000-0000000256e1', 'test');

insert into public.pilot_crisis_review_reads (review_id, entry_id, read_by, included_raw_text)
values ('00000000-0000-0000-0000-0000000256c1', '00000000-0000-0000-0000-0000000256e1',
        '00000000-0000-0000-0000-0000000256f0', true);

-- ---------------------------------------------------------------------------
-- 1. The reference is computed by the database, not taken from the caller
-- ---------------------------------------------------------------------------

do $$
begin
  if (select educator_ref from public.educator_access_log
       where participant_id = '00000000-0000-0000-0000-0000000256a1')
     is distinct from public.viewer_ref('00000000-0000-0000-0000-0000000256e0') then
    raise exception 'FAIL: educator_ref was not computed from educator_user_id';
  end if;
  if (select read_by_ref from public.pilot_crisis_review_reads
       where review_id = '00000000-0000-0000-0000-0000000256c1')
     is distinct from public.viewer_ref('00000000-0000-0000-0000-0000000256f0') then
    raise exception 'FAIL: read_by_ref was not computed from read_by';
  end if;
  if public.viewer_ref('00000000-0000-0000-0000-0000000256e0') !~ '^[0-9a-f]{64}$' then
    raise exception 'FAIL: viewer_ref is not a sha256 hex digest';
  end if;
end $$;

-- A view with no viewer cannot be written. Nullable is for account deletion only.
do $$
begin
  begin
    insert into public.pilot_crisis_review_reads (review_id, entry_id, read_by)
    values ('00000000-0000-0000-0000-0000000256c1', '00000000-0000-0000-0000-0000000256e1', null);
    raise exception 'FAIL: a read with no reader was recorded';
  exception when not_null_violation then null;
  end;
  begin
    insert into public.educator_access_log (educator_user_id, org_id, participant_id, owner_user_id, view_type)
    values (null, '00000000-0000-0000-0000-000000025601',
            '00000000-0000-0000-0000-0000000256a1', '00000000-0000-0000-0000-0000000256a0', 'roster');
    raise exception 'FAIL: an educator view with no educator was recorded';
  exception when not_null_violation then null;
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Append-only holds for the table owner too, not only for `authenticated`
-- ---------------------------------------------------------------------------

do $$
begin
  begin
    update public.educator_access_log set view_type = 'roster'
     where participant_id = '00000000-0000-0000-0000-0000000256a1';
    raise exception 'FAIL: the superuser rewrote an educator_access_log row';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.pilot_crisis_review_reads set read_at = now() - interval '1 day'
     where review_id = '00000000-0000-0000-0000-0000000256c1';
    raise exception 'FAIL: the superuser back-dated a pilot_crisis_review_reads row';
  exception when insufficient_privilege then null;
  end;
  -- Nulling the viewer by hand while also changing something else is still a rewrite.
  begin
    update public.pilot_crisis_review_reads set read_by = null, included_raw_text = false
     where review_id = '00000000-0000-0000-0000-0000000256c1';
    raise exception 'FAIL: a read was rewritten under cover of the viewer being nulled';
  exception when insufficient_privilege then null;
  end;
end $$;

-- No role holds DELETE on either log.
do $$
declare
  holders text;
begin
  select string_agg(format('%s on %s', grantee, table_name), ', ')
    into holders
    from information_schema.role_table_grants
   where table_schema = 'public'
     and table_name in ('educator_access_log', 'pilot_crisis_review_reads')
     and privilege_type in ('DELETE', 'TRUNCATE', 'UPDATE')
     and grantee in ('anon', 'authenticated', 'service_role');
  if holders is not null then
    raise exception 'FAIL: a viewer log can be rewritten or removed by: %', holders;
  end if;

  select string_agg(format('%s.%s', tablename, policyname), ', ')
    into holders
    from pg_policies
   where schemaname = 'public'
     and tablename in ('educator_access_log', 'pilot_crisis_review_reads')
     and cmd in ('DELETE', 'UPDATE', 'ALL');
  if holders is not null then
    raise exception 'FAIL: a viewer log has an UPDATE/DELETE policy: %', holders;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Deleting the viewer's account keeps the rows, and who it was stays traceable
-- ---------------------------------------------------------------------------

delete from auth.users where id in ('00000000-0000-0000-0000-0000000256e0', '00000000-0000-0000-0000-0000000256f0');

do $$
declare
  log_row public.educator_access_log;
  read_row public.pilot_crisis_review_reads;
begin
  select * into log_row from public.educator_access_log
   where participant_id = '00000000-0000-0000-0000-0000000256a1';
  if not found then
    raise exception 'FAIL: deleting the educator''s account deleted their educator_access_log rows';
  end if;
  if log_row.educator_user_id is not null then
    raise exception 'FAIL: educator_user_id still points at a deleted account';
  end if;
  if log_row.educator_ref <> public.viewer_ref('00000000-0000-0000-0000-0000000256e0') then
    raise exception 'FAIL: after deletion, the view can no longer be attributed to the educator';
  end if;
  if log_row.view_type <> 'student_overview' then
    raise exception 'FAIL: the row changed beyond the viewer column';
  end if;

  select * into read_row from public.pilot_crisis_review_reads
   where review_id = '00000000-0000-0000-0000-0000000256c1';
  if not found then
    raise exception 'FAIL: deleting the reviewer''s account deleted their pilot_crisis_review_reads rows';
  end if;
  if read_row.read_by is not null
     or read_row.read_by_ref <> public.viewer_ref('00000000-0000-0000-0000-0000000256f0')
     or read_row.included_raw_text is distinct from true then
    raise exception 'FAIL: the surviving read no longer says who read the journal, or what they saw';
  end if;
end $$;

-- The student still sees that somebody from the school looked.
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000256a0", "role": "authenticated"}';

do $$
begin
  if (select count(*) from public.educator_access_log) <> 1 then
    raise exception 'FAIL: the student lost sight of a view after the viewer''s account was deleted';
  end if;
end $$;

reset role;

-- ---------------------------------------------------------------------------
-- 4. The student's own deletion still takes the logs with it
-- ---------------------------------------------------------------------------

/*
 * Withdrawal and deletion are the student's promise. The logs describe their
 * data, so they go with it — this migration must not have made them outlive the
 * student as well as the viewer.
 */
delete from public.participants where id = '00000000-0000-0000-0000-0000000256a1';

do $$
begin
  if exists (select 1 from public.educator_access_log
              where participant_id = '00000000-0000-0000-0000-0000000256a1') then
    raise exception 'FAIL: educator_access_log outlived the student''s participant row';
  end if;
  if exists (select 1 from public.pilot_crisis_review_reads
              where entry_id = '00000000-0000-0000-0000-0000000256e1') then
    raise exception 'FAIL: pilot_crisis_review_reads outlived the student''s entry';
  end if;
end $$;

rollback;
