-- Pilot launch gate: explicit research consent, durable submissions, follow-up
-- persistence and gated raw-text retention (issues #131 #132 #133 #134 #135).
--
-- Four things this migration establishes, in the order the write path needs
-- them:
--
--   1. Consent stops being a default. `consent_records` previously defaulted
--      `research_analysis` to TRUE, so a participant who never saw a consent
--      screen was recorded as having agreed to research use. The column
--      defaults flip to FALSE and the row gains the fields a consent record has
--      to carry to be worth anything in an audit: what document version was
--      shown, when it was granted, when it was revoked, and — for a minor —
--      whether the participant themselves assented and whether a guardian
--      consented, tracked separately.
--
--   2. A submission becomes idempotent. `entries.client_submission_id` plus a
--      unique index means a retried submission (a double-tapped button, a
--      retry after a failed write) resolves to the row that already exists
--      instead of a duplicate.
--
--   3. Raw journal text gets a place to live that is gated, encrypted,
--      expiring, and unreachable from the student and educator read paths.
--      Column-level privileges do that last part: `authenticated` loses table
--      -wide SELECT on `entries` and gets it back column by column, minus the
--      three raw-text columns. Only the `research_reader` role may read those.
--
--   4. Follow-up answers, submission-write failures, and research exports each
--      get a table, because all three are currently invisible: the answers live
--      in React state, the failures in a server log nobody reads, and the
--      exports nowhere at all.

-- ---------------------------------------------------------------------------
-- 1. Consent: fail-safe defaults, versioning, revocation, minor/guardian split
-- ---------------------------------------------------------------------------

alter table public.consent_records
  alter column app_use set default false,
  alter column research_analysis set default false;

alter table public.consent_records
  add column if not exists minor_assent boolean not null default false,
  add column if not exists guardian_consent boolean not null default false,
  add column if not exists raw_text_retention boolean not null default false,
  add column if not exists document_version text not null default 'research-consent-doc-v1',
  add column if not exists status text not null default 'active',
  add column if not exists granted_at timestamptz not null default now(),
  add column if not exists revoked_at timestamptz;

alter table public.consent_records
  drop constraint if exists consent_records_status_check;
alter table public.consent_records
  add constraint consent_records_status_check
  check (status in ('active', 'revoked'));

-- A revoked row must say when, and an active row must not claim it was.
alter table public.consent_records
  drop constraint if exists consent_records_revocation_check;
alter table public.consent_records
  add constraint consent_records_revocation_check
  check (
    (status = 'revoked' and revoked_at is not null)
    or (status = 'active' and revoked_at is null)
  );

-- The read path always wants the newest row for a participant.
create index if not exists consent_records_participant_recent_idx
  on public.consent_records(owner_user_id, participant_id, granted_at desc);

-- Revoking is an UPDATE, and the timestamp should not depend on the caller
-- remembering to set it.
create or replace function public.stamp_research_consent_revocation()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'revoked' and old.status is distinct from 'revoked' then
    new.revoked_at := coalesce(new.revoked_at, now());
  end if;
  return new;
end;
$$;

drop trigger if exists consent_records_stamp_revocation on public.consent_records;
create trigger consent_records_stamp_revocation
before update on public.consent_records
for each row execute function public.stamp_research_consent_revocation();

-- ---------------------------------------------------------------------------
-- 2. Idempotent submissions
-- ---------------------------------------------------------------------------

alter table public.entries
  add column if not exists client_submission_id text;

-- Partial: rows written before this migration (and any path that does not send
-- a submission id) are not forced into a single-null-row collision.
create unique index if not exists entries_owner_client_submission_idx
  on public.entries(owner_user_id, client_submission_id)
  where client_submission_id is not null;

-- ---------------------------------------------------------------------------
-- 3. Raw text: consented, encrypted, expiring, research-only
-- ---------------------------------------------------------------------------

alter table public.entries
  add column if not exists raw_text_ciphertext text,
  add column if not exists raw_text_key_version text,
  add column if not exists raw_text_expires_at timestamptz;

create index if not exists entries_raw_text_expiry_idx
  on public.entries(raw_text_expires_at)
  where raw_text_ciphertext is not null;

-- The research role. It reads the raw-text columns and nothing else does.
-- NOLOGIN: it is granted to the service account that runs exports, never
-- signed into directly.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'research_reader') then
    create role research_reader nologin;
  end if;
