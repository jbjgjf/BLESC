-- Step 4 of the pilot launch gate rollout: close the raw-text columns for WRITES.
--
-- ===========================================================================
-- APPLY AFTER 20260906000100. Additive to it; safe with the current app.
--
--   1. 20260906000000        — additive columns
--   2. deploy the app
--   3. 20260906000100        — revoke table-wide SELECT, grant back by column
--   4. this migration        — revoke table-wide INSERT/UPDATE, same treatment
-- ===========================================================================
--
-- The gap this closes (#166). 20260906000100 stopped `authenticated` from
-- *reading* the raw-text columns, and the read side was the one everybody
-- looked at. The write side was left as the initial migration wrote it:
--
--   grant select, insert, update, delete on public.entries to authenticated;
--
-- combined with `entries_update_own`, which lets a participant update their own
-- rows. A signed-in participant could therefore, with the anon key and no
-- application involvement:
--
--   * overwrite `raw_text_ciphertext` with arbitrary bytes, which the research
--     reader would later try to decrypt — a write path into a column the
--     reader trusts to have come from the server's own AES-GCM sealing;
--   * set `raw_text_key_version` to a version that never sealed that row,
--     making the ciphertext undecryptable and the failure look like key
--     mismatch rather than tampering;
--   * push `raw_text_expires_at` far into the future, so
--     `purge_expired_raw_text()` never reaches the row and the retention
--     promise in the consent document quietly stops holding;
--   * write `raw_text` in the clear, into a column the whole design says never
--     holds plaintext.
--
-- None of these is reachable through the app: the browser only SELECTs from
-- `entries` (`api/client.ts`), and every write goes through
-- `lib/server/supabaseWriter.ts`, which holds the service-role key. The hole
-- was that nothing *stopped* a participant from doing it directly, and "the UI
-- does not offer it" is not an access control.
--
-- Same shape as the read fix: revoke table-wide, grant back column by column.
-- A column added to `entries` after this is unwritable by participants until
-- someone grants it explicitly — the intended failure mode, since a new column
-- that silently accepts participant writes is how this gap appeared in the
-- first place.

revoke insert, update on public.entries from authenticated;

-- Postgres allows an INSERT that does not mention a column the role lacks
-- privilege on, so the four raw-text columns simply cannot appear in a
-- participant's insert. The service role bypasses column privileges entirely
-- and keeps writing them.
grant insert (
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
  client_submission_id
) on public.entries to authenticated;

grant update (
  is_masked,
  extraction_json,
  provenance_hash,
  expires_at,
  updated_at,
  observation_type,
  extraction_provider,
  extraction_model
) on public.entries to authenticated;

-- DELETE stays whole. Deleting one's own entry is a participant right, and it
-- removes the retained ciphertext with the row rather than orphaning it.

-- `public.purge_raw_text_for_participant` is `security invoker` and updates the
-- raw-text columns, so it needs to run as a role that may write them. It is
-- called from the revocation route, which holds the service-role key; the
-- invoker semantics are deliberate (see 20260906000000) and unchanged here.
-- Making it `security definer` to work around the revoke above would hand every
-- signed-in user the ability to erase any participant's retained text by id,
-- which is exactly what that migration's comment refused.
