-- Student-granted oversight consent (issue #27).
--
-- Educator oversight is opt-in and revocable by the student (epic #25,
-- P1 default-deny / P5 revocable): an educator's roster link alone is no
-- longer enough — the student must hold an ACTIVE consent row for the org
-- (optionally scoped to a single educator). Revocation cuts access on the
-- next read, enforced in RLS via educator_oversees().

create table if not exists public.oversight_consents (
  id uuid primary key default gen_random_uuid(),
  participant_id uuid not null,
  owner_user_id uuid not null,
  org_id uuid not null references public.organizations(id) on delete cascade,
  -- Null = consent covers any actively rostered educator in the org.
  educator_user_id uuid references auth.users(id) on delete cascade,
  scope text not null default 'derived_signals' check (scope in ('derived_signals')),
  status text not null default 'active' check (status in ('active', 'revoked')),
  consent_version text not null default 'oversight-consent-v1',
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint oversight_consents_participant_owner_fk
    foreign key (participant_id, owner_user_id)
    references public.participants(id, owner_user_id)
    on delete cascade
);

-- One consent row per participant/org/educator combination (org-wide rows
-- use the zero uuid sentinel so null educators are unique too).
create unique index if not exists oversight_consents_unique_scope_idx
  on public.oversight_consents(
    participant_id,
    org_id,
    coalesce(educator_user_id, '00000000-0000-0000-0000-000000000000')
  );

create index if not exists oversight_consents_org_status_idx
  on public.oversight_consents(org_id, status);
create index if not exists oversight_consents_owner_idx
  on public.oversight_consents(owner_user_id, status);

create trigger oversight_consents_set_updated_at before update on public.oversight_consents
for each row execute function public.set_updated_at();

-- Keep revoked_at coherent with status transitions.
create or replace function public.stamp_consent_revocation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status = 'revoked' and old.status <> 'revoked' then
    new.revoked_at := now();
  elsif new.status = 'active' then
    new.revoked_at := null;
  end if;
  return new;
end;
$$;

create trigger oversight_consents_stamp_revocation before update on public.oversight_consents
for each row execute function public.stamp_consent_revocation();

-- ---------------------------------------------------------------------------
-- RLS: the student owns their consent; org staff may only observe status.
-- ---------------------------------------------------------------------------

alter table public.oversight_consents enable row level security;

create policy "oversight_consents_select_scoped" on public.oversight_consents
  for select to authenticated
  using (owner_user_id = (select auth.uid()) or public.is_org_member(org_id));

create policy "oversight_consents_insert_own" on public.oversight_consents
  for insert to authenticated
  with check (owner_user_id = (select auth.uid()));

create policy "oversight_consents_update_own" on public.oversight_consents
  for update to authenticated
  using (owner_user_id = (select auth.uid()))
  with check (owner_user_id = (select auth.uid()));

create policy "oversight_consents_delete_own" on public.oversight_consents
  for delete to authenticated
  using (owner_user_id = (select auth.uid()));

grant select, insert, update, delete on public.oversight_consents to authenticated;

-- ---------------------------------------------------------------------------
-- Default-deny: educator_oversees() now ALSO requires an active consent for
-- the same org (org-wide, or scoped to this educator).
-- ---------------------------------------------------------------------------

create or replace function public.educator_oversees(target_participant uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.oversight_roster r
    join public.organization_members m
      on m.org_id = r.org_id
     and m.member_user_id = (select auth.uid())
     and m.status = 'active'
    join public.oversight_consents c
      on c.participant_id = r.participant_id
     and c.org_id = r.org_id
     and c.status = 'active'
     and (c.educator_user_id is null or c.educator_user_id = r.educator_user_id)
    where r.participant_id = target_participant
      and r.educator_user_id = (select auth.uid())
      and r.status = 'active'
  );
$$;

-- ---------------------------------------------------------------------------
-- Transparency: a student with a roster row pointing at their participant may
-- read that organization's name (they must know who is requesting/holding
-- oversight in order to grant, deny, or revoke consent).
-- ---------------------------------------------------------------------------

create or replace function public.student_is_rostered_in(target_org uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.oversight_roster r
    where r.org_id = target_org
      and r.owner_user_id = (select auth.uid())
  );
$$;

revoke execute on function public.student_is_rostered_in(uuid) from public, anon;
grant execute on function public.student_is_rostered_in(uuid) to authenticated;

create policy "organizations_select_rostered_student" on public.organizations
  for select to authenticated
  using (public.student_is_rostered_in(id));
