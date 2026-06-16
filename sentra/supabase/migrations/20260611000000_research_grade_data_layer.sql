create schema if not exists extensions;
create extension if not exists vector with schema extensions;

create table if not exists public.consent_records (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  app_use boolean not null default true,
  research_analysis boolean not null default true,
  anonymized_export boolean not null default false,
  future_fine_tuning boolean not null default false,
  consent_version text not null default 'research-consent-v1',
  source text not null default 'student_ui',
  created_at timestamptz not null default now(),
  constraint consent_records_participant_owner_fk
    foreign key (participant_id, owner_user_id)
    references public.participants(id, owner_user_id)
    on delete cascade
);

create table if not exists public.entry_sessions (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  client_session_id text not null,
  status text not null default 'submitted',
  started_at timestamptz not null,
  submitted_at timestamptz,
  client_timezone text,
  user_agent text,
  consent_snapshot_json jsonb not null default '{}'::jsonb,
  aggregate_metrics_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (owner_user_id, client_session_id),
  unique (id, owner_user_id),
  constraint entry_sessions_participant_owner_fk
    foreign key (participant_id, owner_user_id)
    references public.participants(id, owner_user_id)
    on delete cascade
);

create table if not exists public.entry_fields (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  entry_session_id uuid not null references public.entry_sessions(id) on delete cascade,
  field_name text not null,
  final_text_hash text not null,
  char_count integer not null default 0,
  word_count integer not null default 0,
  started_at timestamptz,
  completed_at timestamptz,
  metrics_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint entry_fields_participant_owner_fk
    foreign key (participant_id, owner_user_id)
    references public.participants(id, owner_user_id)
    on delete cascade,
  constraint entry_fields_session_owner_fk
    foreign key (entry_session_id, owner_user_id)
    references public.entry_sessions(id, owner_user_id)
    on delete cascade
);

create table if not exists public.interaction_events (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  entry_session_id uuid not null references public.entry_sessions(id) on delete cascade,
  field_name text not null,
  event_type text not null,
  occurred_at timestamptz not null,
  relative_ms integer not null default 0,
  value_length integer,
  selection_start integer,
  selection_end integer,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint interaction_events_participant_owner_fk
    foreign key (participant_id, owner_user_id)
    references public.participants(id, owner_user_id)
    on delete cascade,
  constraint interaction_events_session_owner_fk
    foreign key (entry_session_id, owner_user_id)
    references public.entry_sessions(id, owner_user_id)
    on delete cascade
);

create table if not exists public.writing_features (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  entry_id uuid references public.entries(id) on delete cascade,
  entry_session_id uuid not null references public.entry_sessions(id) on delete cascade,
  field_name text not null,
  feature_json jsonb not null default '{}'::jsonb,
  pipeline_version text not null default 'writing-dynamics-v1',
  created_at timestamptz not null default now(),
  constraint writing_features_participant_owner_fk
    foreign key (participant_id, owner_user_id)
    references public.participants(id, owner_user_id)
    on delete cascade,
  constraint writing_features_session_owner_fk
    foreign key (entry_session_id, owner_user_id)
    references public.entry_sessions(id, owner_user_id)
    on delete cascade
);

create table if not exists public.cognitive_probe_features (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  entry_id uuid references public.entries(id) on delete cascade,
  entry_session_id uuid references public.entry_sessions(id) on delete cascade,
  probe_name text not null default 'first_recall_30',
  journal_text_hash text not null,
  recall_text_hash text not null,
  feature_json jsonb not null default '{}'::jsonb,
  pipeline_version text not null default 'cognitive-probe-v1',
  created_at timestamptz not null default now(),
  constraint cognitive_probe_features_participant_owner_fk
    foreign key (participant_id, owner_user_id)
    references public.participants(id, owner_user_id)
    on delete cascade
);

create table if not exists public.entry_research_links (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  entry_id uuid not null references public.entries(id) on delete cascade,
  entry_session_id uuid not null references public.entry_sessions(id) on delete cascade,
  field_name text not null,
  source_hash text not null,
  created_at timestamptz not null default now(),
  constraint entry_research_links_participant_owner_fk
    foreign key (participant_id, owner_user_id)
    references public.participants(id, owner_user_id)
    on delete cascade,
  constraint entry_research_links_entry_owner_fk
    foreign key (entry_id, owner_user_id)
    references public.entries(id, owner_user_id)
    on delete cascade,
  constraint entry_research_links_session_owner_fk
    foreign key (entry_session_id, owner_user_id)
    references public.entry_sessions(id, owner_user_id)
    on delete cascade
);

