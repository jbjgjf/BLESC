-- Normalized Graph RAG index (graph_nodes/graph_edges) and discrete 30-turn
-- recall memory objects (conversation_memory_objects), replacing snapshot-level
-- token-overlap scoring and single-blob recall summaries. graph_snapshots,
-- graph_versions, and conversation_recall_summaries are untouched except for
-- one additive, nullable-safe column on conversation_recall_summaries.

create table if not exists public.graph_nodes (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  node_key text not null,
  category text not null,
  label text not null default '',
  embedding_model text not null default 'not_generated',
  embedding extensions.vector(1536),
  embedding_status text not null default 'pending_no_openai_key',
  confidence double precision not null default 1.0,
  intensity double precision not null default 0.5,
  occurrence_count integer not null default 0,
  first_seen_day date,
  last_seen_day date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_user_id, participant_id, node_key),
  constraint graph_nodes_participant_owner_fk
    foreign key (participant_id, owner_user_id)
    references public.participants(id, owner_user_id)
    on delete cascade
);

create table if not exists public.graph_edges (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  source_node_id uuid not null references public.graph_nodes(id) on delete cascade,
  target_node_id uuid not null references public.graph_nodes(id) on delete cascade,
  relation_type text not null default 'co_occurs',
  embedding_model text not null default 'not_generated',
  embedding extensions.vector(1536),
  embedding_status text not null default 'pending_no_openai_key',
  confidence double precision not null default 1.0,
  mean_confidence double precision not null default 1.0,
  confidence_count integer not null default 0,
  occurrence_count integer not null default 0,
  first_seen_day date,
  last_seen_day date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_user_id, participant_id, source_node_id, target_node_id, relation_type),
  constraint graph_edges_participant_owner_fk
    foreign key (participant_id, owner_user_id)
    references public.participants(id, owner_user_id)
    on delete cascade
);

create table if not exists public.conversation_memory_objects (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  window_id uuid references public.conversation_recall_summaries(id) on delete set null,
  source_message_ids_json jsonb not null default '[]'::jsonb,
  topic text not null default '',
  summary text not null default '',
  emotional_tone_json jsonb not null default '{}'::jsonb,
  importance_score double precision not null default 0,
  score_breakdown_json jsonb not null default '{}'::jsonb,
  recurrence_score double precision not null default 0,
  recurrence_count integer not null default 0,
  confidence_score double precision not null default 0,
  extraction_mode text not null default 'deterministic_fallback',
  embedding_model text not null default 'not_generated',
  embedding extensions.vector(1536),
  embedding_status text not null default 'pending_no_openai_key',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_reinforced_at timestamptz not null default now(),
  merged_into_id uuid references public.conversation_memory_objects(id) on delete set null,
  merge_reason text,
  superseded_by_id uuid references public.conversation_memory_objects(id) on delete set null,
  contradiction_status text not null default 'none',
  contradiction_detail_json jsonb not null default '{}'::jsonb,
  pipeline_version text not null default 'conversation-memory-object-v1',
  constraint conversation_memory_objects_participant_owner_fk
    foreign key (participant_id, owner_user_id)
    references public.participants(id, owner_user_id)
    on delete cascade
);

alter table public.conversation_recall_summaries
  add column if not exists memory_object_ids_json jsonb not null default '[]'::jsonb;

create index if not exists graph_nodes_owner_participant_category_idx
  on public.graph_nodes(owner_user_id, participant_id, category);
create index if not exists graph_nodes_embedding_hnsw_idx
  on public.graph_nodes using hnsw (embedding vector_cosine_ops);
create index if not exists graph_edges_owner_participant_type_idx
  on public.graph_edges(owner_user_id, participant_id, relation_type);
create index if not exists graph_edges_source_node_idx on public.graph_edges(source_node_id);
create index if not exists graph_edges_target_node_idx on public.graph_edges(target_node_id);
create index if not exists graph_edges_embedding_hnsw_idx
  on public.graph_edges using hnsw (embedding vector_cosine_ops);
create index if not exists conversation_memory_objects_owner_participant_created_idx
  on public.conversation_memory_objects(owner_user_id, participant_id, created_at desc);
create index if not exists conversation_memory_objects_window_idx
  on public.conversation_memory_objects(window_id);
create index if not exists conversation_memory_objects_embedding_hnsw_idx
  on public.conversation_memory_objects using hnsw (embedding vector_cosine_ops);

