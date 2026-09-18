begin;
do $$
declare
  target text;
begin
  if has_function_privilege('anon', 'public.bootstrap_org_admin()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.bootstrap_org_admin()', 'EXECUTE') then
    raise exception 'trigger-only bootstrap is callable by client roles';
  end if;
  foreach target in array array['stamp_research_consent_revocation', 'reject_pilot_event_mutation'] loop
    if not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
        lateral unnest(p.proconfig) setting
      where n.nspname = 'public' and p.proname = target and setting like 'search_path=%'
    ) then
      raise exception 'trigger % has no fixed search_path', target;
    end if;
  end loop;
  if has_table_privilege('authenticated', 'public.pilot_self_reports', 'TRUNCATE')
     or has_table_privilege('authenticated', 'public.pilot_pii_reviews', 'TRUNCATE') then
    raise exception 'client role can truncate research tables';
  end if;
end $$;
rollback;
