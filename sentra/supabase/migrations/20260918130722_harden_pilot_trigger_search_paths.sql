-- Trigger-only routines must not be a public RPC surface.
alter function public.stamp_research_consent_revocation() set search_path = pg_catalog, public;
alter function public.reject_pilot_event_mutation() set search_path = pg_catalog, public;
revoke execute on function public.bootstrap_org_admin() from public, anon, authenticated;
