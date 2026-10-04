# 撤回の状態遷移（#263, #224）

protocol §5.2 の「本人の撤回」を、システムの上でどう表すかの設計。

## 1. 何が壊れていたか

撤回の入口が2つあり、それぞれが半分ずつを実行していた。

| 入口 | 以前やっていたこと | やっていなかったこと |
| --- | --- | --- |
| `/pilot/join`「参加をやめる」 | `pilot_enrollments.state = 'withdrawn'` | 同意の撤回、本文の扱いを本人に聞くこと |
| `/consent`「同意を撤回する」 | `consent_records` に revoked 行、本文削除 | 参加登録を止めること |

その結果、次のことが起きていた。

- 前者では同意が active のまま残り、本人に何も聞かないまま本文が保持された。
- 後者では参加登録が `collecting` のまま残った。その結果、収集画面と `POST /api/entries` が開いたまま、ダッシュボードの撤回数は 0、提出率は撤回者を欠測として数え続けた。

## 2. 状態

撤回に関わる状態は3つの場所にある。

| 場所 | 値 | 意味 |
| --- | --- | --- |
| `pilot_enrollments.state` | `…collecting` / `completed` / **`withdrawn`** | 研究に参加しているか。収集ゲート・ダッシュボード・エクスポートが読む |
| `consent_records`（最新行） | `active` / **`revoked`** | 何に同意しているか。書き込み経路の同意ゲートが読む |
| `consent_records.retained_data_disposition` | `delete` / `keep` / `null` | 撤回時に本人が選んだ本文の扱い。`null` は「選んでいない」 |

撤回後に成り立つべきこと（不変条件）は次の2つ。

1. 参加登録が `withdrawn` なら、最新の同意行は `revoked`。
2. 最新の同意行が `revoked` なら、その時刻より前に作られた参加登録はすべて `withdrawn`。

撤回後の再参加（新しい招待コードで新しい参加登録を作る）は正当な順序なので、2 は「その時刻より前」に限る。

## 3. 遷移

撤回は **1つの手続き** `withdraw_from_research`（`20260927020000`）で、1つのトランザクションで次の3つを行う。

```
(1) まだ withdrawn でない参加登録をすべて withdrawn にし、pilot_enrollment_events に記録する
    （completed も含める。収集期間の後に撤回しても、エクスポートから外れる必要があるため）
(2) consent_records に revoked 行を積む。研究の許可はすべて false、app_use は true のまま、
    retained_data_disposition に本人の選択を入れる
(3) delete なら purge_raw_text_for_participant で保管本文を消す
```

- **部分的な撤回は存在しない。** どこかで失敗すれば何も変わらない。画面は「撤回は完了していません。何も変更されていません」と言い、「撤回しました」とは言わない。
- **2回目の呼び出しは安全。** 既に `withdrawn` の参加登録には触れないので、`withdrawn_at`（「撤回後の書き込み 0」を数える基準）は動かない。新しい revoked 行は積まれ、`delete` なら本文を消す。「残す」を選んだ人が後から削除に切り替える経路はこれを使う。
- **`keep` は「消さない」だけで、「使ってよい」ではない。** 研究解析・エクスポート・学習利用は、選択に関係なく止まる。
- **`"keep"` と完全一致したときだけ残す。** それ以外の値は削除として扱い、TypeScript（`parseDisposition`）と SQL の両方がこの規則を持つ。

呼び出し元は2つあり、どちらも `lib/server/withdrawal.ts` の `withdrawFromResearch` を通る。

| 入口 | ルート | `consent_records.source` |
| --- | --- | --- |
| `/consent` | `DELETE /api/consent` | `student_ui` |
| `/pilot/join` | `POST /api/pilot/enrollment {to: "withdrawn"}` | `pilot_join` |

両方の画面が同じ `WithdrawalChoice` を出す。押す前に次のことを示す。

- どちらを選んでも研究への協力は終わること
- 「いま削除する」で消えるのは暗号化して預かっている本文で、元に戻せないこと
- 本文を削除しても残るもの（自己評定、記入時間などの記録、抽出した要素、同意と撤回の履歴）。これらも撤回時点から研究には使われないこと

## 4. 同意の記録を書けるのはサーバーだけ

以前の `consent_records_own_all` は authenticated に FOR ALL を開けていた。そのため、サインインした生徒が PostgREST を直接叩いて `guardian_consent = true` の行を書けた。撤回行を `active` に戻すこともできた。

`20260927020000` で authenticated の権限を SELECT のみに絞った。ブラウザは同意を読むだけで、書き込み（同意・撤回・保護者確認）はすべてサーバールート（service_role）を通る。

## 5. 既に食い違っていた行の修復

`20260927020000` の末尾で一度だけ実行する。

| ケース | 修復 |
| --- | --- |
| 同意は撤回済み、参加登録が生きている（`/consent` から撤回した人） | 参加登録を `withdrawn` にする。`withdrawn_at` には同意を撤回した時刻を入れる。イベントの actor は `system` |
| 参加登録は撤回済み、同意が active（`/pilot/join` から撤回した人） | revoked 行を積み、`retained_data_disposition = null`、`source = 'withdrawal_repair'` とする。**本文には触れない** |

後者で本文を消さない理由: 本人は選んでいない。消すのも「残す」と記録するのも、本人の選択を代筆することになる。`/pilot/join` の撤回済み画面には「保管してある本文をいま削除する」ボタンがあり、いつでも削除に切り替えられる。運用者は `source = 'withdrawal_repair'` の行を持つ参加者に、この選択ができることを連絡する。

## 6. 範囲外

- 保護者による撤回（protocol §5.2）の入口は別 issue（feature-inventory §3.3）。入口ができたら、同じ `withdraw_from_research` を `p_actor = 'guardian'` で呼ぶ。
- 本文以外（自己評定・抽出結果）の削除は、今は研究問い合わせ先への依頼で扱う。

## 7. 検証

| 何を | どこで |
| --- | --- |
| 手続きの原子性、delete / keep、2回目の呼び出し、他人の参加者を撤回できないこと、同意の直接書き込み禁止 | `sentra/supabase/tests/withdrawal.test.sql` |
| 2つの入口が同じ手続きを通ること、選択の規則、応答の形 | `sentra/frontend/tests/withdrawal-disposition.test.mjs` |
| 両方の入口から撤回したあと、収集画面が閉じ、`POST /api/entries` が 403 になり、DB が同じ状態になること | `sentra/frontend/e2e/pilot-join.spec.ts`（CI の `pilot-e2e`） |
