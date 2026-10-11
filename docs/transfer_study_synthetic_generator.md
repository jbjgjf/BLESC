# 合成→実データ移転研究：合成参加者の生成器

**Issue：** #213（合成参加者の生成・凍結）。親 #210。事前登録は [transfer_study_preregistration.md](transfer_study_preregistration.md)。
**状態：** 生成器は動く。生成物はすべて**候補（未凍結）**。どの設定・seed・欠測シナリオを凍結するかは事前登録の P13 で決める（未決定）。

## 何を作るか

実パイロットの研究 export と同じ形の合成データを、seed から再現できる形で作ります。

| 項目 | 合成データでの形 | 対応する正本 |
|---|---|---|
| 参加者 | 50名（`SYN-<seed>-<番号>` の仮名） | protocol §2、`PILOT_TARGET_PARTICIPANTS` |
| 日 | 相対日 1〜28（1起点）。29日目以降を作らない | data dictionary `identity.relative_day`、protocol §3 |
| 期間の区分 | **なし**。区分を表す列を持たない（#315） | protocol §3 |
| 自己評定 | 固定5項目（気分・ストレス・睡眠の質は0〜10の整数、睡眠時間は0〜16時間の0.5刻み、出来事の大きさは0〜10の整数）。各項目は任意で、答えなかった項目は `null` | protocol §4.1、data dictionary `daily_self_report` |
| 自己評定の欠け方 | 提出した日に5項目すべてを答えない日（`self_report: null`）と、一部の項目だけ答えない日がある | 同上 |
| 自由記述 | 1日1件の合成の短文。原文保持に同意した合成参加者だけが本文を持つ | protocol §4.2、consent `raw_text_retention` |
| 提出しなかった日 | 記録そのものが無い（`null` の行を作らない） | research export の形 |
| 提出時刻 | 合成の時刻（6:00〜23:59、日本時間）。**研究 export には無い**ので、モデルの入力にしない | data dictionary `journal.submitted_at`（`as_relative_day`） |
| 同意と撤回 | 合成参加者ごとに `model_training_use`・`raw_text_retention`・撤回日と撤回時の選択（残す／削除） | protocol §5.2、data dictionary `consent` |

「誰かに相談できたか」（`support_contact`）は作りません。data dictionary で `DECISION REQUIRED` のままの項目で、作ると決めたことになるためです。

この形が正本と一致していることは `sentra/backend/tests/test_transfer_schema.py` が照合しています。

## 使わないもの

生成器の入力は設定と seed だけです。実参加者データ・実本文・実データの集計値を入力にしません（#213）。manifest の `inputs` にもそう記録します。

生成器の分布（平均・ばらつき・欠測率など）は、コードを動かすために置いた**仮定**です。実測の母集団事前分布ではありません（#62・#99）。

## 生成の仕組み

- 合成参加者ごとに、持続性のある潜在的な「負荷」（strain）を1本の AR(1) で動かします（S1、#149 の考え方）。
- 気分とストレスはその日の負荷に、睡眠の質と睡眠時間は**前日**の負荷に依存します。週末は出来事の大きさと睡眠時間が少し動きます。
- 値は各項目の尺度に丸めます（整数、または0.5刻み）。

## 欠測シナリオ

| シナリオ | 内容 | 用途 |
|---|---|---|
| `independent` | 提出するか、項目を飛ばすかが、その日の状態に依存しない（参加者ごとの提出率だけで決まる） | 独立欠測 |
| `state_dependent` | 負荷が高い日ほど提出しにくく、気分・ストレスを飛ばしやすい。強さは `mnar_strength` | 状態依存欠測 |
| `none` | 何も欠けない。現実的ではない | 欠測感度分析（#216）の基準 |

`state_dependent` の「真値」は合成の中の設定であり、**実データの事実とは呼びません**（#213）。

3つのシナリオは乱数を共有します。同じ seed なら潜在の軌跡と欠ける前の値は同じで、欠測の判定だけが違います。シナリオの間の差は欠測の規則の差であって、乱数の差ではありません。`state_dependent` で強さ0にすると `independent` と同じデータになります。

## 真値の扱い

`generate()` は2つを分けて返します。

