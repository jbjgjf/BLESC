-- Withdrawal is one procedure, whichever screen it starts from (#263, #224).
--
-- Run against a local Supabase database with all migrations applied:
--   supabase db reset   (from sentra/)
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/withdrawal.test.sql
--
-- Runs in one transaction and rolls back.
--
-- `/pilot/join` used to withdraw the enrollment and leave consent active and
-- the text stored. `/consent` revoked consent and left the enrollment
-- collecting. Both screens now call `withdraw_from_research`, so this file
-- tests that function: all three effects happen together, or none do.

begin;

insert into auth.users (id, email)
values
  ('00000000-0000-0000-0000-000000263a00', 'deleter@test.local'),
  ('00000000-0000-0000-0000-000000263b00', 'keeper@test.local'),
  ('00000000-0000-0000-0000-000000263c00', 'bystander@test.local');

insert into public.participants (id, owner_user_id, code)
values
  ('00000000-0000-0000-0000-000000263a01', '00000000-0000-0000-0000-000000263a00', 'W_DELETE'),
  ('00000000-0000-0000-0000-000000263b01', '00000000-0000-0000-0000-000000263b00', 'W_KEEP'),
  ('00000000-0000-0000-0000-000000263c01', '00000000-0000-0000-0000-000000263c00', 'W_BYSTANDER');

insert into public.pilot_studies (id, slug, title, status, study_days)
values ('00000000-0000-0000-0000-000000263501', 'withdrawal-test', 'Withdrawal test', 'recruiting', 3);

insert into public.pilot_enrollments
  (id, study_id, owner_user_id, participant_id, research_code, cohort, state, is_minor,
   information_read_at, assented_at, enrolled_at, collection_started_at)
values
  ('00000000-0000-0000-0000-000000263e0a', '00000000-0000-0000-0000-000000263501',
   '00000000-0000-0000-0000-000000263a00', '00000000-0000-0000-0000-000000263a01',
   'P-W263A', 'adult', 'collecting', false, now(), now(), now(), now()),
  ('00000000-0000-0000-0000-000000263e0b', '00000000-0000-0000-0000-000000263501',
   '00000000-0000-0000-0000-000000263b00', '00000000-0000-0000-0000-000000263b01',
   'P-W263B', 'adult', 'collecting', false, now(), now(), now(), now()),
  ('00000000-0000-0000-0000-000000263e0c', '00000000-0000-0000-0000-000000263501',
   '00000000-0000-0000-0000-000000263c00', '00000000-0000-0000-0000-000000263c01',
   'P-W263C', 'adult', 'collecting', false, now(), now(), now(), now());

insert into public.consent_records
  (owner_user_id, participant_id, app_use, research_analysis, raw_text_retention, minor_assent, granted_at)
values
  ('00000000-0000-0000-0000-000000263a00', '00000000-0000-0000-0000-000000263a01', true, true, true, true, now() - interval '1 day'),
  ('00000000-0000-0000-0000-000000263b00', '00000000-0000-0000-0000-000000263b01', true, true, true, true, now() - interval '1 day'),
  ('00000000-0000-0000-0000-000000263c00', '00000000-0000-0000-0000-000000263c01', true, true, true, true, now() - interval '1 day');

insert into public.entries (id, owner_user_id, participant_id, raw_text_ciphertext, raw_text_key_version, raw_text_expires_at, client_submission_id)
values
  ('00000000-0000-0000-0000-000000263f0a', '00000000-0000-0000-0000-000000263a00',
   '00000000-0000-0000-0000-000000263a01', 'CIPHERTEXT-A', 'raw-text-aesgcm-v1', now() + interval '90 days', 'w263-a'),
  ('00000000-0000-0000-0000-000000263f0b', '00000000-0000-0000-0000-000000263b00',
   '00000000-0000-0000-0000-000000263b01', 'CIPHERTEXT-B', 'raw-text-aesgcm-v1', now() + interval '90 days', 'w263-b');

-- ---------------------------------------------------------------------------
-- 0. Preconditions: both are being collected from
-- ---------------------------------------------------------------------------

do $$
begin
  if not public.pilot_collection_open('00000000-0000-0000-0000-000000263a01')
     or not public.pilot_collection_open('00000000-0000-0000-0000-000000263b01') then
    raise exception 'FAIL: fixture broken — collection should be open before withdrawal';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Nobody withdraws somebody else
-- ---------------------------------------------------------------------------

do $$
begin
  begin
    perform * from public.withdraw_from_research(
      '00000000-0000-0000-0000-000000263a00', '00000000-0000-0000-0000-000000263c01',
      'delete', 'participant', 'student_ui', null, 'v', 'v');
    raise exception 'FAIL: one account withdrew another account''s participant';
  exception when insufficient_privilege then null;
  end;
  if (select state from public.pilot_enrollments where id = '00000000-0000-0000-0000-000000263e0c') <> 'collecting' then
    raise exception 'FAIL: the bystander''s enrollment changed';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. All or nothing
-- ---------------------------------------------------------------------------

/*
 * An invalid actor fails the enrollment event insert, which happens *after*
 * the enrollment row was updated. If the three steps were separate calls,
 * that would leave the enrollment withdrawn and consent active: the #263
 * failure. As one transaction, the update is rolled back with the rest.
 */
do $$
begin
  begin
    perform * from public.withdraw_from_research(
      '00000000-0000-0000-0000-000000263a00', '00000000-0000-0000-0000-000000263a01',
      'delete', 'not-an-actor', 'student_ui', null, 'v', 'v');
    raise exception 'FAIL: an invalid actor was accepted';
  exception when check_violation then null;
  end;

  if (select state from public.pilot_enrollments where id = '00000000-0000-0000-0000-000000263e0a') <> 'collecting' then
    raise exception 'FAIL: a failed withdrawal left the enrollment half-withdrawn';
  end if;
  if exists (select 1 from public.consent_records
              where participant_id = '00000000-0000-0000-0000-000000263a01' and status = 'revoked') then
    raise exception 'FAIL: a failed withdrawal left a revocation behind';
  end if;
  if (select raw_text_ciphertext from public.entries where id = '00000000-0000-0000-0000-000000263f0a') is null then
    raise exception 'FAIL: a failed withdrawal purged the text anyway';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Delete: all three effects
-- ---------------------------------------------------------------------------

do $$
declare
  r record;
  latest public.consent_records;
begin
  select * into r from public.withdraw_from_research(
    '00000000-0000-0000-0000-000000263a00', '00000000-0000-0000-0000-000000263a01',
    'delete', 'participant', 'student_ui', 'test', 'research-consent-v1', 'doc-v1');

  if r.enrollments_withdrawn <> 1 or r.disposition <> 'delete' or r.purged_raw_text <> 1 then
    raise exception 'FAIL: delete reported %', row_to_json(r);
  end if;

  -- (1) enrollment
  if (select state from public.pilot_enrollments where id = '00000000-0000-0000-0000-000000263e0a') <> 'withdrawn' then
    raise exception 'FAIL: enrollment was not withdrawn';
  end if;
  if not exists (select 1 from public.pilot_enrollment_events
                  where enrollment_id = '00000000-0000-0000-0000-000000263e0a'
                    and to_state = 'withdrawn' and from_state = 'collecting' and actor = 'participant') then
    raise exception 'FAIL: the withdrawal was not recorded as an enrollment event';
  end if;

  -- (2) consent: the newest row is a revocation carrying the choice
  select * into latest from public.consent_records
   where participant_id = '00000000-0000-0000-0000-000000263a01'
   order by granted_at desc limit 1;
  if latest.status <> 'revoked' or latest.retained_data_disposition <> 'delete'
     or latest.research_analysis or latest.raw_text_retention or latest.model_training_use
     or latest.anonymized_export or latest.id <> r.consent_record_id then
    raise exception 'FAIL: the newest consent row is not a delete revocation: %', row_to_json(latest);
  end if;
  if not latest.app_use then
    raise exception 'FAIL: withdrawing from research took away ordinary app use';
  end if;

  -- (3) text
  if (select raw_text_ciphertext from public.entries where id = '00000000-0000-0000-0000-000000263f0a') is not null then
    raise exception 'FAIL: the stored text survived a delete withdrawal';
  end if;

  -- And the consequence the gate and the writer read.
  if public.pilot_collection_open('00000000-0000-0000-0000-000000263a01') then
    raise exception 'FAIL: collection is still open after withdrawal';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Keep: withdrawn and revoked just the same; only the text stays
-- ---------------------------------------------------------------------------

do $$
declare
  r record;
begin
  select * into r from public.withdraw_from_research(
    '00000000-0000-0000-0000-000000263b00', '00000000-0000-0000-0000-000000263b01',
    'keep', 'participant', 'student_ui', null, 'research-consent-v1', 'doc-v1');

  if r.enrollments_withdrawn <> 1 or r.disposition <> 'keep' or r.purged_raw_text <> 0 then
    raise exception 'FAIL: keep reported %', row_to_json(r);
  end if;
  if (select state from public.pilot_enrollments where id = '00000000-0000-0000-0000-000000263e0b') <> 'withdrawn' then
    raise exception 'FAIL: keep did not withdraw the enrollment — keep is not permission to carry on';
  end if;
  if public.pilot_collection_open('00000000-0000-0000-0000-000000263b01') then
    raise exception 'FAIL: keep left collection open';
  end if;
  if (select research_analysis from public.consent_records
       where participant_id = '00000000-0000-0000-0000-000000263b01'
       order by granted_at desc limit 1) then
    raise exception 'FAIL: keep left research analysis consented';
  end if;
  if (select raw_text_ciphertext from public.entries where id = '00000000-0000-0000-0000-000000263f0b') is null then
    raise exception 'FAIL: keep deleted the text';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 5. A second withdrawal: the first time stands, a later delete still deletes
-- ---------------------------------------------------------------------------

/*
 * Someone who chose "keep" may change their mind. Calling again with delete
 * must purge. It must not move `withdrawn_at`, because that timestamp is
 * the baseline for "zero research writes after withdrawal" (#168).
 */
do $$
declare
  first_at timestamptz;
  r record;
begin
  -- Back-dated, because now() is fixed for the whole of this transaction and
  -- a second call would otherwise write the same timestamp either way.
  update public.pilot_enrollments set withdrawn_at = now() - interval '1 hour'
   where id = '00000000-0000-0000-0000-000000263e0b'
  returning withdrawn_at into first_at;

  select * into r from public.withdraw_from_research(
    '00000000-0000-0000-0000-000000263b00', '00000000-0000-0000-0000-000000263b01',
    -- Anything but the exact string "keep" deletes.
    'KEEP', 'participant', 'student_ui', null, 'research-consent-v1', 'doc-v1');

  if r.enrollments_withdrawn <> 0 then
    raise exception 'FAIL: an already-withdrawn enrollment was withdrawn again';
  end if;
  if (select withdrawn_at from public.pilot_enrollments where id = '00000000-0000-0000-0000-000000263e0b') <> first_at then
    raise exception 'FAIL: a second withdrawal moved withdrawn_at';
  end if;
  if r.disposition <> 'delete' or r.purged_raw_text <> 1 then
    raise exception 'FAIL: a misspelled keep did not delete: %', row_to_json(r);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 6. The procedure is service_role only
-- ---------------------------------------------------------------------------

do $$
begin
  if has_function_privilege('authenticated',
       'public.withdraw_from_research(uuid, uuid, text, text, text, text, text, text)', 'execute')
     or has_function_privilege('anon',
       'public.withdraw_from_research(uuid, uuid, text, text, text, text, text, text)', 'execute') then
    raise exception 'FAIL: withdraw_from_research is callable from the browser';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 7. A participant cannot write their own consent record
-- ---------------------------------------------------------------------------

/*
 * `consent_records_own_all` let a signed-in student insert a row reading
 * research_analysis + minor_assent + guardian_consent = true straight through
 * PostgREST. That is the guardian's half, which #164 made writable only by
 * `/api/pilot/guardian/confirm`. They could also flip a revocation back to
 * active.
 */
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-000000263c00", "role": "authenticated"}';

do $$
begin
  if (select count(*) from public.consent_records) <> 1 then
    raise exception 'FAIL: a participant can no longer read their own consent record';
  end if;

  begin
    insert into public.consent_records (owner_user_id, participant_id, research_analysis, minor_assent, guardian_consent)
    values ('00000000-0000-0000-0000-000000263c00', '00000000-0000-0000-0000-000000263c01', true, true, true);
    raise exception 'FAIL: a participant forged their own guardian consent';
  exception when insufficient_privilege then null;
  end;

  begin
    update public.consent_records set guardian_consent = true;
    raise exception 'FAIL: a participant rewrote their consent record';
  exception when insufficient_privilege then null;
  end;

  begin
    delete from public.consent_records;
    raise exception 'FAIL: a participant deleted their consent history';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;

rollback;
