-- Dry-run seed for the pilot launch gate (#168).
--
-- Ten accounts, one per row of docs/pilot/dry-run/scenario-matrix.json, with
-- fixed uuids so the reconciliation queries and the smoke suite can name them.
--
-- Usage (LOCAL or the dedicated pilot environment — never production):
--   supabase db reset
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/seed/pilot_dry_run.seed.sql
--   node frontend/scripts/dry-run-invitations.mjs | psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1
--
-- What this seed does and does not do:
--
--   * It creates the study and the accounts. The invitations come from
--     frontend/scripts/dry-run-invitations.mjs, run after this file. It does NOT walk
--     the enrollment state machine — that is the point of the dry run. An
--     account arrives here at `account_bound` at most, and every transition
--     after that has to happen through the real routes, driven by a person or
--     by the smoke suite.
--   * Journal text is synthetic and written for this file. Account 10 carries a
--     crisis-shaped passage so the runbook exercise has something to run on;
--     it describes no one.
--   * Re-runnable: fixed uuids are deleted first. CI applies it twice to a
--     freshly reset database (scripts/dry_run_sql_smoke.sh, #384).

begin;

-- ---------------------------------------------------------------------------
-- Clean previous dry-run rows.
-- ---------------------------------------------------------------------------

delete from public.pilot_studies where slug = 'dry-run-2026';
delete from auth.users where id in (
  '22222222-0000-0000-0000-000000000001',
  '22222222-0000-0000-0000-000000000002',
  '22222222-0000-0000-0000-000000000003',
  '22222222-0000-0000-0000-000000000004',
  '22222222-0000-0000-0000-000000000005',
  '22222222-0000-0000-0000-000000000006',
  '22222222-0000-0000-0000-000000000007',
  '22222222-0000-0000-0000-000000000008',
  '22222222-0000-0000-0000-000000000009',
  '22222222-0000-0000-0000-000000000010'
);

-- ---------------------------------------------------------------------------
-- The study. `is_dry_run` is what keeps these rows out of the real cohort's
-- counts, and `status='recruiting'` is what lets invitations be redeemed.
-- ---------------------------------------------------------------------------

insert into public.pilot_studies (
  id, slug, title, status, protocol_version, consent_document_version,
  baseline_days, observation_days, is_dry_run, opens_at, closes_at
) values (
  '22222222-1111-0000-0000-000000000000',
  'dry-run-2026',
  '10テストアカウント×3日のdry run',
  'recruiting',
  'pilot-protocol-v1',
  'research-consent-doc-v1',
  -- Three days, not 14+7: the dry run proves the paths, not the study design.
  2, 1,
  true,
  now(), now() + interval '14 days'
);

-- ---------------------------------------------------------------------------
-- Ten accounts.
-- ---------------------------------------------------------------------------

insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                        email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
                        created_at, updated_at)
select
  '00000000-0000-0000-0000-000000000000',
  ('22222222-0000-0000-0000-0000000000' || lpad(n::text, 2, '0'))::uuid,
  'authenticated', 'authenticated',
  'dryrun-' || lpad(n::text, 2, '0') || '@pilot.test.local',
  crypt('dry-run-blesc-2026', gen_salt('bf')),
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb,
  now(), now()
from generate_series(1, 10) as n;

insert into public.participants (id, owner_user_id, code)
select
  ('22222222-3333-0000-0000-0000000000' || lpad(n::text, 2, '0'))::uuid,
  ('22222222-0000-0000-0000-0000000000' || lpad(n::text, 2, '0'))::uuid,
  'DRYRUN_' || lpad(n::text, 2, '0')
from generate_series(1, 10) as n;

-- ---------------------------------------------------------------------------
-- Invitations are NOT created here. The stored value is HMAC-SHA256(code)
-- under PILOT_INVITE_HMAC_KEY, which SQL does not have and must not be given.
-- Run, with the key of the deployment under test:
--
--     node frontend/scripts/dry-run-invitations.mjs | psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1
--
-- This file used to insert sha256(code) for codes shaped `DRYRUN-0001`. The
-- redeem route computes neither that hash nor accepts that shape, so no
-- account could get past the first step.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Synthetic journal text, held here rather than in the smoke suite so the
-- exercise uses the same words every time it is run and the crisis passage is
-- reviewable in one place before anybody sees it.
-- ---------------------------------------------------------------------------

-- Dropped and recreated rather than `create if not exists`, so a change to
-- its shape here reaches a database that already has the old one.
drop table if exists public.dry_run_fixture_text;

create table public.dry_run_fixture_text (
  scenario_id integer not null,
  day integer not null,
  body text not null,
  primary key (scenario_id, day)
);

-- Read by the operator and the smoke suite through the service role only. A
-- table in `public` is otherwise reachable through the Data API.
alter table public.dry_run_fixture_text enable row level security;
revoke all on public.dry_run_fixture_text from public, anon, authenticated;

insert into public.dry_run_fixture_text (scenario_id, day, body) values
  (1, 1, '朝は普通だった。授業のあと、部活で先輩に少し注意された。帰りにコンビニで買い食いした。'),
  (1, 2, '数学の小テストが返ってきた。思ったより悪かったけど、まあこんなものかとも思う。'),
  (1, 3, '今日は特に何もなかった。よく寝た気がする。'),
  (2, 1, '新しいクラスにまだ慣れない。話しかけられると少し緊張する。'),
  (2, 2, '昼休みに一人でいた。別に嫌ではなかった。'),
  (2, 3, '母と進路の話をした。まだ決まらない。'),
  (7, 1, 'テスト前で落ち着かない。夜あまり眠れなかった。'),
  (7, 2, 'やっぱりこの研究は続けないことにした。'),
  (8, 1, '電車が止まって遅刻した。書こうとしたら通信が切れた。'),
  (9, 1, '同じ内容を二回送ってしまった気がする。'),
  (10, 1, '最近ずっとしんどい。何をしても意味がない気がする。'),
  -- Scenario 10 day 2: the crisis-shaped passage the runbook exercise runs on.
  -- Written for this file. It is not a real person's words, and the staff
  -- member submitting it knows it is an exercise.
  (10, 2, 'もう全部どうでもいい。自分がいなくなればいいのにと思うことがある。誰にも言えない。'),
  (10, 3, '昨日書いたことは、まだそのままだけど、少し落ち着いた。');

comment on table public.dry_run_fixture_text is
  'Synthetic journal text for the pilot dry run (#168). No real participant text. Dropped with the dry-run study.';

commit;
