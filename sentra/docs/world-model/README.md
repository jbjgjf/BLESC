# BLESC研究エンジン：設計とチーム実装の入口

版: `research-plan-v1` / 2026-09-06。状態: **設計は確定、v0の実装あり**。
この文書群が書かれた時点では実装前だった。72時間分の実装（Epic [#156](https://github.com/jbjgjf/BLESC/issues/156) の14件）は
`sentra/backend/research_engine/` に入っており、[そのREADME](../../backend/research_engine/README.md) が
「何をしていて、何をしていないか」を実測つきで書いている。以下の設計文書に出てくるAPI・CLI・配置先のうち、
実装済みのものと予定のままのものの区別は、実装側のREADMEと `capability_flags` で確認する。

## 何を作るか

日記と補助観測から、将来の観測を予測する内部状態を学習する。その内部モデルから人が読めるグラフを取り出し、説明の忠実さと予測の誤差を別々に検証する。個人差、履歴、観測の欠落、構造の不確実性を保存する。神経回路の復元や診断を完成目標とはしない。

**3日間の目標は、合成データを使う研究用プロトタイプの統合と再現可能な評価である。** 全研究構想の完成、50人での有効性証明、参加者への公開を意味しない。高度な研究目標は維持し、実装済み・実験的・未検証を区別する。

## 読む順番

| 読者・目的 | 資料 |
| --- | --- |
| 全員：目的と再利用範囲を理解する | [全体設計](architecture.md) |
| 数式を理解したい | [数学入門](math-foundations.md) → [モデルの数学](math-models.md) |
| 先行研究と主張の限界を確認する | [研究根拠と訂正](research-evidence.md) |
| 実装者：入出力を揃える | [受け渡し仕様（Wiki）](https://github.com/jbjgjf/BLESC/wiki/Research-Contracts) |
| 評価者：何をもって成功とするか | [評価仕様（Wiki）](https://github.com/jbjgjf/BLESC/wiki/Research-Evaluation) |
| 統括：誰が何をいつ作るか | [72時間の実行計画（Wiki）](https://github.com/jbjgjf/BLESC/wiki/Research-Delivery) |
| Claudeへ担当作業を渡す | [共通指示とチーム別指示（Wiki）](https://github.com/jbjgjf/BLESC/wiki/Research-Team-Briefs) |

Wikiの入口は [Research-Engine](https://github.com/jbjgjf/BLESC/wiki/Research-Engine)。Wikiは読むための公開版、ここは変更履歴をレビューする版とする。Wikiページに同期元のコミットを残す。変更した仕様をIssue・PR・Discussionへリンクする。

## 既存の作業との関係

- 既存Epic [#102](https://github.com/jbjgjf/BLESC/issues/102)、未完了の [#99](https://github.com/jbjgjf/BLESC/issues/99)・[#100](https://github.com/jbjgjf/BLESC/issues/100) を参照する。新しい研究基盤ができても、これらを自動的に完了にはしない。
- パイロットは [Project 2](https://github.com/users/jbjgjf/projects/2)、運用判断は [Discussion 137](https://github.com/jbjgjf/BLESC/discussions/137) で管理する。
- [PR 138](https://github.com/jbjgjf/BLESC/pull/138) は、確認時点では未マージの同意・保存経路の修正。新チームはそのファイルを同時に変更しない。
- 50人×21日は最大1,050記録、各人の隣接した日次遷移は最大20組。大規模モデルのゼロからの学習データ量と同一視しない。
- 既存の `learning_stages_roadmap.md` は過去のコミットに基づく資料。現在の着手可否は最新mainとIssue/PRの状態を再確認する。

## 72時間の後（後続研究の設計）

3日間の合成プロトタイプの次に来る段階。いずれも**研究計画**であり、実験の実行でも参加者導入の完了でもない。

| 文書 | 対応Issue | 内容 |
| --- | --- | --- |
| [R1 実観測の利用計画と表現・測定の検証](research-r1-real-observations.md) | [#153](https://github.com/jbjgjf/BLESC/issues/153) | 実データの拒否を外す条件、固定アンカー、測定の安定性、50×21で何が推定できないか |
| [R2 多時間尺度・高次構造・部分識別](research-r2-multiscale-structure.md) | [#154](https://github.com/jbjgjf/BLESC/issues/154) | v0が置いた5つの単純化を1つずつ外す実験 |
| [R3 観測選択と前向き評価](research-r3-observation-selection.md) | [#155](https://github.com/jbjgjf/BLESC/issues/155) | 情報利得による質問選択と、`active_questioning` を外す条件 |

依存の向き: R3はR2に依存する（事後分布がなければ情報利得が定義できない）。R2は合成データだけで先に進められる。R1は実データの承認経路（[#161](https://github.com/jbjgjf/BLESC/issues/161)）に依存する。

## 完了を表す言葉

`documented` は文書化済み、`implemented` は動作する実装、`synthetic-tested` は合成条件で検証、`empirically-validated` は別途定義した実観測で検証。四つを取り違えない。固定値だけの画面、インターフェースだけのクラス、未学習の重みを研究エンジンの完成として扱わない。
