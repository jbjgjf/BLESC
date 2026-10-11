-- A guardian's per-item answer is stored whole, or not at all (#316).
--
-- Run against a local Supabase database with all migrations applied:
--   supabase db reset   (from sentra/)
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/guardian_itemized_grants.test.sql
--
-- Runs in one transaction and rolls back.
--
-- 20261010000000 adds `pilot_guardian_verifications.guardian_grants`. The
-- effective consent (participant ∩ guardian) is derived from it, so a value
-- with an item missing would be read as that item having been answered. These
-- check that the database refuses such a value, that an item turned OFF is
-- kept as a value, and that the new column is as closed as the table.

begin;

insert into auth.users (id, email)
values ('00000000-0000-0000-0000-000000031601', 'guardian-grants@test.local');

insert into public.participants (id, owner_user_id, code)
values ('00000000-0000-0000-0000-000000031602', '00000000-0000-0000-0000-000000031601', 'GRANTS_A');

insert into public.pilot_studies (id, slug, title, status)
values ('00000000-0000-0000-0000-000000031603', 'guardian-grants-test', 'Guardian grants', 'recruiting');

insert into public.pilot_enrollments (id, study_id, owner_user_id, participant_id, research_code, state, is_minor)
values ('00000000-0000-0000-0000-000000031604', '00000000-0000-0000-0000-000000031603',
        '00000000-0000-0000-0000-000000031601', '00000000-0000-0000-0000-000000031602',
        'P-GRANT1', 'participant_assented', true);

-- An issued, answered verification with the given guardian_grants. Returns
-- whether the database accepted it.
create function pg_temp.accepts(grants jsonb, decided boolean default true) returns boolean
language plpgsql as $$
begin
  insert into public.pilot_guardian_verifications
    (enrollment_id, owner_user_id, token_hash, token_prefix, expires_at, issued_at,
     decision, decided_at, guardian_grants)
  values
    ('00000000-0000-0000-0000-000000031604', '00000000-0000-0000-0000-000000031601',
     'hash-' || gen_random_uuid(), 'abcdef', now() + interval '72 hours', now(),
     case when decided then 'declined' end, case when decided then now() end, grants);
  return true;
exception when check_violation then
  return false;
end;
$$;

do $$
declare
  whole constant jsonb := '{"app_use": true, "research_analysis": true, "raw_text_retention": false, "document_version": "research-consent-doc-v1"}';
  stored jsonb;
begin
  -- A complete answer is kept, including the item that was turned off.
  if not pg_temp.accepts(whole) then
    raise exception 'FAIL: a complete guardian answer was refused';
  end if;
  select guardian_grants into stored from public.pilot_guardian_verifications
   where guardian_grants is not null limit 1;
  if stored -> 'raw_text_retention' is distinct from 'false'::jsonb then
    raise exception 'FAIL: an item turned off was not stored as false: %', stored;
  end if;

  -- Everything off is an answer too.
  if not pg_temp.accepts('{"app_use": false, "research_analysis": false, "raw_text_retention": false, "document_version": "v"}') then
    raise exception 'FAIL: an all-off answer was refused';
  end if;

  -- The bulk confirmations from before this column have none.
  if not pg_temp.accepts(null) then
    raise exception 'FAIL: a row without guardian_grants was refused';
  end if;

  if pg_temp.accepts(whole - 'raw_text_retention') then
    raise exception 'FAIL: an answer with an item missing was stored';
  end if;
  if pg_temp.accepts(whole - 'app_use') then
    raise exception 'FAIL: an answer without app_use was stored';
  end if;
  if pg_temp.accepts(jsonb_set(whole, '{research_analysis}', '"yes"')) then
    raise exception 'FAIL: a non-boolean item was stored';
  end if;
  if pg_temp.accepts(jsonb_set(whole, '{research_analysis}', 'null')) then
    raise exception 'FAIL: a null item was stored';
  end if;
  if pg_temp.accepts(whole - 'document_version') then
    raise exception 'FAIL: an answer with no document version was stored';
  end if;
  if pg_temp.accepts(jsonb_set(whole, '{document_version}', '""')) then
    raise exception 'FAIL: an answer with an empty document version was stored';
  end if;
  if pg_temp.accepts('[true, true, false]') then
    raise exception 'FAIL: a non-object was stored';
  end if;

  -- A guardian's choices cannot exist on a row nobody has answered.
  if pg_temp.accepts(whole, decided => false) then
    raise exception 'FAIL: guardian_grants was stored on an undecided verification';
  end if;
end;
$$;

-- The column is as closed as the table: service_role only.
do $$
declare
  role_name text;
begin
  foreach role_name in array array['anon', 'authenticated'] loop
    if has_column_privilege(role_name, 'public.pilot_guardian_verifications', 'guardian_grants', 'SELECT')
       or has_column_privilege(role_name, 'public.pilot_guardian_verifications', 'guardian_grants', 'UPDATE')
       or has_column_privilege(role_name, 'public.pilot_guardian_verifications', 'guardian_grants', 'INSERT') then
      raise exception 'FAIL: % holds a privilege on guardian_grants', role_name;
    end if;
  end loop;
  if not has_column_privilege('service_role', 'public.pilot_guardian_verifications', 'guardian_grants', 'UPDATE') then
    raise exception 'FAIL: service_role cannot record a guardian''s answer';
  end if;
end;
$$;

rollback;
