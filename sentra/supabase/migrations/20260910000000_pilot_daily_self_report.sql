-- The daily fixed self-report (#165).
--
-- ===========================================================================
-- Additive. One table. Nothing existing is altered.
-- ===========================================================================
--
-- The study measures how people write. That alone cannot say whether a change
-- in the writing corresponds to a change in the person, because the only
-- reading of the text available during the collection window is the text
-- itself — scoring a text-derived quantity against another text-derived
-- quantity answers a question about the extractor, not about the participant.
-- A small fixed self-report, asked identically every day, is the outside
-- measurement that makes the rest interpretable.
--
-- Three properties the protocol fixes and this table has to preserve:
--
--   1. **The items and their scales are pinned to a version.** `schema_id`
--      travels with every row. A scale that means 0-10 in week one and 1-7 in
--      week three produces a dataset nobody can pool, and the version is what
--      makes that visible rather than silent.
--
--   2. **A missing answer is missing, not zero.** Every item is optional, and
--      an unanswered one is stored with `observed: false` and no value —
--      never 0, never the midpoint. Storing a default would put a fabricated
--      reading into the research record, and the analysis has no way to tell
--      it from a real one.
--
--   3. **One self-report per submission.** It is part of the submission, not a
--      second thing that happens to arrive around the same time, so it hangs
--      off `entries.id` with a unique constraint and is written on the same
--      idempotent path as the entry (#132). A retry resolves to the same row.
--
-- The items themselves live in `docs/pilot/data-dictionary.json`
-- (`pilot-selfreport-v1`) and are mirrored, with the reasoning, in
-- `sentra/frontend/src/lib/selfReport.ts`. This migration deliberately does
-- not encode them: a CHECK constraint per item would put the protocol in two
-- places, and the one that is harder to change would win by accident.

create table if not exists public.entry_self_reports (
  id uuid primary key default gen_random_uuid(),

  entry_id uuid not null references public.entries(id) on delete cascade,
  -- The submission session the answers were given in, when telemetry is being
  -- collected (#135). Null for a submission made without it.
  entry_session_id uuid references public.entry_sessions(id) on delete set null,

  owner_user_id uuid not null references auth.users(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,

  -- Which set of items and scales these answers are on.
  schema_id text not null,

  -- `{ "<item_id>": { "value": <number|string|null>, "observed": <bool> } }`.
  -- Read by the export, which flattens it into one column per item. jsonb and
  -- not one row per item because the answers are given together, are read
  -- together, and adding an item to the protocol should not require a
  -- migration to record it.
  responses_json jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),

  -- Part of the submission, so exactly one per entry. A retry of the same
  -- submission finds the same entry and therefore the same self-report.
  unique (entry_id)
);

create index if not exists entry_self_reports_participant_idx
  on public.entry_self_reports(participant_id, created_at desc);

alter table public.entry_self_reports enable row level security;

-- The participant may read their own answers back — they gave them, and a
-- screen that shows yesterday's answer is a reasonable thing to build later.
-- They may not write them directly: the answers are validated against the
-- pinned schema on the server before storage, and a client that could insert
-- its own row could store an out-of-range value, a made-up item, or a
-- different `schema_id` than the one it was shown.
drop policy if exists "entry_self_reports_select_own" on public.entry_self_reports;
create policy "entry_self_reports_select_own" on public.entry_self_reports
  for select to authenticated
  using ((select auth.uid()) = owner_user_id);

grant select on public.entry_self_reports to authenticated;
grant select, insert, update on public.entry_self_reports to service_role;

-- The research role reads the answers and the schema they are on. Not
-- `owner_user_id`: the export identifies a participant by their research code,
-- and a column that maps back to a login has no business in the dataset.
grant select (id, entry_id, entry_session_id, participant_id, schema_id, responses_json, created_at)
  on public.entry_self_reports to research_reader;

-- The policy that makes the grant above mean something.
--
-- Worth stating plainly, because the same shape appears on `entries`,
-- `pilot_studies`, `pilot_enrollments` and `research_exports` and does *not*
-- have this: a column grant to a role with RLS enabled and no policy admitting
-- it reads back zero rows. `research_reader` is `NOLOGIN` and carries no
-- `BYPASSRLS`, so on those tables the grant currently expresses an intention
-- rather than an access. The export route does not notice because it runs under
-- the service-role key, which bypasses RLS entirely — which is also why the gap
-- has been invisible.
--
-- Here the role can read every row, and the column grant is what narrows it:
-- research data is not scoped to a participant's own session, and a research
-- account that could see only rows it owned would see nothing at all.
drop policy if exists "entry_self_reports_research_read" on public.entry_self_reports;
create policy "entry_self_reports_research_read" on public.entry_self_reports
  for select to research_reader
  using (true);
