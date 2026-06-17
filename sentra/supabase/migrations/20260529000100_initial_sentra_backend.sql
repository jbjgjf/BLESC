create extension if not exists "pgcrypto";

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  email text,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_owner_matches_id check (owner_user_id = id)
);

create table public.participants (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  code text not null,
  display_name text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, owner_user_id),
  unique (owner_user_id, code)
);

create table public.entries (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  raw_text text,
  is_masked boolean not null default false,
  extraction_json jsonb not null default '{}'::jsonb,
  provenance_hash text,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, owner_user_id),
  constraint entries_participant_owner_fk
    foreign key (participant_id, owner_user_id)
    references public.participants(id, owner_user_id)
    on delete cascade
);

create table public.graph_snapshots (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  entry_id uuid references public.entries(id) on delete set null,
  day date not null,
  nodes_json jsonb not null default '[]'::jsonb,
  relations_json jsonb not null default '[]'::jsonb,
  graph_summary_json jsonb not null default '{}'::jsonb,
  temporal_diff_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, owner_user_id),
  constraint graph_snapshots_participant_owner_fk
    foreign key (participant_id, owner_user_id)
    references public.participants(id, owner_user_id)
    on delete cascade,
  constraint graph_snapshots_entry_owner_fk
    foreign key (entry_id, owner_user_id)
    references public.entries(id, owner_user_id)
);

create table public.insights (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  entry_id uuid references public.entries(id) on delete set null,
  graph_snapshot_id uuid references public.graph_snapshots(id) on delete set null,
  day date not null,
  anomaly_score double precision not null default 0,
  z_scores_json jsonb not null default '{}'::jsonb,
  triggered_rules_json jsonb not null default '[]'::jsonb,
  baseline_deviation_json jsonb not null default '{}'::jsonb,
  changed_relations_json jsonb not null default '[]'::jsonb,
  protective_decline_json jsonb not null default '{}'::jsonb,
  uncertainty_json jsonb not null default '{}'::jsonb,
  evidence_summaries jsonb not null default '[]'::jsonb,
  graph_summary_json jsonb not null default '{}'::jsonb,
  score_breakdown_json jsonb not null default '{}'::jsonb,
  key_relations jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint insights_participant_owner_fk
    foreign key (participant_id, owner_user_id)
    references public.participants(id, owner_user_id)
    on delete cascade,
  constraint insights_entry_owner_fk
    foreign key (entry_id, owner_user_id)
    references public.entries(id, owner_user_id),
  constraint insights_graph_snapshot_owner_fk
    foreign key (graph_snapshot_id, owner_user_id)
    references public.graph_snapshots(id, owner_user_id)
);

create index participants_owner_user_id_idx on public.participants(owner_user_id);
create index entries_owner_participant_created_idx on public.entries(owner_user_id, participant_id, created_at desc);
create index graph_snapshots_owner_participant_day_idx on public.graph_snapshots(owner_user_id, participant_id, day, created_at);
create index insights_owner_participant_day_idx on public.insights(owner_user_id, participant_id, day desc, created_at desc);

create trigger profiles_set_updated_at before update on public.profiles
for each row execute function public.set_updated_at();

create trigger participants_set_updated_at before update on public.participants
for each row execute function public.set_updated_at();

create trigger entries_set_updated_at before update on public.entries
for each row execute function public.set_updated_at();

create trigger graph_snapshots_set_updated_at before update on public.graph_snapshots
for each row execute function public.set_updated_at();

create trigger insights_set_updated_at before update on public.insights
for each row execute function public.set_updated_at();

alter table public.profiles enable row level security;
alter table public.participants enable row level security;
alter table public.entries enable row level security;
alter table public.graph_snapshots enable row level security;
alter table public.insights enable row level security;

create policy "profiles_select_own" on public.profiles
for select to authenticated
using ((select auth.uid()) = owner_user_id);

create policy "profiles_insert_own" on public.profiles
for insert to authenticated
with check ((select auth.uid()) = owner_user_id and (select auth.uid()) = id);

create policy "profiles_update_own" on public.profiles
for update to authenticated
using ((select auth.uid()) = owner_user_id)
with check ((select auth.uid()) = owner_user_id and (select auth.uid()) = id);

create policy "profiles_delete_own" on public.profiles
for delete to authenticated
using ((select auth.uid()) = owner_user_id);

create policy "participants_select_own" on public.participants
for select to authenticated
using ((select auth.uid()) = owner_user_id);

create policy "participants_insert_own" on public.participants
for insert to authenticated
with check ((select auth.uid()) = owner_user_id);

create policy "participants_update_own" on public.participants
for update to authenticated
using ((select auth.uid()) = owner_user_id)
with check ((select auth.uid()) = owner_user_id);

create policy "participants_delete_own" on public.participants
for delete to authenticated
using ((select auth.uid()) = owner_user_id);

create policy "entries_select_own" on public.entries
for select to authenticated
using ((select auth.uid()) = owner_user_id);

create policy "entries_insert_own" on public.entries
for insert to authenticated
with check ((select auth.uid()) = owner_user_id);

create policy "entries_update_own" on public.entries
for update to authenticated
using ((select auth.uid()) = owner_user_id)
with check ((select auth.uid()) = owner_user_id);

create policy "entries_delete_own" on public.entries
for delete to authenticated
using ((select auth.uid()) = owner_user_id);

create policy "graph_snapshots_select_own" on public.graph_snapshots
for select to authenticated
using ((select auth.uid()) = owner_user_id);

create policy "graph_snapshots_insert_own" on public.graph_snapshots
for insert to authenticated
with check ((select auth.uid()) = owner_user_id);

create policy "graph_snapshots_update_own" on public.graph_snapshots
for update to authenticated
using ((select auth.uid()) = owner_user_id)
with check ((select auth.uid()) = owner_user_id);

create policy "graph_snapshots_delete_own" on public.graph_snapshots
for delete to authenticated
using ((select auth.uid()) = owner_user_id);

create policy "insights_select_own" on public.insights
for select to authenticated
using ((select auth.uid()) = owner_user_id);

create policy "insights_insert_own" on public.insights
for insert to authenticated
with check ((select auth.uid()) = owner_user_id);

create policy "insights_update_own" on public.insights
for update to authenticated
using ((select auth.uid()) = owner_user_id)
with check ((select auth.uid()) = owner_user_id);

create policy "insights_delete_own" on public.insights
for delete to authenticated
using ((select auth.uid()) = owner_user_id);

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.profiles to authenticated;
grant select, insert, update, delete on public.participants to authenticated;
grant select, insert, update, delete on public.entries to authenticated;
grant select, insert, update, delete on public.graph_snapshots to authenticated;
grant select, insert, update, delete on public.insights to authenticated;
