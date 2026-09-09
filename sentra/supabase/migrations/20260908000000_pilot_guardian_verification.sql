-- Guardian verification on a separate path from the participant (issue #164,
-- epic #161).
--
-- ===========================================================================
-- Additive. One table, one widened CHECK constraint, no data movement. It can
-- be applied while the current version is serving, before the code that uses
-- it ships.
-- ===========================================================================
--
-- 20260906010000 established that a minor cannot reach `enrolled` without a
-- `guardian_verified_at`, and 20260906000000 established that research use is
-- gated on a `consent_records` row carrying both `minor_assent` and
-- `guardian_consent`. Neither one says *how* the guardian's half arrives, and
-- until this migration the honest answer was "through the participant's own
-- session" — the consent route accepted `guardian_consent: true` from whoever
-- was signed in. A fifteen-year-old ticking a box labelled "保護者の同意" is
-- not a guardian's consent, and a record that says otherwise is worse than no
-- record: it is the artefact an ethics review would be shown.
--
-- So the guardian gets their own credential, on their own device:
--
--   1. The participant's session asks for a verification (it may ask only for
--      its own enrollment, and only while that enrollment sits at
--      `participant_assented`).
--   2. The server returns a token **once**. What it stores is
--      HMAC-SHA256(token) under `PILOT_GUARDIAN_HMAC_KEY` — the same reasoning
--      as `pilot_invitations.code_hash`: a dump of this table is a list of
--      hashes nobody can present.
--   3. The guardian opens the link, sees what is being asked, and decides. That
--      request carries no session at all, which is the point: the guardian is
--      not a user of this system and must not need an account to refuse.
--
-- What this table deliberately does NOT hold: the guardian's name, e-mail,
-- phone number or relationship in free text. The study needs to know that a
-- guardian confirmed and through which channel. It does not need to identify
-- them, and collecting a second adult's contact details to answer a yes/no
-- question would be its own disclosure to justify.

-- ---------------------------------------------------------------------------
-- 1. The actor vocabulary
-- ---------------------------------------------------------------------------
--
-- `pilot_enrollment_events.actor` allowed 'participant', 'operator' and
-- 'system'. A guardian is none of those. Recording their confirmation as
-- 'operator' would put a false statement into the one table that exists to be
-- read back during the dry-run review (#168), so the vocabulary is widened
-- rather than borrowed. Widening a CHECK accepts everything it accepted
-- before, so no existing row is affected.

alter table public.pilot_enrollment_events
  drop constraint if exists pilot_enrollment_events_actor_check;
alter table public.pilot_enrollment_events
  add constraint pilot_enrollment_events_actor_check
  check (actor in ('participant', 'operator', 'system', 'guardian'));

-- ---------------------------------------------------------------------------
-- 2. Verification requests
-- ---------------------------------------------------------------------------

create table if not exists public.pilot_guardian_verifications (
  id uuid primary key default gen_random_uuid(),

  enrollment_id uuid not null references public.pilot_enrollments(id) on delete cascade,
  -- Denormalised from the enrollment so that consuming a token needs one read
  -- and so a token can never be applied to a different owner's row than the
  -- one it was issued against.
  owner_user_id uuid not null references auth.users(id) on delete cascade,

  token_hash text not null unique,
  -- The first characters, in the clear, so a participant can be told which of
  -- two links is the live one and an operator can match a support call to a
  -- row. Six symbols is 30 bits: enough to name a token, nowhere near enough
  -- to present one.
  token_prefix text not null,

  -- What the guardian is being asked to approve, exactly as the participant
  -- chose it on the assent screen: the optional grants
  -- (`anonymized_export`, `raw_text_retention`, `future_fine_tuning`) plus the
  -- document version they both read.
  --
  -- It lives here and not only in `consent_records` because the participant's
  -- own record cannot carry `research_analysis: true` while the guardian half
  -- is missing — the write path gates on that flag alone, so storing an
  -- intention there would collect research data from a minor whose guardian
  -- has not answered. The intention waits here instead, and becomes a consent
  -- record at the moment the guardian confirms.
  requested_grants jsonb not null default '{}'::jsonb,

  -- How the link reached the guardian. 'link' is the participant handing it
  -- over; 'operator' is a coordinator sending it from the school. Recorded
  -- because "how was the guardian confirmed" is a protocol question, and
  -- ends up in `pilot_enrollments.guardian_verification_method`.
  channel text not null default 'link',

  expires_at timestamptz not null,

  -- Claimed, then decided. Two timestamps rather than one, because the window
  -- between them is where a consent write and a state transition happen, and
  -- an operator looking at a stuck enrollment needs to see which of the two
  -- steps did not finish.
  claimed_at timestamptz,
  decision text,
  decided_at timestamptz,

  -- Set when a newer request supersedes this one, or when an operator pulls it.
  revoked_at timestamptz,

  created_at timestamptz not null default now()
);

alter table public.pilot_guardian_verifications
  drop constraint if exists pilot_guardian_verifications_decision_check;
alter table public.pilot_guardian_verifications
  add constraint pilot_guardian_verifications_decision_check
  check (decision is null or decision in ('confirmed', 'declined'));

-- A decision and its timestamp travel together in both directions. Half of a
-- decision is not a state this table can be left in.
alter table public.pilot_guardian_verifications
  drop constraint if exists pilot_guardian_verifications_decided_check;
alter table public.pilot_guardian_verifications
  add constraint pilot_guardian_verifications_decided_check
  check ((decision is null) = (decided_at is null));

create index if not exists pilot_guardian_verifications_enrollment_idx
  on public.pilot_guardian_verifications(enrollment_id, created_at desc);

-- The lookup the confirm route performs on every request, by hash alone. It is
-- already served by the unique constraint on `token_hash`; naming it here is
-- for the reader, not for the planner.

-- ---------------------------------------------------------------------------
-- 3. Privileges
-- ---------------------------------------------------------------------------
--
-- No grant to `anon` or `authenticated`, and no policy for them. The guardian
-- screen is unauthenticated, so it necessarily runs through a route handler
-- holding the service-role key; a browser that could read this table could
-- enumerate outstanding tokens, and a browser that could write it could
-- confirm its own guardianship. The participant's own screen never reads this
-- table either — it reads the status the route derives from it, which says
-- "pending" or "confirmed" and never the hash.

alter table public.pilot_guardian_verifications enable row level security;

revoke all on public.pilot_guardian_verifications from public, anon, authenticated;
grant select, insert, update on public.pilot_guardian_verifications to service_role;

-- The export role reads the fact and the timing of a verification, never the
-- token. Column-level, so a `select *` from a research session fails loudly
-- rather than quietly handing over hashes.
grant select (id, enrollment_id, channel, expires_at, claimed_at, decision, decided_at, revoked_at, created_at)
  on public.pilot_guardian_verifications to research_reader;
