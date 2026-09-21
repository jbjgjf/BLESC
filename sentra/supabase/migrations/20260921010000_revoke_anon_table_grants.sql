-- Take the stock `anon` grants off every table (#166).
--
-- ===========================================================================
-- Privileges only. No table, column, policy or row is changed, and nothing
-- the application does today goes through these grants.
-- ===========================================================================
--
-- ## The finding
--
-- Forty tables in `public` still carry Supabase's default grant to `anon`:
-- SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER. That default
-- is applied by
--
--     alter default privileges in schema public
--       grant all on tables to postgres, anon, authenticated, service_role;
--
-- which a stock project ships, so every `create table` since the first
-- migration arrived pre-granted. Later migrations wrote `grant select … to
-- authenticated`, which reads like a narrowing and is not one: it adds a
-- privilege the role already held and leaves everything else in place. The
-- pilot tables were fixed this way in 20260910000000; these forty were not.
--
-- **Not one of these tables has a policy admitting `anon`.** Verified against
-- `pg_policies`: zero rows where `'anon' = any(roles)`. So every one of these
-- grants is a privilege with nothing behind it.
--
-- ## Why that is not harmless
--
-- Row-level security is enabled, so a `select` by `anon` returns nothing today
-- and no data is currently exposed. Two things are still wrong, and they are
-- the same two that justified 20260910000000:
--
--   1. **TRUNCATE is not a row operation.** SELECT, INSERT, UPDATE and DELETE
--      are filtered by policies; TRUNCATE is checked against the table
--      privilege alone. Anyone holding the anon key — which is public, it ships
--      in the browser bundle — and a direct Postgres connection can empty
--      `entries`, `consent_records` and `participants`. PostgREST does not
--      expose TRUNCATE, which is what has kept this unreachable: a property of
--      the API surface, not of the permission model.
--   2. **One permissive policy away from open.** These tables are protected
--      only by the absence of a policy for `anon`. A later migration that adds
--      one — or a moment with RLS disabled to debug something — opens full DML
--      immediately, because the grant underneath was never removed. Defence
--      that depends on nobody adding a policy is not defence.
--
-- #166 asks that a participant cannot directly update the raw-text ciphertext
-- columns. They cannot: `authenticated` lost table-wide UPDATE in
-- 20260906000100. But `anon` still held it here, which made the same claim
-- false for anyone holding the public key.
--
-- ## Scope
--
-- `anon` only. `authenticated` keeps what it has — several of those grants are
-- load-bearing, and auditing them is a separate piece of work with a real risk
-- of breaking a screen. `anon` is different: this product has no anonymous
-- surface that reads or writes a table. The guardian confirmation screen is
-- public, and it goes through `redeem_guardian_token`, a SECURITY DEFINER
-- function whose EXECUTE grant is unaffected by this migration.
--
-- Written as a loop over `information_schema` rather than forty statements, so
-- a table added before this migration and missed by a hand-written list cannot
-- slip through. `supabase/tests/anon_grants.test.sql` asserts the end state.

do $$
declare
  target record;
  revoked integer := 0;
begin
  for target in
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind = 'r'
       and exists (
         select 1
           from information_schema.role_table_grants g
          where g.table_schema = 'public'
            and g.table_name = c.relname
            and g.grantee = 'anon'
       )
    loop
      execute format('revoke all on public.%I from anon', target.relname);
      revoked := revoked + 1;
    end loop;

  raise notice 'revoked anon grants on % table(s)', revoked;
end;
$$;

/*
 * Stop the default from re-applying to tables created later.
 *
 * Without this the next `create table` in `public` arrives pre-granted again
 * and the audit has to be repeated. `alter default privileges` only affects
 * objects created *after* it runs, which is why the revoke above is still
 * needed for what already exists.
 *
 * Scoped to the role that creates objects in migrations. If a table is later
 * created by a different role, its defaults are that role's and this does not
 * reach them — which the test catches rather than assumes.
 */
alter default privileges in schema public revoke all on tables from anon;
