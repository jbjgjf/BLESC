-- Synthetic-user evaluation persistence.
--
-- Written ONLY by the server-side evaluation runner (service role, which
-- bypasses RLS). Authenticated clients get no INSERT/UPDATE/DELETE policy
-- on any evaluation table. Read access is granted per-user through
-- evaluation_access rows (role 'reviewer'). Reviewer and counselor
-- permissions are fully separate: nothing here grants oversight reads, and
-- counselor machinery grants nothing here.
--
-- All data in these tables is synthetic by contract
-- (data_classification=synthetic); no production users or content.

create table if not exists public.evaluation_access (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'reviewer' check (role in ('reviewer')),
  status text not null default 'active' check (status in ('active', 'revoked')),
  granted_by text,
  created_at timestamptz not null default now(),
  unique (user_id, role)
);

create table if not exists public.evaluation_runs (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  mode text not null check (mode in ('smoke', 'full')),
  status text not null default 'running'
    check (status in ('running', 'completed', 'aborted', 'failed')),
  verdict text check (verdict in ('ready', 'needs_attention', 'incomplete')),
  runner_version text not null default 'blesc-eval-v1',
  config_json jsonb not null default '{}'::jsonb,
  totals_json jsonb not null default '{}'::jsonb,
  gates_json jsonb not null default '{}'::jsonb,
  findings_json jsonb not null default '[]'::jsonb,
  recommended_actions_json jsonb not null default '[]'::jsonb,
  limitations text,
  estimated_cost_usd double precision,
  actual_cost_usd double precision,
  openai_trace_refs jsonb not null default '[]'::jsonb,
  openai_eval_refs jsonb not null default '[]'::jsonb,
  data_classification text not null default 'synthetic'
    check (data_classification = 'synthetic'),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.evaluation_cases (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.evaluation_runs(id) on delete cascade,
  case_key text not null,
  persona_id text not null,
  scenario_family text not null,
  seed integer not null,
  expected_json jsonb not null default '{}'::jsonb,
  transcript_json jsonb not null default '[]'::jsonb,
  turn_count integer not null default 0,
  deterministic_json jsonb not null default '{}'::jsonb,
  judge_json jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'running', 'passed', 'failed', 'incomplete', 'error')),
  failure_kinds jsonb not null default '[]'::jsonb,
  human_review boolean not null default false,
  human_review_reason text,
  trace_ref text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  unique (run_id, case_key)
);

create table if not exists public.evaluation_artifacts (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.evaluation_runs(id) on delete cascade,
  case_id uuid references public.evaluation_cases(id) on delete cascade,
  kind text not null check (kind in (
    'executive_html', 'executive_pdf', 'expert_csv', 'repro_jsonl',
    'failure_card', 'screenshot', 'video', 'log'
  )),
  content_type text not null default 'application/octet-stream',
  storage_path text,
  content_text text,
  bytes_sha256 text,
  created_at timestamptz not null default now()
);

create index if not exists evaluation_cases_run_idx
  on public.evaluation_cases(run_id, status);
create index if not exists evaluation_artifacts_run_idx
  on public.evaluation_artifacts(run_id, kind);
create index if not exists evaluation_access_user_idx
  on public.evaluation_access(user_id, status);

alter table public.evaluation_access enable row level security;
alter table public.evaluation_runs enable row level security;
alter table public.evaluation_cases enable row level security;
alter table public.evaluation_artifacts enable row level security;

create or replace function public.is_evaluation_reviewer()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.evaluation_access a
    where a.user_id = (select auth.uid())
      and a.role = 'reviewer'
      and a.status = 'active'
  );
$$;

revoke execute on function public.is_evaluation_reviewer() from public, anon;
grant execute on function public.is_evaluation_reviewer() to authenticated;

-- Reviewers can see their own grant; runs/cases/artifacts are read-only for
-- reviewers. No authenticated write policy exists anywhere below.
create policy "evaluation_access_select_own" on public.evaluation_access
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy "evaluation_runs_select_reviewer" on public.evaluation_runs
  for select to authenticated
  using (public.is_evaluation_reviewer());

create policy "evaluation_cases_select_reviewer" on public.evaluation_cases
  for select to authenticated
  using (public.is_evaluation_reviewer());

create policy "evaluation_artifacts_select_reviewer" on public.evaluation_artifacts
  for select to authenticated
  using (public.is_evaluation_reviewer());

grant select on public.evaluation_access to authenticated;
grant select on public.evaluation_runs to authenticated;
grant select on public.evaluation_cases to authenticated;
grant select on public.evaluation_artifacts to authenticated;
