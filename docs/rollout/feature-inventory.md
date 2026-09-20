# 導入に必要なページ・機能の棚卸し

2026-09-19作成。読み取り調査のみ。対象コミット `c243d0c`、対象は `sentra/frontend/src` と `docs/`。

この文書は**現状の実装と、導入に必要なものの差分**を並べたものであり、承認・完了の記録ではない。
ここに「必要」と書いたことは、実装の要否がまだ決まっていない項目を含む。決まっていないものは `DECISION REQUIRED` と書く。

## 凡例

| 記号 | 意味 |
| --- | --- |
| ✅ | 実データで動く実装がある |
| 🟡 | 実装はあるが、固定データ・草案・部分的など、そのままでは導入に使えない |
| ❌ | 実装が見当たらない |
| `DECISION REQUIRED` | 実装以前に人間の決定が要る |

## 前提: 2つの導入

必要なものが大きく違うため分ける。

- **A（パイロット導入）**: 協力校での50名×21日の基礎データ収集。[protocol](../pilot/protocol.md) の収集専用モードが前提。本文書の無印はすべてAを指す。
- **B（サービス導入）**: 収集専用モードを解除した通常運用、および他校展開。Bでのみ必要な項目に `【B】` を付す。

AとBを同じ実装で回す前提は置かない。[service-inventory](../legal/service-inventory.md) が「通常モードと研究モードの混在を防ぐこと」を正式化前の確認事項に挙げている。

---

## 0. 現状（実装済みの30ページ）

実データで動くページと、固定データ（`sentra/frontend/src/lib/blesc/fixtures.ts`）で動くページが混在している。

| 区分 | ページ | 状態 | 備考 |
| --- | --- | --- | --- |
| 公開 | `/`, `/login`, `/demo` | ✅ | |
| 公開 | `/legal` | 🟡 | 4文書とも未承認の草案（`legal-review-2026-09-14-v1`） |
| 参加登録 | `/pilot/join`, `/pilot/guardian/[token]` | ✅ | |
| 参加者 | `/journal`, `/chat`, `/recall`, `/timeline`, `/insights`, `/graph`, `/consent`, `/sharing`, `/support-summary`, `/audit` | ✅ | |
| 参加者 | `/reflect` | 🟡 | 固定データ |
| 教員 | `/educator`, `/educator/roster`, `/educator/student/[participantId]` | ✅ | |
| 教員 | `/educator/alerts`, `/educator/class`, `/educator/meetings`, `/school` | 🟡 | 固定データ |
| 保護者 | `/guardian` | 🟡 | 固定データ。後述 0.2 |
| 相談員 | `/oversight` | ✅ | |
| 研究 | `/research`, `/research/world-model`, `/evaluation`, `/evaluation/runs/[runId]` | ✅ | |
| 運用者 | （なし） | ❌ | 後述 §5 |

### 0.1 固定データ画面の到達性

`components/AppNav.tsx` の `DEMO_ONLY_NAV_PATHS` は `/reflect`、`/educator/alerts`、`/educator/class`、`/educator/meetings`、`/school` の5つをデモ外のナビゲーションから外す。
**ナビには出ないが、ルート自体は残っており、直接URLで到達すると固定データを描画する。** 導入時は次のいずれかを選ぶ。

- 実データへ接続する
- ルートごと落とす（またはデモ以外で404を返す）

`DECISION REQUIRED`: 5画面それぞれについて、接続するか落とすか。決めるのはowner。

### 0.2 `/guardian` はナビ制限にも入っていない

`app/guardian/page.tsx` は `GUARDIAN_VIEW`（固定データ）を描画し、認証ガードもデモガードも持たない。`DEMO_ONLY_NAV_PATHS` にも含まれない。
実在しない生徒名と気分系列が、保護者向けダッシュボードとして誰にでも表示される。パイロットでは [protocol](../pilot/protocol.md) §7.3 により個人の結果を保護者へ返さないため、**表示しないことが計画と整合する。**

---

## 1. 認証・アカウント

