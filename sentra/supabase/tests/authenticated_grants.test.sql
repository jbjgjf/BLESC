-- `authenticated` cannot TRUNCATE, and append-only records stay append-only
-- even under the service key.
--
-- Run against a local Supabase database with all migrations applied:
--   supabase db reset   (from sentra/)
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/authenticated_grants.test.sql
--
-- Runs in one transaction and rolls back; it creates one table to check the
-- default-privileges change and removes it.
--
-- The sibling of anon_grants.test.sql. That file explains why TRUNCATE is the
-- privilege that matters (§2): RLS filters rows, and TRUNCATE is not a row
-- operation. Here the role holding the key is a signed-in student rather than
-- anyone with the public key, and before 20260927000000 the answer was the
-- same: every table's contents, one statement away.

begin;

-- ---------------------------------------------------------------------------
-- 1. No table grants TRUNCATE to `authenticated`
-- ---------------------------------------------------------------------------

/*
 * `has_table_privilege` rather than `role_table_grants`, so a grant that
 * reaches `authenticated` through PUBLIC or a role it is a member of fails this
 * too — the question is what the role can do, not how it was granted.
 */
do $$
declare
  leftovers text;
begin
  select string_agg(c.relname, ', ' order by c.relname)
    into leftovers
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind in ('r', 'p')
     and has_table_privilege('authenticated', c.oid, 'TRUNCATE');

  if leftovers is not null then
    raise exception 'authenticated can still TRUNCATE: %', leftovers;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Nor REFERENCES or TRIGGER
-- ---------------------------------------------------------------------------

/*
 * Neither is used by any screen. REFERENCES lets a role declare a foreign key
 * that probes another table's keys; TRIGGER lets it attach code to someone
 * else's writes. Both were only ever there because the stock default grants
 * everything.
 */
do $$
declare
  leftovers text;
begin
  select string_agg(format('%s (%s)', c.relname, p.priv), ', ' order by c.relname, p.priv)
    into leftovers
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join (values ('REFERENCES'), ('TRIGGER')) as p(priv)
   where n.nspname = 'public'
     and c.relkind in ('r', 'p')
     and has_table_privilege('authenticated', c.oid, p.priv);

  if leftovers is not null then
    raise exception 'authenticated still holds: %', leftovers;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. And it is refused, not just absent from the catalog
-- ---------------------------------------------------------------------------

/*
 * The catalog checks above are the sweep; this is the thing they are about.
 * If the TRUNCATE went through, the rollback at the end would undo it — but
 * the script would already have failed.
 */
set local role authenticated;

do $$
begin
  begin
    truncate public.entries cascade;
    raise exception 'authenticated emptied public.entries';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;

reset role;

-- ---------------------------------------------------------------------------
-- 4. A table created after the migration does not arrive with them
-- ---------------------------------------------------------------------------

create table public.authenticated_grant_probe (id integer);

do $$
declare
  granted text;
begin
  select string_agg(privilege_type, ', ' order by privilege_type)
    into granted
    from information_schema.role_table_grants
   where table_schema = 'public'
     and table_name = 'authenticated_grant_probe'
     and grantee = 'authenticated'
     and privilege_type in ('TRUNCATE', 'REFERENCES', 'TRIGGER');

  if granted is not null then
    raise exception
      'a newly created table arrived granting authenticated %; the default privileges were not changed', granted;
  end if;
end;
$$;

drop table public.authenticated_grant_probe;

-- ---------------------------------------------------------------------------
-- 5. Append-only records: `service_role` may read and add, nothing else
-- ---------------------------------------------------------------------------

/*
 * Each table's own migration calls it an audit record. The service key is the
 * one every server route holds, so a bug in any of them — or a leaked key —
 * could otherwise rewrite who was told about a safety escalation, or which
 * cohorts a researcher exported.
 *
 * Exact, not "at most": losing INSERT would break the sender, and this is the
 * place that would notice.
 */
do $$
declare
  t text;
  priv text;
  expected boolean;
begin
  foreach t in array array[
    'pilot_enrollment_events',
    'safety_escalation_deliveries',
    'research_exports'
  ]
  loop
    foreach priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
    loop
      expected := priv in ('SELECT', 'INSERT');
      if has_table_privilege('service_role', format('public.%I', t), priv) <> expected then
        raise exception 'service_role % % on public.% (expected %)',
          case when expected then 'lacks' else 'holds' end, priv, t,
          case when expected then 'granted' else 'revoked' end;
      end if;
    end loop;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. What the app does use is still there
-- ---------------------------------------------------------------------------

/*
 * The revoke touched every table, so check a few of the grants the screens
 * depend on. Picked to cover a table-wide grant, a column-level one, and a
 * table the service key writes freely.
 */
do $$
begin
  if not has_table_privilege('authenticated', 'public.participants', 'SELECT') then
    raise exception 'authenticated lost SELECT on participants';
  end if;
  if not has_table_privilege('authenticated', 'public.pilot_studies', 'SELECT') then
    raise exception 'authenticated lost SELECT on pilot_studies';
  end if;
  if not has_column_privilege('authenticated', 'public.safety_escalations', 'acknowledged_at', 'UPDATE') then
    raise exception 'authenticated lost UPDATE (acknowledged_at) on safety_escalations';
  end if;
  if not has_table_privilege('service_role', 'public.safety_escalations', 'UPDATE') then
    raise exception 'service_role lost UPDATE on safety_escalations — the sender marks rows sent';
  end if;
end;
$$;

rollback;
