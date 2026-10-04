-- Every table in `public` has row-level security, and every one that is meant
-- to be read has a policy to read it by (#261).
--
-- Run against a local Supabase database with all migrations applied:
--   supabase db reset   (from sentra/)
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/rls_coverage.test.sql
--
-- Runs in one transaction and rolls back; it creates probe tables to prove the
-- sweep catches them and removes them.
--
-- `anon_grants.test.sql` sweeps the schema for grants rather than listing
-- tables, so a table added by a later migration is checked without anyone
-- remembering to add it. Its reasoning rests on "row-level security filtered
-- every row operation", and nothing checked that premise. `authenticated`
-- holds SELECT/INSERT on almost every table, and without RLS that grant
-- applies to every row. So one missing `alter table ... enable row level
-- security` would let any signed-in participant read every row of that
-- table, and CI would stay green. This file sweeps the same way for that line.

begin;

-- ---------------------------------------------------------------------------
-- 0. The exceptions, with their reasons, where the test reads them
-- ---------------------------------------------------------------------------

/*
 * Tables that deliberately have RLS on and *no* policy: only `service_role`
 * (which bypasses RLS) touches them, and `anon` / `authenticated` must hold no
 * privilege on them at all — §3 below asserts that, so an entry here cannot be
 * used to hide a table that the API roles can in fact reach.
 *
 * There is intentionally no list of tables allowed to have RLS *off*. If one
 * is ever needed, it goes here with its reason, not in a migration comment.
 */
create temporary table rls_service_only (table_name text primary key, reason text not null) on commit drop;
insert into rls_service_only values
  ('pilot_crisis_reviews',
   'protocol §4.4 review queue; operators are an env allowlist checked in the API layer, not a role (20260921030000)'),
  ('pilot_crisis_review_reads',
   'audit log of who opened a journal; written and read only by the triage API via service_role (20260921030000, #256)'),
  ('pilot_invitations',
   'invitation codes are stored hashed and redeemed only through SECURITY DEFINER functions (20260906010000)'),
  ('rate_limit_counters',
   'written only by the server-side limiter with service_role; participants have no reason to see it (20260921000000)');

-- The sweep, as a function so the probes in §4 can re-run exactly the same query.
create function pg_temp.rls_gaps()
returns table (table_name text, problem text)
language sql
stable
as $$
  -- Tables (plain and partitioned) with RLS off.
  select c.relname::text, 'row level security is not enabled'
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind in ('r', 'p')
     and not c.relrowsecurity
  union all
  -- RLS on, no policy, and not a declared service-only table: nobody but
  -- service_role can read it, so whatever feature uses it is silently broken.
  select c.relname::text, 'row level security is enabled but no policy exists'
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind in ('r', 'p')
     and c.relrowsecurity
     and not exists (select 1 from pg_policies p
                      where p.schemaname = 'public' and p.tablename = c.relname)
     and c.relname not in (select s.table_name from rls_service_only s)
  union all
  -- A view runs with its owner's rights unless it says otherwise, which skips
  -- RLS on everything it reads. One the API roles can read must be
  -- security_invoker.
  select c.relname::text, 'view readable by anon/authenticated is not security_invoker'
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind in ('v', 'm')
     and (has_table_privilege('anon', c.oid, 'select')
          or has_table_privilege('authenticated', c.oid, 'select'))
     and not coalesce('security_invoker=true' = any(c.reloptions)
                      or 'security_invoker=on' = any(c.reloptions), false)
$$;

-- ---------------------------------------------------------------------------
-- 1. No table in `public` has RLS off, no table is silently unreadable
-- ---------------------------------------------------------------------------

do $$
declare
  gaps text;
begin
  select string_agg(format('%s (%s)', table_name, problem), '; ' order by table_name)
    into gaps
    from pg_temp.rls_gaps();
  if gaps is not null then
    raise exception 'FAIL: %', gaps;
  end if;
end $$;

-- The sweep saw something. A query that matched no tables at all would pass §1.
do $$
declare
  n integer;
begin
  select count(*) into n
    from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public' and c.relkind in ('r', 'p');
  if n < 40 then
    raise exception 'FAIL: only % tables in public; is this running against a migrated database?', n;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. The exception list is not stale
-- ---------------------------------------------------------------------------

do $$
declare
  stale text;
begin
  select string_agg(s.table_name, ', ') into stale
    from rls_service_only s
   where not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                      where n.nspname = 'public' and c.relname = s.table_name);
  if stale is not null then
    raise exception 'FAIL: rls_service_only names tables that no longer exist: %', stale;
  end if;

  -- A table that gained a policy no longer needs the exemption, and keeping it
  -- would let the policy be dropped later without anything noticing.
  select string_agg(s.table_name, ', ') into stale
    from rls_service_only s
   where exists (select 1 from pg_policies p
                  where p.schemaname = 'public' and p.tablename = s.table_name);
  if stale is not null then
    raise exception 'FAIL: rls_service_only exempts tables that now have policies: %', stale;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. "Service only" means the API roles hold nothing
-- ---------------------------------------------------------------------------

do $$
declare
  leaks text;
begin
  select string_agg(distinct format('%s -> %s', g.table_name, g.grantee), ', ')
    into leaks
    from information_schema.role_table_grants g
    join rls_service_only s on s.table_name = g.table_name
   where g.table_schema = 'public'
     and g.grantee in ('anon', 'authenticated', 'PUBLIC');
  if leaks is not null then
    raise exception 'FAIL: service-only tables are granted to API roles: %', leaks;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. The sweep catches what it is for
-- ---------------------------------------------------------------------------

/*
 * The same demonstration anon_grants.test.sql §4 makes: create the mistake and
 * watch the check fail on it. Each probe is created the way a careless
 * migration would create it — with the grant every other table carries.
 */

create table public.rls_probe_forgotten (id integer);
grant select, insert on public.rls_probe_forgotten to authenticated;

create table public.rls_probe_no_policy (id integer);
alter table public.rls_probe_no_policy enable row level security;
grant select on public.rls_probe_no_policy to authenticated;

create table public.rls_probe_ok (id integer);
alter table public.rls_probe_ok enable row level security;
create policy rls_probe_ok_select on public.rls_probe_ok for select to authenticated using (true);

create view public.rls_probe_definer_view as select id from public.rls_probe_ok;
grant select on public.rls_probe_definer_view to authenticated;

create view public.rls_probe_invoker_view with (security_invoker = true) as select id from public.rls_probe_ok;
grant select on public.rls_probe_invoker_view to authenticated;

do $$
declare
  found text[];
begin
  select array_agg(format('%s: %s', table_name, problem) order by table_name)
    into found
    from pg_temp.rls_gaps()
   where table_name like 'rls\_probe\_%';

  if found is distinct from array[
       'rls_probe_definer_view: view readable by anon/authenticated is not security_invoker',
       'rls_probe_forgotten: row level security is not enabled',
       'rls_probe_no_policy: row level security is enabled but no policy exists'
     ] then
    raise exception 'FAIL: the sweep did not report exactly the planted mistakes; got %', found;
  end if;
end $$;

-- Make the forgotten table concrete: without RLS the grant reaches every row.
insert into public.rls_probe_forgotten values (1), (2);
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-000000000261", "role": "authenticated"}';
do $$
begin
  if (select count(*) from public.rls_probe_forgotten) <> 2 then
    raise exception 'FAIL: expected the unprotected probe to be fully readable (the premise of this test)';
  end if;
end $$;
reset role;

rollback;
