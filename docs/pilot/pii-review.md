# 自由記述のPII review（#167）

研究用exportに参加者以外の人物や、参加者本人を直接特定する情報が入らないようにする
ための手順。**自動検出は補助であり、匿名化の完了を意味しない。** exportの可否を決め
るのは常に人。

- 実装: `sentra/frontend/src/lib/piiScan.ts`（scanner）、
  `sentra/supabase/migrations/20260909010000_pilot_pii_review_and_export.sql`（queue）
- scanner version: `pii-scan-ja-v1`

---

## 1. いつ走るか

日記本文が**保持された**とき、保持と同じ場所で走る
（`lib/server/supabaseWriter.ts`、平文を持っている唯一の地点）。

export時ではない。exportの頃には `purge_expired_raw_text` が本文を消している可能性が
あり、そのときreviewerは「中身がもう存在しない記録」の可否を判断させられる。

保持されなかった本文はscanしない。exportに到達しえないものについて、判断すべきことは
ない。

## 2. queueに入るもの

`pilot_pii_reviews` は **findingsだけ** を持ち、本文は一切持たない。

| 列 | 内容 |
| --- | --- |
| `entry_id` | 対象の提出。1提出1行（再scanは行を置き換える） |
| `scanner_version` | どのscannerが判定したか |
| `finding_count` / `max_severity` / `kinds` | 件数・最大深刻度・種別 |
| `findings_json` | `{kind, severity, start, end, length}` のみ |
| `status` | `clear` / `pending` / `cleared` / `redacted` / `blocked` |

`findings_json` に上記5キー以外を入れると、DBのCHECK制約が拒否する。
「reviewerが見やすいように該当文字列も入れておく」ができないのは意図的で、
それをやった時点でqueueが本文の第2の複製になり、queueが防いでいるはずの漏洩そのものに
なる。

本文を読む必要があるreviewerは、export経路（`RESEARCH_EXPORT_USER_IDS` のallowlist）
から読む。その閲覧は `research_exports` に記録される。

## 3. 検出できるもの

| kind | severity | 例 |
| --- | --- | --- |
| `email` | high | `sakura.t@example.ac.jp` |
| `phone_jp` | high | `090-1234-5678` / `03-1234-5678` / `０９０−１２３４−５６７８` |
| `my_number` | high | 12桁の数字 |
| `student_id` | high | `学籍番号は 2026B014` |
| `postal_code_jp` | medium | `〒150-0001` |
| `address_jp` | medium | `東京都渋谷区` |
| `school_name` | medium | `桜丘高校` / `青葉中学校` |
| `person_name_honorific` | medium | `田中さん` / `佐藤先生` |
| `sns_handle` | medium | `@sakura_2026` |
| `url` | low | `https://…` |

全角の数字・英字・記号は、**文字数を変えない**変換で半角に寄せてから照合する。日本語
IMEで打った `０９０−１２３４−５６７８` を取り逃さないため。NFKC正規化を使わないのは、
文字数が変わるとfindingのoffsetが元の本文の別の場所を指してしまうから。

`お母さん` `お父さん` などの続柄語は、敬称patternに当たるが除外する。毎エントリに出る
false positiveがqueueに並ぶと、reviewerがqueueを読まなくなる。

## 4. 検出できないもの（限界）

`PII_SCANNER_LIMITS` と同一。コードと文書で2つの版が生じないよう、exportのレスポンス
にも同じ配列が同梱される。

- 敬称や肩書きを伴わない氏名（「ゆうた」「Tanaka」）は検出しない。
- ひらがなだけの氏名（「さくらさん」）は検出しない。敬称の前が漢字・カタカナのときだけ
  検出する。
- あだ名・イニシャル・部内での呼び名は検出しない。
- 固有名詞を伴わない間接的な特定（「3年の生徒会長」「隣のクラスの転校生」）は検出しない。
- 複数エントリを突き合わせて初めて特定できる情報は、1件ずつ見る本scannerの対象外。
- 手書き画像・音声・添付ファイルは対象外（本pilotでは収集しない）。
- 日本語と半角英数字を前提とする。他言語の住所・氏名は取りこぼす。
- **検出できたことは匿名化の完了を意味しない。**

「限界を明記する」がAcceptance Criteriaに入っているのは、この一覧が守られない運用が
最も起こりやすい失敗だから。`status = 'clear'` を「安全である」と読み替えた瞬間に、
このscannerは安全性の根拠として使われはじめる。そうではない。

## 5. reviewの手順

1. `GET /api/research/pilot-dashboard?study=<slug>` の `pii_review.by_status` で
   `pending` の件数を見る。ここに本文は出ない。
2. `pending` の `entry_id` について、必要な場合のみ
   `GET /api/research/export?include_raw_text=1&participant_id=…` で本文を読む。
   この閲覧は `research_exports` に記録される。
3. 判断を `pilot_pii_reviews.status` に書く。`cleared` / `redacted` / `blocked` は
   人の判断なので、`reviewed_by` と `reviewed_at` がないとDBが拒否する。
   - `cleared` … findingsは特定情報ではなかった（例: 「東京都」だけ）
   - `redacted` … `redactFindings` で置換すればexport可
   - `blocked` … exportしない。理由を `review_note` に1行で書く
4. `review_note` に本文を引用しない。引用した時点で、queueに本文を入れたのと同じ。

`redacted` を選んだ場合の置換は `[[PII:<kind>]]` という型付きplaceholderで行う。空欄に
しないのは、読み手が「参加者が言いよどんだ」と「名前を消した」を区別できるようにする
ため。

## 6. scannerを更新したとき

1. `PII_SCANNER_VERSION` を上げる。
2. `tests/pii-scan.test.mjs` に、追加したpatternのtrue positiveと、増えたfalse
   positiveの反証を書く。合成テキストのみ。実在の参加者の本文をテストに入れない。
3. 旧versionで `clear` / `cleared` になっている行は、`scanner_version` が古い行として
   再scan対象になる。古い版で通ったことは新しい版で通ることを意味しない。
