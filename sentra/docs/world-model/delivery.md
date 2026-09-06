# 72時間のチーム実行計画

[入口](README.md) / `research-plan-v1` / 開始時刻T0からの相対時間。担当者を割り当て、H6契約を固定した時点で実装を開始する。文書公開時点でチームが稼働しているという意味ではない。

## 分割案と推奨

| 案 | 構成 | 向いている条件・弱点 |
| --- | --- | --- |
| 4チーム | 統括/データ、表現/動態、説明/評価、画面 | 人員が少ない場合。作者と評価者を別セッションにし、モデル側の直列作業が増える |
| **7チーム（推奨）** | 統括1＋データ・表現・動態・説明・評価・画面の6 | 契約で境界を固定できる場合。専門分業と独立評価を保てる |
| 10以上 | 各チームを実装・実験・レビューに細分化 | データと計算環境が既に揃う場合。3日では受け渡し・競合・レビュー待ちが増えやすい |

全員Claudeで進める場合は、T0に1セッション、T1〜T6に各1セッションを基本とする。別セッションで相互レビューし、自分の実装を自分だけで合格にしない。GitHubの人によるレビュー要件は既存CONTRIBUTINGに従う。Claudeの特定モデル名や利用可能枠は未確認のため固定しない。

初期の作業量見積もりは各専門チーム12〜20時間＋レビュー/統合、T0は16〜24時間。実測による見積もりではない。依存データ、環境、担当者、レビュー枠が揃うことが3暦日の条件であり、完了保証ではない。大きいGPUで短縮できない直列工程がある。

## 所有範囲と受け渡し

下記の `research_engine`、`world-model` 配下は新設予定。他チームの所有ファイルを直接変更しない。

| Team | 所有範囲 | 主な出力 | 主なレビュー相手 |
| --- | --- | --- | --- |
| T0 統括・統合 | `research_engine/contracts/`, `cli.py`, `configs/`, 依存ファイル、API接続、CI | schema/fixture、起動・統合経路 | T5 |
| T1 観測・データ | `research_engine/data/` | ObservationBundle、split/normalizer manifest | T5 |
| T2 表現学習 | `research_engine/representation/` | 学習済みencoder、EncodedSequence | T3 |
| T3 動的モデル | `research_engine/dynamics/` | baseline/学習モデル、ForecastBundle | T4 |
| T4 説明・構造 | `research_engine/abstraction/` | ExplanationBundle、忠実度・候補構造 | T3とT5 |
| T5 独立評価 | `research_engine/evaluation/`, `tests/research_engine/fixtures/` | 隔離された合成正解、評価report | T1とT0 |
| T6 研究画面 | `src/app/research/world-model/`, `src/components/research-world-model/` | 時系列・グラフ・根拠の表示 | T0とT5 |

T1〜T4は自分のunit testファイルを `sentra/backend/tests/research_engine/test_<team>_*.py` に置く。T5は統合・漏洩・比較試験を所有する。T6はfrontend内のテストとCSSを所有する。既存Frontend AGENTSが要求するローカルNext.js文書を読んでから実装する。
共有の `requirements`、frontend packageファイル、FastAPIの登録、共有型、CIはT0へ変更案を渡す。パイロットPR #138の同意・日記・writer・SQLをこのスプリントの所有範囲に含めない。

## 作業単位と依存順序

各IDはGitHub Issueへ対応させる。a/bは別の小さいPRにし、各PRの受け入れを明記する。aのfixtureでb以外のチームも先に開発できる。

