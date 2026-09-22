-- protocol §4.4 の目視レビューを回す先 (#225)。
--
-- §4.4 はこう書いてある: 「原文保存に個別同意した記録を、権限者が平日10時・16時
-- （日本時間）に目視確認する」。収集専用モードでは本文を外部AIへ送らないので、
-- 危機の判断は人がやる -- ところがその人が開く画面も、見たことを記録する場所も
-- 無かった。**決まりだけがあって、回す先が無い状態**だった。
--
-- ここで作るのは2つ。レビューの待ち行列と、本文を読んだことの記録である。
-- 後者は付け足しではない: このレビューは生徒の日記を人間が読む行為で、
-- §4.4 が参加者に約束しているのは「読む場合がある」ことの明示であって
-- 「誰がいつ読んだか分からない」ことではない。

-- ---------------------------------------------------------------------------
-- 1. 待ち行列
-- ---------------------------------------------------------------------------

create table if not exists public.pilot_crisis_reviews (
  id uuid primary key default gen_random_uuid(),

  owner_user_id uuid not null references auth.users(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,

  -- 1エントリ1行。再判定は行を置き換える（`pilot_pii_reviews` と同じ理由 --
  -- 待ち行列の長さが「判断が要る件数」であって「判定した回数」にならないように）。
  entry_id uuid not null unique references public.entries(id) on delete cascade,

  -- 機械側の初期判定。`src/lib/safety-assessment.ts` のローカル辞書による
  -- もので、外部AIには一切送っていない。
  --
  -- **これは並べ替えの手がかりであって、判断ではない。** 判断は人がする。
  -- 'none' の行がレビュー対象から消えないのはそのためで、辞書に無い言い方で
  -- 書かれた危機は機械側では 'none' になる。
  assessed_risk text not null default 'none',
  assessed_reasons text[] not null default '{}',
  assessor_version text not null,

  -- 'pending'      未レビュー
  -- 'no_concern'   読んだうえで、対応不要と判断した
  -- 'escalated'    学校担当へ連絡した（連絡そのものは incident-runbook §3）
  -- 'unreadable'   本文が読めない（未保存・期限切れ・復号不能）
  status text not null default 'pending',

  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,

  -- レビュアーの所見。**日記の本文を書き写さないこと。**
  -- ここに引用を貼ると、アクセス制御の違う2つ目の本文の写しができる --
  -- `pilot_pii_reviews.findings_json` が `text` を拒否しているのと同じ理由。
  -- 長さの上限はその抑止で、監査でも「短いこと」を見る。
  reviewer_note text,

  -- どのレビュー枠で見たか。§4.4 の平日10時・16時。
  -- 枠を跨いで放置された行を数えるために、判定時刻とは別に持つ。
  review_slot text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint pilot_crisis_reviews_status_check
    check (status in ('pending', 'no_concern', 'escalated', 'unreadable')),
  constraint pilot_crisis_reviews_risk_check
    check (assessed_risk in ('none', 'low', 'elevated', 'crisis')),
  constraint pilot_crisis_reviews_slot_check
    check (review_slot is null or review_slot in ('morning', 'afternoon', 'ad_hoc')),
  -- 所見は所見であって引用ではない。
  constraint pilot_crisis_reviews_note_length_check
    check (reviewer_note is null or char_length(reviewer_note) <= 500),
  -- 判定したなら、誰がいつ判定したかが必ず入る。
  constraint pilot_crisis_reviews_decided_is_attributed
    check (
      status = 'pending'
      or (reviewed_by is not null and reviewed_at is not null)
    )
);

create index if not exists pilot_crisis_reviews_queue_idx
  on public.pilot_crisis_reviews (status, assessed_risk desc, created_at);
create index if not exists pilot_crisis_reviews_participant_idx
  on public.pilot_crisis_reviews (participant_id);

-- ---------------------------------------------------------------------------
-- 2. 本文を読んだことの記録
-- ---------------------------------------------------------------------------

create table if not exists public.pilot_crisis_review_reads (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references public.pilot_crisis_reviews(id) on delete cascade,
  entry_id uuid not null references public.entries(id) on delete cascade,
  read_by uuid not null references auth.users(id) on delete cascade,
  read_at timestamptz not null default now(),
  -- 本文を実際に復号して返したのか、メタデータだけを見たのか。
  -- 待ち行列を眺めるのと、日記を読むのは別の行為である。
  included_raw_text boolean not null default false
);

create index if not exists pilot_crisis_review_reads_review_idx
  on public.pilot_crisis_review_reads (review_id, read_at desc);

-- ---------------------------------------------------------------------------
-- 3. 権限
-- ---------------------------------------------------------------------------
--
-- どちらのテーブルも service_role だけ。運営者の判定は
-- `PILOT_OPERATOR_USER_IDS` の許可リストで API 層が見ており、これは
-- 環境変数であってテーブルの行ではない -- 役割で開けると、誰も決めていない
-- のに役割を持つアカウントが生まれる。
--
-- 生徒にも教員にも開けない。教員が見るのは `educator_*` の経路で、
-- そこには本文が流れない。
alter table public.pilot_crisis_reviews enable row level security;
alter table public.pilot_crisis_review_reads enable row level security;

-- Supabase の既定で public スキーマの新規テーブルには anon/authenticated への
-- 明示的な grant が付く。`revoke ... from public` はそれを落とさないので、
-- ロールを個別に名指しする（20260715090000 と同じ）。
revoke all on public.pilot_crisis_reviews from public, anon, authenticated;
revoke all on public.pilot_crisis_review_reads from public, anon, authenticated;
grant select, insert, update on public.pilot_crisis_reviews to service_role;
grant select, insert on public.pilot_crisis_review_reads to service_role;

create or replace function public.stamp_pilot_crisis_review_update()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists pilot_crisis_reviews_stamp_update on public.pilot_crisis_reviews;
create trigger pilot_crisis_reviews_stamp_update
  before update on public.pilot_crisis_reviews
  for each row execute function public.stamp_pilot_crisis_review_update();
