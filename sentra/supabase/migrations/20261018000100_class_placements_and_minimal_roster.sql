-- 教員に見せる生徒の識別を、氏名からクラス・出席番号へ置き換える (#466)。
--
-- 公開サイト（blesc.jp）は次の約束をしている。
--
--   「先生に表示されるのは、クラス、出席番号、観測された表現の種類、時刻だけです。」
--
-- 製品はこれを満たしていなかった。`overseen_participants()` は
-- `participants.display_name`（生徒の名前）を返し、教員画面はそれを見出しに
-- 出していた。一方でクラスと出席番号は、製品のどこにも存在しなかった。
-- 2026-10-18、オーナーは「サイトの文言を製品に合わせる」のではなく
-- 「製品をサイトの約束に合わせる」（#466 の案 B）と決めた。このマイグレーションは
-- そのデータベース側の半分である。
--
-- ## 何をするか
--
--   1. `class_placements` を作る。学校（組織）ごとに、生徒のクラスと出席番号を
--      1 行で持つ。両方とも NULL を許す。未設定の生徒は画面上「クラス未設定」と
--      表示され、名前に戻ることはない。
--   2. `overseen_participants()` の返す列から `display_name` を外し、
--      `class_label` と `attendance_number` を加える。
--
-- ## なぜ `participants` の列ではなく別テーブルか
--
-- クラスと出席番号は生徒本人の属性ではなく、「ある学校がその生徒をどう呼ぶか」
-- である。同じ参加者が別の組織（例えば研究機関）からも見られるとき、その組織に
-- 学校のクラス番号を渡す理由はない。`participants` に置くと、本人の行に学校の
-- 情報が混ざり、`participants` の RLS（本人だけ）と書き手（学校の管理者）が
-- 食い違う。`oversight_roster` の列にしなかったのは、あちらが「教員 × 生徒」の
-- 行で、同じ生徒の行が担当教員の数だけあるため。クラスが行ごとにずれうる形は
-- 避けた。
--
-- ## 誰が書くか
--
-- 学校の `org_admin` だけ。担当登録（`oversight_roster`）と同じ書き手で、
-- 同じ組織の名簿に載っている生徒に限る。管理画面はまだない。それまでの設定方法は
-- `docs/educator_oversight.md` の「クラス・出席番号の設定」にある SQL /
-- PostgREST の upsert と、合成アカウント用の `scripts/seed-actors.mjs --class`。
-- 大きな管理画面をここで作らないのは、名簿の取り込み方法（CSV か、校務支援
-- システム連携か）が学校との調整待ちで、形を先に決めると作り直しになるため。
--
-- ## 誰が読むか
--
--   * 教員: このテーブルを直接は読まない。`overseen_participants()` を通じて、
--     担当かつ本人が同意している生徒の分だけを受け取る。今までと同じ経路。
--   * 生徒本人: 自分の行を読める。学校が自分をどう登録したかは、本人が確かめられる
--     べき情報である（`educator_access_log` と同じ透明性の考え方）。
--   * 組織の管理者: 自分の組織の行。
--
-- ## `display_name` について
--
-- 列そのものは `participants` に残る。生徒本人の画面と研究側の処理が使っている。
-- 消えるのは「教員に届く経路」だけで、返り値の型から外すことで、教員画面が
-- 名前を描こうとしても値が届かない。表示側で隠すだけでは足りないことは
-- `docs/educator_display_policy.md` が二度記録している。

-- ---------------------------------------------------------------------------
-- 1. class_placements
-- ---------------------------------------------------------------------------

create table if not exists public.class_placements (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  participant_id uuid not null,
  owner_user_id uuid not null,
  -- 「2-3」「2年A組」など、学校が使っている表記をそのまま持つ。学年と組に
  -- 分けないのは、学校によって表記が違い、分けても画面では連結して出すだけだから。
  class_label text
    check (class_label is null or length(trim(class_label)) between 1 and 20),
  attendance_number integer
    check (attendance_number is null or attendance_number between 1 and 999),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, participant_id),
  constraint class_placements_participant_owner_fk
    foreign key (participant_id, owner_user_id)
    references public.participants(id, owner_user_id)
    on delete cascade
);

