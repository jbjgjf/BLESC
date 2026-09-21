-- No table in `public` grants anything to `anon` (#166).
--
-- Run against a local Supabase database with all migrations applied:
--   supabase db reset   (from sentra/)
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/anon_grants.test.sql
--
-- Runs in one transaction and rolls back; it creates one table to check the
-- default-privileges change and removes it.
--
-- The claim: this product has no anonymous surface that reads or writes a
-- table, so `anon` should hold no table privilege at all. Before
-- 20260921010000 it held the full stock set on forty tables — invisible,
-- because row-level security filtered every row operation and nothing tried
-- the one operation policies do not filter.

begin;

-- ---------------------------------------------------------------------------
-- 1. Nothing is granted to `anon`
-- ---------------------------------------------------------------------------

do $$
declare
  leftovers text;
  n integer;
begin
  select count(*), string_agg(distinct table_name, ', ' order by table_name)
    into n, leftovers
    from information_schema.role_table_grants
   where table_schema = 'public'
     and grantee = 'anon';

  if n > 0 then
    raise exception 'anon still holds table privileges on: %', leftovers;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. TRUNCATE specifically — the one policies do not filter
-- ---------------------------------------------------------------------------

/*
 * Asserted separately from the sweep above because it is the reason the sweep
 * matters. SELECT/INSERT/UPDATE/DELETE by `anon` were already answered with
 * zero rows by RLS; TRUNCATE is checked against the table privilege alone, so
 * the anon key — which ships in the browser bundle — plus a direct Postgres
 * connection could empty `entries`, `consent_records` or `participants`.
 */
do $$
declare
  n integer;
begin
  select count(*) into n
    from information_schema.role_table_grants
   where table_schema = 'public'
     and grantee = 'anon'
     and privilege_type = 'TRUNCATE';
  if n > 0 then
    raise exception '% table(s) still let anon TRUNCATE', n;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. No policy admits `anon` either
-- ---------------------------------------------------------------------------

/*
 * The grants are gone, so a policy admitting `anon` would currently have no
 * privilege to act on. This is the belt to that braces: if someone restores a
 * grant, a policy already in place would make it immediately effective, and
 * the pair is much easier to miss than either alone.
 */
do $$
declare
  offending text;
begin
  select string_agg(format('%s.%s', tablename, policyname), ', ' order by tablename)
    into offending
    from pg_policies
   where schemaname = 'public'
     and 'anon' = any(roles);

  if offending is not null then
    raise exception 'policies admit anon: %', offending;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. A table created after the migration does not arrive pre-granted
-- ---------------------------------------------------------------------------

create table public.anon_grant_probe (id integer);

do $$
declare
  n integer;
begin
  select count(*) into n
    from information_schema.role_table_grants
   where table_schema = 'public'
     and table_name = 'anon_grant_probe'
     and grantee = 'anon';

  if n > 0 then
    raise exception
      'a newly created table arrived with % anon grant(s); the default privileges were not changed', n;
  end if;
end;
$$;

drop table public.anon_grant_probe;

-- ---------------------------------------------------------------------------
-- 5. The public surface that does exist still works
-- ---------------------------------------------------------------------------

/*
 * The guardian confirmation screen is opened by a parent with no account, so
 * `anon` must still be able to call the function behind it. It is SECURITY
 * DEFINER and its EXECUTE grant is not a table privilege, so the revoke above
 * does not touch it — asserted rather than assumed, because "we revoked
 * everything from anon" is exactly the change that breaks the one anonymous
 * path in a product by accident.
 */
do $$
declare
  ok boolean;
begin
  select has_function_privilege('anon', p.oid, 'EXECUTE') into ok
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'redeem_guardian_token'
   limit 1;

  if ok is null then
    raise notice 'redeem_guardian_token not present; skipping';
  elsif not ok then
    raise exception 'anon can no longer redeem a guardian token — the guardian screen is broken';
  end if;
end;
$$;

rollback;
