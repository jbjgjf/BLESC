-- 撤回を1つの手続きにする (#263, #224)。
--
-- 撤回の導線は2本あり、互いを呼んでいなかった。
--
--   /pilot/join「参加をやめる」 → pilot_enrollments を withdrawn にするだけ
--   /consent「同意を撤回」       → consent_records に revoked 行 + 本文削除だけ
--
-- 前者では同意が active のまま残り、本人に何も聞かないまま本文が保持された。
-- 後者では参加登録が collecting のまま残り、収集画面も書き込み API も
-- 開いたまま、ダッシュボードは撤回を 0 と数え、欠測として計上し続けた。
--
-- ここでは状態遷移そのものを定義し直す。設計の全体は
-- docs/pilot/withdrawal.md にある。要点だけ:
--
--   撤回 = 次の3つを、1つのトランザクションで行うこと
--     (1) その参加者の、まだ撤回していない参加登録をすべて withdrawn にする
--     (2) consent_records に revoked 行を積む（本人の選択 delete / keep を持つ）
--     (3) delete なら保管本文を消す
--
-- 3つが1つのトランザクションなので、「一部だけ成功した撤回」は存在しない。
-- 失敗したら何も変わらず、呼び出し側は「撤回は完了していません」と言える。
-- どちらの画面から入っても、この関数を通る。

-- ---------------------------------------------------------------------------
-- 1. 手続き
-- ---------------------------------------------------------------------------

create or replace function public.withdraw_from_research(
  p_owner_user_id uuid,
  p_participant_id uuid,
  p_disposition text,
  p_actor text,
  p_source text,
  p_reason text,
  p_consent_version text,
  p_document_version text
)
returns table (
  enrollments_withdrawn integer,
  consent_record_id uuid,
  disposition text,
  purged_raw_text integer
)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  -- 'keep' と完全一致したときだけ残す。それ以外（null・綴り違い）は削除。
  -- 「何も言わなかった」は「残してほしい」ではない (#224)。
  v_disposition text := case when p_disposition = 'keep' then 'keep' else 'delete' end;
  v_now timestamptz := now();
  v_withdrawn integer := 0;
  v_purged integer := 0;
  v_consent_id uuid;
  v_enrollment record;
begin
  -- 他人の参加者を名指しして撤回させることはできない。service_role で
  -- 呼ばれるので RLS は効かない。所有の確認はここでやる。
  if not exists (
    select 1 from public.participants
     where id = p_participant_id and owner_user_id = p_owner_user_id
  ) then
    raise exception 'participant % is not owned by %', p_participant_id, p_owner_user_id
      using errcode = '42501';
  end if;

  -- (1) 参加登録。completed も含める: 収集期間を終えた後の撤回でも、
  -- 研究エクスポートから外れなければならない（protocol §5.2「撤回後に
  -- export へ含めない」）。既に withdrawn のものは触らない -- 最初に
  -- 撤回した時刻が、それ以降の書き込みを数える基準だから。
  for v_enrollment in
    select id, state
      from public.pilot_enrollments
     where owner_user_id = p_owner_user_id
       and participant_id = p_participant_id
       and state <> 'withdrawn'
     for update
  loop
    update public.pilot_enrollments
       set state = 'withdrawn', withdrawn_at = v_now, updated_at = v_now
     where id = v_enrollment.id;
    insert into public.pilot_enrollment_events
      (enrollment_id, owner_user_id, from_state, to_state, actor, reason)
    values
      (v_enrollment.id, p_owner_user_id, v_enrollment.state, 'withdrawn', p_actor, p_reason);
    v_withdrawn := v_withdrawn + 1;
  end loop;

  -- (2) 同意。撤回行は全ての許可を false にして持つので、最新行を読むだけで
  -- 答えが分かる（loadConsentState がそう読む）。app_use は残す:
  -- 研究をやめてもアプリは使える（protocol §5.2「撤回は不利益をもたらさない」）。
  insert into public.consent_records (
    owner_user_id, participant_id,
    app_use, research_analysis, anonymized_export, raw_text_retention,
    model_training_use, minor_assent, guardian_consent,
    consent_version, document_version,
    status, granted_at, revoked_at, retained_data_disposition, source
  )
  values (
    p_owner_user_id, p_participant_id,
    true, false, false, false,
    false, false, false,
    p_consent_version, p_document_version,
    'revoked', v_now, v_now, v_disposition, coalesce(p_source, 'student_ui')
  )
  returning id into v_consent_id;

  -- (3) 本文。keep なら何もしない: 保持期限が来れば purge_expired_raw_text() が
  -- 他の行と同じように消す。keep は「消さない」であって「使ってよい」ではない。
  if v_disposition = 'delete' then
    v_purged := public.purge_raw_text_for_participant(p_participant_id);
  end if;

  return query select v_withdrawn, v_consent_id, v_disposition, v_purged;
end;
$$;

revoke execute on function public.withdraw_from_research(uuid, uuid, text, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.withdraw_from_research(uuid, uuid, text, text, text, text, text, text)
  to service_role;

comment on function public.withdraw_from_research(uuid, uuid, text, text, text, text, text, text) is
  'The one withdrawal procedure (#263): withdraw every enrollment, append a revoked consent row carrying '
  'the participant''s delete/keep choice, and purge stored text on delete, atomically. '
  'Both /consent and /pilot/join call this.';

-- ---------------------------------------------------------------------------
-- 2. 同意の記録を書けるのはサーバーだけにする
-- ---------------------------------------------------------------------------
--
-- `consent_records_own_all` は authenticated に FOR ALL を開けていた。
-- つまりサインインした生徒は、PostgREST を直接叩いて
--   insert into consent_records (..., research_analysis, minor_assent, guardian_consent)
--   values (..., true, true, true)
-- と書けた。#164 は「保護者の同意は /api/pilot/guardian/confirm からしか
-- 書けない」ことを API 層で作ったが、テーブルの権限がそれを素通りさせていた。
-- 撤回行を UPDATE で active に戻すこともできた。
--
-- ブラウザは consent_records を読むだけ（`ApiClient.getConsent`）で、
-- 書き込みは全て service_role のサーバールート経由。だから authenticated には
-- SELECT だけを残す。
drop policy if exists "consent_records_own_all" on public.consent_records;
drop policy if exists "consent_records_select_own" on public.consent_records;
create policy "consent_records_select_own" on public.consent_records
  for select to authenticated
  using ((select auth.uid()) = owner_user_id);

revoke insert, update, delete, truncate, references, trigger
  on public.consent_records from authenticated;
grant select on public.consent_records to authenticated;

-- ---------------------------------------------------------------------------
-- 3. すでに食い違ってしまった行を揃える
-- ---------------------------------------------------------------------------
--
-- A. 同意は撤回したのに参加登録が生きている人（/consent から撤回した人）。
--    撤回の意思ははっきりしているので、参加登録を withdrawn にする。
--    withdrawn_at は同意を撤回した時刻にする -- 「撤回時刻以降の研究書き込みが
--    0」を数える基準は、本人が撤回した時点であって、この修復の時点ではない。
with latest as (
  select distinct on (owner_user_id, participant_id)
         owner_user_id, participant_id, status, revoked_at
    from public.consent_records
   order by owner_user_id, participant_id, granted_at desc
),
targets as (
  select e.id, e.owner_user_id, e.state, l.revoked_at
    from public.pilot_enrollments e
    join latest l
      on l.owner_user_id = e.owner_user_id
     and l.participant_id = e.participant_id
   where l.status = 'revoked'
     and e.state <> 'withdrawn'
     -- 撤回の後に参加登録した人は対象外（撤回→再参加は正当な順序）。
     and e.created_at < l.revoked_at
),
moved as (
  update public.pilot_enrollments e
     set state = 'withdrawn', withdrawn_at = t.revoked_at, updated_at = now()
    from targets t
   where e.id = t.id
  returning e.id
)
insert into public.pilot_enrollment_events (enrollment_id, owner_user_id, from_state, to_state, actor, reason)
select t.id, t.owner_user_id, t.state, 'withdrawn', 'system',
       'repair (#263): consent was revoked on /consent but the enrollment was not withdrawn'
  from targets t
 where t.id in (select id from moved);

-- B. 参加登録は撤回したのに同意が生きている人（/pilot/join から撤回した人）。
--    同意を撤回した行を積む。**本人は削除／保持を選んでいない**ので、
--    retained_data_disposition は null のまま（= 未選択）にし、本文には触れない。
--    勝手に消すのも、勝手に「残す」と記録するのも、本人の選択の代筆になる。
--    /pilot/join の撤回済み画面が、未選択の人に選択を求める。
with latest as (
  select distinct on (owner_user_id, participant_id)
         owner_user_id, participant_id, status
    from public.consent_records
   order by owner_user_id, participant_id, granted_at desc
),
targets as (
  select distinct e.owner_user_id, e.participant_id
    from public.pilot_enrollments e
    join latest l
      on l.owner_user_id = e.owner_user_id
     and l.participant_id = e.participant_id
   where e.state = 'withdrawn'
     and l.status = 'active'
     and not exists (
       select 1 from public.pilot_enrollments live
        where live.owner_user_id = e.owner_user_id
          and live.participant_id = e.participant_id
          and live.state <> 'withdrawn'
     )
)
insert into public.consent_records (
  owner_user_id, participant_id,
  app_use, research_analysis, anonymized_export, raw_text_retention,
  model_training_use, minor_assent, guardian_consent,
  status, granted_at, revoked_at, retained_data_disposition, source
)
select owner_user_id, participant_id,
       true, false, false, false,
       false, false, false,
       'revoked', now(), now(), null, 'withdrawal_repair'
  from targets;
