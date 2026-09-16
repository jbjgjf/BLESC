-- Crisis reaches a person the night it happens, not the next morning.
--
-- ===========================================================================
-- Additive. Two new tables, their policies and grants. Nothing existing is
-- altered, dropped or rewritten, so this is safe to apply before the code that
-- uses it ships.
-- ===========================================================================
--
-- ## The gap
--
-- `/api/chat` runs `assessConversation` on every turn and writes a
-- `model_runs` row with `artifact_type = 'safety_assessment'` when a student
-- signals danger. That row is an audit record: it says a judgement was made. It
-- does not reach anybody.
--
-- What an educator sees is built the other way round. `alertsFromRoster` in
-- `api/client.ts` runs **in the educator's browser**, over the roster, at the
-- moment they open the dashboard. Nothing is queued, nothing is sent, and no
-- mail or push dependency exists in `package.json`. A student writing at 02:00
-- that they do not want to be alive is answered by the product — the safety
-- floor holds, the crisis lines are named — and then waits until a teacher
-- happens to open a tab.
--
-- ## What this does and does not change about who may know
--
-- It changes **when**, not **who**. `overseen_participants` already returns
-- `safety_level`, `safety_reasons` and `safety_at` to an educator, and it is
-- gated on `educator_oversees`, which requires an active `oversight_consents`
-- row for that participant and that organisation. An educator who receives one
-- of these escalations could already have read the same observation by opening
-- the roster. This makes the existing, consented disclosure timely.
--
-- Two consequences follow, and both are enforced below rather than assumed:
--
--   1. **A recipient is only ever an educator who already had access.**
--      `safety_escalation_recipients()` recomputes consent at send time from
--      the same tables `educator_oversees` reads. Consent revoked an hour ago
--      means no notification tonight.
--   2. **The student can see that it happened.** `safety_escalation_deliveries`
--      is readable by the student the escalation is about. A system that tells
--      an adult something about a minor and hides that from the minor is one
--      they cannot trust, and the product tells them repeatedly that it never
--      keeps things from them.
--
-- ## Delivery is state, not a side effect
--
-- `status` starts at `pending` and is moved by the sender. A send that fails,
-- or a deployment with no channel configured, leaves a row saying so — never a
-- dropped notification and never a silent success. `/api/safety/dispatch`
-- retries what is still pending, so the failure mode of an unreachable mail
-- provider is "late", not "never".

-- ---------------------------------------------------------------------------
-- 1. The escalation
-- ---------------------------------------------------------------------------

