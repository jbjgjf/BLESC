-- 研究終了日と、原文以外のデータの保存期限の定義（#318）。
--
-- ===========================================================================
-- 追加のみ。何も削除しない。この migration が入っても、どの行も消えない：
-- 期限は「案」として置かれ、承認の記録が入るまで期限日は null のままで、
-- 削除処理（後続の PR）は期限日が null の区分に触れない。
-- ===========================================================================
--
-- ## 何が無かったか
--
-- `/legal` は、研究データを研究終了から1年、研究用IDと本人の対応を90日、
-- 同意・撤回の証跡を5年と説明している。期限管理があるのは研究本文だけで
-- （`entries.raw_text_expires_at`）、ほかの3つには起点になる「研究終了日」が
-- どこにも無かった。`pilot_studies.closes_at` は募集の締切で、`status =
-- 'closed'` にした日時は残らない。起点の無い期限は、期限ではない。
--
-- ## 研究終了日
--
-- `pilot_studies.ended_at`。研究責任者が終了を宣言した日を**人が入れる**。
-- コードが `closes_at` や最後の提出から推測して入れることはしない —— その日は
-- 参加者への説明の起点で、推測で動かしてよい日付ではない。`closed` でない
-- 研究には入れられない。
--
-- ## 期限の定義
--
-- `pilot_retention_policy` に区分ごとの期限を持つ。値は `/legal` が示す案で、
-- **`approved_at` が null のあいだは案のまま**。倫理審査と学校承認の結果を
-- 受けて、承認者が期限と根拠（審査番号など）を記録したときに初めて効く。
-- 期限の値をコードの定数にしないのはそのためで、承認という出来事を
-- commit ではなく行として残す。
--
-- 研究本文（各記録から90日）はここに入れない。起点が研究終了ではなく各記録で、
-- 既存の `purge_expired_raw_text()` が担っている。

alter table public.pilot_studies
  add column if not exists ended_at timestamptz;

comment on column public.pilot_studies.ended_at is
  '研究終了日（#318）。保存期限の起点。研究責任者の宣言を人が記録する。status = closed のときだけ入る。';

alter table public.pilot_studies
  drop constraint if exists pilot_studies_ended_requires_closed;
alter table public.pilot_studies
  add constraint pilot_studies_ended_requires_closed
  check (ended_at is null or status = 'closed');

create table if not exists public.pilot_retention_policy (
  category text primary key,
  keep_for interval not null,
  description text not null,
  approved_at timestamptz,
  approved_by uuid references auth.users (id) on delete set null,
  -- 審査番号・承認文書の所在など。承認の根拠を、値の隣に残す。
  approval_reference text,
  constraint pilot_retention_policy_category_check
    check (category in ('research_records', 'identity_map', 'audit_trail')),
  constraint pilot_retention_policy_keep_for_positive
    check (keep_for > interval '0'),
  -- 「承認された」は、いつ・何を根拠に、がそろって初めて言える。
  constraint pilot_retention_policy_approval_complete
    check ((approved_at is null) = (approval_reference is null))
);

comment on table public.pilot_retention_policy is
  '原文以外のデータの保存期限（#318）。approved_at が null の行は案で、削除処理はその区分に触れない。';

alter table public.pilot_retention_policy enable row level security;
-- service_role も名指しで落としてから、要るものだけ渡す。Supabase の既定は新規
-- テーブルに service_role へ ALL を付けるので、落とさないと DELETE が残る。
-- 区分の行は消せてはならない：行が無いことは「規則が無い」と読まれる。
revoke all on public.pilot_retention_policy from public, anon, authenticated, service_role;
grant select, update on public.pilot_retention_policy to service_role;

-- `/legal` プライバシーポリシー §6 の案。既に行があれば触らない：承認済みの
-- 値を、migration の再適用が案に戻してはならない。
insert into public.pilot_retention_policy (category, keep_for, description) values
  ('research_records', interval '1 year',  '研究用自己評定・操作指標・個人単位の研究データ'),
  ('identity_map',     interval '90 days', '研究用IDと本人の対応'),
  ('audit_trail',      interval '5 years', '同意・撤回・削除・管理操作の証跡（本文を含めない）')
on conflict (category) do nothing;

-- 区分ごとの期限日。研究が終了していない、または区分が未承認なら null。
-- 削除処理はこの関数の `deadline` だけを見る。
create or replace function public.pilot_retention_deadlines(target_study uuid)
returns table (category text, keep_for interval, approved boolean, study_ended_at timestamptz, deadline timestamptz)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select
    p.category,
    p.keep_for,
    p.approved_at is not null,
    s.ended_at,
    case when p.approved_at is not null and s.ended_at is not null then s.ended_at + p.keep_for end
  from public.pilot_retention_policy p
  cross join (select ended_at from public.pilot_studies where id = target_study) s
  order by p.category;
$$;

revoke execute on function public.pilot_retention_deadlines(uuid) from public, anon, authenticated;
grant execute on function public.pilot_retention_deadlines(uuid) to service_role;