| # | 必要なもの | 状態 | 根拠・所在 |
| --- | --- | --- | --- |
| 1.1 | パスワード再設定（依頼画面・更新画面） | ❌ | `resetPasswordForEmail` の呼び出しがソース全体に0件。忘れた時点で参加が止まる |
| 1.2 | メール確認の着地ページ | 🟡 | `app/login/page.tsx` が `emailRedirectTo` を `/login` に戻すだけ。確認成功・失敗・期限切れの区別を表示しない |
| 1.3 | 公開サインアップの封鎖と招待制サインアップ | ❌ | `app/login/page.tsx` の `supabase.auth.signUp` が誰でも押せる。[protocol](../pilot/protocol.md) §2は「招待コードのみ。公開signupからは参加できない」 |
| 1.4 | アカウント設定（表示名・メール変更・パスワード変更・ログアウト） | ❌ | |
| 1.5 | 退会・アカウント削除（研究の撤回とは別導線） | ❌ | |
| 1.6 | サーバ側のルートガード | ❌ | `middleware.ts` が存在しない。教員画面の保護は `app/educator/layout.tsx` の `useAuth().isEducator` によるクライアント判定のみで、実効的な境界はRLSだけ |
| 1.7 | 職員アカウントのMFA、共有端末での自動ログアウト | ❌ | 生徒の記述を読む権限がある以上、導入条件に含める |
| 1.8 | 【B】SSO（Google Workspace / Microsoft Entra）、ドメイン制限 | ❌ | |

---

## 2. 参加者（生徒）

| # | 必要なもの | 状態 | 根拠・所在 |
| --- | --- | --- | --- |
| 2.1 | 日記入力と固定自己評定5項目 | ✅ | `app/journal/page.tsx` + `components/SelfReportBlock.tsx` |
| 2.2 | 過去の記録の一覧・単票表示・編集・削除 | ❌ | 単票のパーマリンクも削除UIもない |
| 2.3 | 記録の検索 | ❌ | |
| 2.4 | 初回オンボーディング（何を書くか、AIが何をしないか、危険と思われる記述は運営者が読む場合がある旨） | ❌ | [protocol](../pilot/protocol.md) §4.4が「読む可能性を伏せたまま読むことはしない」と定める。説明文書だけでなく画面上の導線が要る |
| 2.5 | 撤回フロー（いつでも・理由不要・既収集データを残すか削除するか本人が選ぶ） | 🟡 | `ApiClient.revokeConsent` はあるが、[protocol](../pilot/protocol.md) §5.2の選択分岐を持つ画面がない |
| 2.6 | 同意の版上げと再同意（差分提示→再同意の記録） | 🟡 | `consent_records.document_version` は持つ。v1→v2改訂が控えており、再同意UIなしでは版整合が取れない |
| 2.7 | 本人による自分のデータの書き出し（開示請求・ポータビリティ） | ❌ | 研究exportはあるが本人向けがない |
| 2.8 | オフライン下書き・通信断からの復帰 | ❌ | `app/journal/page.tsx` に `localStorage` も下書き保存もない。`EntryNotPersistedError` は失敗を伝えるだけ |
| 2.9 | 収集専用モード時の画面出し分け | 🟡 | 送信の停止は `lib/server/collectionMode.ts` がサーバ側で担保する。一方ナビゲーションは `demo` フラグでしか絞らないため、`/chat` `/graph` `/insights` `/recall` が押せて応答だけ返らない状態になりうる |
| 2.10 | 相談窓口の常設表示（校内相談先・外部窓口） | 🟡 | `components/SafetyNoticeLog.tsx` はあるが常設導線ではない |
| 2.11 | お知らせ・障害情報の表示 | ❌ | |

---

## 3. 保護者

| # | 必要なもの | 状態 | 根拠・所在 |
| --- | --- | --- | --- |
| 3.1 | トークンによる保護者確認 | ✅ | `app/pilot/guardian/[token]/page.tsx` |
| 3.2 | 保護者ダッシュボードの処遇 | 🟡 | 0.2参照。`DECISION REQUIRED`: パイロットでは非表示が計画と整合する。Bで復活させるかは別決定 |
| 3.3 | 保護者による撤回の受付画面 | ❌ | [protocol](../pilot/protocol.md) §5.2に保護者撤回が定義されているが、保護者から辿れる画面がない |
| 3.4 | 確認メールの再送、トークン期限切れからの再発行導線 | 🟡 | `app/api/pilot/guardian/issue` はあるが保護者側の入口がない |
| 3.5 | 保護者説明文書の印刷用出力 | ❌ | 紙配布が現実的な運用であれば必要 |
| 3.6 | 【B】保護者アカウントと項目別同意 | ❌ | [docs/legal/README.md](../legal/README.md) が「保護者の項目別同意」を未完了と記載 |

