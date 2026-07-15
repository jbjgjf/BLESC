-- Educator / organization oversight foundations (issue #26).
--
-- Adds the multi-tenant primitives that let an educator (a distinct auth
-- user) be linked to the students they oversee, with least privilege
-- enforced in the database:
--   * organizations           — a school / program tenant
--   * organization_members    — educator | org_admin membership
--   * oversight_roster        — educator <-> participant links (pending/active/revoked)
--
-- Access principles (see epic #25):
--   P2 data minimization — educators get NO policy on public.entries, so raw
--     journal/chat text is unreachable. Educator reads are limited to derived
--     rows: public.insights and safety-assessment rows in public.model_runs.
--   P6 least privilege — all educator access requires BOTH an active org
--     membership AND an active roster link. Educators get no write policies
--     on any student data.
--   Student-granted consent gating (P1/P5) lands with oversight_consents in
--   issue #27 and will tighten educator_oversees() further.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 120),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.organization_members (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  member_user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('educator', 'org_admin')),
  status text not null default 'active' check (status in ('active', 'revoked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, member_user_id)
);

create table if not exists public.oversight_roster (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  educator_user_id uuid not null references auth.users(id) on delete cascade,
  participant_id uuid not null,
  owner_user_id uuid not null,
  status text not null default 'pending' check (status in ('pending', 'active', 'revoked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, educator_user_id, participant_id),
  constraint oversight_roster_participant_owner_fk
    foreign key (participant_id, owner_user_id)
    references public.participants(id, owner_user_id)
    on delete cascade
);

create index if not exists organization_members_member_idx
  on public.organization_members(member_user_id, status);
create index if not exists organization_members_org_idx
  on public.organization_members(org_id, role, status);
create index if not exists oversight_roster_educator_idx
  on public.oversight_roster(educator_user_id, status);
create index if not exists oversight_roster_participant_idx
  on public.oversight_roster(participant_id, status);
create index if not exists oversight_roster_org_idx
  on public.oversight_roster(org_id, status);

create trigger organizations_set_updated_at before update on public.organizations
for each row execute function public.set_updated_at();

create trigger organization_members_set_updated_at before update on public.organization_members
for each row execute function public.set_updated_at();

create trigger oversight_roster_set_updated_at before update on public.oversight_roster
for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Helper functions (security definer so policies can consult membership
-- without RLS self-recursion; search_path pinned per Supabase guidance)
-- ---------------------------------------------------------------------------

create or replace function public.is_org_member(target_org uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.organization_members m
    where m.org_id = target_org
      and m.member_user_id = (select auth.uid())
      and m.status = 'active'
  );
$$;

create or replace function public.is_org_admin(target_org uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.organization_members m
    where m.org_id = target_org
      and m.member_user_id = (select auth.uid())
      and m.role = 'org_admin'
      and m.status = 'active'
  );
$$;

-- True when the calling user is an active educator/org_admin member of an
-- org that holds an ACTIVE roster link to this participant, assigned to them.
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
    where r.participant_id = target_participant
      and r.educator_user_id = (select auth.uid())
      and r.status = 'active'
  );
$$;

revoke execute on function public.is_org_member(uuid) from public, anon;
revoke execute on function public.is_org_admin(uuid) from public, anon;
revoke execute on function public.educator_oversees(uuid) from public, anon;
grant execute on function public.is_org_member(uuid) to authenticated;
grant execute on function public.is_org_admin(uuid) to authenticated;
grant execute on function public.educator_oversees(uuid) to authenticated;

-- Bootstrap: whoever creates an organization becomes its first org_admin.
-- Security definer so the insert passes organization_members RLS.
create or replace function public.bootstrap_org_admin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.organization_members (org_id, member_user_id, role, status)
  values (new.id, new.created_by, 'org_admin', 'active')
  on conflict (org_id, member_user_id) do nothing;
  return new;
end;
$$;

create trigger organizations_bootstrap_admin after insert on public.organizations
for each row execute function public.bootstrap_org_admin();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.oversight_roster enable row level security;

-- organizations: members can see their org; only the creator can create one
-- (and must stamp themselves); only org_admins can change or remove it.
create policy "organizations_select_member" on public.organizations
  for select to authenticated
  using (public.is_org_member(id) or created_by = (select auth.uid()));

create policy "organizations_insert_creator" on public.organizations
  for insert to authenticated
  with check (created_by = (select auth.uid()));

create policy "organizations_update_admin" on public.organizations
  for update to authenticated
  using (public.is_org_admin(id))
  with check (public.is_org_admin(id));

create policy "organizations_delete_admin" on public.organizations
  for delete to authenticated
  using (public.is_org_admin(id));

-- organization_members: visible to fellow org members and to the member
-- themselves; only org_admins manage membership.
create policy "organization_members_select_member" on public.organization_members
  for select to authenticated
  using (member_user_id = (select auth.uid()) or public.is_org_member(org_id));

create policy "organization_members_insert_admin" on public.organization_members
  for insert to authenticated
  with check (public.is_org_admin(org_id));

create policy "organization_members_update_admin" on public.organization_members
  for update to authenticated
  using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

create policy "organization_members_delete_admin" on public.organization_members
  for delete to authenticated
  using (public.is_org_admin(org_id));

-- oversight_roster: educators see their own assignments; org_admins see and
-- manage the org's roster; students always see (transparency, P4) roster rows
-- that point at their own participants. Only org_admins write.
create policy "oversight_roster_select_scoped" on public.oversight_roster
  for select to authenticated
  using (
    educator_user_id = (select auth.uid())
    or owner_user_id = (select auth.uid())
    or public.is_org_admin(org_id)
  );

create policy "oversight_roster_insert_admin" on public.oversight_roster
  for insert to authenticated
  with check (public.is_org_admin(org_id));

create policy "oversight_roster_update_admin" on public.oversight_roster
  for update to authenticated
  using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

create policy "oversight_roster_delete_admin" on public.oversight_roster
  for delete to authenticated
  using (public.is_org_admin(org_id));

-- ---------------------------------------------------------------------------
-- Educator read access to DERIVED student data only.
-- No policy is added on public.entries (raw_text stays unreachable) and no
-- educator write policy is added anywhere.
-- ---------------------------------------------------------------------------

-- insights: anomaly scores / explanations — derived, contains no raw text.
create policy "insights_select_oversight" on public.insights
  for select to authenticated
  using (public.educator_oversees(participant_id));

-- model_runs: safety assessments only (risk level, reasons, policy refs,
-- hashes). Other artifact types (extraction provenance etc.) stay owner-only.
create policy "model_runs_select_oversight_safety" on public.model_runs
  for select to authenticated
  using (
    artifact_type = 'safety_assessment'
    and public.educator_oversees(participant_id)
  );

grant select, insert, update, delete on public.organizations to authenticated;
grant select, insert, update, delete on public.organization_members to authenticated;
grant select, insert, update, delete on public.oversight_roster to authenticated;
