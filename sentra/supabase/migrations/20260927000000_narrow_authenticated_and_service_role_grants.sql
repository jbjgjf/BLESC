-- Finish what 20260921010000 started: the stock grants `authenticated` and
-- `service_role` were never meant to have.
--
-- ===========================================================================
-- Privileges only. No table, column, policy or row is changed. Every write
-- the application makes today was checked against what is revoked here.
-- ===========================================================================
--
-- ## The finding
--
-- 20260921010000 took Supabase's stock default grant off `anon`. The same
-- default,
--
--     alter default privileges in schema public
--       grant all on tables to postgres, anon, authenticated, service_role;
--
-- handed the same full set to the other two roles, and that migration scoped
-- itself to `anon` on purpose. What is left:
--
--   * `authenticated` holds TRUNCATE, REFERENCES and TRIGGER on every table
--     no migration revoked to nothing first — about forty of them, including
--     `entries`, `consent_records` and `participants`. No screen uses any of
--     the three. TRUNCATE is the one that matters: RLS filters SELECT, INSERT,
--     UPDATE and DELETE row by row, but TRUNCATE is checked against the table
--     privilege alone (anon_grants.test.sql §2). Any signed-in student with a
--     direct Postgres connection could empty every student's journal.
--   * `service_role` holds UPDATE, DELETE and TRUNCATE on tables whose own
--     migrations describe them as append-only records. Those migrations wrote
--     `grant select, insert … to service_role`, which reads like a narrowing
--     and is not one: it adds to the stock grant and removes nothing.
--
-- ## What this does
--
-- 1. Revokes TRUNCATE, REFERENCES and TRIGGER from `authenticated` on every
--    table in `public`, and stops the default from granting them again.
--    SELECT/INSERT/UPDATE/DELETE are left alone: several are load-bearing, RLS
--    does filter them, and narrowing them table by table is separate work.
--
-- 2. Narrows `service_role` to exactly SELECT, INSERT on three append-only
--    records. Each was checked three ways — what its migration says, what
--    `sentra/frontend/src` and `sentra/backend` do with it under the service
--    key, and whether a SQL function running as `service_role` writes it:
--
--    | table                          | its migration says                               | writers today                                       |
--    |--------------------------------|--------------------------------------------------|-----------------------------------------------------|
--    | `pilot_enrollment_events`      | "an audit table that has no UPDATE or DELETE     | `advance_pilot_enrollment` (INSERT only)            |
--    |                                | grant to anybody" (20260906010000:37)            |                                                     |
--    | `safety_escalation_deliveries` | grants `select, insert` to the sender and a      | `safetyEscalation.ts` (INSERT only)                 |
--    |                                | student-visible record of who was told           |                                                     |
--    | `research_exports`             | "The export audit log"; 20260910000000 restates  | `research/export`, `research/identity-map` (INSERT) |
--    |                                | `select, insert` as the complete picture         |                                                     |
--
--    `pilot_enrollment_events` also has a trigger refusing UPDATE and DELETE.
--    TRUNCATE fires no row trigger, so until now the service key could wipe
--    the history the trigger exists to protect.
--
--    Row deletion through `on delete cascade` is unaffected: referential
--    actions run with the table owner's rights, not the caller's.
--
-- ## Deliberately not here
--
--   * `consent_records`. Revocation is written as a new row today
--     (`consentStore.ts` `revokeConsent`), but 20260906000000 says "Revoking is
--     an UPDATE" and installs a trigger for exactly that, so its comments do
--     not claim append-only. Deciding that it is one is a design change.
--   * `submission_failures`. INSERT-only in practice; nothing says it must be.
--   * `educator_access_log`, `pilot_crisis_review_reads`, `legal_acceptances`.
--     Narrowed separately (#250, #256).
--
-- Written as a loop over `pg_class` rather than a list, so a table this
-- migration's author missed cannot slip through — the same reasoning as
-- 20260921010000. `supabase/tests/authenticated_grants.test.sql` asserts the
-- end state.

-- ---------------------------------------------------------------------------
-- 1. `authenticated`: no TRUNCATE, REFERENCES or TRIGGER anywhere
-- ---------------------------------------------------------------------------

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
       and c.relkind in ('r', 'p')
       and exists (
         select 1
           from information_schema.role_table_grants g
          where g.table_schema = 'public'
            and g.table_name = c.relname
            and g.grantee = 'authenticated'
            and g.privilege_type in ('TRUNCATE', 'REFERENCES', 'TRIGGER')
       )
    loop
      execute format(
        'revoke truncate, references, trigger on public.%I from authenticated',
        target.relname
      );
      revoked := revoked + 1;
    end loop;

  raise notice 'revoked truncate/references/trigger from authenticated on % table(s)', revoked;
end;
$$;

/*
 * Stop the default from re-applying to tables created later. Only affects
 * objects created after it runs, which is why the loop above is still needed.
 * Scoped to the role that runs migrations, as in 20260921010000.
 */
alter default privileges in schema public
  revoke truncate, references, trigger on tables from authenticated;

-- ---------------------------------------------------------------------------
-- 2. `service_role`: append-only records are append-only
-- ---------------------------------------------------------------------------

-- Revoke to nothing, then grant exactly what each table's migration said —
-- the pattern of 20260910000000.
revoke all on public.pilot_enrollment_events from service_role;
revoke all on public.safety_escalation_deliveries from service_role;
revoke all on public.research_exports from service_role;

grant select, insert on public.pilot_enrollment_events to service_role;
grant select, insert on public.safety_escalation_deliveries to service_role;
grant select, insert on public.research_exports to service_role;
