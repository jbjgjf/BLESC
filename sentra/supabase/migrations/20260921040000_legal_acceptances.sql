-- 規約・プライバシーポリシーに「いつ・どの版に」同意したかの記録。
--
-- 施行日を決めるのは人間の決裁だが、**版と同意時刻を記録できることは
-- その前提**である。記録する場所が無いまま施行すると、施行後に同意した人と
-- 施行前から使っている人の区別が付かず、改定時に再同意を取る相手も割り出せない。
--
-- 研究同意 (`consent_records`) とは別のテーブルにする。別の文書で、別の時点で、
-- 別の理由で改定されるものを1つの表に混ぜると、片方の改定がもう片方の
-- 同意記録を巻き込む。
create table if not exists public.legal_acceptances (
  id uuid primary key default gen_random_uuid(),

  user_id uuid not null references auth.users(id) on delete cascade,

  -- 'terms' | 'privacy'。片方だけ改定されることがあるので別行で持つ。
  document_id text not null,
  -- 同意した時点で画面に出ていた版そのもの。`legalEnactment.ts` が決める。
  -- **施行前の版（-draft 付き）も記録できる**。草案に同意したという記録は
  -- 「同意していない」とは違う事実で、消してよいものではない。
  document_version text not null,
  -- 施行日。版と同時に持つのは、あとから施行日だけ動いたときに
  -- 「どの施行日のつもりで同意したか」が分かるようにするため。
  effective_date date,

  accepted_at timestamptz not null default now(),

  -- 同じ人が同じ版に二度同意しても1行。押し直しは新しい事実ではない。
  unique (user_id, document_id, document_version),

  constraint legal_acceptances_document_check
    check (document_id in ('terms', 'privacy'))
);

create index if not exists legal_acceptances_user_idx
  on public.legal_acceptances (user_id, document_id, accepted_at desc);

alter table public.legal_acceptances enable row level security;

-- Supabase の既定で public スキーマの新規テーブルには anon/authenticated への
-- 明示的な grant が付く。ロールを個別に名指しして落とす。
revoke all on public.legal_acceptances from public, anon, authenticated;
grant select, insert on public.legal_acceptances to authenticated;
grant select, insert on public.legal_acceptances to service_role;

-- 自分の記録だけ読める。書けるのも自分の行だけ。
-- **UPDATE も DELETE も無い。** 同意の記録は起きた出来事で、あとから
-- 書き換えられる同意記録は記録ではない。
create policy "legal_acceptances_select_own" on public.legal_acceptances
for select to authenticated
using ((select auth.uid()) = user_id);

create policy "legal_acceptances_insert_own" on public.legal_acceptances
for insert to authenticated
with check ((select auth.uid()) = user_id);
