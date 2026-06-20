create table if not exists public.conversation_recall_summaries (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  window_turn_count integer not null,
  message_start timestamptz,
  message_end timestamptz,
  summary_json jsonb not null default '{}'::jsonb,
  source_message_hashes_json jsonb not null default '[]'::jsonb,
  pipeline_version text not null default 'conversation-recall-30-v1',
  status text not null default 'completed',
  created_at timestamptz not null default now(),
  constraint conversation_recall_summaries_participant_owner_fk
    foreign key (participant_id, owner_user_id)
    references public.participants(id, owner_user_id)
    on delete cascade
);

alter table public.conversation_recall_summaries enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'conversation_recall_summaries'
      and policyname = 'conversation_recall_summaries_own_all'
  ) then
    create policy "conversation_recall_summaries_own_all"
      on public.conversation_recall_summaries
      for all
      to authenticated
      using ((select auth.uid()) = owner_user_id)
      with check ((select auth.uid()) = owner_user_id);
  end if;
end $$;

grant select, insert, update, delete on public.conversation_recall_summaries to authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
    and not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'conversation_recall_summaries'
    )
  then
    alter publication supabase_realtime add table public.conversation_recall_summaries;
  end if;
end $$;
