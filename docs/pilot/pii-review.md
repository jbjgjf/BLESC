# 自由記述のPII review queue（#167）

`sentra/docs/research_export_and_pii.md` が **scanner とexportの仕様**、この文書が
**review queue の運用**。scanner が何を見つけ何を見逃すかはあちらに書いてあり、
ここでは繰り返さない（2つの版ができると、片方が必ず古くなる）。

- scanner: `sentra/frontend/src/lib/piiScanner.ts`（version `pii-scanner-ja-v1`）
- queue: `sentra/supabase/migrations/20260909030000_pilot_pii_review_and_export.sql`

---

## 1. なぜqueueが要るのか

scanner だけなら export のたびに走らせれば足りる。queue があるのは、
**「この提出は人が見て判断済みかどうか」が状態として残らないと運用にならない**から。

- 誰がいつ判断したのかが残らないと、同じ提出を何度もreviewすることになる。
- scanner を更新したとき、「古い版で通しただけの行」を選び出せない。
- 判断が「blocked（exportしない）」だった提出を、次のexportが黙って含めてしまう。

## 2. いつ走るか

日記本文が**保持された**とき、保持と同じ場所で走る
（`lib/server/supabaseWriter.ts`、平文を持っている唯一の地点）。

export時ではない。exportの頃には `purge_expired_raw_text` が本文を消している可能性が
あり、そのときreviewerは「中身がもう存在しない記録」の可否を判断させられる。

保持されなかった本文はscanしない。exportに到達しえないものについて、判断すべきことは
ない。

## 3. queueに入るもの

| 列 | 内容 |
| --- | --- |
| `entry_id` | 対象の提出。1提出1行（再scanは行を置き換える） |
| `scanner_version` | どのscannerが判定したか |
| `finding_count` / `max_confidence` / `kinds` | 件数・最大確度・種別 |
| `findings_json` | `{kind, confidence, start, end}` のみ |
| `status` | `clear` / `pending` / `cleared` / `redacted` / `blocked` |

### 該当文字列は入らない

scanner の `PiiFinding` は `text`（一致した文字列そのもの）を持つ。運用画面で
「どこが引っかかったか」を見せるにはそれが要るが、**保存してはいけない**。
保存した時点で、queue が別の権限の下に置かれた日記本文の第2の複製になり、
queue が防いでいるはずの漏洩そのものになる。

`forStorage()` がそれを落とし、`findings_json` のCHECK制約が
`kind` / `confidence` / `start` / `end` 以外のキーを拒否する。
`scanForPii` の結果をそのまま入れようとすると、DBが弾く。

本文を読む必要があるreviewerは、export経路（`RESEARCH_EXPORT_USER_IDS`）から読む。
その閲覧は `research_exports` に記録される。

## 4. reviewの手順

1. `GET /api/research/pilot-dashboard?study=<slug>` の `pii_review.by_status` で
   `pending` の件数を見る。ここに本文は出ない。
2. `pending` の `entry_id` について、必要な場合のみ export で本文を読む。
3. 判断を `pilot_pii_reviews.status` に書く。`cleared` / `redacted` / `blocked` は
   人の判断なので、`reviewed_by` と `reviewed_at` がないとDBが拒否する。
   - `cleared` … findingsは特定情報ではなかった（例:「東京都」だけ）
   - `redacted` … `redactFindings` で置換すればexport可
   - `blocked` … exportしない。理由を `review_note` に1行で書く
4. `review_note` に本文を引用しない。引用した時点で、queueに本文を入れたのと同じ。

## 5. status を「安全」と読み替えないこと

`status = 'clear'` は **scannerが何も見つけなかった** という意味であって、
**特定できない** という意味ではない。

`sentra/docs/research_export_and_pii.md` の「原理的に見つけられないもの」——
ひらがなの下の名前、名前を出さない特定——は `clear` の行にもそのまま当てはまる。
50人のコホートでは「クラスで唯一オーボエを吹いている子」は一人に絞れるが、
scanner はそこに何も見ない。

exportの可否を決めるのは人。scannerはその順番を決めるだけ。

## 6. scannerを更新したとき

1. `PII_SCANNER_VERSION` を上げる。
2. `tests/pii-scanner.test.mjs` に、追加したpatternのtrue positiveと、増えた
   false positiveの反証を書く。合成テキストのみ。実在の参加者の本文を入れない。
3. 旧versionで `clear` / `cleared` になっている行は、`scanner_version` が古い行として
   再scan対象になる。古い版で通ったことは新しい版で通ることを意味しない。
