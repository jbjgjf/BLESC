-- 「誰が見たか」の記録が、見た側のアカウント削除で消えないようにする (#256)。
--
-- 生徒のデータを誰が見たかの記録は2つある。どちらも「消えないこと」を
-- 設計意図として書いていたのに、閲覧者を指す外部キーが `on delete cascade`
-- だった。
--
--   educator_access_log.educator_user_id   (20260716090000)
--   pilot_crisis_review_reads.read_by      (20260921030000)
--
-- RLS に DELETE ポリシーが無いことは、行が消えないことを意味しない。
-- 教員が退職して `auth.users` の行が消されると、その教員が閲覧した全生徒分の
-- ログが cascade で一緒に消えていた。
--
-- ## set null + 参照ハッシュを選んだ理由（restrict にしなかった理由）
--
-- `on delete restrict` にすると、一度でも生徒を閲覧した教員のアカウントは
-- ログを消さない限り削除できなくなる。そして「ログを消す」以外の出口が無い
-- ので、アカウント削除の運用はいずれログ削除の手順になる。守りたいものを
-- 壊す手順を運用者に書かせる設計になるので採らない。
--
-- 代わりに、閲覧者の列を nullable + `on delete set null` にし、**挿入時に
-- データベースが計算する参照ハッシュ**を別列に持つ:
--
--   sha256('blesc:viewer:v1:' || <auth.users.id>) の16進表現
--
-- - アカウントが残っている間は、これまでどおり uuid で辿れる。
-- - アカウントが消えた後も、元の uuid を知っている監査者（学校側の職員記録、
--   Supabase の監査ログ等）はハッシュを再計算して「この閲覧はあの人だった」と
--   照合できる。uuid v4 は122ビットの乱数なので、ハッシュから総当たりで
--   元に戻すことはできない。
-- - 生徒側の画面（`listEducatorAccess`）は組織名と時刻と種別だけを出して
--   いるので、閲覧者の列が null になっても表示は変わらない。
--
-- 既存の `recipient_hash`（`SAFETY_RECIPIENT_HASH_KEY` の HMAC）と同じ方式に
-- しなかったのは、鍵がアプリの環境変数にしか無いから。ここで欲しいのは
-- 「アプリが計算し忘れたら無い」ハッシュではなく、データベースが必ず入れる
-- ハッシュである。鍵付きでないことの代償は「uuid を知っている人は照合できる」
-- ことで、それはこの列の目的そのものである。
--
-- ## 変えないこと
--
-- 生徒本人の `participants` 行が消えたときは、従来どおり cascade で消える。
-- 生徒のデータ削除は撤回の約束であって、閲覧ログもその「データ」に含む。
-- (`educator_access_log` は `(participant_id, owner_user_id)` の複合外部キー、
-- `pilot_crisis_review_reads` は `entry_id` → `entries` 経由。)

-- ---------------------------------------------------------------------------
-- 0. 参照ハッシュ
-- ---------------------------------------------------------------------------

-- pgcrypto に依存しない（`sha256()` は PostgreSQL 11 から組み込み）。
-- 拡張がどのスキーマに入っているかで migration の成否が変わらないように。
create or replace function public.viewer_ref(viewer uuid)
returns text
language sql
immutable
strict
set search_path = pg_catalog
as $$
  select encode(sha256(convert_to('blesc:viewer:v1:' || viewer::text, 'UTF8')), 'hex');
$$;

comment on function public.viewer_ref(uuid) is
  'Irreversible reference to an auth.users id, kept on viewer logs so a view stays attributable after the account is deleted (#256).';

-- ---------------------------------------------------------------------------
-- 1. educator_access_log
-- ---------------------------------------------------------------------------

alter table public.educator_access_log
  add column if not exists educator_ref text;

update public.educator_access_log
   set educator_ref = public.viewer_ref(educator_user_id)
 where educator_ref is null
   and educator_user_id is not null;

alter table public.educator_access_log
  alter column educator_ref set not null,
  alter column educator_user_id drop not null;

alter table public.educator_access_log
  drop constraint if exists educator_access_log_educator_user_id_fkey;
alter table public.educator_access_log
  add constraint educator_access_log_educator_user_id_fkey
  foreign key (educator_user_id) references auth.users(id) on delete set null;

create index if not exists educator_access_log_educator_ref_idx
  on public.educator_access_log(educator_ref, occurred_at desc);

-- ---------------------------------------------------------------------------
-- 2. pilot_crisis_review_reads
-- ---------------------------------------------------------------------------

alter table public.pilot_crisis_review_reads
  add column if not exists read_by_ref text;

update public.pilot_crisis_review_reads
   set read_by_ref = public.viewer_ref(read_by)
 where read_by_ref is null
   and read_by is not null;

alter table public.pilot_crisis_review_reads
  alter column read_by_ref set not null,
  alter column read_by drop not null;

alter table public.pilot_crisis_review_reads
  drop constraint if exists pilot_crisis_review_reads_read_by_fkey;
alter table public.pilot_crisis_review_reads
  add constraint pilot_crisis_review_reads_read_by_fkey
  foreign key (read_by) references auth.users(id) on delete set null;

-- ---------------------------------------------------------------------------
-- 3. 書き込みの守り
-- ---------------------------------------------------------------------------
--
-- 挿入: 閲覧者は必須で、参照ハッシュは呼び出し側の値を無視して常に計算する。
--       nullable にしたのはアカウント削除のためであって、「誰でもない閲覧」を
--       記録できるようにするためではない。
--
-- 更新: 許すのは「閲覧者の列が null になる」ことだけ -- つまり上の
--       `on delete set null` そのもの。それ以外の列は一切変えられない。
--       RLS に UPDATE ポリシーが無いのは authenticated にしか効かず、
--       service_role とテーブル所有者は素通りする。このトリガーはそちらも止める。
--
-- 削除はここでは止めない。行が消える経路は、生徒本人の participants 行の
-- 削除（撤回）と、組織そのものの削除の cascade だけで、どちらも意図したもの。
-- どのロールにも DELETE の grant と policy が無いことは
-- supabase/tests/viewer_log_retention.test.sql が確かめている。

create or replace function public.guard_viewer_log_write()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
declare
  viewer_column text := tg_argv[0];
  ref_column text := tg_argv[1];
  new_viewer uuid;
  old_viewer uuid;
  new_row jsonb;
begin
  new_row := to_jsonb(new);
  new_viewer := (new_row ->> viewer_column)::uuid;

  if tg_op = 'INSERT' then
    if new_viewer is null then
      raise exception '%.%: a view must name its viewer', tg_table_name, viewer_column
        using errcode = '23502';
    end if;
    new := jsonb_populate_record(new, jsonb_build_object(ref_column, public.viewer_ref(new_viewer)));
    return new;
  end if;

  -- UPDATE
  old_viewer := (to_jsonb(old) ->> viewer_column)::uuid;
  if old_viewer is not null
     and new_viewer is null
     and (new_row - viewer_column) = (to_jsonb(old) - viewer_column) then
    return new;
  end if;

  raise exception '%: viewer logs are append-only; the only permitted change is the viewer''s account being deleted', tg_table_name
    using errcode = '42501';
end;
$$;

drop trigger if exists educator_access_log_guard_write on public.educator_access_log;
create trigger educator_access_log_guard_write
  before insert or update on public.educator_access_log
  for each row execute function public.guard_viewer_log_write('educator_user_id', 'educator_ref');

drop trigger if exists pilot_crisis_review_reads_guard_write on public.pilot_crisis_review_reads;
create trigger pilot_crisis_review_reads_guard_write
  before insert or update on public.pilot_crisis_review_reads
  for each row execute function public.guard_viewer_log_write('read_by', 'read_by_ref');

revoke execute on function public.guard_viewer_log_write() from public, anon, authenticated;

-- 既定の grant を落とす。Supabase の既定権限は public スキーマの新規テーブルに
-- authenticated / service_role への ALL を付ける。20260921010000 が落としたのは
-- anon の分だけで、20260921030000 も `grant select, insert ... to service_role`
-- と「足す」書き方をしたため、既に付いていた UPDATE / DELETE / TRUNCATE は
-- どちらのテーブルにも残っていた。RLS は UPDATE / DELETE の行を 0 にするが、
-- TRUNCATE はポリシーを通らない。監査ログにそれを残す理由は無い。
revoke update, delete, truncate on public.educator_access_log from authenticated, service_role;
revoke update, delete, truncate on public.pilot_crisis_review_reads from authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. 宣言を実際の保証に合わせる
-- ---------------------------------------------------------------------------

comment on table public.educator_access_log is
  'Append-only record of every educator view of a student''s data (#31). '
  'No role holds UPDATE or DELETE, and a trigger refuses every update except the '
  'viewer column becoming null when that account is deleted; educator_ref keeps the '
  'view attributable afterwards (#256). Rows are removed only with the student''s own '
  'participant row (withdrawal) or with the organization.';

comment on table public.pilot_crisis_review_reads is
  'Who opened a student''s journal during protocol §4.4 review, and when (#225). '
  'service_role may SELECT and INSERT only; a trigger refuses every update except '
  'read_by becoming null when that account is deleted, and read_by_ref keeps the read '
  'attributable afterwards (#256). Rows are removed only with the entry itself.';
