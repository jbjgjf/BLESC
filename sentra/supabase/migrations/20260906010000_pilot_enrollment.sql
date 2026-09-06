-- Invitation-only pilot enrollment: studies, invitation codes, the participation
-- state machine and the pseudonymous research id (issue #163, epic #161).
--
-- ===========================================================================
-- This migration is additive. It creates four tables and three functions and
-- alters nothing that exists, so it can be applied while the current version is
-- serving, before the code that uses it ships.
--
-- The privilege restriction that belongs with it — taking `signup` off the
-- public path so an account cannot join a study without an invitation — is not
-- a database change and lives in the deployment configuration (#166).
-- ===========================================================================
--
-- Why this exists at all: `participants` records who is in the database, and
-- `consent_records` (20260906000000) records what they agreed to. Neither one
-- records that a person was *invited*, which study they are in, or which of the
-- steps between "was handed a code" and "is being collected from" they have
-- actually completed. Without that, the only thing standing between a stranger
-- who finds the URL and a research dataset is the consent screen, and a consent
-- screen is a page anyone can fill in.
--
-- Four things this establishes:
--
--   1. A study is a row, not a constant. Cohort, protocol version, the
--      baseline/observation split and the collection window all belong to the
--      study, so a dry run and the real pilot are two rows and not two
--      deployments.
--
--   2. An invitation code is never stored. What is stored is an HMAC of it, so
--      a database leak yields codes nobody can redeem. The first characters are
--      kept separately and in the clear, because an operator has to be able to
--      answer "which code did I give this school" without being able to redeem
--      it.
--
--   3. Enrollment is a state machine the server advances. The client can ask
--      for a transition; it cannot perform one. Every transition appends to an
--      audit table that has no UPDATE or DELETE grant to anybody.
--
--   4. The research id is not the login id. `pilot_enrollments.research_code` is
--      what appears in an export; `owner_user_id` is what signs in. Keeping them
--      in separate columns of one row is what makes re-identification a
--      deliberate act against this table rather than a property of every file
--      that leaves the system.

-- ---------------------------------------------------------------------------
-- 1. Studies
-- ---------------------------------------------------------------------------

create table if not exists public.pilot_studies (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,

  -- `draft` accepts no redemptions; `recruiting` accepts them; `collecting`
  -- keeps existing participants but issues nothing new; `closed` accepts
  -- neither. The redeem function reads this, so pausing recruitment is an
  -- UPDATE here and not a deployment.
  status text not null default 'draft',

  -- The protocol this study runs under (#162). Stored per study because a
  -- participant consented to a specific version, and a later amendment must not
  -- silently reinterpret what they agreed to.
  protocol_version text not null default 'pilot-protocol-v1',
  consent_document_version text not null default 'research-consent-doc-v1',

  -- 14 + 7 for the real pilot, 3 + 0 for the dry run. Named separately because
  -- the analysis treats them differently: the first window builds the
  -- within-person baseline and cannot also be used to test deviation from it.
  baseline_days integer not null default 14,
  observation_days integer not null default 7,

  -- Recruitment window. A code cannot outlive its study.
  opens_at timestamptz,
  closes_at timestamptz,

  -- A dry run is a study whose data must never reach a research export. The
  -- flag is on the study rather than inferred from the slug so that the export
  -- path can filter on it (#167).
  is_dry_run boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.pilot_studies
  drop constraint if exists pilot_studies_status_check;
alter table public.pilot_studies
  add constraint pilot_studies_status_check
  check (status in ('draft', 'recruiting', 'collecting', 'closed'));

alter table public.pilot_studies
  drop constraint if exists pilot_studies_window_check;
alter table public.pilot_studies
  add constraint pilot_studies_window_check
  check (opens_at is null or closes_at is null or closes_at > opens_at);

-- ---------------------------------------------------------------------------
-- 2. Invitations
-- ---------------------------------------------------------------------------
--
-- There is no `code` column and there will not be one. `code_hash` is
-- HMAC-SHA256(code) under a server-side key that is not in the database, so
-- possession of this table is not possession of the codes.
--
-- `code_prefix` is the first four characters of the code, in the clear. It is
-- not enough to redeem with (the codes carry 100+ bits and the prefix is 20 of
-- them, and redemption is by hash, not by prefix), and it is what makes an
-- operator's job possible: issuing 60 codes and later being asked which ones a
-- particular school got is otherwise unanswerable.

create table if not exists public.pilot_invitations (
  id uuid primary key default gen_random_uuid(),
  study_id uuid not null references public.pilot_studies(id) on delete cascade,

  code_hash text not null,
  code_prefix text not null,

  -- Which group this code enrolls into. Carried on the invitation rather than
  -- chosen at redemption so that assignment is a property of what was handed
  -- out, and a participant cannot pick their own arm.
  cohort text not null default 'default',

  -- Single-use by default. A shared classroom code is expressible (raise it),
  -- but it has to be a deliberate act, and `redeemed_count` still bounds it.
  max_redemptions integer not null default 1,
  redeemed_count integer not null default 0,

  expires_at timestamptz,
  revoked_at timestamptz,

  -- Free-text operator note: "3-B, handed out 2026-09-10". Never the code.
  note text,

  created_at timestamptz not null default now()
);

create unique index if not exists pilot_invitations_code_hash_idx
  on public.pilot_invitations(code_hash);

create index if not exists pilot_invitations_study_idx
  on public.pilot_invitations(study_id, created_at desc);

alter table public.pilot_invitations
  drop constraint if exists pilot_invitations_redemption_bounds_check;
alter table public.pilot_invitations
  add constraint pilot_invitations_redemption_bounds_check
  check (max_redemptions >= 1 and redeemed_count >= 0 and redeemed_count <= max_redemptions);

-- A prefix long enough to disambiguate and short enough to be useless alone.
alter table public.pilot_invitations
  drop constraint if exists pilot_invitations_prefix_check;
alter table public.pilot_invitations
  add constraint pilot_invitations_prefix_check
  check (char_length(code_prefix) between 3 and 6);

-- ---------------------------------------------------------------------------
-- 3. Enrollments — the state machine
-- ---------------------------------------------------------------------------
--
--   invited
--     → account_bound        the code was redeemed by a signed-in user
--     → information_read     the participant reached the end of the study sheet
--     → participant_assented the participant themselves agreed
--     → guardian_verified    a guardian confirmed, by a separate route (minors)
--     → enrolled             consent record exists and covers research use
--     → collecting           the collection window has opened
--     → completed | withdrawn
--
-- `guardian_verified` is skipped for an adult participant and required for a
-- minor. That branch is the reason the state is a column and not a set of
-- booleans a reader has to reduce: "which of these people may we collect from
-- today" has to be one indexed predicate.

create table if not exists public.pilot_enrollments (
  id uuid primary key default gen_random_uuid(),
  study_id uuid not null references public.pilot_studies(id) on delete cascade,
  invitation_id uuid references public.pilot_invitations(id) on delete set null,

  owner_user_id uuid not null references auth.users(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,

  -- The pseudonym. Exports carry this and never `owner_user_id`.
  research_code text not null,
  cohort text not null default 'default',

  state text not null default 'account_bound',

  -- Age band, not birthdate. The protocol needs "is a guardian required", and
  -- storing the date of birth to answer a yes/no question collects an
  -- identifier the study has no use for.
  is_minor boolean not null default true,

  information_read_at timestamptz,
  assented_at timestamptz,
  guardian_verified_at timestamptz,
  -- How the guardian was confirmed: which channel, which operator. Not the
  -- guardian's contact details — those live outside this system.
  guardian_verification_method text,
  enrolled_at timestamptz,
  collection_started_at timestamptz,
  collection_ends_at timestamptz,
  withdrawn_at timestamptz,
  completed_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One enrollment per person per study. A second redemption by the same
  -- account is a conflict, not a second participant.
  unique (study_id, owner_user_id),
  unique (study_id, research_code),
  -- Lets the RLS policies on child tables join without a second lookup.
  unique (id, owner_user_id)
);

alter table public.pilot_enrollments
  drop constraint if exists pilot_enrollments_state_check;
alter table public.pilot_enrollments
  add constraint pilot_enrollments_state_check
  check (state in (
    'account_bound',
    'information_read',
    'participant_assented',
    'guardian_verified',
    'enrolled',
    'collecting',
    'withdrawn',
    'completed'
  ));

-- A minor cannot be past `participant_assented` without a guardian timestamp.
-- Expressed as a constraint and not only in the transition function, because a
-- future backfill or a manual fix in the dashboard would not go through the
-- function.
alter table public.pilot_enrollments
  drop constraint if exists pilot_enrollments_guardian_required_check;
alter table public.pilot_enrollments
  add constraint pilot_enrollments_guardian_required_check
  check (
    not is_minor
    or state in ('account_bound', 'information_read', 'participant_assented', 'withdrawn')
    or guardian_verified_at is not null
  );

alter table public.pilot_enrollments
  drop constraint if exists pilot_enrollments_withdrawal_check;
alter table public.pilot_enrollments
  add constraint pilot_enrollments_withdrawal_check
  check ((state = 'withdrawn') = (withdrawn_at is not null));

create index if not exists pilot_enrollments_study_state_idx
  on public.pilot_enrollments(study_id, state);

create index if not exists pilot_enrollments_owner_idx
  on public.pilot_enrollments(owner_user_id);

create index if not exists pilot_enrollments_participant_idx
  on public.pilot_enrollments(participant_id);

-- ---------------------------------------------------------------------------
-- 4. Transition audit — append only
-- ---------------------------------------------------------------------------
--
-- "When did this participant assent" has to survive someone later editing the
-- enrollment row. No UPDATE or DELETE is granted to any role below
-- `service_role`, and the trigger below refuses both outright, so a mistake in
-- an admin route cannot rewrite history.

create table if not exists public.pilot_enrollment_events (
  id uuid primary key default gen_random_uuid(),
  enrollment_id uuid not null references public.pilot_enrollments(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,

  from_state text,
  to_state text not null,

  -- Who caused it: the participant, an operator, or the scheduler.
  actor text not null default 'system',
  -- Why, in one line. Shown in the dry-run report (#168).
  reason text,

  created_at timestamptz not null default now()
);

alter table public.pilot_enrollment_events
  drop constraint if exists pilot_enrollment_events_actor_check;
alter table public.pilot_enrollment_events
  add constraint pilot_enrollment_events_actor_check
  check (actor in ('participant', 'operator', 'system'));

create index if not exists pilot_enrollment_events_enrollment_idx
  on public.pilot_enrollment_events(enrollment_id, created_at);

create or replace function public.reject_pilot_event_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'pilot_enrollment_events is append-only (attempted %)', tg_op;
end;
$$;

drop trigger if exists pilot_enrollment_events_append_only on public.pilot_enrollment_events;
create trigger pilot_enrollment_events_append_only
before update or delete on public.pilot_enrollment_events
for each row execute function public.reject_pilot_event_mutation();

-- ---------------------------------------------------------------------------
-- 5. Redemption
-- ---------------------------------------------------------------------------
--
-- SECURITY INVOKER, granted to `service_role` only, for the reason given at
-- length in 20260906000000: a definer function reachable by `authenticated`
-- would let any signed-in caller redeem on behalf of any user id they can name.
-- The route that calls this holds the service-role key, which bypasses RLS on
-- its own, so definer rights buy nothing and cost that.
--
-- `pg_temp` is named last so a caller cannot shadow `public.pilot_invitations`
-- with a temp table.
--
-- The race: two tabs submitting the same single-use code at the same moment.
-- The conditional UPDATE is what settles it. Under READ COMMITTED the second
-- transaction blocks on the row lock the first took, and when the first
-- commits, the second re-evaluates its WHERE against the new row — where
-- `redeemed_count < max_redemptions` is now false, so it updates nothing and
-- `found` is false. No advisory lock, no retry loop.
create or replace function public.redeem_pilot_invitation(
  p_code_hash text,
  p_owner_user_id uuid,
  p_participant_id uuid,
  p_research_code text,
  p_is_minor boolean
)
returns table (
  enrollment_id uuid,
  study_id uuid,
  study_slug text,
  cohort text,
  state text,
  outcome text
)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_invitation public.pilot_invitations%rowtype;
  v_study public.pilot_studies%rowtype;
  v_existing public.pilot_enrollments%rowtype;
  v_enrollment public.pilot_enrollments%rowtype;
begin
  -- Already enrolled in this study? Return the existing row rather than
  -- failing. A participant who taps twice, or who re-opens the join link after
  -- succeeding, should land on their own enrollment.
  select i.* into v_invitation
    from public.pilot_invitations i
   where i.code_hash = p_code_hash;

  if not found then
    -- Deliberately the same shape as every other rejection below. The caller
    -- turns all of them into one message: a redeemer must not be able to tell
    -- "no such code" from "expired code" and enumerate the space.
    return query select null::uuid, null::uuid, null::text, null::text, null::text, 'rejected'::text;
    return;
  end if;

  select s.* into v_study from public.pilot_studies s where s.id = v_invitation.study_id;
  if not found then
    return query select null::uuid, null::uuid, null::text, null::text, null::text, 'rejected'::text;
    return;
  end if;

  select e.* into v_existing
    from public.pilot_enrollments e
   where e.study_id = v_study.id
     and e.owner_user_id = p_owner_user_id;

  if found then
    return query select v_existing.id, v_study.id, v_study.slug, v_existing.cohort,
                        v_existing.state, 'already_enrolled'::text;
    return;
  end if;

  if v_invitation.revoked_at is not null
     or (v_invitation.expires_at is not null and v_invitation.expires_at <= now())
     or v_study.status <> 'recruiting'
     or (v_study.opens_at is not null and v_study.opens_at > now())
     or (v_study.closes_at is not null and v_study.closes_at <= now()) then
    return query select null::uuid, null::uuid, null::text, null::text, null::text, 'rejected'::text;
    return;
  end if;

  update public.pilot_invitations
     set redeemed_count = redeemed_count + 1
   where id = v_invitation.id
     and revoked_at is null
     and (expires_at is null or expires_at > now())
     and redeemed_count < max_redemptions;

  if not found then
    return query select null::uuid, null::uuid, null::text, null::text, null::text, 'rejected'::text;
    return;
  end if;

  insert into public.pilot_enrollments (
    study_id, invitation_id, owner_user_id, participant_id,
    research_code, cohort, state, is_minor
  )
  values (
    v_study.id, v_invitation.id, p_owner_user_id, p_participant_id,
    p_research_code, v_invitation.cohort, 'account_bound', p_is_minor
  )
  returning * into v_enrollment;

  insert into public.pilot_enrollment_events (enrollment_id, owner_user_id, from_state, to_state, actor, reason)
  values (v_enrollment.id, p_owner_user_id, 'invited', 'account_bound', 'participant', 'invitation redeemed');

  return query select v_enrollment.id, v_study.id, v_study.slug, v_enrollment.cohort,
                      v_enrollment.state, 'enrolled'::text;
end;
$$;

revoke execute on function public.redeem_pilot_invitation(text, uuid, uuid, text, boolean)
  from public, anon, authenticated;
grant execute on function public.redeem_pilot_invitation(text, uuid, uuid, text, boolean)
  to service_role;

-- ---------------------------------------------------------------------------
-- 6. Transition
-- ---------------------------------------------------------------------------
--
-- The legal edges live here rather than in the application, so that two code
-- paths (the participant's own route and an operator tool) cannot disagree
-- about them. The function refuses an illegal edge instead of clamping to the
-- nearest legal one: an unexpected transition request is a bug in the caller,
-- and silently doing something adjacent hides it.
--
-- `enrolled` additionally requires a consent record that covers research use.
-- The check reads `consent_records` directly — the same table
-- `loadConsentState` reads — so an enrollment cannot advance past the gate by
-- calling a different code path than the write path checks.
create or replace function public.advance_pilot_enrollment(
  p_enrollment_id uuid,
  p_to_state text,
  p_actor text,
  p_reason text
)
returns table (state text, outcome text)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v public.pilot_enrollments%rowtype;
  v_ok boolean := false;
  v_has_consent boolean := false;
begin
  select * into v from public.pilot_enrollments where id = p_enrollment_id for update;
  if not found then
    return query select null::text, 'not_found'::text;
    return;
  end if;

  -- Withdrawal is legal from anywhere and is terminal. It is checked first so
  -- that a participant can always leave, whatever state a bug left them in.
  if p_to_state = 'withdrawn' then
    update public.pilot_enrollments
       set state = 'withdrawn', withdrawn_at = now(), updated_at = now()
     where id = v.id;
    insert into public.pilot_enrollment_events (enrollment_id, owner_user_id, from_state, to_state, actor, reason)
    values (v.id, v.owner_user_id, v.state, 'withdrawn', p_actor, p_reason);
    return query select 'withdrawn'::text, 'ok'::text;
    return;
  end if;

  if v.state in ('withdrawn', 'completed') then
    return query select v.state, 'terminal'::text;
    return;
  end if;

  v_ok := case
    when v.state = 'account_bound' and p_to_state = 'information_read' then true
    when v.state = 'information_read' and p_to_state = 'participant_assented' then true
    -- A minor goes through guardian_verified; an adult goes straight to enrolled.
    when v.state = 'participant_assented' and p_to_state = 'guardian_verified' and v.is_minor then true
    when v.state = 'participant_assented' and p_to_state = 'enrolled' and not v.is_minor then true
    when v.state = 'guardian_verified' and p_to_state = 'enrolled' then true
    when v.state = 'enrolled' and p_to_state = 'collecting' then true
    when v.state = 'collecting' and p_to_state = 'completed' then true
    else false
  end;

  if not v_ok then
    return query select v.state, 'illegal_transition'::text;
    return;
  end if;

  if p_to_state = 'enrolled' then
    select exists (
      select 1
        from public.consent_records c
       where c.owner_user_id = v.owner_user_id
         and c.participant_id = v.participant_id
         and c.status = 'active'
         and c.research_analysis
         and (not v.is_minor or (c.minor_assent and c.guardian_consent))
    ) into v_has_consent;

    if not v_has_consent then
      return query select v.state, 'consent_missing'::text;
      return;
    end if;
  end if;

  update public.pilot_enrollments
     set state = p_to_state,
         information_read_at  = case when p_to_state = 'information_read'     then now() else information_read_at end,
         assented_at          = case when p_to_state = 'participant_assented' then now() else assented_at end,
         guardian_verified_at = case when p_to_state = 'guardian_verified'    then now() else guardian_verified_at end,
         guardian_verification_method =
           case when p_to_state = 'guardian_verified' then coalesce(p_reason, 'unspecified')
                else guardian_verification_method end,
         enrolled_at          = case when p_to_state = 'enrolled'   then now() else enrolled_at end,
         collection_started_at = case when p_to_state = 'collecting' then now() else collection_started_at end,
         completed_at         = case when p_to_state = 'completed'  then now() else completed_at end,
         updated_at = now()
   where id = v.id;

  insert into public.pilot_enrollment_events (enrollment_id, owner_user_id, from_state, to_state, actor, reason)
  values (v.id, v.owner_user_id, v.state, p_to_state, p_actor, p_reason);

  return query select p_to_state, 'ok'::text;
end;
$$;

revoke execute on function public.advance_pilot_enrollment(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.advance_pilot_enrollment(uuid, text, text, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- 7. "May we collect from this participant right now?"
-- ---------------------------------------------------------------------------
--
-- One predicate, so that the journal write path, the export and the operator
-- report cannot answer it differently. Takes a participant, not an enrollment,
-- because that is what the write path has in hand.
create or replace function public.pilot_collection_open(target_participant uuid)
returns boolean
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.pilot_enrollments e
      join public.pilot_studies s on s.id = e.study_id
     where e.participant_id = target_participant
       and e.state = 'collecting'
       and s.status in ('recruiting', 'collecting')
       and (e.collection_ends_at is null or e.collection_ends_at > now())
  );
$$;

grant execute on function public.pilot_collection_open(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 8. Row level security
-- ---------------------------------------------------------------------------

alter table public.pilot_studies enable row level security;
alter table public.pilot_invitations enable row level security;
alter table public.pilot_enrollments enable row level security;
alter table public.pilot_enrollment_events enable row level security;

-- Study metadata is not secret and the join screen needs the title and the
-- consent document version before an enrollment exists.
drop policy if exists "pilot_studies_read" on public.pilot_studies;
create policy "pilot_studies_read" on public.pilot_studies
for select to authenticated
using (true);

grant select on public.pilot_studies to authenticated;

-- Invitations get NO policy and NO grant. Not "select your own" — there is no
-- such thing as your own invitation before you redeem it, and afterwards the
-- enrollment row is what you need. Every read goes through the service role.
grant select, insert, update on public.pilot_invitations to service_role;

drop policy if exists "pilot_enrollments_select_own" on public.pilot_enrollments;
create policy "pilot_enrollments_select_own" on public.pilot_enrollments
for select to authenticated
using ((select auth.uid()) = owner_user_id);

-- SELECT only. Every write is a transition, and every transition goes through
-- `advance_pilot_enrollment` under the service role. A participant who could
-- UPDATE this row could set their own state to `collecting`.
grant select on public.pilot_enrollments to authenticated;

drop policy if exists "pilot_enrollment_events_select_own" on public.pilot_enrollment_events;
create policy "pilot_enrollment_events_select_own" on public.pilot_enrollment_events
for select to authenticated
using ((select auth.uid()) = owner_user_id);

grant select on public.pilot_enrollment_events to authenticated;

-- The research role reads the pseudonym mapping for exports, and nothing writes
-- through it.
grant select on public.pilot_studies, public.pilot_enrollments to research_reader;

-- ---------------------------------------------------------------------------
-- 9. Rollback
-- ---------------------------------------------------------------------------
--
-- Everything above is additive, so undoing it is dropping it. Kept here as a
-- comment rather than a file so that it stays next to what it undoes.
--
--   drop function if exists public.pilot_collection_open(uuid);
--   drop function if exists public.advance_pilot_enrollment(uuid, text, text, text);
--   drop function if exists public.redeem_pilot_invitation(text, uuid, uuid, text, boolean);
--   drop trigger  if exists pilot_enrollment_events_append_only on public.pilot_enrollment_events;
--   drop function if exists public.reject_pilot_event_mutation();
--   drop table    if exists public.pilot_enrollment_events;
--   drop table    if exists public.pilot_enrollments;
--   drop table    if exists public.pilot_invitations;
--   drop table    if exists public.pilot_studies;
--
-- Dropping `pilot_enrollments` destroys the pseudonym mapping, which makes any
-- export already taken permanently unlinkable. That is a safe direction for
-- privacy and an unrecoverable one for the study: export the mapping first if
-- the run is still live.