create table if not exists public.model_runs (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  artifact_type text not null,
  artifact_id text,
  provider text not null default 'unknown',
  model text not null default 'unknown',
  prompt_version text not null default 'unknown',
  schema_version text not null default 'unknown',
  pipeline_version text not null default 'research-pipeline-v1',
  temperature double precision not null default 0,
  retrieval_config_json jsonb not null default '{}'::jsonb,
  input_provenance_json jsonb not null default '{}'::jsonb,
  output_hash text,
  status text not null default 'completed',
  error_message text,
  created_at timestamptz not null default now(),
  constraint model_runs_participant_owner_fk
    foreign key (participant_id, owner_user_id)
    references public.participants(id, owner_user_id)
    on delete cascade
);

create table if not exists public.extractions (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  entry_id uuid references public.entries(id) on delete cascade,
  model_run_id uuid references public.model_runs(id) on delete set null,
  nodes_json jsonb not null default '[]'::jsonb,
  relations_json jsonb not null default '[]'::jsonb,
  temporal_json jsonb not null default '{}'::jsonb,
  uncertainty_json jsonb not null default '{}'::jsonb,
  safety_flags jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  constraint extractions_participant_owner_fk
    foreign key (participant_id, owner_user_id)
    references public.participants(id, owner_user_id)
    on delete cascade,
  constraint extractions_entry_owner_fk
    foreign key (entry_id, owner_user_id)
    references public.entries(id, owner_user_id)
    on delete cascade
);

create table if not exists public.graph_versions (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  entry_id uuid references public.entries(id) on delete set null,
  graph_snapshot_id uuid references public.graph_snapshots(id) on delete set null,
  version_index integer not null,
  nodes_json jsonb not null default '[]'::jsonb,
  relations_json jsonb not null default '[]'::jsonb,
  summary_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (id, owner_user_id),
  unique (owner_user_id, participant_id, version_index),
  constraint graph_versions_participant_owner_fk
    foreign key (participant_id, owner_user_id)
    references public.participants(id, owner_user_id)
    on delete cascade
);

create table if not exists public.graph_change_events (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  graph_version_id uuid not null references public.graph_versions(id) on delete cascade,
  change_type text not null,
  entity_type text not null,
  entity_key text not null,
  previous_json jsonb,
  current_json jsonb,
  semantic_drift_score double precision not null default 0,
  trajectory_tags jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  constraint graph_change_events_participant_owner_fk
    foreign key (participant_id, owner_user_id)
    references public.participants(id, owner_user_id)
    on delete cascade,
  constraint graph_change_events_version_owner_fk
    foreign key (graph_version_id, owner_user_id)
    references public.graph_versions(id, owner_user_id)
    on delete cascade
);

create table if not exists public.entry_embeddings (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  entry_id uuid references public.entries(id) on delete cascade,
  content_kind text not null,
  embedding_model text not null default 'text-embedding-3-small',
  embedding extensions.vector(1536),
  content_hash text not null,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint entry_embeddings_participant_owner_fk
    foreign key (participant_id, owner_user_id)
    references public.participants(id, owner_user_id)
    on delete cascade
);

create table if not exists public.retrieval_events (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  query_hash text not null,
  retrieval_config_json jsonb not null default '{}'::jsonb,
  result_refs_json jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  constraint retrieval_events_participant_owner_fk
    foreign key (participant_id, owner_user_id)
    references public.participants(id, owner_user_id)
    on delete cascade
);

create table if not exists public.chat_sessions (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  consent_snapshot_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (id, owner_user_id),
  constraint chat_sessions_participant_owner_fk
    foreign key (participant_id, owner_user_id)
    references public.participants(id, owner_user_id)
    on delete cascade
);

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  chat_session_id uuid not null references public.chat_sessions(id) on delete cascade,
  role text not null,
  content_hash text not null,
  content_redacted text,
  evidence_refs_json jsonb not null default '[]'::jsonb,
  model_run_id uuid references public.model_runs(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint chat_messages_participant_owner_fk
    foreign key (participant_id, owner_user_id)
    references public.participants(id, owner_user_id)
    on delete cascade,
  constraint chat_messages_session_owner_fk
    foreign key (chat_session_id, owner_user_id)
    references public.chat_sessions(id, owner_user_id)
    on delete cascade
);

