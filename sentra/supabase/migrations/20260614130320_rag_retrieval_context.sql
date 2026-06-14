create index if not exists graph_versions_nodes_json_gin_idx
  on public.graph_versions using gin (nodes_json jsonb_path_ops);

create index if not exists graph_versions_relations_json_gin_idx
  on public.graph_versions using gin (relations_json jsonb_path_ops);

drop function if exists public.match_entry_embeddings(extensions.vector, integer);

create or replace function public.match_entry_embeddings(
  query_embedding extensions.vector(1536),
  match_count integer default 5,
  participant_filter uuid default null,
  content_kinds text[] default null,
  min_similarity double precision default 0
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
    and (participant_filter is null or entry_embeddings.participant_id = participant_filter)
    and (content_kinds is null or entry_embeddings.content_kind = any(content_kinds))
    and (1 - (entry_embeddings.embedding <=> query_embedding)) >= min_similarity
  order by entry_embeddings.embedding <=> query_embedding
  limit greatest(1, least(match_count, 50));
$$;

create or replace function public.match_graph_patterns(
  query_terms text[],
  match_count integer default 5,
  participant_filter uuid default null
)
returns table (
  graph_version_id uuid,
  entry_id uuid,
  graph_snapshot_id uuid,
  participant_id uuid,
  version_index integer,
  pattern_score double precision,
  matched_terms text[],
  nodes_json jsonb,
  relations_json jsonb,
  summary_json jsonb,
  created_at timestamptz
)
language sql
stable
security invoker
set search_path = public
as $$
  with normalized_terms as (
    select distinct lower(trim(term)) as term
    from unnest(query_terms) as term
    where trim(term) <> ''
  ),
  scored as (
    select
      graph_versions.id,
      graph_versions.entry_id,
      graph_versions.graph_snapshot_id,
      graph_versions.participant_id,
      graph_versions.version_index,
      graph_versions.nodes_json,
      graph_versions.relations_json,
      graph_versions.summary_json,
      graph_versions.created_at,
      coalesce(sum(
        case
          when lower(graph_versions.nodes_json::text) like '%' || normalized_terms.term || '%' then 1.0
          else 0.0
        end
        +
        case
          when lower(graph_versions.relations_json::text) like '%' || normalized_terms.term || '%' then 1.5
          else 0.0
        end
      ), 0.0) as pattern_score,
      array_remove(array_agg(
        case
          when lower(graph_versions.nodes_json::text) like '%' || normalized_terms.term || '%'
            or lower(graph_versions.relations_json::text) like '%' || normalized_terms.term || '%'
          then normalized_terms.term
          else null
        end
      ), null) as matched_terms
    from public.graph_versions
    cross join normalized_terms
    where graph_versions.owner_user_id = (select auth.uid())
      and (participant_filter is null or graph_versions.participant_id = participant_filter)
    group by graph_versions.id
  )
  select
    scored.id as graph_version_id,
    scored.entry_id,
    scored.graph_snapshot_id,
    scored.participant_id,
    scored.version_index,
    scored.pattern_score,
    scored.matched_terms,
    scored.nodes_json,
    scored.relations_json,
    scored.summary_json,
    scored.created_at
  from scored
  where scored.pattern_score > 0
  order by scored.pattern_score desc, scored.created_at desc
  limit greatest(1, least(match_count, 50));
$$;

grant execute on function public.match_entry_embeddings(extensions.vector, integer, uuid, text[], double precision) to authenticated;
grant execute on function public.match_graph_patterns(text[], integer, uuid) to authenticated;
