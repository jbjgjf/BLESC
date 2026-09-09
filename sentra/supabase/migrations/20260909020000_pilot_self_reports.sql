-- The fixed self-report block collected with every pilot journal entry
-- (issue #165, epic #161).
--
-- ===========================================================================
-- This migration is additive. It creates one table and alters nothing that
-- exists, so it applies while the current version is serving, before the code
-- that writes to it ships.
-- ===========================================================================
--
-- Why a table and not a jsonb column on `entries`:
--
--   1. The scale has to be enforceable. `mood` is 0-10 and nothing else; as a
--      key inside a jsonb blob that is a convention the writer is trusted to
--      keep, and as a column it is a CHECK constraint. The pilot's only
--      quantitative series is not left to the honesty of whatever writes it.
--
--   2. A skip is null and must stay distinguishable from a zero. A column that
--      is `smallint null` says that in the type. A jsonb key that is sometimes
--      absent, sometimes `null` and sometimes `0` does not.
--
--   3. The instrument is versioned. `schema_version` is on the row, so an
--      analysis reading two weeks of data can tell whether it is reading one
--      instrument or two. Changing an item's range or the item set means a new
--      version and a new migration — which is the point: a scale that can drift
--      without a migration will drift.
--
-- One row per entry. The unique index on (owner_user_id, entry_id) is what
-- makes a retried submission update the reading rather than store a second one
-- (#132), the same rule `followup_responses` follows.
--
-- No free text. Every column here is a number, an id or a version string, so
-- this table can be read by an operator counting missing answers without any
-- exposure to what a participant wrote.

create table if not exists public.pilot_self_reports (
  id uuid primary key default gen_random_uuid(),

  owner_user_id uuid not null references auth.users(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,

  -- The submission this reading belongs to. `entry_id` is what ties the numbers
  -- to the text they were given alongside: the acceptance criterion for #165 is
  -- that the scale version and the body sit on the same entry, and this column
  -- is that tie.
  entry_id uuid not null references public.entries(id) on delete cascade,
  entry_session_id uuid references public.entry_sessions(id) on delete set null,
  -- Carried for the same reason `entries` carries it: two requests for one
  -- submission resolve to one row.
  client_submission_id text,

  -- `pilot-selfreport-v1`. See src/lib/pilotSelfReport.ts, which is the source
  -- of the item set, and docs/pilot/data-dictionary.json, which is the protocol
  -- it implements.
  schema_version text not null,

  -- The five settled items, in presentation order. All nullable: every item is
  -- optional and an unanswered item is null, never 0 and never the midpoint.
  --
  -- `support_contact` from the data dictionary is deliberately absent. It is
  -- marked DECISION REQUIRED there — asking whether a student talked to someone
  -- is itself a prompt to talk to someone — and adding it is a protocol
  -- decision by the ethics lead followed by a new schema version, not a column
  -- someone adds because the dictionary mentions it.
  mood smallint,
  stress smallint,
  sleep_quality smallint,
  sleep_hours numeric(4, 2),
  event_intensity smallint,

  -- What the client sent that could not be stored, as {item_id: reason}. Reasons
  -- only, never the offending value — a value could be free text.
  --
  -- Without this, a client that starts sending 11 for mood is indistinguishable
  -- from a cohort that stopped answering, because both arrive as nulls.
  rejected_json jsonb not null default '{}'::jsonb,

  answered_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- The scale, as constraints rather than as documentation. An out-of-range
  -- value is refused at the database, so the only way one appears in the
  -- research record is a migration that deliberately widens the scale.
  constraint pilot_self_reports_mood_check
    check (mood is null or (mood between 0 and 10)),
  constraint pilot_self_reports_stress_check
    check (stress is null or (stress between 0 and 10)),
  constraint pilot_self_reports_sleep_quality_check
    check (sleep_quality is null or (sleep_quality between 0 and 10)),
  constraint pilot_self_reports_event_intensity_check
    check (event_intensity is null or (event_intensity between 0 and 10)),
  -- 0-16 hours in half-hour steps. `* 2 = floor(* 2)` is the step check; a
  -- numeric(4,2) column would otherwise accept 7.23.
  constraint pilot_self_reports_sleep_hours_check
    check (
      sleep_hours is null
      or (sleep_hours >= 0 and sleep_hours <= 16 and sleep_hours * 2 = floor(sleep_hours * 2))
    ),

  -- The row belongs to the same owner as the entry it annotates. Without this
  -- pair of composite foreign keys a service-role write could attach a reading
  -- to another participant's entry.
  constraint pilot_self_reports_participant_owner_fk
    foreign key (participant_id, owner_user_id)
    references public.participants(id, owner_user_id)
    on delete cascade,
  constraint pilot_self_reports_entry_owner_fk
    foreign key (entry_id, owner_user_id)
    references public.entries(id, owner_user_id)
    on delete cascade,
  -- Column-specific SET NULL, and it has to be.
  --
  -- A plain `on delete set null` on a composite key nulls *every* column in it,
  -- `owner_user_id` included — and that column is NOT NULL, so deleting a
  -- session would fail on this row instead of detaching it. Naming the column
  -- (PostgreSQL 15+) clears the session reference and leaves the ownership
  -- intact, which is what the cascade was meant to do.
  constraint pilot_self_reports_session_owner_fk
    foreign key (entry_session_id, owner_user_id)
    references public.entry_sessions(id, owner_user_id)
    on delete set null (entry_session_id)
);

-- One reading per entry. A retry updates it; it does not add a second.
create unique index if not exists pilot_self_reports_entry_idx
  on public.pilot_self_reports(owner_user_id, entry_id);

-- The export reads by participant and time.
create index if not exists pilot_self_reports_participant_idx
  on public.pilot_self_reports(participant_id, answered_at desc);

-- The dashboard counts by instrument version, to catch a mixed-version cohort.
create index if not exists pilot_self_reports_schema_idx
  on public.pilot_self_reports(schema_version);

create or replace function public.stamp_pilot_self_report_update()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists pilot_self_reports_touch on public.pilot_self_reports;
create trigger pilot_self_reports_touch
before update on public.pilot_self_reports
for each row execute function public.stamp_pilot_self_report_update();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.pilot_self_reports enable row level security;

-- A participant may read back what they answered. They may not write it.
--
-- Every insert goes through the submission route under the service role, in
-- the same transaction-shaped unit as the entry it belongs to. A participant
-- with INSERT here could add readings for days they did not write on, which is
-- the one thing a self-report series cannot survive.
drop policy if exists "pilot_self_reports_select_own" on public.pilot_self_reports;
create policy "pilot_self_reports_select_own" on public.pilot_self_reports
for select to authenticated
using ((select auth.uid()) = owner_user_id);

grant select on public.pilot_self_reports to authenticated;

-- The research role reads it for the pseudonymised export (#167) and writes
-- nothing.
grant select on public.pilot_self_reports to research_reader;

-- ---------------------------------------------------------------------------
-- Rollback
-- ---------------------------------------------------------------------------
--
-- Additive, so undoing it is dropping it. Kept next to what it undoes.
--
--   drop trigger if exists pilot_self_reports_touch on public.pilot_self_reports;
--   drop function if exists public.stamp_pilot_self_report_update();
--   drop table if exists public.pilot_self_reports;
