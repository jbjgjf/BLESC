-- Educator access accountability + column-minimized roster reads
-- (issues #31 and #29, epic #25 P2/P4).

-- ---------------------------------------------------------------------------
-- educator_access_log: append-only record of every educator view of a
-- student's data. Immutable by design: no UPDATE or DELETE policy exists for
-- any role. Students can always see who looked at their data.
-- ---------------------------------------------------------------------------

create table if not exists public.educator_access_log (
  id uuid primary key default gen_random_uuid(),
  educator_user_id uuid not null references auth.users(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  participant_id uuid not null,
  owner_user_id uuid not null,
  view_type text not null check (view_type in ('roster', 'alerts', 'student_overview', 'alert_ack')),
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  constraint educator_access_log_participant_owner_fk
    foreign key (participant_id, owner_user_id)
    references public.participants(id, owner_user_id)
    on delete cascade
);

create index if not exists educator_access_log_participant_idx
  on public.educator_access_log(participant_id, occurred_at desc);
create index if not exists educator_access_log_educator_idx
  on public.educator_access_log(educator_user_id, occurred_at desc);
create index if not exists educator_access_log_owner_idx
  on public.educator_access_log(owner_user_id, occurred_at desc);

alter table public.educator_access_log enable row level security;

-- Educators may only log their own, currently-authorized views.
create policy "educator_access_log_insert_own" on public.educator_access_log
  for insert to authenticated
  with check (
    educator_user_id = (select auth.uid())
    and public.is_org_member(org_id)
    and public.educator_oversees(participant_id)
  );

-- Educators see their own trail; students see everything about them;
-- org admins see their org's trail.
create policy "educator_access_log_select_scoped" on public.educator_access_log
  for select to authenticated
  using (
    educator_user_id = (select auth.uid())
    or owner_user_id = (select auth.uid())
    or public.is_org_admin(org_id)
  );

grant select, insert on public.educator_access_log to authenticated;

-- ---------------------------------------------------------------------------
-- overseen_participants(): column-minimized roster read. Educators never get
-- a row policy on public.participants (its notes column is student-private);
-- this security definer function exposes only id, code, and display_name for
-- actively rostered AND consented students.
-- ---------------------------------------------------------------------------

create or replace function public.overseen_participants()
returns table (participant_id uuid, org_id uuid, owner_user_id uuid, code text, display_name text)
language sql
security definer
set search_path = public
stable
as $$
  select p.id, r.org_id, r.owner_user_id, p.code, p.display_name
  from public.oversight_roster r
  join public.participants p on p.id = r.participant_id
  where r.educator_user_id = (select auth.uid())
    and r.status = 'active'
    and public.educator_oversees(p.id);
$$;

revoke execute on function public.overseen_participants() from public, anon;
grant execute on function public.overseen_participants() to authenticated;
