-- 保護者の同意を項目別に残す（#316）。
--
-- ===========================================================================
-- 追加のみ。既存の行・列・権限は変えない。アプリの配備より前に適用してよい：
-- この列を読むコードも書くコードも、まだ無い。
-- ===========================================================================
--
-- ## なぜ列が要るのか
--
-- `/legal` の保護者説明と docs/legal/operations-proposal.md は、保護者が
-- アプリ利用／研究データ利用／原文の保持を**項目別に**選び、本人の同意との
-- 積集合だけを使うと説明している。実装は一括の承諾／不承諾で、保護者が
-- 何に「はい」と言ったのかは `decision = 'confirmed'` の1語にしか残らない。
-- `requested_grants` は本人が頼んだ範囲であって、保護者の回答ではない。
--
-- `guardian_grants` は保護者が実際に選んだ値をそのまま持つ。OFF も値として
-- 残る —— 断った項目が「記録が無い」と区別できないと、不同意は回答として
-- 扱われていないことになる。
--
--   { "app_use": bool, "research_analysis": bool,
--     "raw_text_retention": bool, "document_version": text }
--
-- 時刻は既存の `decided_at`。`consent_records` に書かれる実効同意（本人 ∩
-- 保護者）は、この値と `requested_grants` からアプリが導出する。
--
-- ## null の意味
--
-- 項目別になる前の一括確認。既存の `confirmed` の行はこれで、従来どおり
-- 「頼まれた範囲すべてを承諾した」と読む。新しい回答に null を許さない制約は、
-- アプリの配備後に別の migration で足す（追加 → 配備 → 絞る、の順）。
--
-- ## 権限
--
-- 変えない。このテーブルは service_role だけが触れる（20260910000000）。列を
-- 足しても anon / authenticated には何も渡らないことを
-- supabase/tests/guardian_itemized_grants.test.sql が確かめる。

alter table public.pilot_guardian_verifications
  add column if not exists guardian_grants jsonb;

comment on column public.pilot_guardian_verifications.guardian_grants is
  '保護者が項目別に選んだ値（#316）。app_use / research_analysis / raw_text_retention の boolean と '
  'document_version。OFF も値として残す。null は項目別になる前の一括確認。';

-- 形を固定する。3つの boolean と文書版がそろっていない値は、保護者の回答
-- として読めないので入れない。`drop ... if exists` は再適用のため。
alter table public.pilot_guardian_verifications
  drop constraint if exists pilot_guardian_verifications_guardian_grants_shape;

alter table public.pilot_guardian_verifications
  add constraint pilot_guardian_verifications_guardian_grants_shape check (
    guardian_grants is null
    -- `coalesce(..., false)` は飾りではない。無いキーの `jsonb_typeof` は null で、
    -- null になった CHECK は**通る**。これが無いと、項目が欠けた回答がそのまま入る。
    or coalesce(
      jsonb_typeof(guardian_grants) = 'object'
      and jsonb_typeof(guardian_grants -> 'app_use') = 'boolean'
      and jsonb_typeof(guardian_grants -> 'research_analysis') = 'boolean'
      and jsonb_typeof(guardian_grants -> 'raw_text_retention') = 'boolean'
      and jsonb_typeof(guardian_grants -> 'document_version') = 'string'
      and length(guardian_grants ->> 'document_version') > 0,
      false
    )
  );

-- 回答していない行に、保護者の選択だけがあることはない。
alter table public.pilot_guardian_verifications
  drop constraint if exists pilot_guardian_verifications_guardian_grants_decided;

alter table public.pilot_guardian_verifications
  add constraint pilot_guardian_verifications_guardian_grants_decided check (
    guardian_grants is null or decision is not null
  );
