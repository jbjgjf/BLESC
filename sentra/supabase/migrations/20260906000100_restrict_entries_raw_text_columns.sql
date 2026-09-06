-- Step 3 of the pilot launch gate rollout: close the raw-text columns.
--
-- ===========================================================================
-- APPLY THIS ONLY AFTER THE NEW CODE IS LIVE.
--
--   1. 20260906000000        — additive; safe while the old code is serving
--   2. deploy the app
--   3. this migration        — safe only once (2) is done
--
-- It revokes table-wide SELECT on `public.entries` from `authenticated` and
-- grants it back column by column, minus the three raw-text columns. The
-- version of `api/client.ts` before this change selects `raw_text` explicitly,
-- so applying this while that version is still serving turns every entry read
-- into `permission denied for table entries`. The new client does not select
-- it.
--
-- Splitting it out is what makes a safe order possible at all: the columns in
-- step 1 are additive and the code in step 2 needs them, but this statement
-- breaks whatever is running until step 2 has landed.
-- ===========================================================================

-- Table-wide SELECT goes away and comes back column by column. Anything added
-- to `entries` after this migration has to be granted explicitly — which is
-- the intended failure mode: a new column is unreadable until someone decides
-- it should be readable, rather than exposed by default.
revoke select on public.entries from authenticated;
grant select (
  id,
  owner_user_id,
  participant_id,
  is_masked,
  extraction_json,
  provenance_hash,
  expires_at,
  created_at,
  updated_at,
  observation_type,
  extraction_provider,
  extraction_model,
  client_submission_id,
  raw_text_expires_at
) on public.entries to authenticated;

grant select on public.entries to research_reader;
