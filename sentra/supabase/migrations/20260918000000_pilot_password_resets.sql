-- An audit trail for coordinator-issued password resets.
--
-- ===========================================================================
-- Additive. One table, its policies and grants. Nothing existing is altered.
-- ===========================================================================
--
-- ## Why not `educator_access_log`
--
-- That was the obvious place and it does not fit, in three ways that each
-- matter:
--
--   - `org_id` and `participant_id` are both NOT NULL. A coordinator may reset
--     an account by email address before that person is enrolled in anything —
--     during setup, or for a student whose enrollment was never completed —
--     and there is no organisation or participant to name.
--   - `view_type` carries a CHECK constraint listing four reading actions.
--     Issuing a recovery link is not a read.
--   - Its policies are written around "an educator looked at a student's data",
--     and the student can see it on `/audit` framed that way. A password reset
--     belongs in that account's history, but as what it is.
--
-- Squeezing this into a table shaped for something else is how a log ends up
-- with rows nobody can interpret a year later.
--
-- ## What this is for
--
-- A recovery link is a sign-in. Issuing one is the single most powerful thing a
-- coordinator can do to a participant's account, and an unlogged issuance is
-- indistinguishable, afterwards, from an account takeover. The route refuses to
-- return a link if the row cannot be written.

create table if not exists public.pilot_password_resets (
  id uuid primary key default gen_random_uuid(),

  -- The coordinator who asked. Always present: nothing writes here but the
  -- operator route, and that route has already established who is calling.
  issued_by uuid not null references auth.users(id) on delete restrict,

  -- The account recovered. Null only when the address matched no account —
  -- which the route does not reveal to the caller, but does record, because a
  -- coordinator session working through a list of addresses is worth seeing.
  target_user_id uuid references auth.users(id) on delete set null,

  -- Null before enrollment, or when the reset was done by address alone.
  participant_id uuid references public.participants(id) on delete set null,
  research_code text,

  /*
   * A hash of the address, not the address.
   *
   * The row needs to be matchable against a later question — "was a reset
   * issued for this account" — without turning the audit log into a second
   * copy of the roster's contact details. `research_exports` and
   * `safety_escalation_deliveries` make the same trade.
   */
  target_email_hash text,

  outcome text not null,
  created_at timestamptz not null default now()
);

alter table public.pilot_password_resets
  drop constraint if exists pilot_password_resets_outcome_check;
alter table public.pilot_password_resets
  add constraint pilot_password_resets_outcome_check
  check (outcome in ('issued', 'not_found', 'failed'));

create index if not exists pilot_password_resets_target_idx
  on public.pilot_password_resets(target_user_id, created_at desc);

create index if not exists pilot_password_resets_issuer_idx
  on public.pilot_password_resets(issued_by, created_at desc);

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table public.pilot_password_resets enable row level security;

-- Stock Supabase grants every new table in `public` to `anon` and
-- `authenticated` before a policy exists, so the revoke comes first. Without
-- it, `grant select` below would widen nothing and the table would already be
-- open — the lesson of 20260910000000.
revoke all on public.pilot_password_resets from anon, authenticated;

/*
 * The account holder may see that a reset was issued for them.
 *
 * Someone else changing their password is exactly the event a person needs to
 * be able to check on, and this product tells students repeatedly that it keeps
 * nothing from them. They see the fact and the time; they do not see which
 * coordinator, because the row also serves as an internal record and naming
 * staff to a student invites a different conversation than the one this is for.
 * A coordinator who needs that detail reads it under the service role.
 */
drop policy if exists pilot_password_resets_select_own on public.pilot_password_resets;
create policy pilot_password_resets_select_own on public.pilot_password_resets
  for select to authenticated
  using (target_user_id = (select auth.uid()));

grant select (id, target_user_id, created_at, outcome) on public.pilot_password_resets to authenticated;

-- Writing is the operator route's, which runs under the service role.
grant select, insert on public.pilot_password_resets to service_role;