create or replace function public.match_graph_nodes(
  query_embedding extensions.vector(1536),
  match_count integer default 8,
  participant_filter uuid default null
)
returns table (
  id uuid,
  participant_id uuid,
  node_key text,
  category text,
  label text,
  confidence double precision,
  intensity double precision,
  occurrence_count integer,
  similarity double precision,
  last_seen_day date
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select
    graph_nodes.id,
    graph_nodes.participant_id,
    graph_nodes.node_key,
    graph_nodes.category,
    graph_nodes.label,
    graph_nodes.confidence,
    graph_nodes.intensity,
    graph_nodes.occurrence_count,
    1 - (graph_nodes.embedding <=> query_embedding) as similarity,
    graph_nodes.last_seen_day
  from public.graph_nodes
  where graph_nodes.owner_user_id = (select auth.uid())
    and graph_nodes.embedding is not null
    and (participant_filter is null or graph_nodes.participant_id = participant_filter)
  order by graph_nodes.embedding <=> query_embedding
  limit greatest(1, least(match_count, 50));
$$;

create or replace function public.match_graph_edges(
  query_embedding extensions.vector(1536),
  match_count integer default 8,
  participant_filter uuid default null
)
returns table (
  id uuid,
  participant_id uuid,
  source_node_id uuid,
  target_node_id uuid,
  relation_type text,
  mean_confidence double precision,
  occurrence_count integer,
  similarity double precision,
  last_seen_day date
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select
    graph_edges.id,
    graph_edges.participant_id,
    graph_edges.source_node_id,
    graph_edges.target_node_id,
    graph_edges.relation_type,
    graph_edges.mean_confidence,
    graph_edges.occurrence_count,
    1 - (graph_edges.embedding <=> query_embedding) as similarity,
    graph_edges.last_seen_day
  from public.graph_edges
  where graph_edges.owner_user_id = (select auth.uid())
    and graph_edges.embedding is not null
    and (participant_filter is null or graph_edges.participant_id = participant_filter)
  order by graph_edges.embedding <=> query_embedding
  limit greatest(1, least(match_count, 50));
$$;

create or replace function public.match_conversation_memory_objects(
  query_embedding extensions.vector(1536),
  match_count integer default 5,
  participant_filter uuid default null
)
returns table (
  id uuid,
  participant_id uuid,
  topic text,
  summary text,
  importance_score double precision,
  recurrence_score double precision,
  confidence_score double precision,
  contradiction_status text,
  similarity double precision,
  created_at timestamptz,
  last_reinforced_at timestamptz
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select
    conversation_memory_objects.id,
    conversation_memory_objects.participant_id,
    conversation_memory_objects.topic,
    conversation_memory_objects.summary,
    conversation_memory_objects.importance_score,
    conversation_memory_objects.recurrence_score,
    conversation_memory_objects.confidence_score,
    conversation_memory_objects.contradiction_status,
    1 - (conversation_memory_objects.embedding <=> query_embedding) as similarity,
    conversation_memory_objects.created_at,
    conversation_memory_objects.last_reinforced_at
  from public.conversation_memory_objects
  where conversation_memory_objects.owner_user_id = (select auth.uid())
    and conversation_memory_objects.embedding is not null
    and conversation_memory_objects.merged_into_id is null
    and conversation_memory_objects.contradiction_status <> 'superseded'
    and (participant_filter is null or conversation_memory_objects.participant_id = participant_filter)
  order by conversation_memory_objects.embedding <=> query_embedding
  limit greatest(1, least(match_count, 50));
$$;

alter table public.graph_nodes enable row level security;
alter table public.graph_edges enable row level security;
alter table public.conversation_memory_objects enable row level security;

create policy "graph_nodes_own_all" on public.graph_nodes for all to authenticated using ((select auth.uid()) = owner_user_id) with check ((select auth.uid()) = owner_user_id);
create policy "graph_edges_own_all" on public.graph_edges for all to authenticated using ((select auth.uid()) = owner_user_id) with check ((select auth.uid()) = owner_user_id);
create policy "conversation_memory_objects_own_all" on public.conversation_memory_objects for all to authenticated using ((select auth.uid()) = owner_user_id) with check ((select auth.uid()) = owner_user_id);

grant select, insert, update, delete on public.graph_nodes to authenticated;
grant select, insert, update, delete on public.graph_edges to authenticated;
grant select, insert, update, delete on public.conversation_memory_objects to authenticated;

grant execute on function public.match_graph_nodes(extensions.vector, integer, uuid) to authenticated;
grant execute on function public.match_graph_edges(extensions.vector, integer, uuid) to authenticated;
grant execute on function public.match_conversation_memory_objects(extensions.vector, integer, uuid) to authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
    and not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'conversation_memory_objects'
    )
  then
    alter publication supabase_realtime add table public.conversation_memory_objects;
  end if;
end $$;
