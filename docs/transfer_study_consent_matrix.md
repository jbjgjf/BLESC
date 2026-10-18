# 合成→実データ移転研究：列・操作ごとの許諾表と拒否条件

**Issue：** #212（許諾・分離・撤回ゲート）。親 #210。
**状態：** 案。研究コード側の拒否は実装済み・合成データで検証済み。**実データの処理はまだどこでも承認されていない。** 下の「人が判断すること」が決まるまで、この表を承認済みの許諾範囲として扱わない。

## 何を分けるか

この研究では、実データに対する操作を次の5つに分けます。#212 の「評価利用」と「モデル学習／調整」の区別は、`evaluate` と `fit` の区別です。

| 操作 | 内容 | 例 |
|---|---|---|
| `evaluate` | 合成データだけで作った（凍結した）モデルで、実データを採点する | 持続値の予測と実際の値の差を測る |
| `fit` | 実データから何かを推定する。パラメータ・平均・係数・ハイパーパラメータの調整をすべて含む | 訓練平均、線形ARの係数、チューニング |
| `audit` | 参加者単位の測定過程の記述（#214） | 提出率、連続欠測長 |
| `read_text` | 本文を読む（この研究では文字数を数えるだけ） | 1日あたりの文字数 |
| `external_ai` | 本文・自己評定を外部のAIへ送る | — |

`external_ai` はどの段階でも行いません（protocol §6）。研究コードは合成データでもこの操作を拒否します。

## 列×操作の表

研究コード（`sentra/backend/research_engine/transfer/consent_gate.py` の `CONSENT_MATRIX`）と同じ内容です。片方だけ変えると `tests/test_transfer_consent_gate.py` が落ちます。

| 列 | data dictionary | evaluate | fit | external_ai | 公開報告 |
|---|---|---|---|---|---|
| research_code | identity.research_code | `allowed` | `allowed` | `refused` | `refused` |
| day_index | identity.relative_day | `allowed` | `allowed` | `refused` | `aggregate_only` |
| self_report.mood | daily_self_report.items[mood] | `requires:research_analysis` | `requires:research_analysis+model_training_use` | `refused` | `aggregate_only` |
| self_report.stress | daily_self_report.items[stress] | `requires:research_analysis` | `requires:research_analysis+model_training_use` | `refused` | `aggregate_only` |
| self_report.sleep_quality | daily_self_report.items[sleep_quality] | `requires:research_analysis` | `requires:research_analysis+model_training_use` | `refused` | `aggregate_only` |
| self_report.sleep_hours | daily_self_report.items[sleep_hours] | `requires:research_analysis` | `requires:research_analysis+model_training_use` | `refused` | `aggregate_only` |
| self_report.event_intensity | daily_self_report.items[event_intensity] | `requires:research_analysis` | `requires:research_analysis+model_training_use` | `refused` | `aggregate_only` |
| raw_text | journal.text | `requires:research_analysis+raw_text_retention` | `requires:research_analysis+raw_text_retention+model_training_use` | `refused` | `refused` |
| text_char_count | journal.text | `requires:research_analysis+raw_text_retention` | `requires:research_analysis+raw_text_retention+model_training_use` | `refused` | `aggregate_only` |
| model_training_use | consent.model_training_use | `allowed` | `allowed` | `refused` | `aggregate_only` |
| submitted_at | journal.submitted_at | `not_in_export` | `not_in_export` | `refused` | `refused` |
| measures / ontology | （export の抽出集計） | `unused` | `unused` | `refused` | `refused` |
| pause_count / revision_count | process_telemetry.fields | `not_adopted` | `not_adopted` | `refused` | `refused` |
| compose_duration_ms | process_telemetry.fields[compose_duration_ms] | `not_implemented` | `not_implemented` | `refused` | `refused` |
| field_order | process_telemetry.fields[field_order] | `not_implemented` | `not_implemented` | `refused` | `refused` |

### 値の意味

| 値 | 意味 |
|---|---|
| `allowed` | 研究 export に含まれ、この操作に使ってよい（識別子・相対日・許諾フラグそのもの） |
| `requires:…` | 参加者ごとに、書かれた同意がすべて true のときだけ使う |
| `aggregate_only` | 公開報告には参加者単位の集計だけを出す。個人の値・小集団の値は出さない |
| `refused` | 使わない。研究コードの経路も作らない |
| `not_in_export` | 研究 export に無い（data dictionary は提出時刻を相対日に変換して出す）。合成データにだけある |
| `unused` | export にはあるが、収集専用モードでは抽出が止まっており、この研究では使わない |
| `not_adopted` | 取得はしているが、取得率と定義が確認できるまで採用しない（#214） |
| `not_implemented` | data dictionary で未実装、かつ `DECISION REQUIRED` |

## 研究コード側の拒否条件

研究コードのすべての解析（#214〜#216）は、記録を読む前に `admit()` を通ります。拒否はすべて機械可読のコードを持ちます。

| 条件 | 拒否のコード | どこで |
|---|---|---|
| 生成真値（`GeneratedCohort`・`GenerationTruth`）を入力に渡した | `generation_truth_in_model_input` | `admit()` |
| 実データなのに承認記録が無い | `real_data_approval_missing` | `require_real_data_approval()` |
| 承認記録の欄が空、または必要な役割の承認が無い | `real_data_approval_incomplete` | 同上 |
| 承認した protocol 版・同意文書版が `pilot-protocol-v3`／`research-consent-doc-v3` でない | `real_data_approval_version_mismatch` | 同上 |
| その操作を承認していない役割がある | `operation_not_permitted` | 同上 |
| 事前登録が凍結されていない | `preregistration_not_frozen` | `require_frozen()`（#211） |
| 実データの行（v0）。**承認記録と凍結が揃っていても拒否する** | `real_data_refused` | `contracts/observation.py` の `refuse_unpermitted_uses`・`refuse_real_source_kinds`（`load_observations` 経由で再利用） |
| 外部AIへの送信 | `operation_not_permitted` | `admit()` |
| #315 より前の export（`study_phase` 列がある） | `protocol_shape_mismatch` | `dataset_from_research_export()` |

