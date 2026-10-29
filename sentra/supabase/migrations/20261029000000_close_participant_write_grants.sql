-- 参加者のセッションが使っていない書き込み権限を閉じる（#514）。
--
-- ===========================================================================
-- 読み出しは一切変えない。参加者の画面が読んでいる表は、いまと同じ行を
-- いまと同じ条件で読める。消えるのは INSERT / UPDATE / DELETE だけで、
-- その操作を提供する画面は1つも無い。
-- ===========================================================================
--
-- ## 判断基準は 20260907000000 が書いている
--
--   > None of these is reachable through the app: the browser only SELECTs
--   > from `entries` (`api/client.ts`), and every write goes through
--   > `lib/server/supabaseWriter.ts`, which holds the service-role key. The
--   > hole was that nothing *stopped* a participant from doing it directly,
--   > and "the UI does not offer it" is not an access control.
--
-- その migration は `entries` の INSERT / UPDATE を閉じ、`20260927020000` §2 が
-- 同じ理由で `consent_records` を閉じた。`20260921010000:53-55` は残りを
-- 「別の作業」として置いた。
--
--   > `authenticated` keeps what it has — several of those grants are
--   > load-bearing, and auditing them is a separate piece of work with a real
--   > risk of breaking a screen.
--
-- その棚卸しの結果がこの migration である。
--
-- ## 棚卸しの方法
--
-- `sentra/frontend/src` の `.insert(` / `.update(` / `.upsert(` / `.delete()`
-- を全部読み、呼び出しに渡っている client が
--
--   * ブラウザの anon client（`src/api/client.ts`、`src/lib/auth.tsx`）か
--   * `serviceRoleClient()`（`src/app/api/**/route.ts`、`src/lib/server/**`）か
--
-- で分けた。FastAPI 側（`sentra/backend/app/services/supabase_writer.py`）は
-- `SUPABASE_SERVICE_ROLE_KEY` しか読まず、無ければ sync を skip する（:69,:89）。
-- `sentra/eval/src/provision.ts` は admin client である。
--
-- ## ブラウザが書いている表 — 触らない
--
--   chat_sessions, chat_messages, conversation_recall_summaries,
--   conversation_memory_objects, model_runs, oversight_consents,
--   educator_access_log, shared_support_summaries, participants, profiles
--
-- この11表の権限は load-bearing である。`model_runs` と
-- `conversation_memory_objects` は、ブラウザが来歴と重要度の行を書いている
-- という別の問題（#517）を抱えている。書き込みがサーバーへ移るまで、ここは
-- 閉じられない。閉じる順番を間違えると画面が壊れる。
--
-- ## 表を列挙する理由
--
-- `20260921010000` は `information_schema` を掃くループで書かれている。あちらは
-- `anon` が対象で、「この製品に匿名の読み書き面は無い」と言えたからである。
-- `authenticated` にはそれが言えない（上の11表）。掃くと load-bearing な権限まで
-- 落ちるので、ここは配列で明示する。足す・外すが差分として見える形を選ぶ。
--
-- ## 適用順
--
-- deploy gate は要らない。`20260906000100` / `20260907000000` は、当時の
-- アプリが実際に読んでいた列を閉じたので順番が要った。ここで閉じるのは
-- どのコードパスも使っていない権限なので、アプリの前でも後でも同じである。
--
-- 二度適用できる（`migration_smoke.sh` step 3）。

-- ---------------------------------------------------------------------------
-- 1. `entries` の DELETE
-- ---------------------------------------------------------------------------
--
-- `20260529000100:181,222` の `entries_delete_own` と表権限が、いまも両方
-- 生きている。`20260907000000` は INSERT / UPDATE を revoke したが、DELETE は
-- 残した（あの migration の主題が raw-text 列だったため）。
--
-- 残っていると、日記の行を1件 DELETE するだけで `on delete cascade` が
--
--   * `pilot_crisis_reviews`（20260921030000:25） — protocol §4.4 の目視レビュー待ち行列
--   * `pilot_self_reports`（20260909020000:45） — 収集期間で唯一の量的指標
--   * `pilot_pii_reviews`（20260909030000:44） — 目視確認の記録
--   * `extractions` / `entry_fields` / `entry_research_links` / `entry_embeddings`
--
-- を一緒に消す。危機を開示した本人が、記録を残さず自分をレビュー待ち行列から
-- 外せるということである。
--
-- 日記の削除は `/consent` の撤回 → `withdraw_participant`（20260927020000）を
-- 通る。本人の選択（delete / keep）と廃棄の記録が残るのはその経路だけで、
-- 直接 DELETE はその全部を迂回する。「1件だけ消したい」を本人に許すかどうかは
-- 製品の判断で、許すなら記録を残すサーバー経路として作る。ここでは閉じる。

