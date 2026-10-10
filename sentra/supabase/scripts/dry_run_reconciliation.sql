-- Reconciliation queries for the pilot dry run (#168).
--
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/scripts/dry_run_reconciliation.sql
--
-- Read-only. Every query answers one Go condition, and each prints the rows
-- that violate it rather than a count — a count of 0 is what you want to see,
-- and a count of 3 tells you nothing about which three.
--
-- The last query is the summary. Run all of them; the summary alone does not
-- say which account is at fault.

\echo ''
\echo '=== 1. 期待提出数とDB件数の照合 ==================================='
-- Expected submissions per scenario come from the matrix (days array length).
-- A mismatch here is either a lost write or a scenario that was not run.
with expected(scenario_id, expected_days) as (
  values (1, 3), (2, 3), (5, 1), (6, 2), (7, 2), (8, 3), (9, 3), (10, 3)
)
select
  e.scenario_id,
  e.expected_days,
  count(en.id) as stored_entries,
  case when count(en.id) = e.expected_days then 'ok' else 'MISMATCH' end as verdict
from expected e
left join public.participants p
  on p.code = 'DRYRUN_' || lpad(e.scenario_id::text, 2, '0')
left join public.entries en
  on en.participant_id = p.id
group by e.scenario_id, e.expected_days
order by e.scenario_id;

\echo ''
\echo '=== 2. 同意前の研究書き込み（0であること） ========================'
select
  pe.research_code,
  pe.state,
  en.id as entry_id,
  en.created_at
from public.pilot_enrollments pe
join public.participants p on p.id = pe.participant_id
join public.entries en on en.participant_id = p.id
where pe.state in ('account_bound', 'information_read')
order by en.created_at;

\echo ''
\echo '=== 3. 保護者未確認のまま収集した未成年（0であること） ============'
select
  pe.research_code,
  pe.state,
  pe.is_minor,
  pe.guardian_verified_at,
  count(en.id) as entries
from public.pilot_enrollments pe
join public.participants p on p.id = pe.participant_id
left join public.entries en on en.participant_id = p.id
where pe.is_minor
  and pe.guardian_verified_at is null
group by pe.research_code, pe.state, pe.is_minor, pe.guardian_verified_at
having count(en.id) > 0;

\echo ''
\echo '=== 4. 撤回後の書き込み（0であること） ============================'
select
  pe.research_code,
  pe.withdrawn_at,
  en.id as entry_id,
  en.created_at
from public.pilot_enrollments pe
join public.participants p on p.id = pe.participant_id
join public.entries en on en.participant_id = p.id
where pe.withdrawn_at is not null
  and en.created_at > pe.withdrawn_at
order by en.created_at;

\echo ''
\echo '=== 5. 重複提出（同じclient_submission_idで2件以上。0であること） =='
select
  owner_user_id,
  client_submission_id,
  count(*) as rows_stored
from public.entries
where client_submission_id is not null
group by owner_user_id, client_submission_id
having count(*) > 1;

\echo ''
\echo '=== 6. 保存失敗と、その再送結果 ==================================='
-- A failure is not itself a No-Go: the Go condition is that the participant
-- and the operator both saw it and the retry produced exactly one row.
select
  sf.owner_user_id,
  count(*) as failures,
  max(sf.created_at) as last_failure,
  (select count(*) from public.entries e where e.owner_user_id = sf.owner_user_id) as entries_now
from public.submission_failures sf
group by sf.owner_user_id
order by failures desc;

\echo ''
\echo '=== 7. 招待コードの二重利用（redeemed_count > max。0であること） =='
select id, code_prefix, cohort, max_redemptions, redeemed_count, expires_at, revoked_at
from public.pilot_invitations
where redeemed_count > max_redemptions;

\echo ''
\echo '=== 8. 期限切れコードから作られたenrollment（0であること） ========'
select
  pe.research_code,
  pe.created_at as enrolled_at,
  pi.expires_at
from public.pilot_enrollments pe
join public.pilot_invitations pi on pi.id = pe.invitation_id
where pi.expires_at is not null
  and pe.created_at > pi.expires_at;

\echo ''
\echo '=== 9. 平文で保持された本文（0であること） ========================'
-- raw_text must always be null: retention goes to the encrypted column or it
-- does not happen at all.
select id, owner_user_id, created_at
from public.entries
where raw_text is not null;

\echo ''
\echo '=== 10. 保持期限を過ぎたまま残っている暗号本文（0であること） ====='
-- Non-empty means purge_expired_raw_text() is not being run. A retention
-- period with no job behind it is not a retention period.
select id, owner_user_id, raw_text_expires_at
from public.entries
where raw_text_ciphertext is not null
  and raw_text_expires_at is not null
  and raw_text_expires_at <= now();

\echo ''
\echo '=== 11. 参加者がraw-text列に書ける権限を持っていないか ============'
select column_name, privilege_type
from information_schema.column_privileges
where table_schema = 'public'
  and table_name = 'entries'
  and grantee = 'authenticated'
  and privilege_type in ('INSERT', 'UPDATE')
  and column_name in ('raw_text', 'raw_text_ciphertext', 'raw_text_key_version', 'raw_text_expires_at');

\echo ''
\echo '=== 12. 状態の分布（matrixの期待と突き合わせる） =================='
select state, is_minor, count(*) as accounts
from public.pilot_enrollments pe
join public.pilot_studies ps on ps.id = pe.study_id
where ps.slug = 'dry-run-2026'
group by state, is_minor
order by state;

\echo ''
\echo '=== 13. 要約（すべて0であること） ================================='
select
  (select count(*) from public.pilot_enrollments pe
     join public.participants p on p.id = pe.participant_id
     join public.entries en on en.participant_id = p.id
    where pe.state in ('account_bound', 'information_read'))              as writes_before_consent,
  (select count(*) from public.pilot_enrollments pe
     join public.participants p on p.id = pe.participant_id
     join public.entries en on en.participant_id = p.id
    where pe.withdrawn_at is not null and en.created_at > pe.withdrawn_at) as writes_after_withdrawal,
  (select count(*) from (
      select 1 from public.entries
       where client_submission_id is not null
       group by owner_user_id, client_submission_id having count(*) > 1) d) as duplicate_submissions,
  (select count(*) from public.entries where raw_text is not null)          as plaintext_rows,
  (select count(*) from public.pilot_invitations
    where redeemed_count > max_redemptions)                                as over_redeemed_invites,
  (select count(*) from information_schema.column_privileges
    where table_schema='public' and table_name='entries' and grantee='authenticated'
      and privilege_type in ('INSERT','UPDATE')
      and column_name in ('raw_text','raw_text_ciphertext','raw_text_key_version','raw_text_expires_at'))
                                                                           as participant_raw_text_writes;
