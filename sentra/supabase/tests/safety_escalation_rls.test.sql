-- Who may read a crisis escalation, and who may be sent one.
--
-- Run against a local Supabase database with all migrations applied:
--   supabase db reset   (from sentra/, applies migrations)
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/safety_escalation_rls.test.sql
--
-- The whole script runs in one transaction and rolls back: it leaves no data.
-- Every assertion raises an exception (failing the script) when violated.
--
-- The claim under test is the one that makes this feature defensible: notifying
-- an educator about a student in crisis widens *when* somebody knows, never
-- *who*. If `safety_escalation_recipients` can return an educator who could not
-- already read that student's roster row, then this feature is a new disclosure
-- wearing a safety justification, and it should not ship.

begin;

-- ---------------------------------------------------------------------------
-- Fixtures: two students, two educators, one school.
--
--   student A — overseen by educator 1, consent active     → notifiable
--   student B — overseen by educator 1, NO consent row     → not notifiable
--   educator 2 — in the school, not on anyone's roster      → never notified
-- ---------------------------------------------------------------------------

insert into auth.users (id, email)
values
  ('00000000-0000-0000-0000-0000000000a0', 'esc-student-a@test.local'),
  ('00000000-0000-0000-0000-0000000000b0', 'esc-student-b@test.local'),
  ('00000000-0000-0000-0000-0000000000e1', 'esc-educator-1@test.local'),
  ('00000000-0000-0000-0000-0000000000e2', 'esc-educator-2@test.local'),
  ('00000000-0000-0000-0000-0000000000d0', 'esc-admin@test.local');

insert into public.participants (id, owner_user_id, code)
values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a0', 'ESC_A'),
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b0', 'ESC_B');

insert into public.organizations (id, name, created_by)
values ('00000000-0000-0000-0000-000000000f01', 'Escalation Test School',
        '00000000-0000-0000-0000-0000000000d0');

insert into public.organization_members (org_id, member_user_id, role)
values
  ('00000000-0000-0000-0000-000000000f01', '00000000-0000-0000-0000-0000000000e1', 'educator'),
  ('00000000-0000-0000-0000-000000000f01', '00000000-0000-0000-0000-0000000000e2', 'educator')
on conflict do nothing;

insert into public.oversight_roster (org_id, educator_user_id, participant_id, owner_user_id, status)
values
  ('00000000-0000-0000-0000-000000000f01', '00000000-0000-0000-0000-0000000000e1',
   '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a0', 'active'),
  ('00000000-0000-0000-0000-000000000f01', '00000000-0000-0000-0000-0000000000e1',
   '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b0', 'active');

-- Only student A consented to oversight.
insert into public.oversight_consents (participant_id, owner_user_id, org_id)
values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a0',
        '00000000-0000-0000-0000-000000000f01');

insert into public.safety_escalations
  (id, owner_user_id, participant_id, risk_level, reasons, surface, dedupe_key)
values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a0',
   '00000000-0000-0000-0000-0000000000a1', 'crisis', '{explicit_self_harm_statement}',
   'chat', 'crisis:chat:2026-09-16T17'),
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000b0',
   '00000000-0000-0000-0000-0000000000b1', 'crisis', '{explicit_self_harm_statement}',
   'journal', 'crisis:journal:2026-09-16T17');

insert into public.safety_escalation_deliveries
  (escalation_id, recipient_user_id, channel, recipient_hash, status)
values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e1',
        'email', 'deadbeefdeadbeefdeadbeefdeadbeef', 'delivered');

-- ---------------------------------------------------------------------------
-- 1. Recipients are exactly the educators who already had access
-- ---------------------------------------------------------------------------

do $$
declare
  found_count integer;
  found_educator uuid;
begin
  select count(*) into found_count
    from public.safety_escalation_recipients('00000000-0000-0000-0000-0000000000a1');
  select educator_user_id into found_educator
    from public.safety_escalation_recipients('00000000-0000-0000-0000-0000000000a1')
   limit 1;

  if found_count <> 1 then
    raise exception 'student A should have exactly one notifiable educator, got %', found_count;
  end if;
  if found_educator <> '00000000-0000-0000-0000-0000000000e1' then
    raise exception 'the wrong educator would be notified: %', found_educator;
  end if;
end;
$$;

-- No oversight consent means no notification, even though the roster row is
-- active. This is the condition that keeps "when, not who" true.
do $$
declare
  found_count integer;
begin
  select count(*) into found_count
    from public.safety_escalation_recipients('00000000-0000-0000-0000-0000000000b1');
  if found_count <> 0 then
    raise exception 'a student with no oversight consent had % notifiable educator(s)', found_count;
  end if;
end;
$$;

-- Revoking consent stops tonight's notification, not just tomorrow's roster.
do $$
declare
  found_count integer;
begin
  update public.oversight_consents
     set status = 'revoked', revoked_at = now()
   where participant_id = '00000000-0000-0000-0000-0000000000a1';

  select count(*) into found_count
    from public.safety_escalation_recipients('00000000-0000-0000-0000-0000000000a1');
  if found_count <> 0 then
    raise exception 'consent was revoked and % educator(s) would still be notified', found_count;
  end if;

  update public.oversight_consents
     set status = 'active', revoked_at = null
   where participant_id = '00000000-0000-0000-0000-0000000000a1';
end;
$$;

