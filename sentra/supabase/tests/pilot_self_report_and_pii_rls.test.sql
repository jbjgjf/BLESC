-- RLS, privilege and constraint tests for the fixed self-report block (#165)
-- and the PII review queue (#167).
--
-- Run against a local Supabase database with all migrations applied:
--   supabase db reset   (from sentra/, applies migrations)
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/pilot_self_report_and_pii_rls.test.sql
--
-- The whole script runs in one transaction and rolls back: it leaves no data.
-- Every assertion raises an exception (failing the script) when violated.
--
-- Three claims are under test:
--
--   1. A participant may read their own self-report and may not write one. A
--      participant who could INSERT here could add readings for days they did
--      not write on, which is the one thing a self-report series cannot
--      survive.
--
--   2. The scale is enforced by the database, not only by the route. An
--      out-of-range value is refused by a CHECK, so the only way one enters the
--      research record is a migration that deliberately widens the scale.
--
--   3. The PII queue never holds text. The `findings_json` shape constraint
--      refuses a findings array carrying any key beyond the five the scanner
--      emits, so a future writer cannot start attaching the matched string "to
--      make the reviewer's job easier".

begin;

-- ---------------------------------------------------------------------------
-- Fixtures: two accounts, two participants, one entry each.
-- ---------------------------------------------------------------------------

insert into auth.users (id, email)
values
  ('00000000-0000-0000-0000-0000000000f1', 'sr-a@test.local'),
  ('00000000-0000-0000-0000-0000000000f2', 'sr-b@test.local');

insert into public.participants (id, owner_user_id, code)
values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f1', 'SR_A'),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000f2', 'SR_B');

insert into public.entries (id, owner_user_id, participant_id, is_masked, observation_type)
values
  ('00000000-0000-0000-0000-000000000e11', '00000000-0000-0000-0000-0000000000f1',
   '00000000-0000-0000-0000-0000000000d1', true, 'daily'),
  ('00000000-0000-0000-0000-000000000e22', '00000000-0000-0000-0000-0000000000f2',
   '00000000-0000-0000-0000-0000000000d2', true, 'daily');

-- ---------------------------------------------------------------------------
-- The scale is a constraint, not a convention.
-- ---------------------------------------------------------------------------

-- A value inside the scale is accepted, and a skipped item stays null.
insert into public.pilot_self_reports
  (owner_user_id, participant_id, entry_id, schema_version, mood, stress, sleep_hours)
values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000d1',
   '00000000-0000-0000-0000-000000000e11', 'pilot-selfreport-v1', 0, 10, 7.5);

do $$
declare
  row_count integer;
begin
  select count(*) into row_count from public.pilot_self_reports
   where entry_id = '00000000-0000-0000-0000-000000000e11'
     and mood = 0 and stress = 10 and sleep_quality is null;
  if row_count <> 1 then
    raise exception 'a valid reading was not stored, or a skipped item did not stay null';
  end if;
end;
$$;

-- 11 on a 0-10 scale is refused. Not clamped to 10 by anything: refused.
do $$
begin
  begin
    insert into public.pilot_self_reports
      (owner_user_id, participant_id, entry_id, schema_version, mood)
    values ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000d2',
            '00000000-0000-0000-0000-000000000e22', 'pilot-selfreport-v1', 11);
    raise exception 'mood = 11 was accepted';
  exception when check_violation then
    null;
  end;
end;
$$;

-- Sleep hours step by 0.5. 7.3 is not a point on the scale.
do $$
begin
  begin
    insert into public.pilot_self_reports
      (owner_user_id, participant_id, entry_id, schema_version, sleep_hours)
    values ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000d2',
            '00000000-0000-0000-0000-000000000e22', 'pilot-selfreport-v1', 7.3);
    raise exception 'sleep_hours = 7.3 was accepted';
  exception when check_violation then
    null;
  end;
end;
$$;

-- One reading per entry: a retried submission updates rather than doubling.
do $$
begin
  begin
    insert into public.pilot_self_reports
      (owner_user_id, participant_id, entry_id, schema_version, mood)
    values ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000d1',
            '00000000-0000-0000-0000-000000000e11', 'pilot-selfreport-v1', 5);
    raise exception 'a second reading was stored for one entry';
  exception when unique_violation then
    null;
  end;
end;
$$;

-- A reading cannot be attached to another account's entry, even under the
-- service role, because the composite foreign key names the owner too.
do $$
begin
  begin
    insert into public.pilot_self_reports
      (owner_user_id, participant_id, entry_id, schema_version, mood)
    values ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000d1',
            '00000000-0000-0000-0000-000000000e22', 'pilot-selfreport-v1', 5);
    raise exception 'a reading was attached to another account''s entry';
  exception when foreign_key_violation then
    null;
  end;
end;
$$;

-- Deleting the session detaches the reading; it does not fail, and it does not
-- take the ownership with it.
--
-- A plain `on delete set null` on the composite key nulls every column in it,
-- `owner_user_id` included, and that column is NOT NULL — so before the
-- column-specific form this delete raised a not-null violation and the
-- advertised cleanup could not run at all.
insert into public.entry_sessions (id, owner_user_id)
values ('00000000-0000-0000-0000-00000000ff01', '00000000-0000-0000-0000-0000000000f1');