---

## 4. 教員・学校

| # | 必要なもの | 状態 | 根拠・所在 |
| --- | --- | --- | --- |
| 4.1 | 生徒一覧・個別状況 | ✅ | `app/educator/`（`roster`, `student/[participantId]`） |
| 4.2 | アラート・クラス・面談・学校全体 | 🟡 | 4画面とも固定データ。0.1の決定に従う |
| 4.3 | 名簿の取り込み、クラス編成、年度更新、転出・卒業の処理 | ❌ | |
| 4.4 | 教員の招待・権限付与・剥奪（org_admin向け） | ❌ | 現状はDB直編集でしか付与できない |
| 4.5 | 閲覧理由の記録と、生徒側への閲覧履歴の開示 | 🟡 | `ApiClient.recordEducatorAccess` / `listEducatorAccess` はあるが、生徒が自分の閲覧履歴を見る画面が弱い |
| 4.6 | 組織名・学校名の設定 | ❌ | `app/educator/layout.tsx:45` に `"広尾学園 中学校・高等学校"` がフォールバックとしてハードコードされている。`lib/blesc/demoApi.ts` と `fixtures.ts` にも同じ文字列がある。他校導入で誤表示になる |
| 4.7 | 教員向けの利用規約・研修の同意記録（何を見てよく、何を見ないか） | ❌ | |
| 4.8 | 危機記述を受けた教員側の受け口（誰が何分以内に何をするか） | ❌ | [incident-runbook](../pilot/incident-runbook.md) の手順を支える画面がない |

---

## 5. 運用者・研究事務局

**画面が0ページ。導入時に最も大きい欠落。** APIとSQLは存在するが、どのページからも呼ばれていない（`sentra/frontend/src` のうち `app/api/` を除いた全体で参照0件）。
現状、運用担当はcurlとSQLコンソールで作業することになる。

