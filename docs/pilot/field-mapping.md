# protocolの項目と、コード上の保存先の対応

> 生成の元は [data-dictionary.json](data-dictionary.json) の `implementation` と `code_ref`。
> **この表の「未実装」は、実装されていないという事実であって、あとで埋める予定という意味ではない。**

## 実装済み

| protocolの項目 | 保存先 | 定義した場所 |
| --- | --- | --- |
| 研究用仮名ID | `public.pilot_enrollments.research_code` | `sentra/supabase/migrations/20260906010000_pilot_enrollment.sql` |
| 参加状態の遷移 | `public.pilot_enrollments.state` と `public.pilot_enrollment_events` | 同上 |
| 本人assent | `public.consent_records.minor_assent` / `pilot_enrollments.assented_at` | `20260906000000_pilot_consent_and_submission_integrity.sql` |
| 保護者確認 | `public.consent_records.guardian_consent` / `pilot_enrollments.guardian_verified_at` / `guardian_verification_method` | 同上 |
| アプリ利用への同意 | `public.consent_records.app_use`（既定 false） | 同上 |
| 研究分析への同意 | `public.consent_records.research_analysis`（既定 false） | 同上 |
| 本文保持への同意 | `public.consent_records.raw_text_retention`（既定 false） | 同上 |
| 同意文書の版 | `public.consent_records.document_version`（既定 `research-consent-doc-v1`） | 同上 |
| 撤回 | `consent_records.status='revoked'` / `revoked_at`、`pilot_enrollments.withdrawn_at` | 同上 |
| 自由記述の本文 | `public.entries.raw_text_ciphertext` / `raw_text_key_version` / `raw_text_expires_at` | 同上 |
| 二重送信の防止 | `public.entries.client_submission_id`（一意索引） | 同上 |
| 保存失敗の記録 | `public.submission_failures` | 同上 |
| 保持期限による消去 | `purge_expired_raw_text()` | 同上 |
| exportの実行記録 | `public.research_exports` | 同上 |
| 記録の過程 | `sentra/frontend/src/lib/telemetry.ts` | — |
| 外部AI送信の停止 | `sentra/frontend/src/lib/server/collectionMode.ts`（5経路） | — |
| protocol版・期間 | `public.pilot_studies.protocol_version` / `baseline_days` / `observation_days` | `20260906010000_pilot_enrollment.sql` |

## 未実装（protocolでは定義済み）

| protocolの項目 | 必要な実装 | 影響 |
| --- | --- | --- |
| 日次固定自己評定 5項目 | 保存先のテーブル（例 `daily_self_reports`）、入力UI、export | **これがないと時系列モデルの独立した目盛りがない。** 本文だけでは正しさを本文由来の量で採点することになる |
| 相対日 / study phase | export時の変換（`collection_started_at` からの差） | 暦日をexportに出さないという要件が満たせない |
| 学習利用の別opt-in | `consent_records.model_training_use` 相当の列と同意UI | 現状はどの参加者のデータも学習に使えない（安全側） |
| 撤回後のexport除外 | export側のフィルタ | dry runの合格条件（撤回後の書き込み・export 0） |
| 保護者からの撤回経路 | 受付方法が未決定（consent-pack C4） | 決定待ち |

## 定義はあるが決定待ち

| 項目 | 決定者 | 参照 |
| --- | --- | --- |
| `support_contact`（相談接触） | 研究倫理責任者 | [data-dictionary.json](data-dictionary.json) |
| 本文の保持期間 | データ管理責任者 | [protocol §8](protocol.md) |
| 危機記述のレビュー頻度 | 学校責任者・研究責任者 | [protocol §4.4](protocol.md) |

## 収集しないことをコード側でも保証しているもの

| 項目 | 保証の場所 |
| --- | --- |
| 本文の外部AI送信 | `collectionMode.ts` + `tests/collection-mode.test.mjs`（新しい送信点を足すとテストが落ちる） |
| 平文での本文保持 | `raw_text_crypto.ts` / `raw_text_crypto.py`。鍵がなければ保持そのものを行わない |
| 参加者による暗号化列の直接更新 | `20260906000100_restrict_entries_raw_text_columns.sql`（[#166](https://github.com/jbjgjf/BLESC/issues/166) で完全性を確認） |
| 未招待者の参加 | `pilot_invitations` の hash 照合と `pilot_enrollments` の状態機械 |

## 更新の仕方

1. [data-dictionary.json](data-dictionary.json) の `implementation` と `code_ref` を直す。
2. `python3 docs/pilot/render_dictionary.py` を実行する。
3. この表の該当行を移す。

**JSONを直さずにこの表だけ直さない。** 実装とexportが読むのはJSONのほうである。