最後の砦は v0 の契約です。承認記録が揃い、事前登録が凍結されても、`source_kind` が `synthetic` でない行は `real_data_refused` で止まります。契約が求める「サーバー側の同意確認」がまだ存在しないためです。これを外すのはフラグではなく、レビューを受けた契約の変更です（人が行う）。

## 撤回・削除・同意の扱い

| 状態 | 研究コードの扱い | 根拠 |
|---|---|---|
| 研究同意（`research_analysis`）が無い | 全行を除く | export も除く |
| 撤回して「削除」を選んだ | 全行を除く | protocol §5.2 |
| 撤回して「残す」を選んだ | **既定では全行を除く**（`exclude_withdrawn_participants`） | 現在の export（`researchExport.ts` の `isWithdrawn`）が全行を除くため |
| 撤回日以降に書かれた行 | どの方針でも必ず除く | 撤回後の書き込み0件は dry run（#168）の合格条件 |
| export の後に撤回した | 渡された撤回リストで除く | export はその時点の写しであるため |
| `model_training_use` が false | `fit` から除く。`evaluate` には入る | protocol §6、consent-pack 第15条 |
| 実データ（合成でない） | **`fit` を拒否する。** 参加者の同意にかかわらず当てはめに使わない（2026-10-18、#469） | consent-pack 第15条 |
| `raw_text_retention` が false | 本文を持たない。`read_text` 以外の操作には本文を渡さない | protocol §8 |

除いたものは理由ごとの件数で報告します（研究コードは出しません）。

## heldout 参加者が入らない経路

| 経路 | 入らない理由 |
|---|---|
| 合成データの生成 | 生成器の入力は設定と seed だけ。実データを受け取る引数が無い（#213） |
| モデル選択 | 合成上の順位は実データの採点より前に封印する（#215）。封印の後に合成側をやり直した結果は別扱い |
| プロンプトの修正 | LLM ペルソナ生成器のプロンプトは合成参加者の記録からだけ作る。`SYN-` で始まらない仮名を拒否する |
| 当てはめ（`fit`） | 参加者分割で、当てはめ側と評価側の参加者が重なると `split_overlap` で拒否する |

## 合成データだけの dry run

```bash
cd sentra/backend
python -m research_engine.transfer.cli consent-dry-run --seed 11
```

撤回（残す・削除）、研究非同意、撤回後に書かれた模擬行を含む合成コホートを作り、次を実行して結果を出します。すべての検査が通らなければ終了コード1です。

1. 生成真値を渡すと拒否される
2. 実データの形の入力（合成から作った export 形式）が、承認記録なしで拒否される
3. 架空の承認記録があっても、事前登録が凍結されていなければ拒否される（凍結後は v0 契約で拒否される）
4. v0 契約が実データの行を拒否する
5. 外部AIへの送信が拒否される
6. 撤回者（撤回後に書かれた模擬行を含む）の行が、どの操作の入力にも0件
7. 研究非同意者の行が、どの操作の入力にも0件
8. 当てはめには `model_training_use` の参加者だけが入り、評価にだけ入る参加者がいる（合成データ。実データは `fit` 自体を拒否する、#469）
9. 本文は原文保持の同意者だけにあり、`read_text` 以外には渡らない
10. export 後の撤回が除かれる
11. 評価側と当てはめ側の参加者が重ならず、重なりを入れると拒否される

## 人が判断すること

研究コードは、決まっていないところを最も厳しい側に倒しています。緩めるかどうかは次の人が決めます。

| # | 事項 | 今の研究コードの扱い | 決める人（案） |
|---|---|---|---|
| G1 | 訓練平均・線形ARの係数推定を「モデルの学習」（第15条）に含めるか | 含める（`fit` は `model_training_use` の参加者だけ） | 研究倫理責任者・データ管理責任者（事前登録 P14） |
| G2 | 撤回して「残す」を選んだ参加者の、撤回前のデータを解析に使うか | 使わない（export と同じく全行除く）。実データでは既定以外の方針を拒否 | 研究責任者・データ管理責任者 |
| G3 | 実データの処理を承認する役割 | `docs/pilot/approvals.md` の v3 承認欄の3役割（研究責任者・データ管理責任者・運用責任者）をすべて要求 | owner |
| G4 | 承認記録をどこに保存し、研究コードにどう渡すか | 研究コードは引数で受け取るだけで、保存先を持たない | データ管理責任者 |
| G5 | v0 契約の「実データ拒否」を外す条件（サーバー側の同意確認の実装） | 外していない | 研究責任者・T0（契約の所有者） |
| G6 | 文字数を数えるために本文を読むことが、原文保持の同意の範囲に入るか | 原文保持に同意した参加者の本文だけを数える | 研究倫理責任者 |
| G7 | 公開報告の最小集計単位（小集団の値を出さない基準） | 監査は全体の集計だけを出し、参加者数が少ない集計は伏せる | 研究責任者 |
| G8 | 保持期限・研究 export の権限の確認（protocol §8） | 研究コードは export を受け取った後の処理だけを扱う | データ管理責任者 |
