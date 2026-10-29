-- 参加者のセッションは、サーバーしか書かない表に書けない（#514）。
--
-- Run against a local Supabase database with all migrations applied:
--   supabase db reset   (from sentra/)
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/participant_write_grants.test.sql
--
-- Read-only: it asks the catalog what each role may do and changes nothing.
--
-- 他の script は「どの行が見えるか」を見る。これは「どの命令が許されているか」を
-- 見る。`20260611000000` が `for all to authenticated` と
-- `grant select, insert, update, delete` を一括で書いたので、RLS の行の条件は
-- 正しいまま、命令の側だけが広い状態が残った。行の条件を検査する script では
-- それが見えない。
--
-- 4つを検査する。
--
--   1. サーバーしか書かない表に、`authenticated` が insert / update / delete を
--      持たない（`entries` の delete を含む）
--   2. その表の select は残っている — 1 が「全部落とした」で通らないこと
--   3. ブラウザが書いている表は、書けるまま（この migration が行きすぎていないこと）
--   4. `service_role` は何も失っていない
--
-- `followup_responses` はここに入らない。アプリの書き込みは service role だけ
-- だが、#133 の RLS 契約（`pilot_consent_rls.test.sql:173`）が参加者の insert を
-- 検査している。閉じるかどうかは #514 に残した判断である。

begin;

-- ---------------------------------------------------------------------------
-- 1. サーバーしか書かない表に、`authenticated` の書き込みが無い
-- ---------------------------------------------------------------------------

create temporary table server_written (table_name text primary key) on commit drop;
insert into server_written values
  -- 20260611000000_research_grade_data_layer.sql
  ('entry_sessions'), ('entry_fields'), ('interaction_events'), ('writing_features'),
  ('cognitive_probe_features'), ('entry_research_links'), ('extractions'),
  ('graph_versions'), ('graph_change_events'), ('entry_embeddings'),
  ('retrieval_events'), ('longitudinal_features'), ('eval_examples'), ('export_jobs'),
  -- 20260614140000 / 20260621000000
  ('longitudinal_patterns'), ('graph_nodes'), ('graph_edges'),
  -- 20260529000100, 命令ごとに policy が分かれている2表
  ('insights'), ('graph_snapshots'),
  -- 20260927020000 が先に閉じた表。ここで戻っていないことを確かめる
  ('consent_records');

do $$
declare
  row_ record;
  leaked text[] := '{}';
begin
  for row_ in select table_name from server_written order by table_name loop
    -- 表が消えたり名前が変わったら has_table_privilege が raise する。それが
    -- 正しい結果である（この一覧は手で直すものなので）。
    if has_table_privilege('authenticated', 'public.' || row_.table_name, 'INSERT')
       or has_table_privilege('authenticated', 'public.' || row_.table_name, 'UPDATE')
       or has_table_privilege('authenticated', 'public.' || row_.table_name, 'DELETE') then
      leaked := leaked || row_.table_name;
    end if;
  end loop;

  if array_length(leaked, 1) is not null then
    raise exception 'FAIL: authenticated may write tables only the server writes: %',
      array_to_string(leaked, ', ');
  end if;
end;
$$;

-- `entries` は列ごとの INSERT / UPDATE が 20260907000000 で残されているので、
-- 表単位では insert / update を持つ。閉じたのは delete である。
do $$
begin
  if has_table_privilege('authenticated', 'public.entries', 'DELETE') then
    raise exception 'FAIL: authenticated may DELETE from entries — 単一撤回手続きを迂回できる';
  end if;
end;
$$;

-- policy の側も直っていること。`for all` の policy が1つでも残っていれば、
-- 権限を戻した次の migration でそのまま書けるようになる。
do $$
declare
  row_ record;
  wide text[] := '{}';