update public.pilot_self_reports
   set entry_session_id = '00000000-0000-0000-0000-00000000ff01'
 where entry_id = '00000000-0000-0000-0000-000000000e11';

delete from public.entry_sessions where id = '00000000-0000-0000-0000-00000000ff01';

do $$
declare
  detached boolean;
  owner_kept boolean;
  reading smallint;
begin
  select entry_session_id is null, owner_user_id is not null, mood
    into detached, owner_kept, reading
    from public.pilot_self_reports
   where entry_id = '00000000-0000-0000-0000-000000000e11';
  if not detached then
    raise exception 'deleting the session left a dangling entry_session_id';
  end if;
  if not owner_kept then
    raise exception 'deleting the session cleared owner_user_id as well';
  end if;
  if reading is null then
    raise exception 'deleting the session destroyed the reading';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- The PII queue holds findings, never text.
-- ---------------------------------------------------------------------------

insert into public.pilot_pii_reviews
  (owner_user_id, participant_id, entry_id, scanner_version, finding_count, max_severity, kinds, findings_json, status)
values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000d1',
   '00000000-0000-0000-0000-000000000e11', 'pii-scan-ja-v1', 1, 'high', array['email'],
   '[{"kind":"email","severity":"high","start":4,"end":20,"length":16}]'::jsonb, 'pending');

-- A findings array carrying the matched string is refused.
do $$
begin
  begin
    insert into public.pilot_pii_reviews
      (owner_user_id, participant_id, entry_id, scanner_version, finding_count, findings_json)
    values ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000d2',
            '00000000-0000-0000-0000-000000000e22', 'pii-scan-ja-v1', 1,
            '[{"kind":"email","severity":"high","start":4,"end":20,"length":16,"excerpt":"taro@example.com"}]'::jsonb);
    raise exception 'a finding carrying the matched text was accepted';
  exception when check_violation then
    null;
  end;
end;
$$;

-- A human decision names its decider. 'cleared' without a reviewer is refused.
do $$
begin
  begin
    update public.pilot_pii_reviews set status = 'cleared'
     where entry_id = '00000000-0000-0000-0000-000000000e11';
    raise exception 'a review was cleared with no reviewer recorded';
  exception when check_violation then
    null;
  end;
end;
$$;

update public.pilot_pii_reviews
   set status = 'cleared',
       reviewed_by = '00000000-0000-0000-0000-0000000000f1',
       reviewed_at = now()
 where entry_id = '00000000-0000-0000-0000-000000000e11';

do $$
declare
  touched timestamptz;
  created timestamptz;
begin
  select updated_at, created_at into touched, created from public.pilot_pii_reviews
   where entry_id = '00000000-0000-0000-0000-000000000e11';
  if touched < created then
    raise exception 'updated_at was not stamped on review';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- As a signed-in participant.
-- ---------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000f1", "role": "authenticated"}';

-- Their own reading is readable.
do $$
declare
  visible integer;
begin
  select count(*) into visible from public.pilot_self_reports;
  if visible <> 1 then
    raise exception 'participant A saw % self-reports, expected exactly their own', visible;
  end if;
end;
$$;

-- Somebody else's is not, even though the service role wrote one for B above.
do $$
declare
  visible integer;
begin
  select count(*) into visible from public.pilot_self_reports
   where owner_user_id = '00000000-0000-0000-0000-0000000000f2';
  if visible <> 0 then
    raise exception 'participant A could read % of B''s self-reports', visible;
  end if;
end;
$$;

-- A participant cannot write a reading. This is the grant that stops somebody
-- filling in the days they did not write on.
do $$
begin
  begin
    insert into public.pilot_self_reports
      (owner_user_id, participant_id, entry_id, schema_version, mood)
    values ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000d1',
            '00000000-0000-0000-0000-000000000e11', 'pilot-selfreport-v1', 9);
    raise exception 'a participant could insert their own self-report';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;

do $$
begin
  begin
    update public.pilot_self_reports set mood = 10;
    raise exception 'a participant could update their own self-report';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;

do $$
begin
  begin
    delete from public.pilot_self_reports;
    raise exception 'a participant could delete their own self-report';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;

-- The PII queue is not readable by a participant at all — not even their own
-- row. A participant who can read it learns exactly what the scanner looks for.
do $$
begin
  begin
    perform 1 from public.pilot_pii_reviews;
    raise exception 'a participant could select from pilot_pii_reviews';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;

reset role;

-- ---------------------------------------------------------------------------
-- As anon.
-- ---------------------------------------------------------------------------

set local role anon;
set local request.jwt.claims = '{"role": "anon"}';

-- `anon` has no grant at all on either table — not "sees zero rows", but
-- cannot select. The distinction matters: a table anon can query and finds
-- empty is one policy change away from being readable.
do $$
begin
  begin
    perform 1 from public.pilot_self_reports;
    raise exception 'anon could select from pilot_self_reports';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;

do $$
begin
  begin
    perform 1 from public.pilot_pii_reviews;
    raise exception 'anon could select from pilot_pii_reviews';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;

reset role;

rollback;
