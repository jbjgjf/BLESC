# データ辞書（人が読む版）

> 正本は [data-dictionary.json](data-dictionary.json)。**この .md は生成物**で、JSONを変えたら
> `python3 docs/pilot/render_dictionary.py` で作り直す。手で編集しない。

版 `pilot-protocol-v1` / 状態 **draft**

The collected fields of the 50x28 pilot, as one machine-readable source. The app, the export and the analysis all read the field names and scales from here rather than each carrying its own copy - which is how a scale ends up meaning 0-10 in one place and 1-7 in another. `implementation` records whether the field exists in code yet; a field marked not_implemented is a protocol decision that still needs building, not a field that quietly returns null.

- Every self-report item is optional. A missing answer is null with observed=false, never 0 and never the midpoint.
- Times are stored as timestamptz. The analysis uses relative day numbers, not calendar dates, so the export cannot be aligned to a school timetable.
- No field in this dictionary is sent to an external AI provider during the collection window. See sentra/frontend/src/lib/server/collectionMode.ts.
- `DECISION REQUIRED` in a description means the item is not settled. It must not be implemented from a guess.

## 識別子

| id | 型 | export | 実装 | 説明 |
| --- | --- | --- | --- | --- |
| `research_code` | string | True | implemented | 研究用の仮名ID。参加者に見える識別子はこれだけ。auth上のuser idともemailとも結び付けてexportしない。 |
| `relative_day` | integer | True | implemented | 参加者ごとの収集期間の初日を1とした相対日。暦日はexportしない。**0起点ではなく1起点**で、起点は登録日ではなく collection_started_at（＝運営が窓を開けた日）。export上の名前は day_index。 値は1..study_days（pilot_studies.study_days、既定28）。最終日を過ぎた記録は研究データとせずexportから除く。baseline／観察の区分は持たない（#315）。 |

## 日次の固定自己評定

schema id `pilot-selfreport-v1` / 提示順は固定

| 順 | id | 項目 | 尺度 | 必須 | 実装 |
| --- | --- | --- | --- | --- | --- |
| 1 | `mood` | 今日の気分 | likert_0_10 | 任意 | implemented |
| 2 | `stress` | 今日のストレス | likert_0_10 | 任意 | implemented |
| 3 | `sleep_quality` | 昨夜の睡眠の質 | likert_0_10 | 任意 | implemented |
| 4 | `sleep_hours` | 昨夜の睡眠時間 | hours_0_5_step | 任意 | implemented |
| 5 | `event_intensity` | 今日の出来事の大きさ | likert_0_10 | 任意 | implemented |
| 6 | `support_contact` | 誰かに相談できたか | enum(yes, no, prefer_not_to_say) | 任意 | not_implemented |

- `support_contact`: DECISION REQUIRED: 採用するかどうか未決定。質問すること自体が相談を促す介入になりうる。決定者は研究倫理責任者。**未実装は意図的** — 20260909020000 のmigrationで列を置かないことを明示している。他の5項目とは違い『まだ作っていない』ではなく『決めていない』。

## 自由記述

| id | 型 | export | 実装 | 説明 |
| --- | --- | --- | --- | --- |
| `text` | string | pseudonymised_only | implemented | 自由記述。収集期間中は外部AIへ送らない。保持は暗号化列でのみ行い、鍵がなければ保持しない。 |
| `client_submission_id` | string | False | implemented | 再送で重複行を作らないための冪等キー。 |
| `submitted_at` | timestamptz | as_relative_day | implemented | exportでは相対日へ変換する。 |

## 記録の過程

書く過程の記録。参加者の画面には返さない。（`sentra/frontend/src/lib/telemetry.ts`）

| id | 型 | export | 実装 |
| --- | --- | --- | --- |
| `compose_duration_ms` | integer | True | not_implemented |
| `pause_count` | integer | True | implemented |
| `revision_count` | integer | True | implemented |
| `field_order` | array | True | not_implemented |

## 同意

| id | 既定 | 実装 | 保存先 |
| --- | --- | --- | --- |
| `app_use` | False | implemented | public.consent_records.app_use |
| `research_analysis` | False | implemented | public.consent_records.research_analysis |
| `minor_assent` | False | implemented | public.consent_records.minor_assent |
| `guardian_consent` | False | implemented | public.consent_records.guardian_consent |
| `raw_text_retention` | False | implemented | public.consent_records.raw_text_retention |
| `model_training_use` | False | implemented | public.consent_records.model_training_use -> ResearchRow.model_training_use |
| `document_version` | research-consent-doc-v1 | implemented | public.consent_records.document_version |

- `model_training_use`: 二次利用（AIモデルの学習）への別opt-in。本研究への参加・本文提出とは別に取り、既定はオフ。同意しなくても研究には通常どおり参加できる（consent-pack.md 第15条）。2026-09-20に列名を future_fine_tuning から model_training_use へ改名し、DB・export・辞書・画面が一致した。旧名は「future」が『まだ使っていない』という実装当時の事実を永続的な文言として残してしまい、「fine_tuning」は第15条が問う『モデルの学習』より狭い一手法しか指していなかった。exportでは行ごとに載る（撤回・未成年同意欠如でも false）。

## 運用の記録

| id | 実装 | 保存先 | 説明 |
| --- | --- | --- | --- |
| `submission_failures` | implemented | public.submission_failures | 書き込みに失敗した提出の記録。本文は含まない。参加者と運営者の両方が失敗を検知できることが要件。 |
| `enrollment_events` | implemented | public.pilot_enrollment_events | 登録状態の遷移。誰がいつ何をしたかの追記ログ。 |
| `research_exports` | implemented | public.research_exports | exportの実行記録。 |

## 収集しないもの

- 実名、住所、電話番号、学籍番号
- 所属クラス・部活動（個人が特定されうる粒度）
- 医療・診断・服薬に関する直接の質問
- 位置情報
- 端末の連絡先・写真・他アプリの利用状況