create table if not exists public.longitudinal_features (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  window_days integer not null,
  window_start date not null,
  window_end date not null,
  feature_json jsonb not null default '{}'::jsonb,
  pipeline_version text not null default 'longitudinal-v1',
  created_at timestamptz not null default now(),
  constraint longitudinal_features_participant_owner_fk
    foreign key (participant_id, owner_user_id)
    references public.participants(id, owner_user_id)
    on delete cascade
);

create table if not exists public.eval_examples (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  source_entry_id uuid references public.entries(id) on delete set null,
  task_type text not null,
  input_json jsonb not null default '{}'::jsonb,
  expected_output_json jsonb not null default '{}'::jsonb,
  consent_snapshot_json jsonb not null default '{}'::jsonb,
  review_status text not null default 'unreviewed',
  created_at timestamptz not null default now(),
  constraint eval_examples_participant_owner_fk
    foreign key (participant_id, owner_user_id)
    references public.participants(id, owner_user_id)
    on delete cascade
);

create table if not exists public.export_jobs (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  export_format text not null,
  status text not null default 'pending',
  consent_filter_json jsonb not null default '{}'::jsonb,
  manifest_json jsonb not null default '{}'::jsonb,
  output_path text,
  error_message text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint export_jobs_participant_owner_fk
    foreign key (participant_id, owner_user_id)
    references public.participants(id, owner_user_id)
    on delete cascade
);

create index if not exists entry_sessions_owner_participant_created_idx on public.entry_sessions(owner_user_id, participant_id, created_at desc);
create index if not exists interaction_events_session_time_idx on public.interaction_events(entry_session_id, occurred_at);
create index if not exists writing_features_owner_field_idx on public.writing_features(owner_user_id, participant_id, field_name, created_at desc);
create index if not exists cognitive_probe_features_owner_probe_idx on public.cognitive_probe_features(owner_user_id, participant_id, probe_name, created_at desc);
create index if not exists model_runs_owner_artifact_idx on public.model_runs(owner_user_id, participant_id, artifact_type, created_at desc);
create index if not exists graph_versions_owner_participant_version_idx on public.graph_versions(owner_user_id, participant_id, version_index desc);
create index if not exists graph_change_events_version_idx on public.graph_change_events(graph_version_id, change_type, entity_type);
create index if not exists entry_embeddings_owner_kind_idx on public.entry_embeddings(owner_user_id, participant_id, content_kind, created_at desc);
create index if not exists longitudinal_features_owner_window_idx on public.longitudinal_features(owner_user_id, participant_id, window_days, window_end desc);
create index if not exists eval_examples_owner_task_idx on public.eval_examples(owner_user_id, participant_id, task_type, review_status);
create index if not exists entry_embeddings_embedding_hnsw_idx on public.entry_embeddings using hnsw (embedding vector_cosine_ops);

