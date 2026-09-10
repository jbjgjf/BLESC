-- Dry-run seed for the pilot launch gate (#168).
--
-- Ten accounts, one per row of docs/pilot/dry-run/scenario-matrix.json, with
-- fixed uuids so the reconciliation queries and the smoke suite can name them.
--
-- Usage (LOCAL or the dedicated pilot environment — never production):
--   supabase db reset
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/seed/pilot_dry_run.seed.sql
--
-- What this seed does and does not do:
--
--   * It creates the study, the invitations and the accounts. It does NOT walk
--     the enrollment state machine — that is the point of the dry run. An
--     account arrives here at `account_bound` at most, and every transition
--     after that has to happen through the real routes, driven by a person or
--     by the smoke suite.
--   * Journal text is synthetic and written for this file. Account 10 carries a
--     crisis-shaped passage so the runbook exercise has something to run on;
--     it describes no one.
--   * Re-runnable: fixed uuids are deleted first.

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
-- Invitations. Codes are stored as a hash, never in the clear — the same rule
-- as production, because a dry run that relaxes it does not test the thing.
--
-- The plaintext codes are derived from the row number so the operator running
-- the exercise can reproduce them without a stored list:
--     DRYRUN-0001 .. DRYRUN-0010
-- Account 3's expires in the past and account 4's allows one redemption.
-- ---------------------------------------------------------------------------

insert into public.pilot_invitations (
  study_id, code_hash, code_prefix, cohort, max_redemptions, redeemed_count,
  expires_at, note
)
select
  '22222222-1111-0000-0000-000000000000',
  encode(digest('DRYRUN-' || lpad(n::text, 4, '0'), 'sha256'), 'hex'),
  'DRYRUN',
  case when n in (2, 6, 10) then 'minor' else 'adult' end,
  1,
  0,
  case when n = 3 then now() - interval '1 day' else now() + interval '14 days' end,
  'dry-run scenario ' || n
from generate_series(1, 10) as n;

-- ---------------------------------------------------------------------------
-- Synthetic journal text, held here rather than in the smoke suite so the
-- exercise uses the same words every time it is run and the crisis passage is
-- reviewable in one place before anybody sees it.
-- ---------------------------------------------------------------------------

create table if not exists public.dry_run_fixture_text (
  scenario_id integer primary key,
  day integer not null,
  body text not null
);

delete from public.dry_run_fixture_text;

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
