# パイロット環境の構築と運用（Vercel / Supabase）

> [#166](https://github.com/jbjgjf/BLESC/issues/166) / 版 `pilot-protocol-v1`
> **秘密値そのものはこの文書に書かない。** 名前と置き場所だけを書く。

## 0. なぜ専用環境なのか

本番利用者・デモ・パイロットが同じDBを共有していると、

- パイロットのRLSを直すために本番のポリシーを触ることになる
- デモの固定データがexportに混ざりうる
- 参加者のデータが、パイロットとは無関係な障害対応の視界に入る

3つとも「気をつける」では防げない。**分離は設定ではなく、別のprojectで行う。**

## 1. 作るもの

| 対象 | 内容 | 誰が作るか |
| --- | --- | --- |
| Supabase project | パイロット専用。DB・storage・auth を本番と別に持つ | **人間**（課金と所有者の設定が要る） |
| Vercel project | パイロット専用。独自URL、preview保護あり | **人間** |
| 環境変数 | §3 の一覧。値はVercel/Supabaseのダッシュボードにのみ置く | **人間** |
| DB schema | `sentra/supabase/migrations/` を順に適用 | 手順は §4（自動化可能） |
| 検証 | §5 のsmokeとRLSテスト | 自動 |

**人間の作業（1行ずつ）**

- [ ] Supabaseでパイロット専用projectを作り、regionと課金を設定する
- [ ] Vercelでパイロット専用projectを作り、本番と別のドメインを割り当てる
- [ ] `RESEARCH_RAW_TEXT_KEY` を生成し、Vercelのserver-side環境変数へ入れる（値はどこにも貼らない）
- [ ] `PILOT_INVITE_HMAC_KEY` を生成し、同上
- [ ] `SUPABASE_SERVICE_ROLE_KEY` をパイロットprojectのものに設定する
- [ ] `PILOT_OPERATOR_USER_IDS` と `RESEARCH_EXPORT_USER_IDS` に、実在する運営者のuser idを入れる
- [ ] Supabaseのallowed originsを、パイロットのURLだけに絞る
- [ ] backupの保持設定（point-in-time recovery）を有効にする
- [ ] live URLとdeployment SHAを [Discussion #137](https://github.com/jbjgjf/BLESC/discussions/137) に記録する

## 2. 分離の確認

構築後、次が**すべて**成り立つことを確認する。

| 確認 | 方法 |
| --- | --- |
| DBが別 | パイロットのSupabase URLが本番と異なる。本番のtableにパイロットのrowが増えない |
| storageが別 | 同上 |
| authが別 | 本番のアカウントでパイロットURLにログインできない |
| demoが無効 | `NEXT_PUBLIC_DEMO_MODE` を設定しない。`?demo=1` でも研究画面が固定データにならないこと |
| 公開signupが無効 | `/pilot/join` の招待コード以外から研究参加者になれない |
| service-role keyがclientに出ない | ビルド成果物を検索して `SUPABASE_SERVICE_ROLE_KEY` の値が出ないこと（§5.3） |

## 3. 環境変数の目録

**値は書かない。** どこに置くか、無いとどうなるかを書く。

### 3.1 Vercel（server-side のみ。`NEXT_PUBLIC_` を付けない）

| 名前 | 用途 | 無いとどうなるか |
| --- | --- | --- |
| `SUPABASE_URL` | server-side書き込み先 | 書き込みをスキップする（`supabaseWriter.ts`） |
| `SUPABASE_SERVICE_ROLE_KEY` | RLSを越える書き込み | 同上。**clientへ出してはならない** |
| `RESEARCH_RAW_TEXT_KEY` | 本文のAES-GCM封緘 | 本文の保持を**行わない**（平文では保持しない） |
| `RESEARCH_RAW_TEXT_RETENTION_DAYS` | 保持期限 | 既定値。protocol D5 の決定に合わせる |
| `PILOT_INVITE_HMAC_KEY` | 招待コードのhash | 招待の検証ができない |
| `PILOT_OPERATOR_USER_IDS` | 運営者の許可リスト | 運営操作が誰にもできない（安全側） |
| `RESEARCH_EXPORT_USER_IDS` | exportの許可リスト | exportが誰にもできない（安全側） |
| `RESEARCH_API_TOKEN` | 研究APIの資格情報 | 研究APIが503を返す（安全側） |
| `RESEARCH_API_BASE_URL` | 研究APIの転送先 | 既定 `http://127.0.0.1:8000` |
| `RESEARCH_UI_ALLOWED_USER_IDS` | 研究画面の許可リスト | 誰も研究画面から実行できない（安全側） |
| `OPENAI_API_KEY` | 外部AI | **収集専用モードでは使わない。** 未設定が望ましい |
| `PILOT_STUDY_SLUG` | ゲートの ON/OFF そのもの。どの研究で収集するか | **ゲートが丸ごと無効になる。** 未設定なら `pilotGateEnforced()` が false になり、登録も同意も見ずに誰でも記録できる。**build 時にも必要**（未設定でビルドすると `/journal` が静的に事前レンダリングされ、レイアウトのゲートが実行されない） |
| `PILOT_GUARDIAN_HMAC_KEY` | 保護者確認リンクの署名 | 保護者リンクを発行も検証もできない。未成年は `participant_assented` から先へ進めない |
| `PILOT_TIMEZONE` | export の日付境界 | 既定 `Asia/Tokyo`。ずれると `day_index` の切れ目がずれる |
| `RESEARCH_IDENTITY_MAP_USER_IDS` | 研究コード↔participant の対応表を引ける人 | 対応表を誰も引けない（安全側）。撤回請求の突き合わせができなくなる |
| `SAFETY_DISPATCH_TOKEN` | `/api/safety/dispatch` の共有シークレット | エンドポイントが全拒否。**失敗した危機通知を誰も拾い直せない**（`openssl rand -base64 32`） |
| `SAFETY_ALERT_WEBHOOK_URL` | 危機通知の第一経路（Slack/Teams/当直ゲートウェイ） | 下の2つも未設定なら、危機通知は `no_recipient` で終端する |
| `RESEND_API_KEY` | 危機通知のメール経路 | `SAFETY_ALERT_EMAIL_FROM` と**両方そろって初めて**有効 |
| `SAFETY_ALERT_EMAIL_FROM` | 同上・送信元 | 同上 |
| `CRON_SECRET` | Vercel cron の共有シークレット | **cron が全部 403 で空振りする。** Vercel は cron に自動でこの bearer を付ける。未設定＝危機通知の再送も保持期限の削除も動かない（`openssl rand -base64 32`） |
| `RETENTION_PURGE_TOKEN` | `POST /api/retention/purge` の共有シークレット | 手動・外部schedulerからの purge ができない（cron 経路は `CRON_SECRET`） |

> **`PILOT_STUDY_SLUG` と危機通知の3変数は、他と失敗の向きが違う。**
> 表の大半は「無いと何もできない（安全側）」だが、この4つは違う:
>
> - `PILOT_STUDY_SLUG` 未設定は**ゲートOFF**であって停止ではない。登録も同意も
>   確認せずに収集を受け付ける状態で起動する。
> - `SAFETY_ALERT_WEBHOOK_URL` / `RESEND_API_KEY` + `SAFETY_ALERT_EMAIL_FROM` が
>   どれも未設定だと、危機通知は `status='no_recipient'` で**終端**する。
>   `/api/safety/dispatch` は `pending` と `failed` しか拾い直さないので、
>   **後から設定しても、その間に起きた危機は永久に届かない。**
>   チャネルは収集開始の**前**に設定し、`/api/safety/dispatch` の GET で
>   `no_recipient` が 0 であることを確認すること。
>
> この4つだけは、デプロイ直後に §5 の検証で実際に値が入っているかを見る。

### 3.2 Vercel（client へ出る）

| 名前 | 備考 |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | 公開してよい |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | 公開してよい。RLSが前提 |
| `NEXT_PUBLIC_DEMO_MODE` | **パイロットでは設定しない** |
| `NEXT_PUBLIC_API_URL` | FastAPIを使う場合のみ |

### 3.3 バックエンド（FastAPIを動かす場合）

| 名前 | 用途 |
| --- | --- |
| `DATABASE_URL` | ローカルSQLite/Postgres |
| `RESEARCH_API_TOKEN` | 研究APIの資格情報。Vercel側と同じ値 |
| `RESEARCH_RUN_ROOT` | 研究runの成果物置き場 |
| `USE_MOCK_LLM` | 収集専用モードの検証時は `true` |

### 3.4 秘密値の扱い

- GitHubのIssue・PR・commit・ログ・エラーレポートに値を書かない。
- `.env.local` をコミットしない（`.gitignore` 済み）。
- ローテーション時は §7 の手順。

## 4. 反映の順序（3段階）

PR #138 の migration は**順序に依存する**。順序を守らないと本番相当の環境が落ちる。

```
step 1  20260906000000_pilot_consent_and_submission_integrity.sql   （列の追加。既存コードのまま安全）
        20260906010000_pilot_enrollment.sql                         （新テーブル。同上）
step 2  アプリのデプロイ                                             （raw_text をSELECTしない版）
step 3  20260906000100_restrict_entries_raw_text_columns.sql        （SELECTの絞り込み）
        20260907000000_restrict_entries_raw_text_writes.sql         （INSERT/UPDATEの絞り込み）
```

**step 3 を step 2 より先に打たない。** step 3 は `entries` の table-wide SELECT を落とす。`raw_text` を明示的に選ぶ旧clientが動いている間に打つと、すべての記録閲覧が `permission denied for table entries` になる。migration の先頭にこの順序が書いてあり、[migration_smoke.sh](../../sentra/supabase/scripts/migration_smoke.sh) の step 4 がその記載の有無を検査する。

### 4.1 rollback

| 適用したもの | 戻し方 |
| --- | --- |
| step 1 | 列とテーブルを落とす。**データが消えるので、参加者がいる状態では戻さない** |
| step 3（SELECT） | `grant select on public.entries to authenticated;` |
| step 3（INSERT/UPDATE） | `grant insert, update on public.entries to authenticated;` |

rollbackは**権限を緩める方向**なので、緩めた事実をDiscussion #137 に記録する。緩めたまま忘れるのが最悪の状態である。

## 5. 検証

### 5.1 migration smoke

```bash
cd sentra
supabase start
./supabase/scripts/migration_smoke.sh
```

5つを見る。新規適用、再適用（冪等性）、RLS/権限テスト、順序の記載、`entries` の列権限。**冪等でない migration は落とす。** 部分適用から復旧できなくなる。

### 5.2 RLSテスト

```bash
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/pilot_consent_rls.test.sql
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/pilot_enrollment_rls.test.sql
```

すべてトランザクション内で走り、rollbackする。データを残さない。

### 5.3 秘密値が出ていないこと

```bash
cd sentra/frontend
npm run build
grep -rl "$(printf 'service_role')" .next/static 2>/dev/null && echo "LEAK" || echo "clean"
```

client bundleにservice-role keyの実値が含まれていないことを、**値そのものではなく検索で**確認する。CIでも同じ検査を行う。

### 5.4 Vercel preview でのE2E

`sentra/eval` の browser driver（playwright）で、招待→登録→説明→assent→（未成年なら保護者確認）→提出→撤回 を通す。preview保護は `x-vercel-protection-bypass` で越える（`sentra/eval/src/browser.ts` が対応済み）。

## 6. 運用コンソール `/pilot/ops`

招待の発行・保護者確認リンクの発行・収集期間の開閉は、**`/pilot/ops` から行う**。
`PILOT_OPERATOR_USER_IDS` に入っているアカウントでサインインして開く。
許可が無いアカウントには各操作が「見つかりません」を返す（403 ではなく 404 — 
運用画面の存在自体を伏せるため）。生徒向けのナビゲーションには出てこない。

この画面の外で回す必要があるのは、`curl` でしか指定できない項目
（`max_redemptions`、`expires_at` の細かい指定）だけ。§6.1 の一括操作は
コンソールのボタンと同じ API を呼ぶ。

**招待コードは発行時の1回しか表示されない。** サーバーは HMAC しか保持しない
ので、画面を閉じたら復元できない（再発行はできる）。コンソールは閉じるときに
確認を出すが、**配布の段取りを決めてから発行すること。**

**保護者確認リンクは保護者に渡すもので、生徒に渡してはいけない。**
リンクを持っている人は誰でも確認を完了できる。`/pilot/join`（生徒側）には
このリンクは表示されない。

### 6.1 収集期間の開閉（day 0 と day 21）

`enrolled` になっただけでは日記画面は開かない。`pilotGate` が通すのは
`collecting` だけで、そこへ進めるのは**運営だけ**（参加者ルートは 403 を返す）。
開けるのは `POST /api/pilot/admin/enrollment`、許可リストは
`PILOT_OPERATOR_USER_IDS`。

**コホート単位で開くのが既定。** プロトコルが日付を決めているのはコホートに
対してであって個人に対してではない。50人を1人ずつ開けると、必ず誰かだけ
違う日になる。

```bash
# 1. 開ける前に、誰が対象かを見る（POST と同じ絞り込み）
curl -s -H "Authorization: Bearer $OPERATOR_TOKEN" \
  "$BASE_URL/api/pilot/admin/enrollment?study=$PILOT_STUDY_SLUG&cohort=A" | jq

# 2. 開ける（day 0 の朝）
curl -s -X POST -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"study":"'"$PILOT_STUDY_SLUG"'","cohort":"A","to":"collecting","reason":"day0"}' \
  "$BASE_URL/api/pilot/admin/enrollment" | jq '.counts'

# 3. 閉じる（day 21 の終了後）
#    to を "completed" に変えるだけ。
```

**`counts` の読み方。** 一括は行ごとに結果を返し、失敗しても他の行は進む。

| outcome | 意味 | day 0 朝の対応 |
| --- | --- | --- |
| `ok` | 窓が開いた | — |
| `consent_missing` | 同意がまだ揃っていない | **正常。** その場で追わず、同意が済んでから個別に `enrollment_ids` で開ける |
| `illegal_transition` | すでに `collecting`、または `enrolled` に達していない | 二重実行なら無害。状態を GET で確認する |
| `not_found` | 行が消えている | 調査対象 |

`consent_missing` が数件出るのは開講日の通常状態であって、やり直しの合図ではない。
**同じリクエストを二度投げても二重には開かない**（`illegal_transition` になる）が、
`counts` を見ずに再実行する運用にはしないこと。

> `withdrawn` はこのルートでは指定できない。撤回は参加者本人の決定で、
> 代行できる経路を作らない。

## 7. 監視とアラート

| 見るもの | 閾値 | 通知先 |
| --- | --- | --- |
| `submission_failures` の件数 | 1件でも | 運用責任者 |
| 期待提出数とDB件数の差 | 不一致が出た時点 | 運用責任者 |
| 外部AIへの送信 | 1件でも（**0が正常**） | 研究責任者・運用責任者 |
| 同意前・撤回後の研究書き込み | 1件でも | 研究責任者 |
| `purge_expired_raw_text()` の実行結果 | 実行されない日があれば | データ管理責任者 |
| cross-user read/write | 1件でも | 全員（P0） |

`DECISION REQUIRED`: 通知の手段（メール／Slack／その他）と当番。**決定者: 運用責任者。**

### 7.1 定期実行（解決済み）

`vercel.json` の `crons` で2本動かす。**Vercel cron は GET しか送らない**ので、
入口は `/api/cron/*`（GET）で、`/api/safety/dispatch` や `/api/retention/purge`
（POST）を直接 cron に指定してはいけない。指定すると各ルートの GET ハンドラ＝
読み取り専用の確認用が実行され、**200 を返しながら何もしない cron** になる。

| path | 頻度 | 役割 |
| --- | --- | --- |
| `/api/cron/safety-dispatch` | `*/5 * * * *` | 失敗した危機通知の再送。`no_recipient` も拾う（#178） |
| `/api/cron/retention-purge` | `17 3 * * *` | `purge_expired_raw_text()` の実行 |

**プラン確認が先。** Vercel Hobby は cron が**2本まで・1日1回まで**。
`*/5` は Pro 以上でないと通らない。Hobby のまま進めるなら、再送は外部scheduler
（GitHub Actions の `schedule` など）から `POST /api/safety/dispatch` を
`SAFETY_DISPATCH_TOKEN` で叩く形にする。**root directory の設定も併せて確認すること** —
このリポジトリは `vercel.json` が `BLESC-app/` にあり、Vercel プロジェクトの
root directory がそれと食い違っていると `crons` は読まれない。

確認方法:

```bash
# cron が実際に動いているか（どちらも 0 が正常）
curl -s -H "Authorization: Bearer $SAFETY_DISPATCH_TOKEN" \
  "$BASE_URL/api/safety/dispatch" | jq   # -> {channels, owed, no_recipient}
curl -s -H "Authorization: Bearer $RETENTION_PURGE_TOKEN" \
  "$BASE_URL/api/retention/purge" | jq   # -> {overdue, configured}
```

`channels: false` は**収集開始前に必ず潰す**。危機通知の行き先が無い状態で
収集を始めると、その間の危機は `no_recipient` として残る。#178 の修正で
後から再送はされるようになったが、届くのはチャネルを設定した後であって、
**その夜には誰にも届かない。**

## 8. 鍵のローテーション

1. 新しい鍵を生成し、`RESEARCH_RAW_TEXT_KEY` の新しい版として設定する。
2. 既存行を新鍵で再暗号化し、`raw_text_key_version` を更新する。**再暗号化中に平文をログへ出さない。**
3. 旧鍵を失効させる。
4. ローテーションの日時と実施者を記録する（値は記録しない）。

鍵を失った場合の扱いは [incident-runbook.md](incident-runbook.md) §7.2。**復元できない。** 復元できると説明しない。

## 9. backup と restore

- Supabaseのpoint-in-time recoveryを有効にする（人間の作業）。
- dry run day 3 で**実際にrestoreを行い**、件数の一致を確認する（[#168](https://github.com/jbjgjf/BLESC/issues/168)）。
- 演習していないrestore手順を「手順がある」と書かない。

## 10. 記録する成果

| 項目 | 置き場所 |
| --- | --- |
| live URL | [Discussion #137](https://github.com/jbjgjf/BLESC/discussions/137) |
| deployment SHA | 同上 |
| migration適用の日時と順序 | 同上 |
| smokeとRLSテストの結果 | 同上 |
| 未解決の課題 | 対応するIssue |

## 11. 未決定事項

| # | 事項 | 決定者 |
| --- | --- | --- |
| E1 | 通知の手段と当番 | 運用責任者 |
| E2 | `purge_expired_raw_text()` の定期実行方法 | データ管理責任者 |
| E3 | Supabase projectのregionと課金主体 | 学校責任者・研究責任者 |
| E4 | 保持期間の実値（protocol D5と同じ） | データ管理責任者 |