drop policy if exists "entries_delete_own" on public.entries;
revoke delete on public.entries from authenticated;

-- ---------------------------------------------------------------------------
-- 2. 書き込みが service role だけの表 — `*_own_all` を SELECT に置き換える
-- ---------------------------------------------------------------------------
--
-- どの表も policy が `*_own_all`（`for all to authenticated`）で、表権限が
-- `select, insert, update, delete` である。policy と権限の両方を直す。
-- 片方だけでは二重の壁が一枚になる。
--
-- `graph_nodes` / `graph_edges` / `longitudinal_patterns` / `export_jobs` /
-- `eval_examples` は、Supabase 側では書き込みも読み出しもコードから一度も
-- 行われていない（`export_jobs` の扱いは #515）。
--
-- 行の見え方は変わらない：`*_select_own` の `using` は `*_own_all` と同じ
-- `(select auth.uid()) = owner_user_id` である。

do $$
declare
  target text;
begin
  foreach target in array array[
    -- 20260611000000_research_grade_data_layer.sql
    'entry_sessions',
    'entry_fields',
    'interaction_events',
    'writing_features',
    'cognitive_probe_features',
    'entry_research_links',
    'extractions',
    'graph_versions',
    'graph_change_events',
    'entry_embeddings',
    'retrieval_events',
    'longitudinal_features',
    'eval_examples',
    'export_jobs',
    -- 20260614140000_longitudinal_patterns.sql
    'longitudinal_patterns',
    -- 20260621000000_graph_index_and_memory_objects.sql
    'graph_nodes',
    'graph_edges',
    -- 20260906000000_pilot_consent_and_submission_integrity.sql
    'followup_responses'
  ] loop
    execute format('drop policy if exists %I on public.%I', target || '_own_all', target);
    execute format('drop policy if exists %I on public.%I', target || '_select_own', target);
    execute format(
      'create policy %I on public.%I for select to authenticated '
      'using ((select auth.uid()) = owner_user_id)',
      target || '_select_own', target
    );
    execute format(
      'revoke insert, update, delete, truncate, references, trigger on public.%I from authenticated',
      target
    );
    execute format('grant select on public.%I to authenticated', target);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. `insights` と `graph_snapshots`
-- ---------------------------------------------------------------------------
--
-- `20260529000100` が命令ごとに policy を分けて書いた2表。読み出し側の
-- policy は2つあり、どちらも残す。
--
--   * `insights_select_own` / `graph_snapshots_select_own` — 本人
--   * `insights_select_oversight` — `educator_oversees(participant_id)`（#250 の経路）
--
-- ブラウザは両方を SELECT しかしない（`src/api/client.ts:1035,1466,1629,1646,1662`）。
-- 書いているのは `src/lib/server/supabaseWriter.ts` と FastAPI 側
-- （`app/services/supabase_writer.py:217,360`）で、どちらも service role である。

drop policy if exists "insights_insert_own" on public.insights;
drop policy if exists "insights_update_own" on public.insights;
drop policy if exists "insights_delete_own" on public.insights;
revoke insert, update, delete, truncate, references, trigger on public.insights from authenticated;
grant select on public.insights to authenticated;

drop policy if exists "graph_snapshots_insert_own" on public.graph_snapshots;
drop policy if exists "graph_snapshots_update_own" on public.graph_snapshots;
drop policy if exists "graph_snapshots_delete_own" on public.graph_snapshots;
revoke insert, update, delete, truncate, references, trigger on public.graph_snapshots from authenticated;
grant select on public.graph_snapshots to authenticated;

-- ---------------------------------------------------------------------------
-- 4. service_role は何も失わない
-- ---------------------------------------------------------------------------
--
-- 上の revoke はすべて `from authenticated` である。`service_role` は RLS を
-- 迂回し、表権限も別に持っているので、`supabaseWriter.ts` と FastAPI 側の
-- 書き込みは変わらない。`research_reader` も `20260910010000` で受け取った
-- SELECT をそのまま持つ。
--
-- 検査は `supabase/tests/participant_write_grants.test.sql` にある。