begin
  for row_ in
    select p.tablename, p.policyname, p.cmd
      from pg_policies p
      join server_written s on s.table_name = p.tablename
     where p.schemaname = 'public'
       and p.cmd <> 'SELECT'
       and ('authenticated' = any (p.roles) or 'public' = any (p.roles))
  loop
    wide := wide || (row_.tablename || '.' || row_.policyname || ' (' || row_.cmd || ')');
  end loop;

  if array_length(wide, 1) is not null then
    raise exception 'FAIL: a write policy for authenticated remains: %',
      array_to_string(wide, ', ');
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. 読み出しは残っている
-- ---------------------------------------------------------------------------
--
-- 1 が「表ごと取り上げた」で通ってしまわないように。参加者の画面は
-- `insights` / `graph_snapshots` / `extractions` などを読む。

do $$
declare
  row_ record;
  lost text[] := '{}';
begin
  for row_ in select table_name from server_written order by table_name loop
    if not has_table_privilege('authenticated', 'public.' || row_.table_name, 'SELECT') then
      lost := lost || row_.table_name;
    end if;
  end loop;

  if array_length(lost, 1) is not null then
    raise exception 'FAIL: authenticated lost SELECT on: %', array_to_string(lost, ', ');
  end if;
end;
$$;

-- 権限だけでは読めない。行を返す policy も要る。
do $$
declare
  row_ record;
  unreadable text[] := '{}';
begin
  for row_ in select table_name from server_written order by table_name loop
    if not exists (
      select 1 from pg_policies p
       where p.schemaname = 'public'
         and p.tablename = row_.table_name
         and p.cmd in ('SELECT', 'ALL')
         and ('authenticated' = any (p.roles) or 'public' = any (p.roles))
    ) then
      unreadable := unreadable || row_.table_name;
    end if;
  end loop;

  if array_length(unreadable, 1) is not null then
    raise exception 'FAIL: no SELECT policy for authenticated on: %',
      array_to_string(unreadable, ', ');
  end if;
end;
$$;

-- 教職員の読み出し経路（#250）は `insights` の2本目の policy である。
do $$
begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'insights'
       and policyname = 'insights_select_oversight'
  ) then
    raise exception 'FAIL: insights_select_oversight が無い — 教職員の閲覧経路が消えている';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. ブラウザが書いている表は、書けるまま
-- ---------------------------------------------------------------------------
--
-- `src/api/client.ts` と `src/lib/auth.tsx` が insert / update している表。
-- `model_runs` と `conversation_memory_objects` は #517 が片付けるまでここに
-- 残る。この一覧が縮むのは、その書き込みがサーバーへ移ったときである。

do $$
declare
  target text;
  broken text[] := '{}';
begin
  foreach target in array array[
    'chat_sessions', 'chat_messages', 'conversation_recall_summaries',
    'conversation_memory_objects', 'model_runs', 'oversight_consents',
    'educator_access_log', 'shared_support_summaries', 'participants', 'profiles'
  ] loop
    if not has_table_privilege('authenticated', 'public.' || target, 'INSERT') then
      broken := broken || target;
    end if;
  end loop;

  if array_length(broken, 1) is not null then
    raise exception 'FAIL: authenticated lost INSERT on a table the browser writes: %',
      array_to_string(broken, ', ');
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. `service_role` は何も失っていない
-- ---------------------------------------------------------------------------

do $$
declare
  row_ record;
  broken text[] := '{}';
begin
  for row_ in select table_name from server_written order by table_name loop
    if not (has_table_privilege('service_role', 'public.' || row_.table_name, 'INSERT')
            and has_table_privilege('service_role', 'public.' || row_.table_name, 'UPDATE')
            and has_table_privilege('service_role', 'public.' || row_.table_name, 'DELETE')) then
      broken := broken || row_.table_name;
    end if;
  end loop;

  if array_length(broken, 1) is not null then
    raise exception 'FAIL: service_role cannot write: %', array_to_string(broken, ', ');
  end if;
end;
$$;

rollback;
