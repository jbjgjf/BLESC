-- 書きぶりの変化を、本人の過去と比べた「観測」として本番に置く (#468, 案B)。
--
-- ===========================================================================
-- 追加が中心。新しいテーブル1つ、既存の `writing_features` に列1つ、そして
-- `writing_features` の書き込み権限を `authenticated` から外す。既存の行は
-- 書き換えも削除もしないので、使うコードより先に適用してよい。
-- ===========================================================================
--
-- ## 何が無かったか
--
-- blesc.jp は「本文ではなく、本人の過去と比べた変化 ── 言葉づかいの変化と、
-- 入力のためらい・書き直しといった書く行動の変化 ── を捉え、教員には観測した
-- 変化と時刻と根拠だけを渡す」と書いている。
--
-- 書く行動の分析（`backend/app/analytics/writing_dynamics.py`）は FastAPI の
-- 研究経路にしか無く、FastAPI は本番に出ていない（ADR 0001）。本番の Next.js は
-- その入力となる telemetry を `entry_fields` / `interaction_events` に保存して
-- いたが、分析は一行も無かった。`writing_features` テーブルは 20260611000000 で
-- 作られたまま、本番では一度も書かれていない。
--
-- ## このマイグレーションが置くもの
--
-- 1. `writing_features.baseline_comparison_json`
--    本番の書き込み（`lib/server/supabaseWriter.ts`）が、日記欄の特徴量と
--    一緒に「本人の基準との比較」をまるごと残す列。z 値・本人の平均と標準偏差・
--    変化なしと判定した特徴量・退化した特徴量を含む。**研究記録であって、教員は
--    読めない**（このテーブルに教員向けの policy は無い）。
--
-- 2. `writing_change_observations`
--    教員が読める唯一の形。1 行 = 1 件の「書きぶりの変化」の観測で、持つのは
--    時刻・入力元（どの画面のどの欄か）・根拠（どの特徴量が本人の基準から
--    どちら向きに動いたか）だけ。**本文も、スコアも、z 値も、帯も持たない。**
--    `docs/educator_display_policy.md` の規則 1（分類を出さない）と規則 2
--    （根拠の無い観測は表示しない）を、画面ではなく保存の形で守る。根拠が空の
--    行は check 制約で入らない。
--
-- 3. `writing_features` の書き込み権限の縮小
--    20260611000000 は研究テーブルを一律 `*_own_all`（本人が自分の行を
--    insert/update/delete できる）にした。`writing_features` はこれから、教員に
--    見える観測を決める「本人の基準」の入力になる。生徒本人が API から自分の
--    過去の行を書き換えれば、観測を出すことも消すこともできてしまう。書くのは
--    service_role（サーバー）だけなので、本人には select だけを残す。
--
-- ## 誰が読めるか
--
--   - 本人: 自分の観測を select できる。生徒に隠して大人に何かを伝える仕組みは、
--     生徒が信頼できない（safety_escalations と同じ理由、20260916000000）。
--   - 教員: `educator_oversees(participant_id)`。名簿登録と本人の同意
--     （oversight_consents）が両方そろった生徒だけ。insights と同じ門。
--   - anon: 何も持たない。
--   - 書き込み: service_role のみ。
--
-- ## 収集専用モードと同意
--
-- このテーブルに行が入るのは、研究利用の同意（telemetry の保存と同じ門、
-- `telemetryAllowed`）があり、かつ収集期間の外であるときだけ。収集期間中は、
-- 特徴量（`writing_features` の数値、すでに保存している `entry_fields.metrics_json`
-- の言い換え）は残すが、本人の基準との比較も観測も作らない。ゲートは
-- アプリ側（`supabaseWriter.ts`）にあり、理由はそこに書いた。

-- ---------------------------------------------------------------------------
-- 1. 研究記録としての比較結果
-- ---------------------------------------------------------------------------

alter table public.writing_features
  add column if not exists baseline_comparison_json jsonb not null default '{}'::jsonb;

comment on column public.writing_features.baseline_comparison_json is
  '日記欄の書きぶりを本人の過去 14 日（基準を満たす日）と比べた結果。writing_dynamics_conformance.json の'
  ' change_cases と同じ形。z 値を含む研究記録であり、教員には渡さない（#468）。';

-- 基準の読み出し: 本人の、日記欄の、新しい順。
create index if not exists writing_features_participant_field_created_idx
  on public.writing_features(participant_id, field_name, created_at desc);

-- 本人による書き換えを止める（上の 3.）。select は残す。
drop policy if exists "writing_features_own_all" on public.writing_features;
drop policy if exists "writing_features_select_own" on public.writing_features;
create policy "writing_features_select_own" on public.writing_features
  for select to authenticated
  using ((select auth.uid()) = owner_user_id);

revoke all on public.writing_features from anon, authenticated;
grant select on public.writing_features to authenticated;
grant select, insert, update, delete on public.writing_features to service_role;

-- ---------------------------------------------------------------------------
-- 2. 教員が読める観測
-- ---------------------------------------------------------------------------

create table if not exists public.writing_change_observations (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  entry_id uuid not null references public.entries(id) on delete cascade,
  entry_session_id uuid references public.entry_sessions(id) on delete cascade,

  -- 観測の種類。いまは「書きぶりの変化」の 1 種だけ。教員画面の文言はこの値で引く。
  kind text not null default 'writing_change',

  -- 入力元。どの画面（surface）の、どの欄（field_name）で書かれたか。
  surface text not null default 'journal',
  field_name text not null,

  -- いつ書かれたか。entry_sessions.submitted_at（送信時刻）。
  observed_at timestamptz not null,

  -- 根拠: [{"feature": "max_pause_ms", "direction": "higher"}, ...]
  -- 特徴量の名前と向きだけ。値も z 値も入れない。
  evidence jsonb not null,

  -- 比べた本人の過去の日数（基準を満たした日）。「何と比べたか」の根拠。
  baseline_days integer not null,

  pipeline_version text not null,
  created_at timestamptz not null default now(),

  constraint writing_change_observations_participant_owner_fk
    foreign key (participant_id, owner_user_id)
    references public.participants(id, owner_user_id)
    on delete cascade,

  -- 再送（同じ client_submission_id）で二重にならない。
  unique (entry_id, field_name)
);

alter table public.writing_change_observations
  drop constraint if exists writing_change_observations_kind_check;
alter table public.writing_change_observations
  add constraint writing_change_observations_kind_check
  check (kind in ('writing_change'));

-- 規則 2: 根拠の無い観測は保存しない。
alter table public.writing_change_observations
  drop constraint if exists writing_change_observations_evidence_check;
alter table public.writing_change_observations
  add constraint writing_change_observations_evidence_check
  check (jsonb_typeof(evidence) = 'array' and jsonb_array_length(evidence) > 0);

-- 規則 4: 本人の基準が定まる前（14 日未満）の比較は無い。
alter table public.writing_change_observations
  drop constraint if exists writing_change_observations_baseline_days_check;
alter table public.writing_change_observations
  add constraint writing_change_observations_baseline_days_check
  check (baseline_days >= 14);

create index if not exists writing_change_observations_participant_idx
  on public.writing_change_observations(participant_id, observed_at desc);

alter table public.writing_change_observations enable row level security;

revoke all on public.writing_change_observations from anon, authenticated;

drop policy if exists writing_change_observations_select_own on public.writing_change_observations;
create policy writing_change_observations_select_own on public.writing_change_observations
  for select to authenticated
  using (owner_user_id = (select auth.uid()));

drop policy if exists writing_change_observations_select_educator on public.writing_change_observations;
create policy writing_change_observations_select_educator on public.writing_change_observations
  for select to authenticated
  using (public.educator_oversees(participant_id));

grant select on public.writing_change_observations to authenticated;
grant select, insert, update, delete on public.writing_change_observations to service_role;
