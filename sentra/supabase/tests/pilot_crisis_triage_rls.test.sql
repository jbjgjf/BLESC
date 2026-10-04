-- The crisis review queue and the record of who read a journal are
-- service_role only (#250).
--
-- Run against a local Supabase database with all migrations applied:
--   supabase db reset   (from sentra/)
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/pilot_crisis_triage_rls.test.sql
--
-- Runs in one transaction and rolls back.
--
-- 20260921030000 states the intent: revoke everything from anon and
-- authenticated, and grant service_role only what the triage API uses. This
-- file checks that intent. `pilot_crisis_review_reads` matters most: it is the
-- audit log of a person reading a minor's diary. Students and educators must
-- not be able to read it, and nobody may delete from it.

begin;

-- ---------------------------------------------------------------------------
-- Fixtures: a student with a reviewed entry, an educator who oversees them
-- with consent, and an operator who read the entry.
-- ---------------------------------------------------------------------------

insert into auth.users (id, email)
values
  ('00000000-0000-0000-0000-0000000250a0', 'student@test.local'),
  ('00000000-0000-0000-0000-0000000250e0', 'educator@test.local'),
  ('00000000-0000-0000-0000-0000000250d0', 'org-admin@test.local'),
  ('00000000-0000-0000-0000-0000000250f0', 'operator@test.local');

insert into public.participants (id, owner_user_id, code)
values ('00000000-0000-0000-0000-0000000250a1', '00000000-0000-0000-0000-0000000250a0', 'STUDENT_250');

insert into public.entries (id, owner_user_id, participant_id, raw_text, is_masked)
values ('00000000-0000-0000-0000-0000000250e1', '00000000-0000-0000-0000-0000000250a0',
        '00000000-0000-0000-0000-0000000250a1', 'x', false);

insert into public.pilot_crisis_reviews
  (id, owner_user_id, participant_id, entry_id, assessed_risk, assessor_version, status, reviewed_by, reviewed_at)
values ('00000000-0000-0000-0000-0000000250c1', '00000000-0000-0000-0000-0000000250a0',
        '00000000-0000-0000-0000-0000000250a1', '00000000-0000-0000-0000-0000000250e1',
        'crisis', 'test', 'escalated', '00000000-0000-0000-0000-0000000250f0', now());

insert into public.pilot_crisis_review_reads (review_id, entry_id, read_by, included_raw_text)
values ('00000000-0000-0000-0000-0000000250c1', '00000000-0000-0000-0000-0000000250e1',
        '00000000-0000-0000-0000-0000000250f0', true);

-- The educator oversees the student, with the student's consent — the strongest
-- position an educator can be in. If they cannot read the queue from here, no
-- educator can.
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000250d0", "role": "authenticated"}';
insert into public.organizations (id, name, created_by)
values ('00000000-0000-0000-0000-000000025001', 'Test School 250', '00000000-0000-0000-0000-0000000250d0');
insert into public.organization_members (org_id, member_user_id, role)
values ('00000000-0000-0000-0000-000000025001', '00000000-0000-0000-0000-0000000250e0', 'educator');
insert into public.oversight_roster (org_id, educator_user_id, participant_id, owner_user_id, status)
values ('00000000-0000-0000-0000-000000025001', '00000000-0000-0000-0000-0000000250e0',
        '00000000-0000-0000-0000-0000000250a1', '00000000-0000-0000-0000-0000000250a0', 'active');

set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000250a0", "role": "authenticated"}';
insert into public.oversight_consents (participant_id, owner_user_id, org_id)
values ('00000000-0000-0000-0000-0000000250a1', '00000000-0000-0000-0000-0000000250a0',
        '00000000-0000-0000-0000-000000025001');
reset role;

-- ---------------------------------------------------------------------------
-- 1. No privilege for anon or authenticated, on either table
-- ---------------------------------------------------------------------------

do $$
declare
  held text;
begin
  select string_agg(format('%s:%s:%s', table_name, grantee, privilege_type), ', ' order by 1)
    into held
    from information_schema.role_table_grants
   where table_schema = 'public'
     and table_name in ('pilot_crisis_reviews', 'pilot_crisis_review_reads')
     and grantee in ('anon', 'authenticated', 'PUBLIC');
  if held is not null then
    raise exception 'FAIL: the crisis triage tables are granted to API roles: %', held;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Nobody but service_role can touch them — tried, not only inspected
-- ---------------------------------------------------------------------------

/*
 * Each operation is attempted as each API role, as the student whose entry it
 * is and as the consenting educator. Every one must be refused with 42501; a
 * zero-row answer would mean a grant had come back and only RLS stood in the
 * way, which §1 forbids.
 */
create function pg_temp.expect_refused(role_name text, sub uuid, stmt text)
returns void
language plpgsql
as $$
begin
  execute format('set local role %I', role_name);
  perform set_config('request.jwt.claims',
                     json_build_object('sub', sub, 'role', role_name)::text, true);
  begin
    execute stmt;
    reset role;
    raise exception 'FAIL: % (sub %) was allowed: %', role_name, sub, stmt;
  exception when insufficient_privilege then
    reset role;
  end;
end;
$$;

do $$
declare
  who record;
  stmt text;
begin
  for who in
    select * from (values
      ('anon', null::uuid),
      ('authenticated', '00000000-0000-0000-0000-0000000250a0'::uuid),  -- the student
      ('authenticated', '00000000-0000-0000-0000-0000000250e0'::uuid),  -- the educator
      ('authenticated', '00000000-0000-0000-0000-0000000250f0'::uuid)   -- the operator, via the API role
    ) as t(role_name, sub)
  loop
    foreach stmt in array array[
      'select 1 from public.pilot_crisis_reviews',
      'insert into public.pilot_crisis_reviews (owner_user_id, participant_id, entry_id, assessor_version) values (''00000000-0000-0000-0000-0000000250a0'', ''00000000-0000-0000-0000-0000000250a1'', ''00000000-0000-0000-0000-0000000250e1'', ''x'')',
      'update public.pilot_crisis_reviews set status = ''no_concern''',
      'delete from public.pilot_crisis_reviews',
      'select 1 from public.pilot_crisis_review_reads',
      'insert into public.pilot_crisis_review_reads (review_id, entry_id, read_by) values (''00000000-0000-0000-0000-0000000250c1'', ''00000000-0000-0000-0000-0000000250e1'', ''00000000-0000-0000-0000-0000000250a0'')',
      'update public.pilot_crisis_review_reads set included_raw_text = false',
      'delete from public.pilot_crisis_review_reads'
    ]
    loop
      perform pg_temp.expect_refused(who.role_name, who.sub, stmt);
    end loop;
  end loop;
end $$;

-- The educator's legitimate path to the student is unaffected: they can still
-- see the student on their roster. Their inability to see the queue is the
-- table's doing, not a broken fixture.
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000250e0", "role": "authenticated"}';
do $$
begin
  if not exists (select 1 from public.overseen_participants()
                  where participant_id = '00000000-0000-0000-0000-0000000250a1') then
    raise exception 'FAIL: fixture broken — the educator does not oversee the student';
  end if;
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- 3. The audit log cannot be deleted from, by anyone, by grant or by policy
-- ---------------------------------------------------------------------------

do $$
declare
  found text;
begin
  select string_agg(format('%s:%s', grantee, privilege_type), ', ')
    into found
    from information_schema.role_table_grants
   where table_schema = 'public'
     and table_name = 'pilot_crisis_review_reads'
     and privilege_type in ('DELETE', 'TRUNCATE', 'UPDATE')
     and grantee <> 'postgres';
  if found is not null then
    raise exception 'FAIL: pilot_crisis_review_reads can be rewritten or removed via: %', found;
  end if;

  select string_agg(policyname, ', ') into found
    from pg_policies
   where schemaname = 'public'
     and tablename = 'pilot_crisis_review_reads';
  if found is not null then
    raise exception 'FAIL: pilot_crisis_review_reads has policies (%); it is service_role only', found;
  end if;
end $$;

-- service_role keeps exactly what the triage API uses.
do $$
begin
  if not has_table_privilege('service_role', 'public.pilot_crisis_review_reads', 'select')
     or not has_table_privilege('service_role', 'public.pilot_crisis_review_reads', 'insert') then
    raise exception 'FAIL: service_role cannot log a read; crisisTriage.readEntryText would refuse every journal';
  end if;
  if has_table_privilege('service_role', 'public.pilot_crisis_review_reads', 'delete') then
    raise exception 'FAIL: service_role can delete the read log';
  end if;
  if not has_table_privilege('service_role', 'public.pilot_crisis_reviews', 'update') then
    raise exception 'FAIL: service_role cannot record a review decision';
  end if;
end $$;

-- And as service_role, a delete is refused, not filtered.
set local role service_role;
do $$
begin
  begin
    delete from public.pilot_crisis_review_reads;
    raise exception 'FAIL: service_role deleted from the read log';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

rollback;
