-- `consent_records.model_training_use` は true を持てない（#469）。
--
-- APPLY THIS ONLY AFTER THE NEW CODE IS LIVE. 以前のアプリは同意画面に学習利用の
-- スイッチを出していて、オンのまま送ると、この制約で同意の保存そのものが失敗する。
--
-- ===========================================================================
-- blesc.jp は「日記を販売することも、広告に使うことも、AIモデルの学習に使う
-- こともありません」と約束している。2026-10-18、owner はこの約束を守る側
-- （option B）に決めた: 同意があっても、参加者のデータを学習に使わない。
-- ===========================================================================
--
-- ## なぜ列を消さず、制約にするか
--
-- 同意の記録は、何を尋ね、何と答えたかの証跡である。列を消すと、過去の行が
-- 何を持っていたかが読めなくなる。値は残し、これから先 true が入らないこと
-- だけをデータベースが保証する。アプリ側も true を書かないが、アプリの不具合
-- 一つで約束が破れる形にはしない。
--
-- ## 既存の行
--
-- 書き換えない。同意の記録を黙って false に直すのは、参加者が答えた内容の
-- 改ざんになる。true の行が1行でもあれば、このマイグレーションは止まる。
-- その場合は、人が参加者ごとに扱いを決めてから（撤回行を足すなど）再実行する。
-- 第15条は「実装と検証が済むまで本項の同意を取得しない」と定めていたので、
-- 本来は0行のはずである。止まったなら、それ自体が調べるべき事実である。

do $$
declare
  granted bigint;
begin
  select count(*) into granted from public.consent_records where model_training_use is true;
  if granted > 0 then
    raise exception
      'consent_records has % row(s) with model_training_use = true. Decide each one by hand before applying this migration (#469).',
      granted;
  end if;
end;
$$;

alter table public.consent_records
  drop constraint if exists consent_records_no_model_training;

alter table public.consent_records
  add constraint consent_records_no_model_training
  check (model_training_use is not true);

comment on column public.consent_records.model_training_use is
  '常に false。Blesc は参加者のデータをAIモデルの学習に使わない（2026-10-18 決定、#469、consent-pack 第15条）。過去の行を読めるように列は残す。';
