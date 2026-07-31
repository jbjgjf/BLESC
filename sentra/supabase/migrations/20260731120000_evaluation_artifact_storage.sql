-- Storage for evaluation artifacts.
--
-- Before this, evaluation_artifacts.storage_path held a path on the machine
-- that happened to run the evaluation ("artifacts/smoke-.../executive.pdf"),
-- which meant the PDF, the repro JSONL, and the session recordings never
-- reached anyone but the operator. The reports the reviewer dashboard is for
-- were, in practice, undeliverable.
--
-- Same permission shape as the evaluation tables: the runner writes with the
-- service role (which bypasses RLS); authenticated users get read only, and
-- only through an active evaluation_access reviewer row. Counselor and
-- educator roles grant nothing here. All content is synthetic by contract.

insert into storage.buckets (id, name, public)
values ('evaluation-artifacts', 'evaluation-artifacts', false)
on conflict (id) do nothing;

drop policy if exists "evaluation_artifacts_objects_select_reviewer" on storage.objects;
create policy "evaluation_artifacts_objects_select_reviewer"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'evaluation-artifacts'
    and public.is_evaluation_reviewer()
  );

-- No insert/update/delete policy is created on purpose: only the service-role
-- runner writes objects into this bucket.
