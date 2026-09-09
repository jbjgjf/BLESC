# BLESC研究エンジン：設計とチーム実装の入口

版: `research-plan-v1` / 2026-09-06。状態: **実装前の設計**。
コード確認基準: `main@7f5763d5adc3aff4d89d9e8ff1c478cc0b722777`。記載する新API・CLI・配置先は予定であり、現行機能ではない。

## 何を作るか

日記と補助観測から、将来の観測を予測する内部状態を学習する。その内部モデルから人が読めるグラフを取り出し、説明の忠実さと予測の誤差を別々に検証する。個人差、履歴、観測の欠落、構造の不確実性を保存する。神経回路の復元や診断を完成目標とはしない。

**3日間の目標は、合成データを使う研究用プロトタイプの統合と再現可能な評価である。** 全研究構想の完成、50人での有効性証明、参加者への公開を意味しない。高度な研究目標は維持し、実装済み・実験的・未検証を区別する。

## 読む順番

| 読者・目的 | 資料 |
| --- | --- |
| 全員：目的と再利用範囲を理解する | [全体設計](architecture.md) |
| 数式を理解したい | [数学入門](math-foundations.md) → [モデルの数学](math-models.md) |
| 高校課程を超える道具を先に押さえたい | [詳解：線形代数・確率・最適化](math-advanced.md) |
| T3：連続時間・記憶・切り替わりを実装する | [詳解：連続時間・記憶・状態の切り替わり](math-dynamics.md) |
| T4・T5：説明の忠実さと評価を実装する | [詳解：説明・構造・識別・評価](math-identification.md) |
| 先行研究と主張の限界を確認する | [研究根拠と訂正](research-evidence.md) |
| 実装者：入出力を揃える | [受け渡し仕様（Wiki）](https://github.com/jbjgjf/BLESC/wiki/Research-Contracts) |
| 評価者：何をもって成功とするか | [評価仕様（Wiki）](https://github.com/jbjgjf/BLESC/wiki/Research-Evaluation) |
| 統括：誰が何をいつ作るか | [72時間の実行計画（Wiki）](https://github.com/jbjgjf/BLESC/wiki/Research-Delivery) |
| Claudeへ担当作業を渡す | [共通指示とチーム別指示（Wiki）](https://github.com/jbjgjf/BLESC/wiki/Research-Team-Briefs) |

### 数学の詳解ページについて

[数学入門](math-foundations.md) と [モデルの数学](math-models.md) は簡潔な索引として維持する。そこで使う道具のうち、現行の高校課程（数学I〜III、A〜C）に含まれないものは、次の三つで定義・導出・数値例・実装上の落とし穴まで展開する。主張を弱めた要約ではないので、注意書きは元の文書と同じ強さで残している。

| 詳解 | 主な内容 | 主な読み手 |
| --- | --- | --- |
| [線形代数・確率・最適化](math-advanced.md) | 行列と固有値、行列指数、正定値性、多変量ガウス、連続ベイズ、階層モデルの縮約、勾配とL1、表現の崩壊、情報量 | 全チーム |
| [連続時間・記憶・状態の切り替わり](math-dynamics.md) | 時定数と観測設計の限界、SDEとEuler–Maruyama、記憶項の導出、semi-Markov | T3 |
| [説明・構造・識別・評価](math-identification.md) | 因果抽象化、Wasserstein距離、ヤコビアン、DAG空間、識別可能性、バックドア調整、部分識別、較正とbootstrap | T4・T5 |

「高校数学を超える語は数学解説へリンクし、未掲載なら説明案を添える」という共通指示の掲載先はこの三つである。新しい語を導入したPRは、該当ページへ節を足すか、Discussionへ説明案を出す。

Wikiの入口は [Research-Engine](https://github.com/jbjgjf/BLESC/wiki/Research-Engine)。Wikiは読むための公開版、ここは変更履歴をレビューする版とする。Wikiページに同期元のコミットを残す。変更した仕様をIssue・PR・Discussionへリンクする。

## 既存の作業との関係

- 既存Epic [#102](https://github.com/jbjgjf/BLESC/issues/102)、未完了の [#99](https://github.com/jbjgjf/BLESC/issues/99)・[#100](https://github.com/jbjgjf/BLESC/issues/100) を参照する。新しい研究基盤ができても、これらを自動的に完了にはしない。
- パイロットは [Project 2](https://github.com/users/jbjgjf/projects/2)、運用判断は [Discussion 137](https://github.com/jbjgjf/BLESC/discussions/137) で管理する。
- [PR 138](https://github.com/jbjgjf/BLESC/pull/138) は、確認時点では未マージの同意・保存経路の修正。新チームはそのファイルを同時に変更しない。
- 50人×21日は最大1,050記録、各人の隣接した日次遷移は最大20組。大規模モデルのゼロからの学習データ量と同一視しない。
- 既存の `learning_stages_roadmap.md` は過去のコミットに基づく資料。現在の着手可否は最新mainとIssue/PRの状態を再確認する。

## 完了を表す言葉

`documented` は文書化済み、`implemented` は動作する実装、`synthetic-tested` は合成条件で検証、`empirically-validated` は別途定義した実観測で検証。四つを取り違えない。固定値だけの画面、インターフェースだけのクラス、未学習の重みを研究エンジンの完成として扱わない。
