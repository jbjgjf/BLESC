# 合成→実データ移転研究：測定・入力過程の監査

**Issue：** #214（測定・入力過程の監査）。親 #210。コードは `sentra/backend/research_engine/transfer/audit.py`。
**状態：** 道具は動き、合成データで最後まで走る。実データでは**まだ一度も動かしていない**（承認記録と凍結した事前登録が無いため、同意ゲート #212 が拒否する）。どの指標を副次・探索とするかは事前登録 P8（未決定）。

## 何を見るか

見た目が似ているかではなく、**モデルの採点を変えうる違い**を見ます。提出の頻度、欠測の続き方、答えの日ごとの動き方、書く量と時刻は、モデルとは無関係に「どのモデルが勝つか」を変えます。

## 集計の単位は参加者

記録は最大1,400件ですが、それは50人の記録であって、1,400個の独立な標本ではありません（#214）。

- 指標は**参加者ごとに1つ**計算します。
- 要約（中央値・四分位・平均）は参加者についての要約です。
- 平均の区間は、参加者を復元抽出する bootstrap で出します。毎日提出した参加者が28回数えられることはありません。

## 指標と data dictionary の照合

下の表はコードの `AUDIT_METRICS` と同じです（`tests/test_transfer_audit.py` が照合します）。「export での可否」は `docs/pilot/data-dictionary.json` の該当欄と矛盾しないことを `check_against_dictionary()` が確かめます。

| metric_id | 指標 | 単位 | data dictionary | export での可否 |
|---|---|---|---|---|
| submission_rate | 提出率 | 参加者 | identity.relative_day | `research_export` |
| self_report_answered_rate | 自己評定の回答率 | 参加者 | daily_self_report.items[mood] | `research_export` |
| item_response_rate | 項目ごとの回答率 | 参加者×項目 | daily_self_report.items[{item}] | `research_export` |
| longest_missing_run | 最長の連続欠測 | 参加者 | identity.relative_day | `research_export` |
| n_missing_runs | 欠測の連続の回数 | 参加者 | identity.relative_day | `research_export` |
| within_person_sd | 個人内のばらつき | 参加者×項目 | daily_self_report.items[{item}] | `research_export` |
| lag1_autocorrelation | 個人内の1日自己相関 | 参加者×項目 | daily_self_report.items[{item}] | `research_export` |
| text_char_count_mean | 文字数 | 参加者 | journal.text | `requires_raw_text_retention` |
| submission_hour_median | 提出時刻 | 参加者 | journal.submitted_at | `not_in_research_export` |
| weekday_submission_rate | 曜日ごとの提出率 | 参加者×曜日 | journal.submitted_at | `not_in_research_export` |
| submission_trend_slope | 提出の日数に伴う変化 | 参加者 | identity.relative_day | `research_export` |
| char_count_trend_slope | 文字数の日数に伴う変化 | 参加者 | journal.text | `requires_raw_text_retention` |
| compose_duration | 入力時間 | 参加者 | process_telemetry.fields[compose_duration_ms] | `not_implemented` |
| pause_count | 書き止まり | 参加者 | process_telemetry.fields[pause_count] | `not_adopted` |
| revision_count | 書き直し | 参加者 | process_telemetry.fields[revision_count] | `not_adopted` |

### 「export での可否」の意味

| 値 | 意味 |
|---|---|
| `research_export` | 研究 export に含まれる欄から計算できる |
| `requires_raw_text_retention` | 本文から計算する。本文は原文保持に同意した参加者にしか無いので、その参加者だけで計算する |
| `not_in_research_export` | data dictionary は提出時刻を**相対日に変換して**出す（`submitted_at.in_export = as_relative_day`）。時刻・曜日は export に無く、合成データでだけ計算できる。実データで計算するには export の仕様変更が要り、再識別の危険（`researchExport.ts` の説明）を人が評価する |
| `not_implemented` | data dictionary で未実装、かつ `DECISION REQUIRED`。計算しない |
| `not_adopted` | 取得はしているが、実際の取得率と定義が確認できるまで採用しない（#214）。計算しない |

### 時間帯・曜日の扱い

- 研究期間は28日なので、どの曜日に始めても各曜日は4回ずつ入ります（protocol §3）。曜日ごとの提出率は、各曜日4日分の割合です。
- 曜日は収集開始日から導きますが、開始日は対応表の側（`pilot_enrollments.collection_started_at`）にあり、研究 export にはありません。
- 提出時刻は日本時間で数えます。

### 未定義と0は別

- 観測が2点未満なら個人内のばらつきは未定義、連続する観測の組が5未満なら自己相関は未定義です。未定義の参加者は `n_undefined` に数え、0として平均に入れません。
- 本文が無い参加者の文字数は未定義です（0文字ではありません）。

## 合成と実の比較

`compare_audits()` は、実の参加者単位の値と合成の参加者単位の値の差（平均の差と、参加者の bootstrap による区間）を、指標ごとに出します。

- **指標の定義が違う監査どうしは比較しません。** 指標の定義全体の hash（`metric_set_hash`）が一致しないと拒否します。
- **後から生成器を合わせ直した結果と混ぜません。** 実データを見た後に生成器の設定を変えた合成データ（`post_hoc_adjusted`）との比較は、「探索（事後調整）」として別の一覧に入れます（`collect_comparisons()`）。
- どの指標を副次・探索とするかは事前登録 P8 で決めます。比較の出力は「P8 未決定」と書きます。

## 公開レポートに出さないもの

`public_view()` は次を除きます。

- 参加者単位の値（研究コード付きの値）
- 最小値・最大値（それぞれが1人の値であるため）
- 参加者数が公開の最小単位より少ない要約（最小単位は未決定。同意表の G7。コードの既定値5は仮置き）
- 本文

## 実行

```bash
cd sentra/backend
python -m research_engine.transfer.cli audit --seed <seed> --missingness <シナリオ> --out <出力先>
```

合成コホートを作って同意ゲートを通し、`audit.json`（内部用、参加者単位の値を含む）と `audit_public.json`（公開用）、`dictionary_check.json`（照合の結果）を出します。照合が1件でも一致しなければ終了コード1です。

## 人が決めること

- どの指標を副次・探索にするか（P8）
- 区間の水準と bootstrap の回数（P3・P8。コードは 90%・1000回を仮置き）
- 公開の最小集計単位（G7）
- 提出時刻・曜日を実データで計算するために export を広げるか（再識別の危険の評価を含む）
- 書き止まり・書き直しを採用するか（取得率と定義の確認の後）
