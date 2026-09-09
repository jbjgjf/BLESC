-- Two holes the first cut of #164 left open, both found in review of PR #170.
--
-- ===========================================================================
-- Additive. One nullable column, three columns relaxed from NOT NULL, one
-- function replaced. Nothing existing is dropped and no row is rewritten, so
-- it can be applied while the current version is serving.
-- ===========================================================================
--
-- **1. The participant was allowed to decide whether a guardian was needed.**
--
-- `redeem_pilot_invitation` took `p_is_minor` from the request body — that is,
-- from a radio button on the join screen. A minor who picked 「18歳以上」 was
-- recorded as an adult, and the state machine then skipped guardian
-- verification entirely, exactly as designed for an adult. The whole control
-- was one click wide.
--
-- 20260906010000 knew this ("an operator confirms it before collection opens
-- rather than trusting the checkbox alone") and left it for #164. So the age
-- band moves onto the invitation, where the coordinator who issues the code
-- sets it, and the participant's own statement becomes a fallback used only
-- for invitations issued before this migration.
--
-- Note what is *not* collected: still no date of birth. The protocol needs
-- "is a guardian required", and the coordinator already knows which class they
-- are handing codes to.
--
-- **2. The verification link was handed to the person it verifies.**
--
-- The first cut returned the guardian URL to the participant's own browser,
-- on the theory that they would pass it to a parent. But the confirm route
-- authenticates with the token and nothing else, so the participant could open
-- their own link and record their own guardian's consent — the same
-- self-confirmation the change exists to prevent, one redirect further away.
--
-- The token now belongs to the operator. A participant *requests* verification
-- (their request records what they are asking the guardian to approve); the
-- coordinator issues the link and delivers it through the channel the school
-- already uses for consent forms. That is what 20260906010000 said would
-- happen — "that step belongs to the operator route (#164) and records how it
-- was verified" — and this makes the row able to exist in the requested state,
-- before a token exists.

-- ---------------------------------------------------------------------------
-- 1. The age band belongs to the invitation
-- ---------------------------------------------------------------------------

alter table public.pilot_invitations
  add column if not exists is_minor boolean;

comment on column public.pilot_invitations.is_minor is
  'Whether the participant this code is for requires guardian verification. '
  'Set by the coordinator at issue time. NULL means the code predates '
  '20260909000000 and the redeemer''s own statement is used, which is the '
  'weaker path and exists only so old codes keep working.';

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
  v_is_minor boolean;
begin
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

  -- The one line this function was replaced for. The coordinator's answer
  -- wins; the redeemer's is consulted only when the invitation has none, and
  -- `true` wins over a missing answer on both sides — an unknown age band
  -- means a guardian is asked, never that one is skipped.
  v_is_minor := coalesce(v_invitation.is_minor, p_is_minor, true);

  insert into public.pilot_enrollments (
    study_id, invitation_id, owner_user_id, participant_id,
    research_code, cohort, state, is_minor
  )
  values (
    v_study.id, v_invitation.id, p_owner_user_id, p_participant_id,
    p_research_code, v_invitation.cohort, 'account_bound', v_is_minor
  )
  returning * into v_enrollment;

  insert into public.pilot_enrollment_events (enrollment_id, owner_user_id, from_state, to_state, actor, reason)
  values (
    v_enrollment.id, p_owner_user_id, 'invited', 'account_bound', 'participant',
    case
      when v_invitation.is_minor is not null then 'invitation redeemed (age band from invitation)'
      else 'invitation redeemed (age band self-declared; invitation carried none)'
    end
  );

  return query select v_enrollment.id, v_study.id, v_study.slug, v_enrollment.cohort,
                      v_enrollment.state, 'enrolled'::text;
end;
$$;

revoke execute on function public.redeem_pilot_invitation(text, uuid, uuid, text, boolean)
  from public, anon, authenticated;
grant execute on function public.redeem_pilot_invitation(text, uuid, uuid, text, boolean)
  to service_role;

-- ---------------------------------------------------------------------------
-- 2. A verification can exist before its token does
-- ---------------------------------------------------------------------------
--
-- The participant creates the row when they ask for a guardian to be
-- contacted; it carries what they are asking the guardian to approve, and no
-- token. The coordinator issues the token onto that row later. So the three
-- token columns stop being NOT NULL.
--
-- `token_hash` keeps its UNIQUE constraint. Postgres allows any number of
-- NULLs in a unique index, so many pending requests coexist and every issued
-- token is still unique.

alter table public.pilot_guardian_verifications
  alter column token_hash drop not null,
  alter column token_prefix drop not null,
  alter column expires_at drop not null;

alter table public.pilot_guardian_verifications
  add column if not exists requested_at timestamptz not null default now(),
  add column if not exists issued_at timestamptz,
  -- Which operator issued it. The audit answer to "who sent this link", which
  -- `channel` alone cannot give once issuing is a person's action rather than
  -- a side effect of the participant pressing a button.
  add column if not exists issued_by uuid references auth.users(id) on delete set null;

-- A token and its issue stamp travel together, and neither appears without an
-- expiry. Half-issued is not a state this table can be left in.
alter table public.pilot_guardian_verifications
  drop constraint if exists pilot_guardian_verifications_issued_check;
alter table public.pilot_guardian_verifications
  add constraint pilot_guardian_verifications_issued_check
  check (
    (token_hash is null and token_prefix is null and expires_at is null and issued_at is null)
    or (token_hash is not null and token_prefix is not null and expires_at is not null and issued_at is not null)
  );

-- A decision cannot precede a token: nobody can answer a link that was never
-- sent. Without this, a bug that wrote a decision onto a pending request would
-- produce a guardian consent with no delivery behind it.
alter table public.pilot_guardian_verifications
  drop constraint if exists pilot_guardian_verifications_decision_needs_token_check;
alter table public.pilot_guardian_verifications
  add constraint pilot_guardian_verifications_decision_needs_token_check
  check (decision is null or token_hash is not null);

-- One outstanding request per enrollment. Two pending rows would leave the
-- coordinator guessing which scope the participant meant.
create unique index if not exists pilot_guardian_verifications_one_pending_idx
  on public.pilot_guardian_verifications(enrollment_id)
  where decision is null and revoked_at is null;

grant select (id, enrollment_id, channel, requested_at, issued_at, expires_at, claimed_at,
              decision, decided_at, revoked_at, created_at)
  on public.pilot_guardian_verifications to research_reader;