-- 同じ学校で「2-3 の 12 番」が二人いると、教員はどちらの生徒か分からない。
-- 名前を出さない以上、この組み合わせが一意であることが識別の唯一の手がかりになる。
create unique index if not exists class_placements_org_class_number_key
  on public.class_placements(org_id, class_label, attendance_number)
  where class_label is not null and attendance_number is not null;

create index if not exists class_placements_participant_idx
  on public.class_placements(participant_id);

drop trigger if exists class_placements_set_updated_at on public.class_placements;
create trigger class_placements_set_updated_at before update on public.class_placements
for each row execute function public.set_updated_at();

alter table public.class_placements enable row level security;

-- Stock Supabase は public の新しいテーブルに anon / authenticated への明示的な
-- grant を付ける。先に全部落としてから、必要なものだけ付け直す（#166）。
revoke all on public.class_placements from public, anon, authenticated;
grant select, insert, update, delete on public.class_placements to authenticated;
grant select, insert, update, delete on public.class_placements to service_role;

drop policy if exists class_placements_select_scoped on public.class_placements;
create policy class_placements_select_scoped on public.class_placements
  for select to authenticated
  using (
    owner_user_id = (select auth.uid())
    or public.is_org_admin(org_id)
  );

-- 書けるのは、その組織の管理者が、その組織の名簿に載っている生徒について
-- だけ。名簿にない参加者にクラスを付けられると、組織を作っただけの利用者が
-- 任意の参加者に学校の情報を書き込めてしまう。
drop policy if exists class_placements_insert_admin on public.class_placements;
create policy class_placements_insert_admin on public.class_placements
  for insert to authenticated
  with check (
    public.is_org_admin(org_id)
    and exists (
      select 1 from public.oversight_roster r
      where r.org_id = class_placements.org_id
        and r.participant_id = class_placements.participant_id
    )
  );

drop policy if exists class_placements_update_admin on public.class_placements;
create policy class_placements_update_admin on public.class_placements
  for update to authenticated
  using (public.is_org_admin(org_id))
  with check (
    public.is_org_admin(org_id)
    and exists (
      select 1 from public.oversight_roster r
      where r.org_id = class_placements.org_id
        and r.participant_id = class_placements.participant_id
    )
  );

drop policy if exists class_placements_delete_admin on public.class_placements;
create policy class_placements_delete_admin on public.class_placements
  for delete to authenticated
  using (public.is_org_admin(org_id));

-- ---------------------------------------------------------------------------
-- 2. overseen_participants(): display_name を外し、クラスと出席番号を返す
-- ---------------------------------------------------------------------------
--
-- 返り値の列が変わるので `create or replace` では置き換えられない。drop して
-- 作り直し、grant も付け直す。この関数に依存するビューやポリシーはない。
--
-- `code` は残す。教員画面には描かない（#466 で外した）が、アラートの鍵と、
-- 支援サマリー共有の一覧で参加者を突き合わせるのに使っている内部の識別子で、
-- 名前ではない。

drop function if exists public.overseen_participants();

create function public.overseen_participants()
returns table (
  participant_id uuid,
  org_id uuid,
  owner_user_id uuid,
  code text,
  class_label text,
  attendance_number integer
)
language sql
security definer
set search_path = public
stable
as $$
  select p.id, r.org_id, r.owner_user_id, p.code, cp.class_label, cp.attendance_number
  from public.oversight_roster r
  join public.participants p on p.id = r.participant_id
  left join public.class_placements cp
    on cp.org_id = r.org_id
   and cp.participant_id = r.participant_id
  where r.educator_user_id = (select auth.uid())
    and r.status = 'active'
    and public.educator_oversees(p.id);
$$;

revoke execute on function public.overseen_participants() from public, anon;
grant execute on function public.overseen_participants() to authenticated;