-- An educator in the school who is on nobody's roster is never a recipient.
do $$
declare
  leaked integer;
begin
  select count(*) into leaked
    from public.safety_escalation_recipients('00000000-0000-0000-0000-0000000000a1')
   where educator_user_id = '00000000-0000-0000-0000-0000000000e2';
  if leaked <> 0 then
    raise exception 'an educator with no roster entry would be notified';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. The student can see what was sent about them
-- ---------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000a0", "role": "authenticated"}';

do $$
declare
  visible integer;
begin
  select count(*) into visible from public.safety_escalations;
  if visible <> 1 then
    raise exception 'student A should see exactly their own escalation, saw %', visible;
  end if;
end;
$$;

-- And who it went to. A system that tells an adult something about a minor and
-- hides that from the minor is one they cannot trust.
do $$
declare
  visible integer;
begin
  select count(*) into visible from public.safety_escalation_deliveries;
  if visible <> 1 then
    raise exception 'student A should see the delivery about them, saw %', visible;
  end if;
end;
$$;

-- A student may not mark their own escalation acknowledged. Acknowledgement is
-- a claim that an adult has it.
do $$
begin
  begin
    update public.safety_escalations
       set acknowledged_at = now()
     where id = '00000000-0000-0000-0000-0000000000c1';
    -- RLS has no UPDATE policy admitting the owner, so zero rows match and no
    -- error is raised. The assertion is therefore on the row, not on an error.
    if exists (
      select 1 from public.safety_escalations
       where id = '00000000-0000-0000-0000-0000000000c1' and acknowledged_at is not null
    ) then
      raise exception 'a student acknowledged their own escalation';
    end if;
  exception when insufficient_privilege then
    null;
  end;
end;
$$;

reset role;

-- ---------------------------------------------------------------------------
-- 3. One student cannot see another's
-- ---------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000b0", "role": "authenticated"}';

do $$
declare
  visible integer;
begin
  select count(*) into visible from public.safety_escalations
   where owner_user_id <> '00000000-0000-0000-0000-0000000000b0';
  if visible <> 0 then
    raise exception 'student B saw % escalation(s) belonging to someone else', visible;
  end if;
end;
$$;

reset role;

-- ---------------------------------------------------------------------------
-- 4. The consented educator sees it; the unrostered one does not
-- ---------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000e1", "role": "authenticated"}';

do $$
declare
  visible integer;
begin
  -- Student A only: student B is on this educator's roster but never consented,
  -- so `educator_oversees` is false for them.
  select count(*) into visible from public.safety_escalations;
  if visible <> 1 then
    raise exception 'educator 1 should see exactly one escalation, saw %', visible;
  end if;
end;
$$;

-- Acknowledgement is the one write an educator makes.
do $$
begin
  update public.safety_escalations
     set acknowledged_at = now(), acknowledged_by = '00000000-0000-0000-0000-0000000000e1'
   where id = '00000000-0000-0000-0000-0000000000c1';
  if not exists (
    select 1 from public.safety_escalations
     where id = '00000000-0000-0000-0000-0000000000c1' and acknowledged_at is not null
  ) then
    raise exception 'the overseeing educator could not acknowledge';
  end if;
end;
$$;

-- But not the delivery state. Rewriting `status` would let a recipient mark an
-- undelivered escalation as delivered.
do $$
begin
  begin
    update public.safety_escalations set status = 'delivered'
     where id = '00000000-0000-0000-0000-0000000000c1';
    raise exception 'an educator rewrote the delivery status';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;

reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000e2", "role": "authenticated"}';

do $$
declare
  visible integer;
begin
  select count(*) into visible from public.safety_escalations;
  if visible <> 0 then
    raise exception 'an educator who oversees nobody saw % escalation(s)', visible;
  end if;
end;
$$;

reset role;

-- ---------------------------------------------------------------------------
-- 5. Nothing is reachable anonymously, and nobody writes but the service role
-- ---------------------------------------------------------------------------

set local role anon;
set local request.jwt.claims = '{"role": "anon"}';

do $$
declare
  visible integer;
begin
  begin
    select count(*) into visible from public.safety_escalations;
  exception when insufficient_privilege then
    return; -- the grant is gone, which is the stronger of the two outcomes
  end;
  if visible <> 0 then
    raise exception 'an anonymous caller saw % escalation(s)', visible;
  end if;
end;
$$;

-- `safety_escalation_recipients` returns educator email addresses. It must be
-- unreachable over PostgREST RPC by anyone holding the anon key.
do $$
begin
  begin
    perform public.safety_escalation_recipients('00000000-0000-0000-0000-0000000000a1');
    raise exception 'anon could call safety_escalation_recipients';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;

reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000e1", "role": "authenticated"}';

do $$
begin
  begin
    perform public.safety_escalation_recipients('00000000-0000-0000-0000-0000000000a1');
    raise exception 'an educator could read recipient email addresses';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;

-- A participant cannot manufacture an escalation about somebody else.
do $$
begin
  begin
    insert into public.safety_escalations
      (owner_user_id, participant_id, risk_level, reasons, surface, dedupe_key)
    values ('00000000-0000-0000-0000-0000000000a0', '00000000-0000-0000-0000-0000000000a1',
            'crisis', '{}', 'chat', 'forged:chat:2026-09-16T18');
    raise exception 'an authenticated caller inserted an escalation';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;

reset role;

rollback;
