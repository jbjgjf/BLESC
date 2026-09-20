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

### 3.4 定期実行と危機通知（#194）

**この4件は全て「未設定なら黙って動かない」。** エラーにならず、画面にも出ず、logに1行出るだけで、
「purgeすべき行が無かった日」と区別がつかない。2026-09-18の監査が4件を未確認のまま残したのはそのためである。

| 置き場所 | 名前 | 無いとどうなるか |
| --- | --- | --- |
| Vercel | `CRON_SECRET` | Vercel cron が全て403。purge も日次の再送backstopも走らない |
| Vercel | `SAFETY_DISPATCH_TOKEN` | 5分ごとの再送が403。初回送信に失敗した危機通知が誰にも届かない |
| Vercel | `SAFETY_ALERT_WEBHOOK_URL` または `RESEND_API_KEY` + `SAFETY_ALERT_EMAIL_FROM` | 危機通知の**宛先が無い**。記録だけ残り、誰にも届かない |
| Vercel | `SAFETY_RECIPIENT_HASH_KEY` | 通知logの recipient hash が null（通知自体は届く）。base64で32バイト以上 |
| Vercel | `NEXT_PUBLIC_PILOT_MODE=1` | 専用デプロイで `/demo-view` とデモ上書きが生きたまま（#193）。**ビルド時に焼き込まれる** |
| GitHub secrets | `PILOT_BASE_URL` | 5分ごとの再送workflowがskip（redにはせず、warningとrun summaryに出す） |
| GitHub secrets | `SAFETY_DISPATCH_TOKEN` | 同上。**Vercel側と同じ値**でなければ403 |

`NEXT_PUBLIC_PILOT_MODE` だけ性質が違う。Next.js がビルド時に bundle へ埋め込むので、
**後から変数を足しても再デプロイするまで効かない。** 変数は `1` なのに `/demo-view` は生きている、
という状態が普通に起こる。だから §5.5 では変数ではなく配信物（404であること）を見る。

値の生成と投入手順:

```bash
node scripts/pilot/check-ops-config.mjs --new-secrets
```

値は画面に出ない。`$TMPDIR` に0600のファイルを書き、**pathだけを印字する**。投入したら `rm` する。

初版はstdoutへ印字して「端末の外へ出すな」と注意書きを添えていたが、これは2026-09-20に実際に破られた。
この作業はCLIエージェント越しに行われており、**その端末のstdoutは会話の記録にそのまま入る**。
注意書きが前提にしていた「端末の中」が、もう閉じた場所ではなかった。生成した3件は破棄して作り直した
（未投入だったので実害は無い）。`--stdout` は残してあるが、明示的に選ばれた時だけ通る道である。

同じ理由で、ファイルはrepositoryの外に置く。repository内に置けば、いつか誰かがcommitする。

`SAFETY_DISPATCH_TOKEN` がVercelとGitHubの2箇所に出るのは誤記ではなく、検証する側と提示する側で
同じ値が要るためである。

**順序**: Vercel 4件 → **再デプロイ** → GitHub 2件 → §5.5 で確認。

### 3.5 秘密値の扱い

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

### 5.5 設定と定期実行の確認（#194）

```bash
PILOT_BASE_URL=https://blesc-pilot.vercel.app CRON_SECRET=... \
  node scripts/pilot/check-ops-config.mjs
```

3方向から見る。**申告と結果が食い違ったときは結果を信じる。**

| 見るもの | 何の証拠になるか |
| --- | --- |
| `GET /api/pilot/admin/ops` に到達できる | `CRON_SECRET` がこのdeploymentの値と一致している（＝cronが403にならない） |
| `config.checks` | Vercel側の各変数の有無と、鍵の形（base64・32バイト） |
| `observed.safety_dispatch.stale` | 未送信の危機通知が30分以上滞留していないか。trueなら**再送が走っていない** |
| `observed.retention_purge.overdue` | 保持期限を過ぎた本文が残っていないか。0以外なら**purgeが走っていない** |
| `/demo-view` が404 | `NEXT_PUBLIC_PILOT_MODE` が**このビルドに**効いている |
| `gh secret list` | GitHub側2件の有無（値は取得できない） |

