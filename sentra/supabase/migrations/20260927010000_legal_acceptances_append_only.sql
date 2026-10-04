-- 規約・ポリシーへの同意記録を、service_role からも書き換えられないようにする (#250)。
--
-- 20260921040000 は「UPDATE も DELETE も無い。あとから書き換えられる同意記録は
-- 記録ではない」と書き、anon / authenticated からは全部落としてから
-- SELECT / INSERT だけを付け直した。service_role には
-- `grant select, insert` と「足す」書き方をしたため、Supabase の既定権限が
-- 新規テーブルに付ける ALL（UPDATE / DELETE / TRUNCATE を含む）がそのまま
-- 残っていた。service_role は RLS を通らないので、残っていた権限は
-- そのまま全行に効く。
--
-- アプリはこのテーブルを利用者本人のクライアント経由でしか触らない
-- （`app/api/legal/acceptance/route.ts` の `auth.client`）。service_role に
-- 書き換えの権限を残す理由は無い。アカウント削除時の cascade は
-- 外部キーがテーブル所有者の権限で行うので、ここでの revoke に影響されない。
--
-- supabase/tests/legal_acceptances_rls.test.sql §4 が固定する。

revoke update, delete, truncate, references, trigger
  on public.legal_acceptances from service_role;
