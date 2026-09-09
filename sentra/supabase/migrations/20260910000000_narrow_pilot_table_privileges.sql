-- Make the pilot tables' privileges match what their migrations meant (#164, #167).
--
-- `supabase/tests/pilot_enrollment_rls.test.sql` asserts that a participant
-- cannot select from `pilot_invitations` "at all — not their own, not anyone's.
-- There is no policy and no grant." The first half was true and the second was
-- not, and the test failed:
--
--     ERROR: a participant could select from pilot_invitations
--
-- ---------------------------------------------------------------------------
-- Why the grants were there
-- ---------------------------------------------------------------------------
--
-- A stock Supabase project ships
--
--     alter default privileges in schema public
--       grant all on tables to postgres, anon, authenticated, service_role;
--
-- so every table created in `public` arrives with full DELETE/INSERT/SELECT/
-- UPDATE/TRUNCATE for `anon` and `authenticated` before a migration says
-- anything. Writing `grant select on public.pilot_enrollments to authenticated`
-- then reads as a narrowing but is not one: it adds a privilege the role
-- already had, and everything the author intended to withhold stays.
--
-- The same trap is documented for *functions* in
-- 20260906000000_pilot_consent_and_submission_integrity.sql:192 — "Revoking
-- from PUBLIC is NOT enough on Supabase". It applies to tables identically and
-- was not applied to them.
--
-- ---------------------------------------------------------------------------
-- Why this is worth a migration rather than a note
-- ---------------------------------------------------------------------------
--
-- Row-level security is on for all six tables, so no row is readable today: a
-- table with RLS enabled and no policy returns nothing. Two things are still
-- wrong.
--
--   1. **TRUNCATE is not a row operation, so RLS does not filter it.** SELECT,
--      INSERT, UPDATE and DELETE are all subject to policies; TRUNCATE is
--      checked against the table privilege alone. `authenticated` holding it
--      means any account with a direct database connection can empty
--      `pilot_invitations` or `pilot_enrollments`. PostgREST does not expose
--      TRUNCATE, which is what keeps this from being reachable from the app —
--      a property of the API surface, not of the permission model.
--
--   2. **The protection is one policy away from gone.** Every one of these
--      tables is protected only by the absence of a policy. A later migration
--      that adds a permissive one — or any change that disables RLS to debug
--      something — opens full DML immediately, because the grant underneath
--      was never removed. Defence that depends on nobody adding a policy is
--      not defence.
--
-- Each table below is revoked to nothing and then granted exactly what its own
-- migration said it should have. `anon` receives nothing anywhere: no screen in
-- this product reads pilot state before login.

-- ---------------------------------------------------------------------------
-- Reset
-- ---------------------------------------------------------------------------

revoke all on public.pilot_studies from anon, authenticated;
revoke all on public.pilot_invitations from anon, authenticated;
revoke all on public.pilot_enrollments from anon, authenticated;
revoke all on public.pilot_enrollment_events from anon, authenticated;
revoke all on public.pilot_guardian_verifications from anon, authenticated;

-- The export audit log. No policy, and its rows name who pulled what — it
-- belongs to the operator path, which runs as `service_role`.
revoke all on public.research_exports from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Re-grant, matching each table's own migration
-- ---------------------------------------------------------------------------

-- 20260906010000:584 — participants read the study they are enrolled in.
grant select on public.pilot_studies to authenticated;

-- 20260906010000:599 — SELECT only. The state machine advances through
-- `advance_pilot_enrollment`; a direct UPDATE is the attack that function
-- exists to prevent, and the test at pilot_enrollment_rls.test.sql:462 says so.
grant select on public.pilot_enrollments to authenticated;

-- 20260906010000:606 — a participant may read their own transition history.
grant select on public.pilot_enrollment_events to authenticated;

-- `pilot_invitations` and `pilot_guardian_verifications` are deliberately
-- absent. Both are redeemed through SECURITY DEFINER functions
-- (`redeem_pilot_invitation`, `redeem_guardian_token`) whose EXECUTE is granted
-- to `authenticated`; the tables themselves stay unreachable. Granting SELECT
-- on `pilot_invitations` would expose `code_hash` and `code_prefix` and turn a
-- guessing attack into an offline one.

-- Unchanged, restated so this file is a complete picture of who may read what:
-- `service_role` keeps the write access the migrations gave it, and
-- `research_reader` keeps its SELECT on studies, enrollments and self-reports.
grant select, insert, update on public.pilot_invitations to service_role;
grant select, insert, update on public.pilot_guardian_verifications to service_role;
grant select, insert on public.research_exports to service_role;
