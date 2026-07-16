-- Student-controlled support-summary sharing (counselor handoff).
--
-- A share is an immutable STRUCTURED SNAPSHOT of the student's counselor
-- summary (the eight sections; evidence event ids only — never raw journal
-- or chat content), shared to an organization and optionally narrowed to a
-- single counselor. Counselor read access requires FOUR active gates:
--   active org membership + active roster assignment + active student
--   consent (all three via educator_oversees()) + an ACTIVE share row.
-- Revoking the share — or revoking consent — cuts access on the next read.

create table if not exists public.shared_support_summaries (
  id uuid primary key default gen_random_uuid(),
  participant_id uuid not null,
  owner_user_id uuid not null,
  org_id uuid not null references public.organizations(id) on delete cascade,
  -- Null = any counselor in the org who passes the other three gates.
  counselor_user_id uuid references auth.users(id) on delete cascade,
  summary_id text not null,
  summary_json jsonb not null,
  evidence_event_ids jsonb not null default '[]'::jsonb,
  date_range_from timestamptz,
  date_range_to timestamptz,
  reflection_count integer not null default 0,
  status text not null default 'active' check (status in ('active', 'revoked')),
  shared_at timestamptz not null default now(),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shared_support_summaries_participant_owner_fk
    foreign key (participant_id, owner_user_id)
    references public.participants(id, owner_user_id)
    on delete cascade
);

create index if not exists shared_support_summaries_participant_idx
  on public.shared_support_summaries(participant_id, status, shared_at desc);
create index if not exists shared_support_summaries_org_idx
  on public.shared_support_summaries(org_id, status, shared_at desc);
create index if not exists shared_support_summaries_counselor_idx
  on public.shared_support_summaries(counselor_user_id, status);

create trigger shared_support_summaries_set_updated_at
before update on public.shared_support_summaries
for each row execute function public.set_updated_at();

-- Reuse the consent revocation stamping pattern.
create trigger shared_support_summaries_stamp_revocation
before update on public.shared_support_summaries
for each row execute function public.stamp_consent_revocation();

alter table public.shared_support_summaries enable row level security;

-- Students own their shares: create, see, revoke, delete.
create policy "shared_summaries_owner_all" on public.shared_support_summaries
  for all to authenticated
  using (owner_user_id = (select auth.uid()))
  with check (owner_user_id = (select auth.uid()));

-- Counselors: read-only, all four gates enforced here.
-- educator_oversees() = active membership + active roster + active consent.
create policy "shared_summaries_counselor_select" on public.shared_support_summaries
  for select to authenticated
  using (
    status = 'active'
    and (counselor_user_id is null or counselor_user_id = (select auth.uid()))
    and public.educator_oversees(participant_id)
  );

grant select, insert, update, delete on public.shared_support_summaries to authenticated;
