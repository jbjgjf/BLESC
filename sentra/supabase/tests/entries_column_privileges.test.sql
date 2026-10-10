-- A participant's client cannot write the raw-text columns of `entries` (#166, #378).
--
-- Run against a local Supabase database with all migrations applied:
--   supabase db reset   (from sentra/)
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/entries_column_privileges.test.sql
--
-- Read-only: it asks the catalog what `authenticated` may do and changes nothing.
--
-- The claim is the reason 20260906000100 and 20260907000000 exist: raw text
-- reaches the database only through the server, which encrypts it and sets the
-- expiry. The other scripts here test which *rows* a role can see; none of them
-- looks at column privileges, and a later migration that touches `entries` can
-- hand them back with one `grant`. This used to be step 5 of
-- scripts/migration_smoke.sh, which no CI job ran.

begin;

do $$
declare
  col text;
  leaked text[] := '{}';
begin
  foreach col in array array[
    'raw_text', 'raw_text_ciphertext', 'raw_text_key_version', 'raw_text_expires_at'
  ] loop
    -- A column dropped or renamed would make has_column_privilege raise, which
    -- is the right outcome: this list has to be updated by hand.
    if has_column_privilege('authenticated', 'public.entries', col, 'INSERT')
       or has_column_privilege('authenticated', 'public.entries', col, 'UPDATE') then
      leaked := leaked || col;
    end if;
  end loop;

  if array_length(leaked, 1) is not null then
    raise exception 'FAIL: authenticated may write raw-text columns of entries: %',
      array_to_string(leaked, ', ');
  end if;
end;
$$;

-- The columns the app does need are still writable, or the check above passes
-- because nothing works.
do $$
begin
  if not has_column_privilege('authenticated', 'public.entries', 'extraction_json', 'INSERT') then
    raise exception 'FAIL: authenticated lost INSERT on entries.extraction_json';
  end if;
end;
$$;

rollback;
