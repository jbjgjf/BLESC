-- Terms / privacy acceptances: your own rows only, and never rewritten (#250).
--
-- Run against a local Supabase database with all migrations applied:
--   supabase db reset   (from sentra/)
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/legal_acceptances_rls.test.sql
--
-- Runs in one transaction and rolls back.
--
-- 20260921040000 says "UPDATE も DELETE も無い" — an acceptance record that can
-- be rewritten afterwards is not a record. Until now only a comment said so.

begin;

insert into auth.users (id, email)
values
  ('00000000-0000-0000-0000-000000025a01', 'alice@test.local'),
  ('00000000-0000-0000-0000-000000025a02', 'bob@test.local');

-- ---------------------------------------------------------------------------
-- 1. Alice records her own acceptances
-- ---------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-000000025a01", "role": "authenticated"}';

insert into public.legal_acceptances (user_id, document_id, document_version, effective_date)
values
  ('00000000-0000-0000-0000-000000025a01', 'terms', '2026-09-01', '2026-10-01'),
  ('00000000-0000-0000-0000-000000025a01', 'privacy', '2026-09-01-draft', null);

do $$
begin
  if (select count(*) from public.legal_acceptances) <> 2 then
    raise exception 'FAIL: alice cannot read back her own acceptances';
  end if;
end $$;

-- She cannot record an acceptance in Bob's name.
do $$
begin
  begin
    insert into public.legal_acceptances (user_id, document_id, document_version)
    values ('00000000-0000-0000-0000-000000025a02', 'terms', '2026-09-01');
    raise exception 'FAIL: alice recorded an acceptance for bob';
  exception when insufficient_privilege then null;
  end;
end $$;

-- Pressing "accept" twice on the same version is not a second fact.
do $$
begin
  begin
    insert into public.legal_acceptances (user_id, document_id, document_version)
    values ('00000000-0000-0000-0000-000000025a01', 'terms', '2026-09-01');
    raise exception 'FAIL: a duplicate (user, document, version) was accepted';
  exception when unique_violation then null;
  end;
end $$;

-- A different version of the same document is a new row.
insert into public.legal_acceptances (user_id, document_id, document_version)
values ('00000000-0000-0000-0000-000000025a01', 'terms', '2026-12-01');

-- ---------------------------------------------------------------------------
-- 2. Bob sees only Bob
-- ---------------------------------------------------------------------------

set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-000000025a02", "role": "authenticated"}';

insert into public.legal_acceptances (user_id, document_id, document_version)
values ('00000000-0000-0000-0000-000000025a02', 'terms', '2026-09-01');

do $$
begin
  if exists (select 1 from public.legal_acceptances
              where user_id = '00000000-0000-0000-0000-000000025a01') then
    raise exception 'FAIL: bob can read alice''s acceptances';
  end if;
  if (select count(*) from public.legal_acceptances) <> 1 then
    raise exception 'FAIL: bob should see exactly his own row';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Nobody rewrites or removes a record — not the owner, not anon
-- ---------------------------------------------------------------------------

/*
 * Tried as the owner of the row, which is the case a policy is most likely to
 * be loosened for ("let people fix a mistake"). Either refusal (no grant) or
 * zero rows (grant, but no policy) keeps the record; §4 then pins down which.
 */
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-000000025a01", "role": "authenticated"}';

do $$
declare
  touched integer := 0;
begin
  begin
    update public.legal_acceptances set accepted_at = now() - interval '1 year';
    get diagnostics touched = row_count;
  exception when insufficient_privilege then touched := 0;
  end;
  if touched <> 0 then
    raise exception 'FAIL: the owner back-dated % acceptance(s)', touched;
  end if;

  begin
    delete from public.legal_acceptances;
    get diagnostics touched = row_count;
  exception when insufficient_privilege then touched := 0;
  end;
  if touched <> 0 then
    raise exception 'FAIL: the owner deleted % acceptance(s)', touched;
  end if;
end $$;

reset role;
set local role anon;
do $$
begin
  begin
    perform 1 from public.legal_acceptances;
    raise exception 'FAIL: anon can read legal_acceptances';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

do $$
begin
  if (select count(*) from public.legal_acceptances
       where user_id = '00000000-0000-0000-0000-000000025a01') <> 3 then
    raise exception 'FAIL: alice''s acceptances changed';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. The shape of the permissions, so a loosening is caught at the source
-- ---------------------------------------------------------------------------

do $$
declare
  found text;
begin
  select string_agg(format('%s:%s', grantee, privilege_type), ', ')
    into found
    from information_schema.role_table_grants
   where table_schema = 'public'
     and table_name = 'legal_acceptances'
     and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')
     and privilege_type not in ('SELECT', 'INSERT');
  if found is not null then
    raise exception 'FAIL: legal_acceptances grants more than SELECT/INSERT: %', found;
  end if;

  if exists (select 1 from information_schema.role_table_grants
              where table_schema = 'public' and table_name = 'legal_acceptances' and grantee = 'anon') then
    raise exception 'FAIL: anon holds a privilege on legal_acceptances';
  end if;

  select string_agg(format('%s(%s)', policyname, cmd), ', ') into found
    from pg_policies
   where schemaname = 'public'
     and tablename = 'legal_acceptances'
     and cmd not in ('SELECT', 'INSERT');
  if found is not null then
    raise exception 'FAIL: legal_acceptances has a policy beyond SELECT/INSERT: %', found;
  end if;
end $$;

rollback;
