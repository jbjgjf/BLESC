-- Longitudinal pattern learning layer.
--
-- Persists the patterns mined across a participant's history: recurring graph
-- motifs, leading indicators (lift), and narratable feature trends. Mirrors the
-- owner-scoped RLS conventions of the research-grade data layer so the learned
-- patterns inherit the same per-user isolation as their source graphs.

create table if not exists public.longitudinal_patterns (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  window_days integer not null,
  pattern_kind text not null,          -- recurring_motif | leading_indicator | feature_trend
  pattern_key text not null,
  label text not null default '',
  recurrence_count integer not null default 0,
  lift double precision not null default 0,
  mean_confidence double precision not null default 0,
  first_seen date,
  last_seen date,
  support_days_json jsonb not null default '[]'::jsonb,
  detail_json jsonb not null default '{}'::jsonb,
  pipeline_version text not null default 'sentra-pattern-mining-v1',
  created_at timestamptz not null default now(),
  constraint longitudinal_patterns_participant_owner_fk
    foreign key (participant_id, owner_user_id)
    references public.participants(id, owner_user_id)
    on delete cascade
);

create index if not exists longitudinal_patterns_owner_kind_idx
  on public.longitudinal_patterns(owner_user_id, participant_id, pattern_kind, window_days);

create index if not exists longitudinal_patterns_owner_strength_idx
  on public.longitudinal_patterns(owner_user_id, participant_id, lift desc, recurrence_count desc);

alter table public.longitudinal_patterns enable row level security;

create policy "longitudinal_patterns_own_all" on public.longitudinal_patterns
  for all to authenticated
  using ((select auth.uid()) = owner_user_id)
  with check ((select auth.uid()) = owner_user_id);

grant select, insert, update, delete on public.longitudinal_patterns to authenticated;