- `dataset` — 解析に渡すもの。記録と同意・撤回の状態だけを持つ。
- `truth` — 生成時の負荷、欠ける前の値、欠測の確率。解析に渡さない。

ディスクに書くときも `sealed_truth/` に分けます。`truth` と、それを含む `GeneratedCohort` には印（`__carries_generation_truth__`）があり、解析の入口（同意ゲート、#212）はこの印のあるものを拒否します。

## 未来の情報が混ざらないこと

ある日の値は、その日までの乱数だけで決まります。欠測の判定で負荷を標準化するときも、実際の系列ではなく理論上の定常分散を使います（系列全体を使うと、後の日の値が前の日の判定に入るため）。14日分だけ生成したデータが、28日分のデータの最初の14日とまったく同じになることをテストで確かめています。

## manifest に記録するもの

| 欄 | 内容 |
|---|---|
| `status` | `candidate_not_frozen`（候補・未凍結） |
| `generator` | 種類（`statistical`）、版、**生成コードのファイル hash**、固定パラメータの全部 |
| `config` / `config_hash` | 設定の全部と、その hash |
| `environment` | numpy と Python の版。numpy は版をまたいで乱数列が同じであることを保証しないため |
| `seed` / `missingness_scenario` | seed と欠測シナリオ |
| `shape` | 参加者数、日数、記録数、protocol の形と一致するか |
| `schema` | 5項目の尺度、相対日の範囲、期間区分なし、protocol 版・同意文書版 |
| `inputs` | 実データ・実本文・実データ集計をすべて「使っていない」 |
| `llm` | 使っていない、呼び出し0回、費用0 |
| `hashes` | dataset の hash と、真値の hash |
| `reproduce` | 作り直すコマンド |

作成日時は入れません。入れると同じ seed でも hash が変わるためです。

## 作り直し方

実データを見ずに、次のコマンドで同じものが作れます。

```bash
cd sentra/backend
python -m research_engine.transfer.cli generate --seed <seed> --missingness <シナリオ> --out <出力先>
```

`--seed` と `--missingness` は省略できません。既定値を置くと、凍結する seed とシナリオ（P13）をライブラリが決めたことになるためです。

同じ seed で同じ hash になることは `sentra/backend/tests/test_transfer_generator.py` が確かめます。seed=1・`state_dependent` の hash はテストに固定してあり、生成器の出力が変わるとテストが落ちます。そのときは生成器の版（`GENERATOR_VERSION`）を上げ、すでに封印した結果が古いコードで作られたことを記録してください。

## LLM ペルソナ生成器（インターフェースだけ）

統計生成器とは別のモジュール（`research_engine/transfer/llm_persona.py`）です。今回は**有料 API を呼びません**。用意したのは次のものだけです。

| もの | 内容 |
|---|---|
| `PersonaTextProvider` | provider が実装する1つのメソッド。具体的な provider はこのパッケージに含めない |
| `DisabledProvider` | 既定の provider。すべての呼び出しを拒否する |
| `LLMPersonaConfig` | モデル名（既定値なし）、プロンプトテンプレート、seed、予算（USD）、呼び出し回数の上限 |
| `LLMGenerationRecord` | 要求したモデル、provider が返したモデル版、テンプレートの hash、送ったプロンプト全体の hash、トークン数、費用、呼び出し回数 |

- 費用を返さない応答が1つでもあれば、費用は `null`（未計測）とし、0 にしません。
- 予算が0以下なら始めません。呼び出し回数が上限を超えるなら始めません。報告された費用が予算を超えたら止めます。
- プロンプトは合成参加者の記録からだけ作ります。`source_kind` が `synthetic` でない記録や、`SYN-` で始まらない仮名からは作りません（protocol §6）。
- テストは偽物の provider だけを使います（`test_transfer_llm_persona.py`）。

実際に LLM を使うかどうか、どのモデルを使うか、予算はいくらかは、人が決めることです。

## 決めていないこと

- どの設定・seed・欠測シナリオを凍結するか（事前登録 P13）
- `state_dependent` の強さをいくつにするか（P13、感度分析 #216 の範囲）
- LLM ペルソナ生成器を使うか、使うならモデルと予算（P13 と費用の承認）
