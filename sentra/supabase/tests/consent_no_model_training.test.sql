-- consent_records cannot hold model_training_use = true (#469).
--
-- Run against a local Supabase database with all migrations applied:
--   supabase db reset   (from sentra/, applies migrations)
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/consent_no_model_training.test.sql
--
-- The whole script runs in one transaction and rolls back: it leaves no data.

begin;

insert into auth.users (id, email)
values ('00000000-0000-0000-0000-0000000469a1', 'no-training@test.local');

insert into public.participants (id, owner_user_id, code)
values ('00000000-0000-0000-0000-0000000469b1', '00000000-0000-0000-0000-0000000469a1', 'NO_TRAINING');

-- A grant of everything else is still accepted.
insert into public.consent_records
  (owner_user_id, participant_id, app_use, research_analysis, anonymized_export, raw_text_retention, model_training_use, minor_assent, guardian_consent)
values
  ('00000000-0000-0000-0000-0000000469a1', '00000000-0000-0000-0000-0000000469b1', true, true, true, true, false, true, true);

-- A training grant is refused, however it arrives.
do $$
begin
  begin
    insert into public.consent_records (owner_user_id, participant_id, model_training_use)
    values ('00000000-0000-0000-0000-0000000469a1', '00000000-0000-0000-0000-0000000469b1', true);
    raise exception 'consent_records accepted model_training_use = true';
  exception when check_violation then
    null;
  end;
end;
$$;

rollback;
