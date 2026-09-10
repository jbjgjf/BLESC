-- Make the `research_reader` grants mean something (#167).
--
-- ===========================================================================
-- Additive. Policies only — no table, column, or grant is changed, and no row
-- is rewritten.
-- ===========================================================================
--
-- ## The finding
--
-- Seven tables grant SELECT to `research_reader`:
--
--   research_exports              20260906000000
--   entries                       20260906000100
--   pilot_studies, pilot_enrollments   20260906010000
--   pilot_guardian_verifications  20260908000000 / 20260909000000
--   pilot_self_reports            20260909020000
--   pilot_pii_reviews             20260909030000
--
-- **Not one of them has a policy admitting the role, and every one has RLS
-- enabled.** `research_reader` is `NOLOGIN` and carries no `BYPASSRLS`, so a
-- grant without a policy reads back zero rows. Verified against PostgreSQL 16:
-- with the grant and no policy, `set role research_reader; select ...` returns
-- an empty result on a table holding rows.
--
-- Nothing has broken because nothing uses the role: every export route runs
-- under the service-role key, which bypasses RLS entirely. The grants have
-- therefore been expressing an intention rather than an access, and the first
-- person to rely on them — a researcher handed a `research_reader` login for
-- direct SQL, which is what 20260906000000 says the role is for — would have
-- found an empty database and no error to explain it.
--
-- ## What this does
--
-- Adds the missing `for select to research_reader using (true)` policy to the
-- tables whose contents are the research record itself. `using (true)` and not
-- a scoped predicate: RLS on these tables exists to keep participants inside
-- their own rows, and a research role that could see only rows it owned would
-- see nothing at all. What narrows `research_reader` is the column-level
-- grants, which already say exactly what it may read — no `owner_user_id`, no
-- `token_hash`.
--
-- ## What this deliberately does NOT do
--
-- **`public.entries` is left alone, and that is a decision for a person.**
--
-- Its grant (20260906000100) is table-wide, not column-level, so a policy here
-- would hand `research_reader` every row of the table including
-- `raw_text_ciphertext` — the encrypted journal text of children. That may
-- well be the intent: the role's own comment says "It reads the raw-text
-- columns and nothing else does". But it is a real expansion of who can reach
-- minors' diary text, from "nobody, because the policy is missing" to "any
-- account granted this role", and it should be turned on deliberately by the
-- person who owns the export process, not folded into a migration fixing a
-- privilege bug.
--
-- The narrower fix available, if that decision goes the other way, is to
-- replace the table-wide grant with a column-level one and admit the role to
-- the columns a human evaluation actually needs.

do $$
declare
  target text;
begin
  foreach target in array array[
    'research_exports',
    'pilot_studies',
    'pilot_enrollments',
    'pilot_guardian_verifications',
    'pilot_self_reports',
    'pilot_pii_reviews'
  ]
  loop
    -- Skip a table this deployment has not reached yet. The pilot migrations
    -- have moved timestamps once already to avoid colliding with main, and a
    -- migration that fails on a table that arrives two files later is a worse
    -- outcome than one that no-ops and is re-run.
    if to_regclass('public.' || target) is null then
      raise notice 'skipping %: table not present', target;
      continue;
    end if;

    execute format(
      'drop policy if exists %I on public.%I',
      target || '_research_read',
      target
    );
    execute format(
      'create policy %I on public.%I for select to research_reader using (true)',
      target || '_research_read',
      target
    );
  end loop;
end;
$$;
