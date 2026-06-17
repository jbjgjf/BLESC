alter table public.entries
  add column if not exists observation_type text not null default 'daily',
  add column if not exists extraction_provider text not null default 'unknown',
  add column if not exists extraction_model text not null default 'unknown';

alter table public.graph_snapshots
  add column if not exists extraction_provider text not null default 'unknown',
  add column if not exists extraction_model text not null default 'unknown';

alter table public.insights
  add column if not exists extraction_provider text not null default 'unknown',
  add column if not exists extraction_model text not null default 'unknown';

create index if not exists entries_owner_participant_model_created_idx
  on public.entries(owner_user_id, participant_id, extraction_provider, extraction_model, created_at desc);

create index if not exists graph_snapshots_owner_participant_model_day_idx
  on public.graph_snapshots(owner_user_id, participant_id, extraction_provider, extraction_model, day, created_at);

create index if not exists insights_owner_participant_model_day_idx
  on public.insights(owner_user_id, participant_id, extraction_provider, extraction_model, day desc, created_at desc);
