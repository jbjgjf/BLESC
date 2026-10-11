# 抽出品質のゴールドセット（合成）

日記の文からノードと関係を取り出す抽出が、どれだけ正しいかを測るための正解セットです。#7 は「抽出品質を測れること」を期待する成果の1行目に挙げていましたが、閉じた時点で、ラベル付きの正解に対する適合率・再現率はありませんでした。これはその形式と道具です。

## まず読むこと：いまの正解はすべて草案です

**すべての項目は `labelled_by: "draft"` です。** 文も正解も、同じモデル（`author: "model:claude-opus-5.5"`）が書きました。

#88 の原則は「問題と答えを同じモデルが書かない」です。モデルが書いた問題と答えで測ると、そのモデルの得意な形をしたベンチマークになります。そのため、

- 評価器は、`labelled_by: "draft"` の項目を**確証的な数字（`confirmatory`）から必ず除きます。** 草案だけで出た数字は `preliminary` に分けて出します。
- 人のラベルが1件も無いあいだ、`confirmatory` は `None`（「測っていない」）です。0 ではありません。
- この性質は `sentra/backend/tests/test_extraction_gold.py` で固定しています（草案を書き換えても確証的な数字が動かないこと、など）。

もう一つ、草案を書いたモデルは、測る対象の mock 抽出器の語彙（`llm_adapter.MOCK_CUES`）を読んだあとで正解を書いています。`match_terms` が mock の言い方に寄っている可能性があります。これも `preliminary` を品質の主張に使わない理由です。

## ファイル

| ファイル | 中身 |
| :-- | :-- |
| `gold.json` | 項目の本体 |
| `README.md` | この文書 |

評価器は `sentra/backend/app/evaluation/extraction_gold.py`、表を出すのは `sentra/backend/scripts/report_extraction_gold.py` です。

## 項目の形

オントロジーの語彙（`sentra/backend/app/ontology/schema.py` の `CATEGORIES` と `RELATIONS`）をそのまま使います。語彙を広げたり狭めたりはしていません。

```json
{
  "id": "eg-001",
  "text": "明日の数学のテストが不安で、夜なかなか眠れなかった。",
  "labelled_by": "draft",
  "author": "model:claude-opus-5.5",
  "nodes": [
    {"id": "t1", "category": "Trigger", "label": "数学のテスト", "match_terms": ["テスト", "試験"], "evidence": "明日の数学のテスト"},
    {"id": "s1", "category": "State", "label": "不安", "match_terms": ["不安", "心配", "緊張"], "evidence": "不安"}
  ],
  "relations": [{"source": "t1", "target": "s1", "type": "causes"}]
}
```

| 欄 | 意味 |
| :-- | :-- |
| `labelled_by` | `draft`（モデルの草案）か `human`（人がラベルした） |
| `labeller` / `labelled_on` | `human` のときに必須。`labeller` は評定者の ID か役割（例: `rater-a`）。氏名は書かない。`model:` で始まる値は拒否される |
| `nodes[].category` | `State` / `Trigger` / `Protective` / `Behavior` / `Event` |
| `nodes[].label` | 正解の名前 |
| `nodes[].match_terms` | その概念の核になる語。抽出器のラベルがどれかを含めば同じ概念とみなす |
| `nodes[].evidence` | 本文からの**そのままの**引用。本文に無い文字列はテストが拒否する |
| `relations[].type` | `causes` / `escalates` / `buffers` / `avoids` / `co_occurs` / `precedes` |

## 採点の規則

1. **ノードの一致**: 区分（category）が同じで、かつ次のどちらかを満たすとき。
   - 抽出器のラベルが、正解の `label` と同じか、`match_terms` のどれかを含む（全角・半角と大文字・小文字は畳む）
   - 抽出器の `evidence_text` と正解の `evidence` が重なる（どちらかがどちらかを含む）
   区分が違えば、ラベルが合っていても不一致です。たとえば正解が `Trigger` の「テスト」を、抽出器が `Event` で出した場合です。
2. **対応づけは1対1で、最大の組数**をとります。同じノードを2回出しても2回は数えません。出した順番で結果は変わりません。
3. **関係の一致**: 両端のノードが対応づけられ、種類も同じとき。`co_occurs` は向きを問いません。ほかの種類は向きも一致が要ります。
   - あわせて「端点のみ」（種類と向きを問わない）も出します。つながりは見つけたが名前を誤った、を区別するためです。
4. 率は項目ごとではなく、全項目の件数を足してから計算します（マイクロ平均）。分母が0の率は `None`（表では「—」）です。何も出さない抽出器の適合率は「0」ではなく「無い」です。

## 測っている抽出器

モデルを呼ばない経路だけです。有料の API は呼びません。

| 名前 | 中身 |
| :-- | :-- |
| `mock` | API キーが無いときに `/entries` が使う `llm_adapter` の mock を、`validate_extraction` に通したもの（保存されるのと同じ形）。アダプタが実モデル向けに設定されていると、呼ぶ前に止まる |
| `fallback` | 抽出が失敗したときに保存される空のグラフ（`get_fallback_extraction`）。再現率の下限 |

実モデルの抽出を測るのは、このセットに人のラベルが付き、費用の承認が取れてからです。

## ラベル付けの手順

人のラベルを付けて、草案を確証的な数字に入れる手順です。

1. **抽出器の出力を見ずに**ラベルする。評定者は `text` だけを読み、ノード・関係を `schema.py` の `scope_note` に沿って書く。草案（いまの `nodes` / `relations`）を下敷きにしない。下敷きにすると、草案の偏りがそのまま「人の正解」になる
2. `evidence` は本文からそのまま写す。`match_terms` には、その概念を別の言い方で書いても必ず含まれる短い語を入れる。抽出器のラベルに合わせて足さない
3. 2人で独立にラベルし、食い違いを話し合って1つにする。一致率を測る場合は、`docs/benchmark_labelling_runbook.md` の手順と同じく、測った値を測った人が記録する（この README には書かない）
4. 項目を書き換え、`labelled_by: "human"`、`labeller`（評定者 ID）、`labelled_on`（日付）を入れる
5. `python -m pytest tests/test_extraction_gold.py` が通ることを確かめる

人のラベルが30件に満たないあいだは、評価器が「幅の広い暫定値」として警告を出します。

## 実行

```sh
cd sentra/backend
USE_MOCK_LLM=true python scripts/report_extraction_gold.py
```

## 2026-10-10 時点の値（草案との一致。品質の主張ではない）

`origin/main`（2fadb92）の mock 抽出器、17項目（すべて草案）:

| 対象 | 正解 | 予測 | 一致 | 適合率 | 再現率 |
| :-- | --: | --: | --: | --: | --: |
| ノード | 44 | 64 | 13 | 0.20 | 0.30 |
| 関係（種類まで一致） | 27 | 26 | 1 | 0.04 | 0.04 |

`confirmatory` は `None` です（人のラベルが無いため）。mock はどの文にも「ふだんの気持ち」（State）と「毎日の習慣」（Protective）を足すので、`Protective` の適合率が特に低く出ます。
