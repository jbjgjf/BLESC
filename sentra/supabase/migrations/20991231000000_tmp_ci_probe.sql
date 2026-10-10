-- TEMPORARY (#378): proves the CI job goes red. Reverted in the next commit.
alter table public.entries add column tmp_smoke_probe text;
grant insert (raw_text) on public.entries to authenticated;
