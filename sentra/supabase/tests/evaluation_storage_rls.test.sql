-- RLS tests for the evaluation-artifacts Storage bucket.
-- Run like the other suites:
--   docker exec -i supabase_db_sentra psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 < supabase/tests/evaluation_storage_rls.test.sql

begin;

insert into auth.users (id, email)
values
  ('00000000-0000-0000-0000-0000000000f1', 'storage-reviewer@test.local'),
  ('00000000-0000-0000-0000-0000000000f2', 'storage-counselor@test.local');

insert into public.evaluation_access (user_id, role, granted_by)
values ('00000000-0000-0000-0000-0000000000f1', 'reviewer', 'test-suite');

-- The runner writes objects with the service role (bypasses RLS), modeled
-- here as a superuser insert.
insert into storage.objects (bucket_id, name, owner)
values ('evaluation-artifacts', 'runs/suite/executive.pdf', null);

-- A reviewer reads artifacts.
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000f1", "role": "authenticated"}';

do $$
begin
  if (select count(*) from storage.objects where bucket_id = 'evaluation-artifacts' and name like 'runs/suite/%') <> 1 then
    raise exception 'reviewer must be able to read evaluation artifact objects';
  end if;
end $$;

-- A user without an evaluation_access row reads nothing, even though the
-- counselor machinery may grant them oversight elsewhere.
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000f2", "role": "authenticated"}';

do $$
begin
  if (select count(*) from storage.objects where bucket_id = 'evaluation-artifacts' and name like 'runs/suite/%') <> 0 then
    raise exception 'non-reviewer must not read evaluation artifact objects';
  end if;
end $$;

-- Nobody writes through RLS: authenticated users have no insert policy.
do $$
begin
  begin
    insert into storage.objects (bucket_id, name) values ('evaluation-artifacts', 'runs/suite/forged.pdf');
    raise exception 'authenticated insert into the evaluation bucket must be denied';
  exception
    when insufficient_privilege then null;
  end;
end $$;

-- Revoking reviewer access closes the bucket again.
reset role;
update public.evaluation_access set status = 'revoked'
where user_id = '00000000-0000-0000-0000-0000000000f1';

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000f1", "role": "authenticated"}';

do $$
begin
  if (select count(*) from storage.objects where bucket_id = 'evaluation-artifacts' and name like 'runs/suite/%') <> 0 then
    raise exception 'revoked reviewer must lose object access';
  end if;
end $$;

reset role;
rollback;
