-- RLS and privilege tests for the pilot launch gate (issues #131 #132 #133 #134).
--
-- Run against a local Supabase database with all migrations applied:
--   supabase db reset   (from sentra/, applies migrations)
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/pilot_consent_rls.test.sql
--
-- The whole script runs in one transaction and rolls back: it leaves no data.
-- Every assertion raises an exception (failing the script) when violated.

begin;

-- ---------------------------------------------------------------------------
-- Fixtures: two students, one entry each, one with retained (encrypted) text.
-- ---------------------------------------------------------------------------

insert into auth.users (id, email)
values
  ('00000000-0000-0000-0000-0000000000c1', 'consent-a@test.local'),
  ('00000000-0000-0000-0000-0000000000c2', 'consent-b@test.local');

insert into public.participants (id, owner_user_id, code)
values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c1', 'CONSENT_A'),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000c2', 'CONSENT_B');

insert into public.entries (id, owner_user_id, participant_id, raw_text_ciphertext, raw_text_key_version, raw_text_expires_at, client_submission_id)
values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000c1',
   '00000000-0000-0000-0000-0000000000d1', 'BASE64-CIPHERTEXT-A', 'raw-text-aesgcm-v1',
   now() + interval '180 days', 'submission-a-1');

-- ---------------------------------------------------------------------------
-- #134: consent defaults to nothing.
-- ---------------------------------------------------------------------------

do $$
declare
  research boolean;
  app boolean;
  assent boolean;
  guardian boolean;
begin
  insert into public.consent_records (owner_user_id, participant_id)
  values ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000d2');

  select research_analysis, app_use, minor_assent, guardian_consent
    into research, app, assent, guardian
    from public.consent_records
   where participant_id = '00000000-0000-0000-0000-0000000000d2';

  if research then
    raise exception 'research_analysis defaulted to true; an unasked participant would be recorded as consenting';
  end if;
  if app then
    raise exception 'app_use defaulted to true';
  end if;
  if assent or guardian then
    raise exception 'assent/guardian consent defaulted to true';
  end if;
end;
$$;

-- A revoked row must carry its revocation timestamp, and the trigger fills it
-- in so a caller cannot record a revocation that looks like it never happened.
do $$
declare
  stamped timestamptz;
begin
  insert into public.consent_records
    (id, owner_user_id, participant_id, app_use, research_analysis, minor_assent, guardian_consent)
  values
    ('00000000-0000-0000-0000-0000000000e9', '00000000-0000-0000-0000-0000000000c1',
     '00000000-0000-0000-0000-0000000000d1', true, true, true, true);

  update public.consent_records set status = 'revoked'
   where id = '00000000-0000-0000-0000-0000000000e9';

  select revoked_at into stamped from public.consent_records
   where id = '00000000-0000-0000-0000-0000000000e9';
  if stamped is null then
    raise exception 'revoking did not stamp revoked_at';
  end if;
end;
$$;

do $$
begin
  begin
    insert into public.consent_records
      (owner_user_id, participant_id, status, revoked_at)
    values
      ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1', 'active', now());
    raise exception 'an active consent row was allowed to carry a revocation timestamp';
  exception when check_violation then
    null;
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- #132: one submission id, one entry.
-- ---------------------------------------------------------------------------

do $$
begin
  begin
    insert into public.entries (owner_user_id, participant_id, client_submission_id)
    values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1', 'submission-a-1');
    raise exception 'a retried submission created a second entry';
  exception when unique_violation then
    null;
  end;

  -- Two entries without a submission id are still allowed: the partial index
  -- must not collapse every legacy row into one.
  insert into public.entries (owner_user_id, participant_id)
  values
    ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1'),
    ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1');
end;
$$;

-- ---------------------------------------------------------------------------
-- #131: the student's own read path cannot reach retained text.
-- ---------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000c1", "role": "authenticated"}';

do $$
declare
  visible integer;
begin
  -- The columns the app actually reads still work.
  select count(*) into visible
    from public.entries
   where id = '00000000-0000-0000-0000-0000000000f1';
  if visible <> 1 then
    raise exception 'the owner can no longer read their own entry at all';
  end if;
end;
$$;

do $$
begin
  begin
    perform raw_text_ciphertext from public.entries
     where id = '00000000-0000-0000-0000-0000000000f1';
    raise exception 'a student could select the retained ciphertext of their own entry';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;

do $$
begin
  begin
    perform raw_text from public.entries
     where id = '00000000-0000-0000-0000-0000000000f1';
    raise exception 'a student could select raw_text';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- #133: follow-up answers belong to their owner, and one probe stores once.
-- ---------------------------------------------------------------------------

insert into public.followup_responses
  (owner_user_id, participant_id, entry_id, probe_id, probe_index, question_text, answer_kind, answer_text, outcome)
values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1',
   '00000000-0000-0000-0000-0000000000f1', 'topic', 0, '特に気になった出来事はありましたか。', 'choice', '部活動', 'answered');

do $$
begin
  begin
    insert into public.followup_responses
      (owner_user_id, participant_id, entry_id, probe_id, probe_index, question_text, answer_kind, outcome)
    values
      ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1',
       '00000000-0000-0000-0000-0000000000f1', 'topic', 0, '特に気になった出来事はありましたか。', 'choice', 'answered');
    raise exception 'a resent follow-up answer stored a second row';
  exception when unique_violation then
    null;
  end;
end;
$$;

set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000c2", "role": "authenticated"}';

do $$
declare
  leaked integer;
begin
  select count(*) into leaked from public.followup_responses;
  if leaked <> 0 then
    raise exception 'another student could read % follow-up answers', leaked;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Retention: the purge job clears expired text and leaves live text alone.
-- ---------------------------------------------------------------------------

reset role;

do $$
declare
  purged integer;
  remaining text;
begin
  update public.entries
     set raw_text_expires_at = now() - interval '1 day'
   where id = '00000000-0000-0000-0000-0000000000f1';

  select public.purge_expired_raw_text() into purged;
  if purged <> 1 then
    raise exception 'purge_expired_raw_text cleared % rows, expected 1', purged;
  end if;

  select raw_text_ciphertext into remaining from public.entries
   where id = '00000000-0000-0000-0000-0000000000f1';
  if remaining is not null then
    raise exception 'expired raw text survived the purge';
  end if;
end;
$$;

do $$
declare
  purged integer;
begin
  update public.entries
     set raw_text_ciphertext = 'BASE64-CIPHERTEXT-B',
         raw_text_key_version = 'raw-text-aesgcm-v1',
         raw_text_expires_at = now() + interval '30 days'
   where id = '00000000-0000-0000-0000-0000000000f1';

  select public.purge_expired_raw_text() into purged;
  if purged <> 0 then
    raise exception 'purge_expired_raw_text cleared text that had not expired';
  end if;

  -- Revocation deletes it regardless of the expiry.
  select public.purge_raw_text_for_participant('00000000-0000-0000-0000-0000000000d1') into purged;
  if purged <> 1 then
    raise exception 'revocation purge cleared % rows, expected 1', purged;
  end if;
end;
$$;

rollback;