| ID | 独立してレビューする成果 | 依存 |
| --- | --- | --- |
| T0a | v0 schema、例、拒否例、型の固定 | なし |
| T0b | CLI・研究API・CI・最終統合 | T0a、最終受け入れは全チームb |
| T1a | 既存時系列からの観測アダプター | T0a |
| T1b | 分割・正規化・利用範囲マニフェスト | T1a、T5a |
| T2a | 合成数値入力の学習する予測encoder | T0a、T1b（開発はfixtureで開始） |
| T2b | 保存・再読込・時点制限付きencode | T2a |
| T3a | 持続値・線形予測・統一出力 | T0a、T1b |
| T3b | encoderを使う記憶モデルとrollout | T3a、T2b |
| T4a | 学習する射影と説明モデル | T0a、T3b（開発はfixtureで開始） |
| T4b | 積項の候補・不確実性区別・忠実度 | T4a、T5a |
| T5a | S1〜S5合成・隔離した正解・分割規約 | T0a |
| T5b | 比較report・封印予測・漏洩検査 | T5a、T2b、T3b、T4b |
| T6a | 契約fixtureで全状態の研究画面 | T0a |
| T6b | 実行結果APIとの接続とブラウザ検証 | T6a、T0bのAPI経路、T5b |

T0bのAPI骨格は早期に共有し、T6b/T5bを取り込んだ最終統合で閉じる。依存の循環を避けるため、API骨格PRと最終統合PRを分ける。型fixtureは開発を並行化する道具であり、最終デモは実際の学習成果へ交換する。

## 時間割

| 時間 | 全体の達成条件 |
| --- | --- |
| H0〜H6 | T0aでschema/fixture固定、担当とreviewer決定、T5が評価仮説・分割・seed固定。全員の環境起動 |
| H6〜H24 | T1の入力経路、T2の小型学習、T3 baseline、T4説明fixture、T5合成、T6画面が各自で動く。T0はAPI骨格 |
| H24 | 第1統合：C1/C2を実ファイルで交換。schemaの相違をここで解消 |
| H24〜H36 | encoder固定→動態学習→射影学習を接続。C3/C4の実データ形状を確定 |
| H36 | 破壊的schema変更と新しい依存追加を止める。未達機能は能力フラグと次段階Issueへ記録 |
| H36〜H48 | 合成生成から評価JSONまで1コマンド。T5が独立採点、T6が実reportを表示 |
| H48〜H60 | 欠測・未来混入・未学習・権限・失敗・再読込を検証し、レビュー指摘を修正 |
| H60〜H72 | 3seed再現、ブラウザ証跡、文書同期、CI、レビュー、完成/未完了の判定 |

H24で入力経路が未達なら実データの準備を外し合成に集中。H36でT4が未達なら表示を未対応にし、説明完了と主張しない。H48で実モデルとUIがつながらなければ「統合未完」とする。時間切れをDoneへ読み替えない。

## GitHubでの運用

Wikiは目的・数学・担当別指示、Issuesは個別作業、Projectは状態と依存、Discussionは設計変更と異論、PRは実装と証跡、Actionsは再現手順の実行結果を置く。
各Issueには責任者を一人置く。公開時は `jbjgjf` を受付責任者とし、実装担当の引受後に担当者へ変更する。Teamは責務を示す欄で、実装者が稼働中という意味ではない。未引受はTodo。
`Todo → In Progress → Done` の間のレビュー待ちはBlocker欄にPRを記載する。Doneは受け入れ・CI・レビュー・マージ・デモ証跡が揃ったとき。研究の有効性を同時にDoneとしない。
Claudeは担当Issueの本文と依存Issueの受け渡しコメントを毎回読む。独立branch/worktreeで作業し、他チームと同じcheckoutを使わない。引き継ぎにはcommit SHA、契約版、確認コマンド、結果、残る制約を書く。
契約変更はDiscussionに提案し、結論を仕様のPRへ反映する。長い会話だけに決定を残さない。4時間ごとを目安にIssueへ進捗を残し、H24/H48で全体を実演する。定時投稿の自動化はこの文書では作成しない。

## 72時間の後

R1は許諾された実データと表現/測定の検証、R2は多時間尺度・高次構造・部分識別の実証、R3は観測選択と前向き評価。#99/#100のゲートは対応する研究の条件として残す。パイロットの運用準備は既存Project 2へリンクして管理する。