| # | 画面 | 状態 | 既存の裏付け |
| --- | --- | --- | --- |
| 5.1 | 招待コードの発行・配布状況・失効・残数 | ❌ | `app/api/pilot/admin/invitations/route.ts`, `lib/server/inviteCodes.ts` |
| 5.2 | 参加者・enrollment一覧と状態遷移（draft→recruiting→active→closed） | ❌ | `app/api/pilot/enrollment/route.ts`, `lib/server/pilotStore.ts` |
| 5.3 | 保護者確認の進捗・再送・手動確認 | ❌ | `app/api/pilot/guardian/*`, `lib/server/guardianStore.ts` |
| 5.4 | 撤回の受付と処理（残す／削除の反映、撤回後の書き込み0の確認） | ❌ | 撤回後にexportへ含めないことは [#168](https://github.com/jbjgjf/BLESC/issues/168) の合格条件 |
| 5.5 | 危機エスカレーションのトリアージ（平日10時・16時の目視確認、既読と対応の記録、一次連絡30分の計測） | ❌ | `app/api/safety/dispatch/route.ts`, `app/api/cron/safety-dispatch/route.ts`, `lib/server/safetyEscalation.ts`。[protocol](../pilot/protocol.md) §4.4が目視レビュー運用を前提にしている |
| 5.6 | 当番表・緊急連絡先・学校担当者の管理 | ❌ | 実装なし。[readiness-audit](../pilot/readiness-audit-2026-09-18.md) が「担当と代替、校内相談先、当番、演習が揃うまで募集しない」 |
| 5.7 | PIIレビュー（検出結果の確認とマスク判断） | ❌ | `lib/piiScanner.ts`, migration `20260909030000_pilot_pii_review_and_export.sql`, [pii-review.md](../pilot/pii-review.md) |
| 5.8 | 研究exportの実行と監査ログ閲覧 | ❌ | `app/api/research/export/route.ts`, `lib/server/researchExportAudit.ts` |
| 5.9 | 対応表（user id ↔ participant id ↔ research code）の限定閲覧 | ❌ | `app/api/research/identity-map/route.ts`。[protocol](../pilot/protocol.md) §8で限定管理者のみ |
| 5.10 | 提出率・欠測・提出失敗・撤回のモニタ | ❌ | `app/api/research/pilot-dashboard/route.ts` が存在するがUIがない |
| 5.11 | 原文保持期限とpurge実行結果の監視 | ❌ | `app/api/cron/retention-purge/route.ts`。[service-inventory](../legal/service-inventory.md) は「自動削除が運用されているとは判断しない」 |
| 5.12 | study設定（`protocol_version` / `document_version` / 収集専用モードの切替） | ❌ | 現状は環境変数とSQL |
| 5.13 | インシデント・障害の記録 | ❌ | |
| 5.14 | 開示・訂正・利用停止・削除請求の受付管理 | ❌ | 法令対応の窓口の実体 |

### 5.15 既存コードの記述と実装の不一致

`lib/server/cronAuth.ts:14` のコメントが `/api/pilot/admin/ops` を「ジョブが実際に動いているかを報告する」ものとして参照しているが、**そのルートは存在しない**（`app/api/pilot/admin/` 配下は `invitations` のみ）。
5.11の監視画面を作る際に、このコメントを実装に合わせるか、ルートを実装するかを決める。

---

## 6. 横断機能

| # | 必要なもの | 状態 | 根拠・所在 |
| --- | --- | --- | --- |
| 6.1 | メール送信基盤（テンプレート、日本語、到達確認、送信ログ、バウンス処理） | 🟡 | `RESEND_API_KEY` の環境変数はある。[service-inventory](../legal/service-inventory.md) は実送信サービスを「不明」とする |
| 6.2 | 提出リマインダーを送らないことの担保 | ❌ | [protocol](../pilot/protocol.md) §4.2が「アプリ・メール・学校から提出リマインダーを送らず、欠測理由も尋ねない」と定める。送らない設計を実装として固定する仕組みが要る |
| 6.3 | 問い合わせ窓口の一本化 | 🟡 | 個人情報窓口は `blesc.jp@gmail.com`、企業サイトの設定は `blesc.official@gmail.com`。[service-inventory](../legal/service-inventory.md) が施行前の統一を求めている |
| 6.4 | ヘルプ・FAQ・使い方 | ❌ | |
| 6.5 | 障害・稼働状況の告知面 | ❌ | |
| 6.6 | アクセシビリティの全画面受入 | 🟡 | `lib/a11y.ts` と `components/a11y/` はある。[#116](https://github.com/jbjgjf/BLESC/issues/116) は全画面・全状態の受入を未完了とする |
| 6.7 | 多言語 | 🟡 | `lib/i18n/ja.ts` のみ。`DECISION REQUIRED`: 日本語のみで確定するかを明文化する |
| 6.8 | 端末・ブラウザ対応（学校配備端末、390px〜1440px） | 🟡 | [readiness-audit](../pilot/readiness-audit-2026-09-18.md) で4画面×2幅のみ実見 |
| 6.9 | レート制限・ボット対策（`/pilot/join` と `/api/*`） | ❌ | |
| 6.10 | 監査ログの横断検索と保持期間 | 🟡 | `lib/audit-trail.ts` ほかに分散 |
| 6.11 | 可観測性（エラー監視、アラート、SLO） | ❌ | [service-inventory](../legal/service-inventory.md) はAnalytics類の導入を確認できないとする |
| 6.12 | バックアップ、復旧演習、復旧時の再削除、鍵ローテーション | ❌ | [readiness-audit](../pilot/readiness-audit-2026-09-18.md) の残条件 |
| 6.13 | 外部通信0件の独立監査（収集専用モードの実証） | ❌ | 同上。health応答の確認は監査ではないと明記されている |
| 6.14 | E2Eと実環境の通し検証 | 🟡 | `playwright.config.ts` と `e2e/` の器はある。専用環境E2Eは未実施 |

---

## 7. 法務・文書

| # | 必要なもの | 状態 | 根拠・所在 |
| --- | --- | --- | --- |
| 7.1 | 利用規約・プライバシーポリシー・研究参加説明・保護者説明 | 🟡 | `lib/legalDocuments.ts` に4文書。すべて未承認の草案で、`/legal` に「確認用草案」と表示される |
| 7.2 | 保有個人データに関する公表事項（事業者名、住所、利用目的、請求手続） | ❌ | [docs/legal/README.md](../legal/README.md) は住所を本文に載せない方針だが、求めに応じ遅滞なく回答する体制を施行前に整えるとしている |
| 7.3 | 委託先・サブプロセッサ一覧と越境移転の説明（Supabase、Vercel、OpenAI） | ❌ | [service-inventory](../legal/service-inventory.md) に接続先の調査結果はあるが、公表用の記載がない |
| 7.4 | 開示・訂正・利用停止・削除の請求フォームと手順 | ❌ | 5.14と対 |
| 7.5 | 漏えい時の報告・本人通知の手順 | 🟡 | 文書はあるが実装・訓練が未了 |
| 7.6 | 保存期間の明示と実装の一致 | 🟡 | 既存Google Docの「1ヶ月」とコード・計画の「21日」が不一致であることが [service-inventory](../legal/service-inventory.md) に記録されている。原文保持は標準・上限90日 |
| 7.7 | 研究倫理審査、学校、データ管理の承認 | ❌ | [approvals.md](../pilot/approvals.md) は空欄。2026-12-01施行の指針改正の該当性確認を含む |
| 7.8 | 【B】特定商取引法に基づく表記、料金・解約条件、DPA、SLA | ❌ | |

---

## 8. 【B】サービス導入で追加になるもの

いずれも ❌。パイロットの範囲外だが、導入の議論では先に線を引いておく。

- 組織テナント管理（複数校）と学校管理者コンソール
- 契約・請求・プラン
- ロール設計の一般化（現状は `educator` / `org_admin` の2種）
- 名簿連携（SIS、Google Classroom）
- 監査レポートの出力、データ保持ポリシーの組織別設定
- 解約時のデータ返却と削除証明
- サポート窓口とSLA、導入マニュアル、教員研修資料
- 料金ページ・申込フォーム
- 収集専用モードを解除する場合の、AI利用コストと安全性の再審査

---

## 優先順位

### 第1段: これが無いと運用が始まらない

1. パスワード再設定とメール確認の着地（1.1、1.2）
2. 公開サインアップの封鎖と招待制化（1.3）
3. 運用者画面の最小版 = 招待発行、enrollment一覧、危機トリアージ、撤回処理、提出モニタ（5.1〜5.5、5.10）
4. 撤回フローと再同意フロー（2.5、2.6）
5. 固定データ画面6つの処遇決定と反映（0.1、0.2、4.2）

### 第2段: 導入前の検証で必ず問われる

6. サーバ側ルートガードと職員のMFA（1.6、1.7）
7. purge・cron・外部通信の監視と証跡（5.11、6.13）
8. 窓口の一本化と法定公表事項（6.3、7.2〜7.4）
9. 学校名ハードコードの除去と組織設定（4.6）

### 第3段: 規模と継続に効く

10. 名簿運用と教員権限管理（4.3、4.4）
11. 記録の単票・編集・削除・検索（2.2、2.3）
12. 可観測性、バックアップ復旧演習、鍵ローテーション（6.11、6.12）

---

## この文書で確認していないこと

推測で埋めない。以下は未確認であり、「無い」と断定していない。

- 本番およびパイロット用Vercel/Supabaseの稼働設定、環境変数の実値、Cronの実行実績。読んだのはリポジトリ内のコードと文書のみ
- バックエンド（`sentra/backend`）側の画面・管理機能の有無。本棚卸しはフロントエンドのルートを対象とした
- `sentra/docs` 配下の設計文書に、ここで❌とした機能の計画が既に存在するかどうか
- 別リポジトリ・別プロジェクトに運用者向けツールが存在する可能性

## 関連

- [パイロット文書一式](../pilot/README.md) — 承認・開始条件
- [開始条件の監査](../pilot/readiness-audit-2026-09-18.md) — 人間の承認・演習側の残件
- [書類草案](../legal/README.md) / [サービス調査](../legal/service-inventory.md)