create or replace function public.match_entry_embeddings(
  query_embedding extensions.vector(1536),
  match_count integer default 5
)
returns table (
  id uuid,
  entry_id uuid,
  participant_id uuid,
  content_kind text,
  embedding_model text,
  content_hash text,
  similarity double precision,
  metadata_json jsonb,
  created_at timestamptz
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select
    entry_embeddings.id,
    entry_embeddings.entry_id,
    entry_embeddings.participant_id,
    entry_embeddings.content_kind,
    entry_embeddings.embedding_model,
    entry_embeddings.content_hash,
    1 - (entry_embeddings.embedding <=> query_embedding) as similarity,
    entry_embeddings.metadata_json,
    entry_embeddings.created_at
  from public.entry_embeddings
  where entry_embeddings.owner_user_id = (select auth.uid())
    and entry_embeddings.embedding is not null
  order by entry_embeddings.embedding <=> query_embedding
  limit greatest(1, least(match_count, 50));
$$;

alter table public.consent_records enable row level security;
alter table public.entry_sessions enable row level security;
alter table public.entry_fields enable row level security;
alter table public.interaction_events enable row level security;
alter table public.writing_features enable row level security;
alter table public.cognitive_probe_features enable row level security;
alter table public.entry_research_links enable row level security;
alter table public.model_runs enable row level security;
alter table public.extractions enable row level security;
alter table public.graph_versions enable row level security;
alter table public.graph_change_events enable row level security;
alter table public.entry_embeddings enable row level security;
alter table public.retrieval_events enable row level security;
alter table public.chat_sessions enable row level security;
alter table public.chat_messages enable row level security;
alter table public.longitudinal_features enable row level security;
alter table public.eval_examples enable row level security;
alter table public.export_jobs enable row level security;

create policy "consent_records_own_all" on public.consent_records for all to authenticated using ((select auth.uid()) = owner_user_id) with check ((select auth.uid()) = owner_user_id);
create policy "entry_sessions_own_all" on public.entry_sessions for all to authenticated using ((select auth.uid()) = owner_user_id) with check ((select auth.uid()) = owner_user_id);
create policy "entry_fields_own_all" on public.entry_fields for all to authenticated using ((select auth.uid()) = owner_user_id) with check ((select auth.uid()) = owner_user_id);
create policy "interaction_events_own_all" on public.interaction_events for all to authenticated using ((select auth.uid()) = owner_user_id) with check ((select auth.uid()) = owner_user_id);
create policy "writing_features_own_all" on public.writing_features for all to authenticated using ((select auth.uid()) = owner_user_id) with check ((select auth.uid()) = owner_user_id);
create policy "cognitive_probe_features_own_all" on public.cognitive_probe_features for all to authenticated using ((select auth.uid()) = owner_user_id) with check ((select auth.uid()) = owner_user_id);
create policy "entry_research_links_own_all" on public.entry_research_links for all to authenticated using ((select auth.uid()) = owner_user_id) with check ((select auth.uid()) = owner_user_id);
create policy "model_runs_own_all" on public.model_runs for all to authenticated using ((select auth.uid()) = owner_user_id) with check ((select auth.uid()) = owner_user_id);
create policy "extractions_own_all" on public.extractions for all to authenticated using ((select auth.uid()) = owner_user_id) with check ((select auth.uid()) = owner_user_id);
create policy "graph_versions_own_all" on public.graph_versions for all to authenticated using ((select auth.uid()) = owner_user_id) with check ((select auth.uid()) = owner_user_id);
create policy "graph_change_events_own_all" on public.graph_change_events for all to authenticated using ((select auth.uid()) = owner_user_id) with check ((select auth.uid()) = owner_user_id);
create policy "entry_embeddings_own_all" on public.entry_embeddings for all to authenticated using ((select auth.uid()) = owner_user_id) with check ((select auth.uid()) = owner_user_id);
create policy "retrieval_events_own_all" on public.retrieval_events for all to authenticated using ((select auth.uid()) = owner_user_id) with check ((select auth.uid()) = owner_user_id);
create policy "chat_sessions_own_all" on public.chat_sessions for all to authenticated using ((select auth.uid()) = owner_user_id) with check ((select auth.uid()) = owner_user_id);
create policy "chat_messages_own_all" on public.chat_messages for all to authenticated using ((select auth.uid()) = owner_user_id) with check ((select auth.uid()) = owner_user_id);
create policy "longitudinal_features_own_all" on public.longitudinal_features for all to authenticated using ((select auth.uid()) = owner_user_id) with check ((select auth.uid()) = owner_user_id);
create policy "eval_examples_own_all" on public.eval_examples for all to authenticated using ((select auth.uid()) = owner_user_id) with check ((select auth.uid()) = owner_user_id);
create policy "export_jobs_own_all" on public.export_jobs for all to authenticated using ((select auth.uid()) = owner_user_id) with check ((select auth.uid()) = owner_user_id);

grant select, insert, update, delete on public.consent_records to authenticated;
grant select, insert, update, delete on public.entry_sessions to authenticated;
grant select, insert, update, delete on public.entry_fields to authenticated;
grant select, insert, update, delete on public.interaction_events to authenticated;
grant select, insert, update, delete on public.writing_features to authenticated;
grant select, insert, update, delete on public.cognitive_probe_features to authenticated;
grant select, insert, update, delete on public.entry_research_links to authenticated;
grant select, insert, update, delete on public.model_runs to authenticated;
grant select, insert, update, delete on public.extractions to authenticated;
grant select, insert, update, delete on public.graph_versions to authenticated;
grant select, insert, update, delete on public.graph_change_events to authenticated;
grant select, insert, update, delete on public.entry_embeddings to authenticated;
grant select, insert, update, delete on public.retrieval_events to authenticated;
grant select, insert, update, delete on public.chat_sessions to authenticated;
grant select, insert, update, delete on public.chat_messages to authenticated;
grant select, insert, update, delete on public.longitudinal_features to authenticated;
grant select, insert, update, delete on public.eval_examples to authenticated;
grant select, insert, update, delete on public.export_jobs to authenticated;
grant execute on function public.match_entry_embeddings(extensions.vector, integer) to authenticated;
