# 2026-09-20 運用演習の証跡と Go / No-Go 記録

対象: 研究データ収集の開始可否。
演習: `scripts/pilot/run-operations-drill.mjs`（保護者確認・撤回/削除・撤回後の提出・危機連絡）。
証跡: [`operations-drill-2026-09-20T06-49-19-914Z.json`](operations-drill-2026-09-20T06-49-19-914Z.json)

> **この記録は Go / No-Go を判定していない。** 判定欄は空である。
> [one-day-verification-plan.md](../../one-day-verification-plan.md) が定めるとおり、
> 判定は実際に演習した3役の担当者本人が自分で記録する。機械実行の結果は
> その判断の材料であって、判断そのものではない。存在しない署名を作らない。

---

## 1. 実行した内容

合成データのみ。`@drill.invalid` のアカウントと固定本文だけを使い、実在の参加者データには触れていない。
スクリプトはローカルスタック以外を向いていたら起動時に停止する（ホスト完全一致の許可制）。

**外部への送信は行っていない。** 危機連絡は手順書が tabletop と定めているため、
escalation 行の生成と宛先解決までを確認し、配信はローカルのダミー受け口に閉じた。

| 演習 | 段 | 結果 |
| :--- | :--- | :--- |
| C 保護者確認 | 確認前は `enrolled` に進めない | OK（`illegal_transition`） |
| C 保護者確認 | 確認リンクの発行（未決のまま） | OK（`decision=null`） |
| C 保護者確認 | 保護者が**断る**経路も通る | OK（`decision=declined`） |
| C 保護者確認 | 断られた後も `enrolled` に進めない | OK（`illegal_transition`） |
| C 保護者確認 | 再発行して保護者が確認 | OK（`decision=confirmed`） |
| C 保護者確認 | 確認後に `guardian_verified` へ | OK |
| D 危機連絡 | escalation 行の生成 | OK |
| D 危機連絡 | 宛先が見守り同意から解決される | OK（1名、期待どおり） |
| D 危機連絡 | 受け口へ到達（ダミー、外部送信なし） | OK |
| A 撤回・削除 | `research_code` から対象を特定 | OK |
| A 撤回・削除 | `withdrawn` へ遷移し遷移ログが残る | OK（`events=3`） |
| A 撤回・削除 | 保持本文の削除 | OK（1件削除、`ciphertext=null`） |
| B 撤回後の提出 | 収集が閉じている | OK（`collection_open=false`） |

15段すべて期待どおり。所要時間は各段0.0〜0.9秒（機械実行部分のみ）。

## 2. 演習の過程で分かったこと

最初の実行は通らなかった。**通らなかったこと自体が演習の成果**なので記録する。

1. **`pilot_guardian_verifications` の列名を取り違えていた**（`outcome` ではなく `decision`、
   `study_id` ではなく `owner_user_id`）。手順書には列名が書かれておらず、
   実際に叩くまで分からなかった。
2. **発行の4列は揃っていなければ挿入できない**（`pilot_guardian_verifications_issued_check`）。
   期限のないトークンは「失効しないリンク」なので、制約が正しく拒否した。
3. **未決の確認は同時に1件まで**（`pilot_guardian_verifications_one_pending_idx`）。
   同じ保護者に2通届いてどちらが有効か分からなくなることを防いでいる。
   したがって実際の順序は「発行 → 断る → 再発行 → 確認」であり、演習もその順に直した。

いずれも実装が正しく、演習側の想定が誤っていた。ただし **1〜3 は手順書
（[data-operations-drills.md](../../data-operations-drills.md)）に書かれていない**。
当日に人が手で叩けば同じところで詰まる。手順書への反映は未了。

## 3. 機械実行が確認していないこと

Go / No-Go を判断する人が、ここを読んでから判定すること。

| 項目 | 状態 |
| :--- | :--- |
| 保護者への**実際の送付経路** | 未確認。協力校の連絡システムは未確定（consent-pack 4.6） |
| 危機連絡の**実送信** | 未実施。宛先・文面・到達の机上確認のみ |
| 削除請求の**受付から回答まで**の人の手順 | 未実施。受領経路・回答文面・所要時間は未測定 |
| `purge_expired_raw_text()` の**定期実行の実績** | 未確認。cron 設定は入ったが、本番での実行実績は未取得 |
| 本番環境での通し | 未実施。本演習はローカルスタック |
| 3役の**当番表** | 未確定（consent-pack 附則 3-1） |

## 4. 同意文書の版

本演習の時点で、アプリが記録する `document_version` は **`research-consent-doc-v1`** である。

`research-consent-doc-v2` は [consent-pack.md](../../consent-pack.md) として存在するが、
附則2の施行前確認（実施者所在地の非公開台帳と回答演習、
委託先の実設定・所在国・措置、期限削除と本番通し、当番表）が未完了のため施行していない。
3名の内部責任者については、本人返信による担当受諾・文書承認と連絡先を記録済みである。実装側は
`sentra/frontend/src/lib/consentDocument.ts` で版を一元化し、
`NEXT_PUBLIC_CONSENT_DOCUMENT_ENACTED=research-consent-doc-v2` を設定するまで
v1 を記録し、`/legal` の表示も `-draft` のままにしてある。
未完了のまま v2 を記録すると、存在しない完成文書への同意を主張する行ができる。

2026-09-21時点では、`NEXT_PUBLIC_CONSENT_DOCUMENT_ENACTED=research-consent-doc-v2` は
**設定しない**。設定は、[consent-pack.md](../../consent-pack.md) 附則2・附則3と本README第3節の
未確認事項が解消し、判定欄がGoで揃った後に行う。

## 5. Go / No-Go

**判定は未記入。** 以下を読んだうえで、各自が自分の欄を埋める。

### No-Go とすべき既知の未了事項

- 第2節の手順書未反映（当日に人が詰まる）
- 第3節の6項目すべて
- consent-pack 附則2の施行前確認事項。3名の担当受諾・文書承認は記録済み。実施者所在地の非公開台帳と回答演習、委託先の本番実設定・所在国・措置は未完了
- consent-pack 附則3の施行条件のうち、本演習が満たすのは「5. 合成データによる演習」の一部のみ

### 判定欄

| 役割 | 氏名 | 署名日 | 判定 | 判定の理由 |
| :--- | :--- | :--- | :--- | :--- |
| 研究責任者 | | | Go / No-Go | |
| データ管理責任者 | | | Go / No-Go | |
| 運用責任者 | | | Go / No-Go | |

**3名全員が Go でなければ No-Go。** 1名でも No-Go なら募集を開始しない。

判定を記入した後、[approvals.md](../../approvals.md) にも同じ内容を記録する。

## 6. 再実行

```
cd sentra && supabase start && supabase db reset
node scripts/pilot/run-operations-drill.mjs
```

終了コード 0 が全段期待どおり、1 が逸脱あり。証跡は
`docs/pilot/audit-evidence/<日付>/` に書かれる。