終了コードは 0=blocking無し / 1=blockingあり / 2=確認できなかった。
**2 を 0 として記録しない。** 「聞けなかった」は「問題なし」ではない。

`observed` の2つは設定の有無より強い証拠である。`CRON_SECRET` があっても
`overdue` が0でなければ、値が違うか、`vercel.json` を読んでいないprojectか、
manifestを取り込んでいないdeploymentである。設定確認だけならこれを健全と呼んでしまう。

`ops` は運営者（`PILOT_OPERATOR_USER_IDS`）のセッション、または `CRON_SECRET` のbearerで開く。
後者は外形監視から叩くためで、`ready: false` はそのまま当番への通知条件にしてよい。

## 6. 監視とアラート

| 見るもの | 閾値 | 通知先 |
| --- | --- | --- |
| `submission_failures` の件数 | 1件でも | 運用責任者 |
| 期待提出数とDB件数の差 | 不一致が出た時点 | 運用責任者 |
| 外部AIへの送信 | 1件でも（**0が正常**） | 研究責任者・運用責任者 |
| 同意前・撤回後の研究書き込み | 1件でも | 研究責任者 |
| `purge_expired_raw_text()` の実行結果 | 実行されない日があれば | データ管理責任者 |
| cross-user read/write | 1件でも | 全員（P0） |

`DECISION REQUIRED`: 通知の手段（メール／Slack／その他）と当番。**決定者: 運用責任者。**

`purge_expired_raw_text()` の定期実行は `sentra/frontend/vercel.json` の cron（`/api/cron/retention-purge`、毎日03:17 UTC）が担う。**ただし `CRON_SECRET` が無ければ403で、走らないことは画面にも出ない。** 保持期限を設定しても、消す処理が動いていなければ保持期限は無い。走っている証拠は §5.5 の `observed.retention_purge.overdue`（0であること）であり、cronの設定が存在することではない。

危機通知の再送は `.github/workflows/safety-dispatch.yml`（5分ごと）＋ Vercel cron の日次backstop。GitHubのschedulerはbest-effortなので、5分は目標であって保証ではない。滞留は §5.5 の `observed.safety_dispatch.stale` で見る。

## 7. 鍵のローテーション

1. 新しい鍵を生成し、`RESEARCH_RAW_TEXT_KEY` の新しい版として設定する。
2. 既存行を新鍵で再暗号化し、`raw_text_key_version` を更新する。**再暗号化中に平文をログへ出さない。**
3. 旧鍵を失効させる。
4. ローテーションの日時と実施者を記録する（値は記録しない）。

鍵を失った場合の扱いは [incident-runbook.md](incident-runbook.md) §7.2。**復元できない。** 復元できると説明しない。

## 8. backup と restore

- Supabaseのpoint-in-time recoveryを有効にする（人間の作業）。
- dry run day 3 で**実際にrestoreを行い**、件数の一致を確認する（[#168](https://github.com/jbjgjf/BLESC/issues/168)）。
- 演習していないrestore手順を「手順がある」と書かない。

## 9. 記録する成果

| 項目 | 置き場所 |
| --- | --- |
| live URL | [Discussion #137](https://github.com/jbjgjf/BLESC/discussions/137) |
| deployment SHA | 同上 |
| migration適用の日時と順序 | 同上 |
| smokeとRLSテストの結果 | 同上 |
| 未解決の課題 | 対応するIssue |

## 10. 未決定事項

| # | 事項 | 決定者 |
| --- | --- | --- |
| E1 | 通知の手段と当番 | 運用責任者 |
| E2 | ~~`purge_expired_raw_text()` の定期実行方法~~ → Vercel cron で実装済み（§6）。残るのは `CRON_SECRET` の投入と、初回実行翌朝の `overdue: 0` の確認 | データ管理責任者 |
| E3 | Supabase projectのregionと課金主体 | 学校責任者・研究責任者 |
| E4 | 保持期間の実値（protocol D5と同じ） | データ管理責任者 |