create table if not exists public.safety_escalations (
  id uuid primary key default gen_random_uuid(),

  owner_user_id uuid not null references auth.users(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,

  -- `crisis` and `elevated` only. `none` and `low` never reach this table:
  -- an escalation that fires on everything is one an educator learns to ignore,
  -- and the cost of that is paid on the night it matters.
  risk_level text not null,

  -- Which deterministic rules in `safety.py` matched. The same strings the
  -- roster already shows. Never the text the student wrote.
  reasons text[] not null default '{}',

  surface text not null,
  detected_at timestamptz not null default now(),

  -- The `model_runs` row that recorded the judgement, so an escalation can
  -- always be traced back to the assessment that caused it.
  source_artifact_id uuid,

  /*
   * Repeat suppression.
   *
   * A student in distress writes several turns in a row, and each one assesses
   * as crisis. Five notifications in four minutes is not five times the signal;
   * it is one situation, and it trains the recipient to swipe the alert away.
   *
   * The route computes this as `participant + risk_level + the hour`, so a
   * continuing conversation escalates once per hour while a new night is a new
   * row. The uniqueness is enforced here rather than in the route because two
   * concurrent requests can both find nothing and both insert.
   */
  dedupe_key text not null,

  status text not null default 'pending',
  attempts integer not null default 0,
  last_attempt_at timestamptz,
  last_error text,
  delivered_at timestamptz,

  -- Someone said they have it. Not "seen" — an educator opening a dashboard is
  -- not the same as an educator acting.
  acknowledged_at timestamptz,
  acknowledged_by uuid references auth.users(id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (participant_id, dedupe_key)
);

alter table public.safety_escalations
  drop constraint if exists safety_escalations_risk_level_check;
alter table public.safety_escalations
  add constraint safety_escalations_risk_level_check
  check (risk_level in ('elevated', 'crisis'));

alter table public.safety_escalations
  drop constraint if exists safety_escalations_status_check;
alter table public.safety_escalations
  add constraint safety_escalations_status_check
  check (status in ('pending', 'delivered', 'failed', 'no_recipient'));

-- The dispatcher's query: what is still owed, oldest first.
create index if not exists safety_escalations_pending_idx
  on public.safety_escalations(detected_at)
  where status in ('pending', 'failed');

create index if not exists safety_escalations_participant_idx
  on public.safety_escalations(participant_id, detected_at desc);

-- ---------------------------------------------------------------------------
-- 2. Who was actually told
-- ---------------------------------------------------------------------------

create table if not exists public.safety_escalation_deliveries (
  id uuid primary key default gen_random_uuid(),
  escalation_id uuid not null references public.safety_escalations(id) on delete cascade,

  -- Null for a channel that is not a person — a shared webhook into a school's
  -- own system, where the recipient is the system.
  recipient_user_id uuid references auth.users(id) on delete set null,
  channel text not null,

  -- A hash, not the address. The student may see that a delivery happened and
  -- to which of their educators; they have no reason to be handed that
  -- educator's personal email, and neither has anyone who reaches this table.
  recipient_hash text,

  status text not null,
  error text,
  attempted_at timestamptz not null default now()
);

alter table public.safety_escalation_deliveries
  drop constraint if exists safety_escalation_deliveries_status_check;
alter table public.safety_escalation_deliveries
  add constraint safety_escalation_deliveries_status_check
  check (status in ('delivered', 'failed', 'skipped'));

create index if not exists safety_escalation_deliveries_escalation_idx
  on public.safety_escalation_deliveries(escalation_id, attempted_at desc);

-- ---------------------------------------------------------------------------
-- 3. Recipients, recomputed at send time
-- ---------------------------------------------------------------------------

/*
 * The educators who may be told about this participant, right now.
 *
 * SECURITY DEFINER because the sender runs as `service_role` and needs to read
 * `auth.users` for an address. EXECUTE is granted to `service_role` alone, and
 * revoked from `anon` and `authenticated` explicitly — a stock Supabase project
 * grants EXECUTE on every new function in `public` to both, so `revoke ... from
 * public` would not be enough (see 20260906000000:192).
 *
 * The consent conditions are copied from `educator_oversees` rather than called
 * through it, because that function reads `auth.uid()` — there is no session
 * here, only a participant.
 */
create or replace function public.safety_escalation_recipients(target_participant uuid)
returns table (educator_user_id uuid, email text)
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select distinct r.educator_user_id, u.email::text
    from public.oversight_roster r
    join public.organization_members m
      on m.org_id = r.org_id
     and m.member_user_id = r.educator_user_id
     and m.status = 'active'
    join public.oversight_consents c
      on c.participant_id = r.participant_id
     and c.org_id = r.org_id
     and c.status = 'active'
     and (c.educator_user_id is null or c.educator_user_id = r.educator_user_id)
    join auth.users u
      on u.id = r.educator_user_id
   where r.participant_id = target_participant
     and r.status = 'active';
$$;

revoke execute on function public.safety_escalation_recipients(uuid) from public, anon, authenticated;
grant execute on function public.safety_escalation_recipients(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Row-level security
-- ---------------------------------------------------------------------------

alter table public.safety_escalations enable row level security;
alter table public.safety_escalation_deliveries enable row level security;

-- Stock Supabase grants every new table in `public` to `anon` and
-- `authenticated` before a policy is written. Revoke first, then grant what is
-- meant — the lesson of 20260910000000.
revoke all on public.safety_escalations from anon, authenticated;
revoke all on public.safety_escalation_deliveries from anon, authenticated;

-- The student may read escalations about themselves. They are the person the
-- notification is about; being unable to find out is the version of this
-- feature that betrays them.
drop policy if exists safety_escalations_select_own on public.safety_escalations;
create policy safety_escalations_select_own on public.safety_escalations
  for select to authenticated
  using (owner_user_id = (select auth.uid()));

-- And the educator who already oversees them.
drop policy if exists safety_escalations_select_educator on public.safety_escalations;
create policy safety_escalations_select_educator on public.safety_escalations
  for select to authenticated
  using (public.educator_oversees(participant_id));

/*
 * Acknowledgement is the one write an educator makes.
 *
 * Scoped to the two acknowledgement columns by convention, not by SQL —
 * PostgreSQL has no per-column UPDATE policy — so `authenticated` receives
 * UPDATE only on those columns, which does enforce it.
 */
drop policy if exists safety_escalations_ack_educator on public.safety_escalations;
create policy safety_escalations_ack_educator on public.safety_escalations
  for update to authenticated
  using (public.educator_oversees(participant_id))
  with check (public.educator_oversees(participant_id));

grant select on public.safety_escalations to authenticated;
grant update (acknowledged_at, acknowledged_by) on public.safety_escalations to authenticated;

drop policy if exists safety_escalation_deliveries_select_own on public.safety_escalation_deliveries;
create policy safety_escalation_deliveries_select_own on public.safety_escalation_deliveries
  for select to authenticated
  using (
    exists (
      select 1 from public.safety_escalations e
       where e.id = escalation_id
         and (e.owner_user_id = (select auth.uid()) or public.educator_oversees(e.participant_id))
    )
  );

grant select on public.safety_escalation_deliveries to authenticated;

-- Everything else is the sender's, which runs as `service_role`.
grant select, insert, update on public.safety_escalations to service_role;
grant select, insert on public.safety_escalation_deliveries to service_role;

-- ---------------------------------------------------------------------------
-- 5. `updated_at`
-- ---------------------------------------------------------------------------

create or replace function public.touch_safety_escalation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke execute on function public.touch_safety_escalation() from public, anon, authenticated;

drop trigger if exists safety_escalations_touch on public.safety_escalations;
create trigger safety_escalations_touch
before update on public.safety_escalations
for each row execute function public.touch_safety_escalation();
