-- The PII review queue and the audit columns the pseudonymised export needs
-- (issue #167, epic #161).
--
-- ===========================================================================
-- This migration is additive: one new table, three new nullable columns on
-- `research_exports`. It applies while the current version is serving.
-- ===========================================================================
--
-- Two things it establishes.
--
-- 1. A queue that holds findings, not text.
--
--    `pilot_pii_reviews` records that an entry contains something shaped like
--    an identifier, what kind, and where — never the matched string. A review
--    queue that quotes what it found is a second copy of the participant's
--    journal in a table with different access rules, which is exactly the leak
--    the queue exists to prevent. A reviewer who needs to read the passage goes
--    through the export route, under the export allowlist, and that read is
--    logged in `research_exports`.
--
--    The scan runs at write time, next to the plaintext, because by export time
--    the text may already have been purged by `purge_expired_raw_text` and a
--    reviewer would be asked to clear a record whose content is gone.
--
-- 2. An audit row that can distinguish the two exports.
--
--    #167 requires the research dataset and the identity map to be separate
--    permissions and separate outputs. They are separate routes, and these
--    columns let one audit table record both without a reader having to parse
--    `export_kind` to tell which one happened.

-- ---------------------------------------------------------------------------
-- 1. The PII review queue
-- ---------------------------------------------------------------------------

create table if not exists public.pilot_pii_reviews (
  id uuid primary key default gen_random_uuid(),

  owner_user_id uuid not null references auth.users(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  -- One row per entry. A re-scan under a newer scanner replaces the row rather
  -- than adding one, so the queue length is the number of entries needing a
  -- decision and not the number of times they were scanned.
  entry_id uuid not null unique references public.entries(id) on delete cascade,

  -- Which scanner produced this. A row cleared by `pii-scan-ja-v1` and a row
  -- cleared by a later version are not the same assurance, and after a pattern
  -- is added the rows to re-scan are the ones whose version is behind.
  scanner_version text not null,

  finding_count integer not null default 0,
  -- The highest confidence present: 'high' | 'medium' | 'low', or null when
  -- nothing matched. Same vocabulary as `PiiConfidence` in the scanner.
  max_confidence text,
  -- Distinct finding kinds, for a dashboard that groups without opening the
  -- findings array.
  kinds text[] not null default '{}',

  -- [{kind, confidence, start, end}]. Kinds and positions only.
  --
  -- The scanner's own `PiiFinding` carries a fifth field, `text`: the matched
  -- substring, verbatim. That is what makes a finding useful on an operator's
  -- screen and exactly what must not be stored here — a queue that keeps it is
  -- a second copy of the journal under different access rules, which is the
  -- leak the queue exists to prevent.
  --
  -- So the CHECK below refuses it. `forStorage()` in the scanner strips it, and
  -- a future writer that forgets to call that and inserts findings straight
  -- from `scanForPii` is rejected by the database rather than quietly
  -- persisting participant text.
  findings_json jsonb not null default '[]'::jsonb,

  -- 'clear'     nothing matched; no human decision needed
  -- 'pending'   waiting for a reviewer
  -- 'cleared'   a reviewer decided the findings are not identifying
  -- 'redacted'  the text may be exported only with findings replaced
  -- 'blocked'   the text must not be exported at all
  status text not null default 'pending',

  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  -- The reviewer's reason, in one line. Not a place to quote the entry: a
  -- reviewer who pastes the sentence here has recreated the leak.
  review_note text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint pilot_pii_reviews_status_check
    check (status in ('clear', 'pending', 'cleared', 'redacted', 'blocked')),
  constraint pilot_pii_reviews_confidence_check
    check (max_confidence is null or max_confidence in ('high', 'medium', 'low')),
  constraint pilot_pii_reviews_count_check
    check (finding_count >= 0),
  -- A decided row names its decider. 'clear' and 'pending' are machine states
  -- and have no reviewer; the other three are human decisions and must.
  constraint pilot_pii_reviews_reviewed_check
    check (
      status in ('clear', 'pending')
      or (reviewed_by is not null and reviewed_at is not null)
    ),
  constraint pilot_pii_reviews_participant_owner_fk
    foreign key (participant_id, owner_user_id)
    references public.participants(id, owner_user_id)
    on delete cascade,
  constraint pilot_pii_reviews_entry_owner_fk
    foreign key (entry_id, owner_user_id)
    references public.entries(id, owner_user_id)
    on delete cascade
);

-- No text in the findings. Enforced, not documented.
--
-- Every element must be an object whose keys are a subset of the four that
-- survive `forStorage`, so a findings array carrying the scanner's own `text`
-- field — or an `excerpt`, or a `match` — is refused.
--
-- The predicate lives in a function because a CHECK constraint cannot contain a
-- subquery, and answering "do any of this array's elements have a key outside
-- the allowed set" needs one. The function is IMMUTABLE and reads only its
-- argument — no table, no setting, no clock — which is what makes it legitimate
-- in a constraint rather than merely accepted by one.
create or replace function public.pii_findings_carry_no_text(findings jsonb)
returns boolean
language sql
immutable
parallel safe
set search_path = pg_catalog, pg_temp
as $$
  select jsonb_typeof(findings) = 'array'
     and not exists (
       select 1
       from jsonb_array_elements(findings) as element
       where jsonb_typeof(element) <> 'object'
          or exists (
            select 1
            from jsonb_object_keys(element) as element_key
            where element_key not in ('kind', 'confidence', 'start', 'end')
          )
     );
$$;

alter table public.pilot_pii_reviews
  drop constraint if exists pilot_pii_reviews_findings_shape_check;
alter table public.pilot_pii_reviews
  add constraint pilot_pii_reviews_findings_shape_check
  check (public.pii_findings_carry_no_text(findings_json));

create index if not exists pilot_pii_reviews_status_idx
  on public.pilot_pii_reviews(status, max_confidence);

create index if not exists pilot_pii_reviews_participant_idx
  on public.pilot_pii_reviews(participant_id);

create index if not exists pilot_pii_reviews_scanner_idx
  on public.pilot_pii_reviews(scanner_version);

create or replace function public.stamp_pilot_pii_review_update()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists pilot_pii_reviews_touch on public.pilot_pii_reviews;
create trigger pilot_pii_reviews_touch
before update on public.pilot_pii_reviews
for each row execute function public.stamp_pilot_pii_review_update();

alter table public.pilot_pii_reviews enable row level security;

-- No policy and no grant for `authenticated`. Not even "select your own".
--
-- A participant who can read this table learns which of their entries the
-- scanner flagged, which is a description of their own text held under
-- operator rules, and — more to the point — learns exactly what the scanner
-- looks for. Every read goes through the service role, which is the operator
-- path.
grant select, insert, update on public.pilot_pii_reviews to service_role;
grant select on public.pilot_pii_reviews to research_reader;

-- ---------------------------------------------------------------------------
-- 2. Export audit: which export, for which study, at what granularity
-- ---------------------------------------------------------------------------
--
-- `research_exports` (20260906000000) already records every attempt including
-- the denied ones. These columns let it record *which* of the two outputs was
-- attempted without a reader parsing `export_kind` as prose.

alter table public.research_exports
  add column if not exists study_id uuid references public.pilot_studies(id) on delete set null;

-- True for the identity map: the output that maps a research code back to an
-- account. Separate from `included_raw_text`, because they are separate
-- disclosures under separate allowlists and an audit that conflates them
-- cannot answer "who has ever been able to re-identify a participant".
alter table public.research_exports
  add column if not exists included_identity_map boolean not null default false;

-- Participants deliberately left out of this export and why, as
-- {withdrawn: n, dry_run: n, no_consent: n, ...}. A pull that returned 40 rows
-- because ten people withdrew and one that returned 40 because the cohort is
-- small are different facts about the study.
alter table public.research_exports
  add column if not exists excluded_json jsonb not null default '{}'::jsonb;

create index if not exists research_exports_study_idx
  on public.research_exports(study_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 3. Rollback
-- ---------------------------------------------------------------------------
--
--   drop trigger if exists pilot_pii_reviews_touch on public.pilot_pii_reviews;
--   drop function if exists public.stamp_pilot_pii_review_update();
--   drop table if exists public.pilot_pii_reviews;
--   drop function if exists public.pii_findings_carry_no_text(jsonb);
--   alter table public.research_exports
--     drop column if exists study_id,
--     drop column if exists included_identity_map,
--     drop column if exists excluded_json;
