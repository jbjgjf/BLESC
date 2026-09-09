-- RLS, privilege and state-machine tests for invitation-only enrollment (#163).
--
-- Run against a local Supabase database with all migrations applied:
--   supabase db reset   (from sentra/, applies migrations)
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/pilot_enrollment_rls.test.sql
--
-- The whole script runs in one transaction and rolls back: it leaves no data.
-- Every assertion raises an exception (failing the script) when violated.
--
-- One thing this file cannot test from a single session: two *simultaneous*
-- redemptions of the same single-use code. The safety of that case rests on the
-- conditional UPDATE in `redeem_pilot_invitation` taking a row lock, which
-- needs two concurrent connections to exercise. What is tested here is the
-- sequential equivalent (the second redemption is refused) and the constraint
-- that makes over-redemption unrepresentable even if the function were wrong:
-- `redeemed_count <= max_redemptions`. The concurrent case belongs to the dry
-- run (#168), where it is exercised by two browsers.

begin;

-- ---------------------------------------------------------------------------
-- Fixtures: one study, three participants.
-- ---------------------------------------------------------------------------

insert into auth.users (id, email)
values
  ('00000000-0000-0000-0000-0000000000e1', 'pilot-a@test.local'),
  ('00000000-0000-0000-0000-0000000000e2', 'pilot-b@test.local'),
  ('00000000-0000-0000-0000-0000000000e3', 'pilot-c@test.local');

insert into public.participants (id, owner_user_id, code)
values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000e1', 'PILOT_A'),
  ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000e2', 'PILOT_B'),
  ('00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000e3', 'PILOT_C');

insert into public.pilot_studies (id, slug, title, status, baseline_days, observation_days)
values ('00000000-0000-0000-0000-0000000000b1', 'dry-run-2026-09', 'Dry run', 'recruiting', 3, 0);

insert into public.pilot_studies (id, slug, title, status)
values ('00000000-0000-0000-0000-0000000000b2', 'not-open-yet', 'Draft study', 'draft');

-- Hashes here stand in for HMACs; the function only ever compares them.
insert into public.pilot_invitations (id, study_id, code_hash, code_prefix, max_redemptions, expires_at, revoked_at)
values
  ('00000000-0000-0000-0000-000000000c01', '00000000-0000-0000-0000-0000000000b1', 'hash-good',    'AAAA', 1, null, null),
  ('00000000-0000-0000-0000-000000000c02', '00000000-0000-0000-0000-0000000000b1', 'hash-expired', 'BBBB', 1, now() - interval '1 day', null),
  ('00000000-0000-0000-0000-000000000c03', '00000000-0000-0000-0000-0000000000b1', 'hash-revoked', 'CCCC', 1, null, now() - interval '1 hour'),
  ('00000000-0000-0000-0000-000000000c04', '00000000-0000-0000-0000-0000000000b1', 'hash-shared',  'DDDD', 2, null, null),
  ('00000000-0000-0000-0000-000000000c05', '00000000-0000-0000-0000-0000000000b2', 'hash-draft',   'EEEE', 1, null, null);

-- ---------------------------------------------------------------------------
-- Redemption: every rejection is a rejection.
-- ---------------------------------------------------------------------------

do $$
declare
  r record;
begin
  for r in
    select * from public.redeem_pilot_invitation(
      'hash-does-not-exist', '00000000-0000-0000-0000-0000000000e1',
      '00000000-0000-0000-0000-0000000000a1', 'P-AAA001', true)
  loop
    if r.outcome <> 'rejected' then
      raise exception 'an unknown code produced outcome %', r.outcome;
    end if;
  end loop;
end;
$$;

do $$
declare
  r record;
begin
  for r in
    select * from public.redeem_pilot_invitation(
      'hash-expired', '00000000-0000-0000-0000-0000000000e1',
      '00000000-0000-0000-0000-0000000000a1', 'P-AAA002', true)
  loop
    if r.outcome <> 'rejected' then
      raise exception 'an expired code produced outcome %', r.outcome;
    end if;
  end loop;
end;
$$;

do $$
declare
  r record;
begin
  for r in
    select * from public.redeem_pilot_invitation(
      'hash-revoked', '00000000-0000-0000-0000-0000000000e1',
      '00000000-0000-0000-0000-0000000000a1', 'P-AAA003', true)
  loop
    if r.outcome <> 'rejected' then
      raise exception 'a revoked code produced outcome %', r.outcome;
    end if;
  end loop;
end;
$$;

-- A code for a study that is not recruiting. The code itself is perfectly
-- valid, which is the point: recruitment is paused by an UPDATE on the study.
do $$
declare
  r record;
begin
  for r in
    select * from public.redeem_pilot_invitation(
      'hash-draft', '00000000-0000-0000-0000-0000000000e1',
      '00000000-0000-0000-0000-0000000000a1', 'P-AAA004', true)
  loop
    if r.outcome <> 'rejected' then
      raise exception 'a code for a draft study produced outcome %', r.outcome;
    end if;
  end loop;
end;
$$;

-- The good code works, once.
do $$
declare
  r record;
  seen integer := 0;
begin
  for r in
    select * from public.redeem_pilot_invitation(
      'hash-good', '00000000-0000-0000-0000-0000000000e1',
      '00000000-0000-0000-0000-0000000000a1', 'P-AAA100', true)
  loop
    seen := seen + 1;
    if r.outcome <> 'enrolled' then
      raise exception 'a valid code produced outcome %', r.outcome;
    end if;
    if r.state <> 'account_bound' then
      raise exception 'a fresh enrollment started in state %', r.state;
    end if;
    if r.study_slug <> 'dry-run-2026-09' then
      raise exception 'redemption reported study %', r.study_slug;
    end if;
  end loop;
  if seen <> 1 then
    raise exception 'redemption returned % rows', seen;
  end if;
end;
$$;

-- Spent. A different user with the same single-use code is refused.
do $$
declare
  r record;
begin
  for r in
    select * from public.redeem_pilot_invitation(
      'hash-good', '00000000-0000-0000-0000-0000000000e2',
      '00000000-0000-0000-0000-0000000000a2', 'P-BBB100', true)
  loop
    if r.outcome <> 'rejected' then
      raise exception 'a spent single-use code produced outcome %', r.outcome;
    end if;
  end loop;
end;
$$;

-- The same user redeeming again lands on their existing enrollment rather than
-- an error. A double tap must not look like a failure.
do $$
declare
  r record;
begin
  for r in
    select * from public.redeem_pilot_invitation(
      'hash-shared', '00000000-0000-0000-0000-0000000000e1',
      '00000000-0000-0000-0000-0000000000a1', 'P-AAA101', true)
  loop
    if r.outcome <> 'already_enrolled' then
      raise exception 'a second redemption by the same user produced outcome %', r.outcome;
    end if;
  end loop;
end;
$$;

-- ...and that second attempt must not have consumed a redemption of the
-- shared code, because it never got that far.
do $$
declare
  used integer;
begin
  select redeemed_count into used from public.pilot_invitations
   where id = '00000000-0000-0000-0000-000000000c04';
  if used <> 0 then
    raise exception 'an already-enrolled user consumed % redemptions of another code', used;
  end if;
end;
$$;

-- Over-redemption is unrepresentable even by direct UPDATE.
do $$
begin
  begin
    update public.pilot_invitations
       set redeemed_count = max_redemptions + 1
     where id = '00000000-0000-0000-0000-000000000c04';
    raise exception 'redeemed_count could exceed max_redemptions';
  exception when check_violation then
    null;
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- Transitions
-- ---------------------------------------------------------------------------

do $$
declare
  v_enrollment uuid;
  r record;
begin
  select id into v_enrollment from public.pilot_enrollments
   where owner_user_id = '00000000-0000-0000-0000-0000000000e1';

  -- Skipping the information sheet is refused.
  for r in select * from public.advance_pilot_enrollment(v_enrollment, 'participant_assented', 'participant', null) loop
    if r.outcome <> 'illegal_transition' then
      raise exception 'skipping information_read produced outcome %', r.outcome;
    end if;
  end loop;

  for r in select * from public.advance_pilot_enrollment(v_enrollment, 'information_read', 'participant', null) loop
    if r.outcome <> 'ok' then raise exception 'information_read failed: %', r.outcome; end if;
  end loop;

  for r in select * from public.advance_pilot_enrollment(v_enrollment, 'participant_assented', 'participant', null) loop
    if r.outcome <> 'ok' then raise exception 'participant_assented failed: %', r.outcome; end if;
  end loop;

  -- A minor cannot reach `enrolled` without the guardian step, whatever their
  -- consent record says.
  for r in select * from public.advance_pilot_enrollment(v_enrollment, 'enrolled', 'participant', null) loop
    if r.outcome <> 'illegal_transition' then
      raise exception 'a minor skipped guardian verification (outcome %)', r.outcome;
    end if;
  end loop;

  for r in select * from public.advance_pilot_enrollment(v_enrollment, 'guardian_verified', 'operator', 'phone call 2026-09-10') loop
    if r.outcome <> 'ok' then raise exception 'guardian_verified failed: %', r.outcome; end if;
  end loop;

  -- Still no consent record: enrollment stops here.
  for r in select * from public.advance_pilot_enrollment(v_enrollment, 'enrolled', 'participant', null) loop
    if r.outcome <> 'consent_missing' then
      raise exception 'enrollment advanced without a consent record (outcome %)', r.outcome;
    end if;
  end loop;
end;
$$;

-- A consent record that does not cover research use is still not consent.
do $$
declare
  v_enrollment uuid;
  r record;
begin
  select id into v_enrollment from public.pilot_enrollments
   where owner_user_id = '00000000-0000-0000-0000-0000000000e1';

  insert into public.consent_records (owner_user_id, participant_id, app_use, research_analysis, minor_assent, guardian_consent)
  values ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', true, false, true, true);

  for r in select * from public.advance_pilot_enrollment(v_enrollment, 'enrolled', 'participant', null) loop
    if r.outcome <> 'consent_missing' then
      raise exception 'app-use-only consent was accepted for research enrollment (outcome %)', r.outcome;
    end if;
  end loop;

  -- Research consent without the guardian half is not enough for a minor.
  update public.consent_records
     set research_analysis = true, guardian_consent = false
   where owner_user_id = '00000000-0000-0000-0000-0000000000e1';

  for r in select * from public.advance_pilot_enrollment(v_enrollment, 'enrolled', 'participant', null) loop
    if r.outcome <> 'consent_missing' then
      raise exception 'a minor enrolled without guardian consent (outcome %)', r.outcome;
    end if;
  end loop;

  update public.consent_records
     set guardian_consent = true
   where owner_user_id = '00000000-0000-0000-0000-0000000000e1';

  for r in select * from public.advance_pilot_enrollment(v_enrollment, 'enrolled', 'participant', null) loop
    if r.outcome <> 'ok' then raise exception 'enrollment with full consent failed: %', r.outcome; end if;
  end loop;
end;
$$;

-- Collection is closed until the window opens, and the predicate the write path
-- calls says so.
do $$
declare
  v_enrollment uuid;
  r record;
begin
  if public.pilot_collection_open('00000000-0000-0000-0000-0000000000a1') then
    raise exception 'collection was open for an enrolled-but-not-collecting participant';
  end if;

  select id into v_enrollment from public.pilot_enrollments
   where owner_user_id = '00000000-0000-0000-0000-0000000000e1';
  for r in select * from public.advance_pilot_enrollment(v_enrollment, 'collecting', 'operator', 'window opened') loop
    if r.outcome <> 'ok' then raise exception 'opening collection failed: %', r.outcome; end if;
  end loop;

  if not public.pilot_collection_open('00000000-0000-0000-0000-0000000000a1') then
    raise exception 'collection was closed for a collecting participant';
  end if;
end;
$$;

-- A participant who never enrolled is never open for collection.
do $$
begin
  if public.pilot_collection_open('00000000-0000-0000-0000-0000000000a3') then
    raise exception 'collection was open for a participant with no enrollment';
  end if;
end;
$$;

-- Withdrawal works from a live state and is terminal.
do $$
declare
  v_enrollment uuid;
  r record;
begin
  select id into v_enrollment from public.pilot_enrollments
   where owner_user_id = '00000000-0000-0000-0000-0000000000e1';

  for r in select * from public.advance_pilot_enrollment(v_enrollment, 'withdrawn', 'participant', 'changed my mind') loop
    if r.outcome <> 'ok' then raise exception 'withdrawal failed: %', r.outcome; end if;
  end loop;

  if public.pilot_collection_open('00000000-0000-0000-0000-0000000000a1') then
    raise exception 'collection stayed open after withdrawal';
  end if;

  for r in select * from public.advance_pilot_enrollment(v_enrollment, 'collecting', 'operator', 'reopen') loop
    if r.outcome <> 'terminal' then
      raise exception 'a withdrawn enrollment was reopened (outcome %)', r.outcome;
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Audit trail is append-only
-- ---------------------------------------------------------------------------

do $$
declare
  events integer;
begin
  select count(*) into events from public.pilot_enrollment_events;
  if events < 6 then
    raise exception 'only % transition events were recorded', events;
  end if;
end;
$$;

do $$
begin
  begin
    update public.pilot_enrollment_events set reason = 'rewritten';
    raise exception 'a transition event could be updated';
  exception when raise_exception then
    if sqlerrm not like '%append-only%' then raise; end if;
  end;
end;
$$;

do $$
begin
  begin
    delete from public.pilot_enrollment_events;
    raise exception 'a transition event could be deleted';
  exception when raise_exception then
    if sqlerrm not like '%append-only%' then raise; end if;
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- Cross-participant isolation
-- ---------------------------------------------------------------------------

-- Give B an enrollment to try to reach.
do $$
declare
  r record;
begin
  for r in
    select * from public.redeem_pilot_invitation(
      'hash-shared', '00000000-0000-0000-0000-0000000000e2',
      '00000000-0000-0000-0000-0000000000a2', 'P-BBB200', true)
  loop
    if r.outcome <> 'enrolled' then raise exception 'setting up B failed: %', r.outcome; end if;
  end loop;
end;
$$;

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000e1", "role": "authenticated"}';

do $$
declare
  visible integer;
begin
  select count(*) into visible from public.pilot_enrollments
   where owner_user_id = '00000000-0000-0000-0000-0000000000e2';
  if visible <> 0 then
    raise exception 'participant A could see % of B''s enrollments', visible;
  end if;

  select count(*) into visible from public.pilot_enrollments
   where owner_user_id = '00000000-0000-0000-0000-0000000000e1';
  if visible <> 1 then
    raise exception 'participant A could not see their own enrollment';
  end if;
end;
$$;

do $$
declare
  visible integer;
begin
  select count(*) into visible from public.pilot_enrollment_events
   where owner_user_id = '00000000-0000-0000-0000-0000000000e2';
  if visible <> 0 then
    raise exception 'participant A could read % of B''s transition events', visible;
  end if;
end;
$$;

-- Invitations are not readable by a participant at all — not their own, not
-- anyone's. There is no policy and no grant.
do $$
begin
  begin
    perform 1 from public.pilot_invitations;
    raise exception 'a participant could select from pilot_invitations';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;

-- A participant cannot advance their own state by writing the row directly.
-- This is the attack the SELECT-only grant exists to stop: an UPDATE here would
-- let anyone set themselves to `collecting`.
do $$
begin
  begin
    update public.pilot_enrollments set state = 'collecting'
     where owner_user_id = '00000000-0000-0000-0000-0000000000e1';
    raise exception 'a participant could update their own enrollment state';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;

do $$
begin
  begin
    insert into public.pilot_enrollments (study_id, owner_user_id, participant_id, research_code)
    values ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000e1',
            '00000000-0000-0000-0000-0000000000a1', 'P-FORGED');
    raise exception 'a participant could insert their own enrollment';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;

-- The privileged functions are not reachable over PostgREST by a signed-in
-- user. `revoke ... from public` alone would not achieve this on Supabase; the
-- migration names `anon` and `authenticated` explicitly.
do $$
begin
  begin
    perform public.redeem_pilot_invitation('hash-shared', '00000000-0000-0000-0000-0000000000e1',
      '00000000-0000-0000-0000-0000000000a1', 'P-XXXXXX', true);
    raise exception 'authenticated could call redeem_pilot_invitation';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;

do $$
declare
  v_enrollment uuid := '00000000-0000-0000-0000-000000000999';
begin
  begin
    perform public.advance_pilot_enrollment(v_enrollment, 'collecting', 'participant', null);
    raise exception 'authenticated could call advance_pilot_enrollment';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;

reset role;

-- Anonymous callers see nothing and can call nothing.
set local role anon;
set local request.jwt.claims = '{"role": "anon"}';

-- Two ways to see nothing, and this accepts either.
--
-- Before 20260907000000 `anon` held Supabase's default table grant, so the
-- read succeeded and RLS filtered it to zero rows. That migration revokes the
-- grant, so the same read now raises instead. The guarantee under test is "an
-- anonymous caller cannot learn a single enrollment", which the privilege
-- error satisfies more strongly than the empty result did — but a test that
-- only accepted the error would fail on any deployment still carrying the old
-- grant while the property it cares about still held.
do $$
declare
  visible integer;
begin
  begin
    select count(*) into visible from public.pilot_enrollments;
  exception when insufficient_privilege then
    return;
  end;
  if visible <> 0 then
    raise exception 'an anonymous caller saw % enrollments', visible;
  end if;
end;
$$;

do $$
begin
  begin
    perform public.redeem_pilot_invitation('hash-shared', '00000000-0000-0000-0000-0000000000e1',
      '00000000-0000-0000-0000-0000000000a1', 'P-ANON01', true);
    raise exception 'anon could call redeem_pilot_invitation';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;

reset role;

-- ---------------------------------------------------------------------------
-- Constraints that hold even against a manual fix in the dashboard
-- ---------------------------------------------------------------------------

do $$
begin
  begin
    insert into public.pilot_enrollments (study_id, owner_user_id, participant_id, research_code, state, is_minor)
    values ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000e3',
            '00000000-0000-0000-0000-0000000000a3', 'P-CCC100', 'enrolled', true);
    raise exception 'a minor was inserted as enrolled with no guardian timestamp';
  exception when check_violation then
    null;
  end;
end;
$$;

do $$
begin
  begin
    insert into public.pilot_enrollments (study_id, owner_user_id, participant_id, research_code, state, withdrawn_at)
    values ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000e3',
            '00000000-0000-0000-0000-0000000000a3', 'P-CCC101', 'withdrawn', null);
    raise exception 'a withdrawn enrollment was inserted with no withdrawal time';
  exception when check_violation then
    null;
  end;
end;
$$;

-- One enrollment per person per study.
do $$
begin
  begin
    insert into public.pilot_enrollments (study_id, owner_user_id, participant_id, research_code)
    values ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000e2',
            '00000000-0000-0000-0000-0000000000a2', 'P-BBB300');
    raise exception 'a second enrollment in the same study was accepted';
  exception when unique_violation then
    null;
  end;
end;
$$;

-- Research codes are unique within a study, which is what makes the retry loop
-- in `redeemInvitation` correct rather than optimistic.
do $$
begin
  begin
    insert into public.pilot_enrollments (study_id, owner_user_id, participant_id, research_code)
    values ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000e3',
            '00000000-0000-0000-0000-0000000000a3', 'P-BBB200');
    raise exception 'a duplicate research code was accepted';
  exception when unique_violation then
    null;
  end;
end;
$$;

rollback;