end;
$$;

grant usage on schema public to research_reader;

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

-- Retention. `raw_text_expires_at` was a column nothing enforced; this is the
-- job that enforces it. Scheduled by whatever runs cron for the deployment
-- (pg_cron, a Supabase scheduled function, or an external worker) — the
-- function is the contract, not the scheduler.
-- SECURITY INVOKER, not DEFINER.
--
-- The callers that need it — the service-role route handler and whatever runs
-- cron — already bypass RLS, so definer rights buy nothing; what they would buy
-- is a function that ignores RLS for *whoever* can reach it. As an invoker
-- function, a caller who should not have been able to reach it at all is still
-- confined by `entries_update_own` to their own rows.
--
-- `pg_temp` is named explicitly and last. Left out of a search_path it is
-- searched FIRST, which lets a caller shadow `public.entries` with a temp table.
create or replace function public.purge_expired_raw_text()
returns integer
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  purged integer;
begin
  update public.entries
     set raw_text = null,
         raw_text_ciphertext = null,
         raw_text_key_version = null,
         raw_text_expires_at = null
   where raw_text_ciphertext is not null
     and raw_text_expires_at is not null
     and raw_text_expires_at <= now();
  get diagnostics purged = row_count;
  return purged;
end;
$$;

-- Revoking from PUBLIC is NOT enough on Supabase.
--
-- `alter default privileges in schema public grant all on functions to
-- postgres, anon, authenticated, service_role` is part of a stock project, so
-- every new function in `public` is created with EXPLICIT grants to `anon` and
-- `authenticated`. `revoke ... from public` does not touch an explicit grant,
-- and the function stays callable over PostgREST RPC by anyone holding the
-- anon key. Each role has to be named — which is why every other privileged
-- function in this schema revokes from `anon` separately (see
-- 20260715090000_educator_oversight_foundations.sql:139).
revoke execute on function public.purge_expired_raw_text() from public, anon, authenticated;
grant execute on function public.purge_expired_raw_text() to service_role;

-- Revocation. Deleting the stored text is the point of revoking, so it is one
-- call and not an application-level loop that can be interrupted half way.
-- Same reasoning as above, and it matters more here: this one takes the
-- participant to erase straight from its caller. As a definer function reachable
-- by `authenticated`, it would let any signed-in user destroy any participant's
-- retained journal text by id — and participant ids are visible to educator
-- accounts through `overseen_participants()`. As an invoker function it is
-- confined by `entries_update_own` to the caller's own rows even if the grants
-- below are ever loosened, and the route that legitimately calls it holds the
-- service-role key, which bypasses RLS on its own.
create or replace function public.purge_raw_text_for_participant(target_participant uuid)
returns integer
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  purged integer;
begin
  update public.entries
     set raw_text = null,
         raw_text_ciphertext = null,
         raw_text_key_version = null,
         raw_text_expires_at = null
   where participant_id = target_participant
     and raw_text_ciphertext is not null;
  get diagnostics purged = row_count;
  return purged;
end;
$$;

