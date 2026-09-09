-- The PII review queue (#167).
--
-- ===========================================================================
-- Additive. One table. Nothing existing is altered.
-- ===========================================================================
--
-- `piiScan.ts` finds shapes in free text — an address-like string, a run of
-- digits, a name with an honorific. It is not anonymisation and a cleared text
-- is not a safe text: a diary entry can identify its author perfectly with no
-- PII token in it at all. What the scanner produces is a queue, and a human
-- decides. This table is the queue.
--
-- Two things it deliberately does not hold:
--
--   1. **The text.** Not the entry, not the matched substring, not a snippet
--      for context. The operator surfaces built on this table exist so that
--      submission rates and failures can be watched *without* reading anyone's
--      journal, and a queue row carrying the most sensitive fragment of an
--      entry would defeat exactly that. A reviewer who needs to see the text
--      goes through the export, which is allowlisted and audited separately.
--
--   2. **Offsets.** `findings_json` carries counts per kind, not spans. Spans
--      plus a length is a surprising amount of structure about a text nobody
--      is supposed to be reading from here.
--
-- The queue is written at export time rather than at submission time, on
-- purpose: the scanner will change, and re-scanning at export means a queue
-- built with today's patterns rather than with whatever was current on the day
-- the participant wrote. It also means no scan runs over text nobody has asked
-- to look at.

create table if not exists public.research_pii_reviews (
  id uuid primary key default gen_random_uuid(),

  entry_id uuid not null references public.entries(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,

  -- `{ "email": 1, "phone_jp": 2 }`. Counts per detector kind. No offsets, no
  -- matched text.
  findings_json jsonb not null default '{}'::jsonb,
  -- Which scanner produced them, so a queue built under an older pattern set
  -- is legible as such rather than looking like a text that has changed.
  scanner_version text not null,

  status text not null default 'pending',
  -- Who resolved it and when. `auth.users.id` and not a research code: this is
  -- an operations record about a staff member, not research data about a
  -- participant.
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  -- One line from the reviewer. Free text written by staff about their own
  -- decision — never a quotation from the entry.
  note text,

  created_at timestamptz not null default now(),

  -- One open row per entry per scanner version. Re-running an export does not
  -- pile up duplicates of a review somebody already did.
  unique (entry_id, scanner_version)
);

alter table public.research_pii_reviews
  drop constraint if exists research_pii_reviews_status_check;
alter table public.research_pii_reviews
  add constraint research_pii_reviews_status_check
  check (status in ('pending', 'cleared', 'redaction_requested', 'redacted'));

-- A resolved row names who resolved it. A status that moved with nobody
-- attached is an audit gap, and this is cheaper than discovering it later.
alter table public.research_pii_reviews
  drop constraint if exists research_pii_reviews_resolution_check;
alter table public.research_pii_reviews
  add constraint research_pii_reviews_resolution_check
  check (status = 'pending' or (reviewed_by is not null and reviewed_at is not null));

create index if not exists research_pii_reviews_pending_idx
  on public.research_pii_reviews(status, created_at)
  where status = 'pending';

alter table public.research_pii_reviews enable row level security;

-- No participant reads or writes this. It is an operations table about the
-- handling of their data, reached only by the allowlisted export and review
-- routes under the service-role key.
revoke all on public.research_pii_reviews from public, anon, authenticated;
grant select, insert, update on public.research_pii_reviews to service_role;
