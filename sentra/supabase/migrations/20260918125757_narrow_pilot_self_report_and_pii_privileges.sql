-- Explicitly narrow grants inherited from Supabase's default table privileges.
-- RLS does not filter TRUNCATE; SELECT-only grants alone do not revoke writes.
revoke all on public.pilot_self_reports from public, anon, authenticated;
revoke all on public.pilot_pii_reviews from public, anon, authenticated;
grant select on public.pilot_self_reports to authenticated;
-- Preserve the server-side writer/reviewer and the existing research reader.
grant select, insert, update, delete on public.pilot_self_reports to service_role;
grant select, insert, update, delete on public.pilot_pii_reviews to service_role;
grant select on public.pilot_self_reports to research_reader;
grant select on public.pilot_pii_reviews to research_reader;
