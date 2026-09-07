# 世界モデル研究エンジンの文書

実装は `sentra/backend/research_engine/`。設計の正本はWikiで、この配下には**リポジトリ側で管理する研究計画**を置く。

| 文書 | 対応Issue | 状態 |
| --- | --- | --- |
| [R1 実観測の利用計画と表現・測定の検証](research-r1-real-observations.md) | #153 | 設計。実行前 |
| [R2 多時間尺度・高次構造・部分識別](research-r2-multiscale-structure.md) | #154 | 設計。実行前 |
| [R3 観測選択と前向き評価](research-r3-observation-selection.md) | #155 | 設計。実行前 |

Wiki側:
[入口](https://github.com/jbjgjf/BLESC/wiki/Research-Engine) /
[全体設計](https://github.com/jbjgjf/BLESC/wiki/Research-Architecture) /
[受け渡し仕様](https://github.com/jbjgjf/BLESC/wiki/Research-Contracts) /
[評価仕様](https://github.com/jbjgjf/BLESC/wiki/Research-Evaluation) /
[実行計画](https://github.com/jbjgjf/BLESC/wiki/Research-Delivery)

## 3つの文書に共通する前提

**v0は合成データのみ。** 実データの取込は契約の2箇所（`permitted_uses` と `source_kind`）で拒否されている。R1の§2に、その拒否を外すために揃える条件を判定者つきで書いた。

**設計と実行は別。** R1〜R3は研究計画であり、実験の実行でも参加者導入の完了でもない。この3文書が揃ってもEpic #156 は閉じない。

**依存の向き。** R3はR2に依存する（事後分布がなければ情報利得が定義できない）。R2はR1に依存しない部分が多く、合成データだけで先に進められる。R1は実データの承認経路（#161〜#168）に依存する。
