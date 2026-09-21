-- 撤回したとき、すでに集めたものをどうするかを本人が選ぶ (#224)。
--
-- これまで撤回は常に削除だった。`DELETE /api/consent` が
-- `purge_raw_text_for_participant` を無条件に呼び、保存済みの本文はその場で
-- 消えた。安全側ではあるが、本人の所有権の観点では選ばせていない --
-- 「自分の記録を残したい」という撤回者に、残す手段が無かった。
--
-- ここで足すのは**破棄するかどうか**の選択であって、利用の許可ではない。
-- 撤回は撤回のままで、研究解析も学習利用も止まる。`keep` が意味するのは
-- 「今ある本文を今すぐ消さない」ことだけで、保持期限が来れば
-- `purge_expired_raw_text()` が通常どおり消す。撤回した人が「残す」と言ったのを
-- 「使ってよい」と読み替えないために、この区別は列コメントにも書いておく。
alter table public.consent_records
  add column if not exists retained_data_disposition text;

comment on column public.consent_records.retained_data_disposition is
  '撤回行にのみ入る。''delete''=保存済み本文を即時削除、''keep''=保持期限まで残す。'
  '破棄の可否のみを表し、利用の許可ではない。撤回後も研究解析・学習利用は止まったまま。';

-- 未指定は NULL であって ''keep'' ではない。
--
-- 既定を ''delete'' にしないのは、撤回以外の行（通常の同意記録）にまで
-- 「削除を選んだ」という意味の値が入ってしまうため。**取り違えると危ないのは
-- 逆向き**なので、アプリ側は NULL を delete として扱う（指示が無いことは
-- 残してよいという意味ではない）。その既定は `revokeConsent` にある。
alter table public.consent_records
  drop constraint if exists consent_records_retained_data_disposition_check;
alter table public.consent_records
  add constraint consent_records_retained_data_disposition_check
  check (
    retained_data_disposition is null
    or retained_data_disposition in ('delete', 'keep')
  );

-- 撤回行以外には入れない。撤回していない同意記録が「削除を選んだ」と
-- 読める状態は、あとで撤回の集計を狂わせる。
alter table public.consent_records
  drop constraint if exists consent_records_disposition_only_on_revocation;
alter table public.consent_records
  add constraint consent_records_disposition_only_on_revocation
  check (
    retained_data_disposition is null
    or status = 'revoked'
  );
