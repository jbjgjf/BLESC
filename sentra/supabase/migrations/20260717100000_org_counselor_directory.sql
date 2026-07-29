-- Minimized counselor directory for the student share picker.
-- Students cannot read organization_members (asserted in the RLS suite);
-- this security definer function exposes ONLY user id + display label of
-- active educator-role members, and only for orgs where the caller has a
-- roster row (i.e. orgs that requested oversight of them).

create or replace function public.org_counselors(target_org uuid)
returns table (counselor_user_id uuid, display_label text)
language sql
security definer
set search_path = public
stable
as $$
  select m.member_user_id,
         coalesce(p.display_name, 'Counselor') as display_label
  from public.organization_members m
  left join public.profiles p on p.id = m.member_user_id
  where m.org_id = target_org
    and m.role = 'educator'
    and m.status = 'active'
    and exists (
      select 1 from public.oversight_roster r
      where r.org_id = target_org
        and r.owner_user_id = (select auth.uid())
    );
$$;

revoke execute on function public.org_counselors(uuid) from public, anon;
grant execute on function public.org_counselors(uuid) to authenticated;
