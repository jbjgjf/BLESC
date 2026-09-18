# パイロット開始条件の監査（2026-09-18）

**現時点では No-Go（承認された最終判定ではなく、開始条件未充足による募集停止）。**
成人スタッフの合成データ検証と、実在の生徒の募集を区別する。
担当者の署名・決定・演習結果を代理で記入しない。

## 追加対応（同日）

以下は初回監査後の更新。下表の初回所見を履歴として残す。

- ownerがC1のメール `blesc.jp@gmail.com` と担当者3名を指定。join/guardian画面と配布説明文書へ反映。受付時間・学校確認・担当受諾は未確認であり、署名済みではない。
- 専用Vercel `blesc-pilot`（`prj_IjgTAtHZ2tKIZ0AWybYJEcPdrm27`）を作成し、保護を維持してデプロイ。URL: https://blesc-pilot.vercel.app、deployment `dpl_99BkG1pyCmSaEUG7rYoxNdknkGcA`、アプリSHA `0f8ff65`。
- 専用Supabase `blesc-pilot`（`urzzfkkiewleejcthuow`、東京）を作成・確認。空DBへ既存28本の非空migrationを適用（空のtest migrationは除外）。additive → 新アプリREADY → privilege restrictionの順序を守った。追加2本の権限/search_path修正も適用。
- study `pilot-2026-draft` は `draft`。研究募集・収集・招待発行は未開始。OpenAI鍵は設定せず、`NEXT_PUBLIC_PILOT_MODE=1` でURL/sessionのデモ上書きを禁止。運営者・export許可リストは担当アカウント未指定のため未設定。
- 専用SupabaseでSQL検査8本が成功（各検査はrollback）。同意・enrollment・自己評定/PII・oversight・評価/storage・危機通知RLS・trigger/権限。実時間3日間のdry runではない。
- #175の画面実見で、既存テストが見逃した `improving/worsening` によるフォロー選別と状態改善の文言を発見・削除。4画面×390/1440pxの描画・文言検査を再実施。分類名・状態方向の文言の不在を確認。
- #182のeval CIで意図的失敗を検知した証跡: https://github.com/jbjgjf/BLESC/actions/runs/35347322494/job/105606824577 。一時テストは削除済み。通常版eval/test/typecheckとfrontend lint/test/buildはGitHub上で成功。PR #190は人間review/merge待ち。
- 新アプリのhealth応答はok、Supabase接続設定あり・OpenAI鍵なし。これは実地運用合格や外部通信0件の独立監査ではない。
- security advisorの可変search_pathと未認証trigger RPCの指摘を修正。残る7件は認証済みRLS helperのSECURITY DEFINER警告、1件は意図的deny-allの招待表のINFO。全警告を解消したとは扱わない。

**残る開始条件**: その他の正式決定・研究倫理/学校/データ管理承認、危機連絡先と当番、担当アカウント、purge監視、backup/restore・鍵ローテーション・外部通信監査、成人スタッフの実時間3日演習、3名の最終Go署名。build中にnpm auditの11件（critical 1を含む）も報告されたため、依存関係の影響評価も必要。

| 対象 | 確認結果 | 残る作業 |
| --- | --- | --- |
| 承認 | D1–D7・C1–C6・I1は未決定、3役割の承認欄は空欄 | 各決定者が決定内容・根拠・日付を記録し、その後に両版を承認 |
| 問い合わせ | join/guardian画面の配布説明文書への参照は、C1未決定のため未成立 | 正式窓口を決定し、配布文書と画面で一致させて到達確認。`legalDocuments.ts` のメールはレビュー用草案であり、C1の承認証跡ではない |
| #168 | CLOSED、コメント0。テンプレートは未記入、Discussion #137に結果・署名なし | Issueを再開し、成人スタッフ10アカウント×実時間3日を実施。SQL出力、外部通信記録、運用演習、逸脱、3名の署名を記録 |
| #166 | CLOSED、コメント0。Discussionに専用URL・deployment SHA・DB refなし | Issueを再開し、所有者が専用projectの識別子と稼働証跡を提示。分離・RLS・purge・復旧を検証。存在しないとは断定しない |
| #175 | リスク型・バンドの使用は削除済み。観測表示・時刻順への修正と2例目の記録、自動回帰検査がある | デモ含む4画面を各画面幅で実見し、分類の別名再導入や集計漏れを確認するまではIssueを閉じない |
| #181 | 本番Supabase拒否を他の設定検証より先へ移動。キー未設定を明示した回帰テスト | 変更のレビュー・merge |
| #182 | Node 24のeval CIジョブ、test/typecheck、README手順を追加 | PR上でgreenと、意図的失敗でredになる証跡を取得。ローカル成功をCI実行済みと扱わない |
| #116 | 日本語カタログ・翻訳検査は存在し、frontendテスト成功 | 公開deploymentと全状態の文脈・アクセシビリティ・生成応答レビューを完了する。ソース検査だけで全受入条件達成としない |

## ローカル検証

- Node v25.9.0、`sentra/eval`: `npm test` 30/30、`npm run typecheck` 成功。
- `sentra/frontend`: `npm test` 462/462（日本語UI・教員表示の回帰検査を含む）。
- Node 24のGitHub Actions実行、専用環境E2E、RLS実行、外部通信監査、実時間dry runは未実施。
- enrollment関連3ファイルに既存の未コミット変更あり。これらを含む作業ツリーでの結果であり、clean checkoutの証跡ではない。

## 再開に必要な人間の入力

1. 14件の決定と3役割の正式承認（保持期間・保護者確認・撤回削除窓口・危機対応の当番を含む）。
2. 専用Vercel URL / deployment SHA / Supabase ref、所有者、課金主体、運営担当。秘密値は共有記録へ貼らない。
3. 成人スタッフの実施者と3日間の日程、7種の運用演習、研究・データ・運用責任者の判定署名。

これらが揃うまで `pilot_studies.status` を `recruiting` に変更しない。
ツールの実装Issueが閉じたことを、承認・環境構築・演習の完了根拠にしない。