revoke execute on function public.purge_raw_text_for_participant(uuid) from public, anon, authenticated;
grant execute on function public.purge_raw_text_for_participant(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 4a. Follow-up answers (#133)
-- ---------------------------------------------------------------------------

create table if not exists public.followup_responses (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  entry_id uuid references public.entries(id) on delete cascade,
  entry_session_id uuid references public.entry_sessions(id) on delete set null,
  -- Which question was asked, and which wording of it. `probe_id` is the step
  -- id from the client script; `probe_version` is the script version, so an
  -- answer stays interpretable after the wording changes.
  probe_id text not null,
  probe_version text not null default 'followup-script-v1',
  probe_index integer not null default 0,
  question_text text not null,
  -- 'choice' | 'free_text' — how the answer was given, not what it says.
  answer_kind text not null default 'choice',
  answer_text text,
  -- 'answered' | 'declined' | 'stopped' | 'abandoned'. A student who closes the
  -- panel is 'abandoned' for the unanswered probe: distinguishable from one who
  -- picked "答えたくない" ('declined'), which is an answer.
  outcome text not null default 'answered',
  answered_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint followup_responses_outcome_check
    check (outcome in ('answered', 'declined', 'stopped', 'abandoned')),
  constraint followup_responses_kind_check
    check (answer_kind in ('choice', 'free_text', 'none')),
  constraint followup_responses_participant_owner_fk
    foreign key (participant_id, owner_user_id)
    references public.participants(id, owner_user_id)
    on delete cascade,
  constraint followup_responses_entry_owner_fk
    foreign key (entry_id, owner_user_id)
    references public.entries(id, owner_user_id)
    on delete cascade,
  constraint followup_responses_session_owner_fk
    foreign key (entry_session_id, owner_user_id)
    references public.entry_sessions(id, owner_user_id)
    on delete set null
);

-- Re-sending the same answer (a retried request) must not double the row.
create unique index if not exists followup_responses_unique_probe_idx
  on public.followup_responses(owner_user_id, entry_id, probe_id)
  where entry_id is not null;

create index if not exists followup_responses_participant_idx
  on public.followup_responses(owner_user_id, participant_id, answered_at desc);

alter table public.followup_responses enable row level security;

drop policy if exists "followup_responses_own_all" on public.followup_responses;
create policy "followup_responses_own_all" on public.followup_responses
for all to authenticated
using ((select auth.uid()) = owner_user_id)
with check ((select auth.uid()) = owner_user_id);

grant select, insert, update, delete on public.followup_responses to authenticated;

-- ---------------------------------------------------------------------------
-- 4b. Submission write failures (#132)
-- ---------------------------------------------------------------------------
--
-- A failed write leaves nothing behind by definition, so the failure is
-- recorded here instead: enough to count them and to tell a student "your
-- entry did not save" apart from "the student did not write one".
--
-- No entry content. A row here means a submission was lost, not what it said.

create table if not exists public.submission_failures (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid references auth.users(id) on delete set null,
  participant_id uuid references public.participants(id) on delete set null,
  client_submission_id text,
  -- 'failed' | 'skipped' | 'partial' — mirrors SupabaseSyncResult.status, with
  -- 'partial' for a core write that landed while research mirrors did not.
  outcome text not null,
  reason text,
  warnings_json jsonb not null default '[]'::jsonb,
  observation_type text,
  occurred_at timestamptz not null default now(),
  constraint submission_failures_outcome_check
    check (outcome in ('failed', 'skipped', 'partial'))
);

create index if not exists submission_failures_recent_idx
  on public.submission_failures(occurred_at desc);
create index if not exists submission_failures_owner_idx
  on public.submission_failures(owner_user_id, occurred_at desc);

alter table public.submission_failures enable row level security;

-- Students may see that their own submission failed; nobody writes through
-- RLS (the service-role writer inserts these), so there is no insert policy.
drop policy if exists "submission_failures_select_own" on public.submission_failures;
create policy "submission_failures_select_own" on public.submission_failures
for select to authenticated
using ((select auth.uid()) = owner_user_id);

grant select on public.submission_failures to authenticated;

-- ---------------------------------------------------------------------------
-- 4c. Research export audit (#131)
-- ---------------------------------------------------------------------------

create table if not exists public.research_exports (
  id uuid primary key default gen_random_uuid(),
  requested_by uuid references auth.users(id) on delete set null,
  export_kind text not null,
  participant_scope_json jsonb not null default '{}'::jsonb,
  row_count integer not null default 0,
  included_raw_text boolean not null default false,
  status text not null default 'completed',
  reason text,
  created_at timestamptz not null default now(),
  constraint research_exports_status_check
    check (status in ('completed', 'denied', 'failed'))
);

create index if not exists research_exports_recent_idx
  on public.research_exports(created_at desc);

alter table public.research_exports enable row level security;
-- No policy for `authenticated`: RLS is on and nothing grants access, so the
-- table is unreachable except through the service-role key. Deliberate — an
-- export log a student can read tells them which cohorts a researcher pulled.
grant select on public.research_exports to research_reader;
