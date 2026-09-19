# 危機の通知

深夜のSOSが、翌朝まで誰にも届かない状態を解消するための仕組み。

## それまでの状態

`/api/chat` は毎ターン `assessConversation` を走らせ、危険の合図を読み取ると
`model_runs` に `artifact_type = 'safety_assessment'` の行を書いていました。
これは**監査記録**で、「判定を行った」と言うだけです。誰にも届きません。

教員が見るアラートは逆向きでした。`api/client.ts` の `alertsFromRoster()` が
**教員のブラウザの中で**、名簿を材料に、ダッシュボードを開いた瞬間に計算していました。
キューも送信もなく、`package.json` にメール／プッシュの依存はゼロ。

つまり、02:00 に「生きていたくない」と書いた生徒に対して、プロダクトは正しく応答し
（安全floorが働き、相談先も提示される）、そのあと**誰かがタブを開くまで待って**いました。

## 何が変わって、何が変わらないか

**変わるのは「いつ」であって「誰が」ではありません。** ここが、この機能が
正当化できるかどうかの分かれ目です。

`overseen_participants` は既に `safety_level` / `safety_reasons` / `safety_at` を
教員に返しており、その関門は `educator_oversees` ——
つまり当該参加者・当該組織について `oversight_consents` が active であること。
通知を受け取る教員は、名簿を開けば同じ観測を読めた人です。

これを前提として、2つを実装側で強制しています（意図ではなく仕組みとして）。

1. **受け取れるのは、既にアクセス権を持つ教員だけ。**
   `safety_escalation_recipients()` が送信時点で `educator_oversees` と同じ条件を
   再計算します。1時間前に同意が撤回されていれば、今夜の通知は行きません。
   `supabase/tests/safety_escalation_rls.test.sql` がこれを検査します。
2. **生徒本人が、起きたことを見られる。** `safety_escalations` と
   `safety_escalation_deliveries` は本人が読めます（`/audit` の「先生に届いた連絡」）。
   未成年について大人に何かを伝え、それを本人に隠すシステムは信用できません。
   チャットのガードレールが「秘密を約束しない」と言っているのと同じ理由です。

## 送る内容

参加者コード（仮名）、時刻、リンクだけ。**日記の本文・チャットの本文・
マッチした規則名・スコア・バンドは含みません。** 通知はロック画面や職員室で、
他人の肩越しに読まれます。詳細が要る教員はログインします。

```
【blesc】参加者 2A-08 の記録に、確認が必要な表現がありました。すぐに確認してください。
検知時刻：2026/9/16 15:45:29
内容は本人の画面にのみ保存されています。詳細はログインして確認してください。
https://pilot.example.jp/educator/roster

blesc は緊急対応を行いません。危険が差し迫っていると判断される場合は、学校の緊急対応手順に従ってください。
```

## 経路

```
/api/chat, /api/entries
  └ assessSafety → crisis
      └ recordEscalation()      ← await する（行を失うことだけが回復不能）
          └ deliverEscalation() ← await しない（生徒をSMTPの後ろで待たせない）
                ├ webhook  SAFETY_ALERT_WEBHOOK_URL
                └ email    RESEND_API_KEY + SAFETY_ALERT_EMAIL_FROM
/api/safety/dispatch (cron)
  └ status が pending / failed の行を拾い直す
```

**書いてから送る**順序が肝です。送信は失敗しても再送できますが、行が書かれなければ
その事実ごと消えます。`tests/safety-escalation.test.mjs` がこの順序を検査しています。

### 失敗したときに何が残るか

| status | 意味 |
| :--- | :--- |
| `pending` | まだ試していない。dispatch が拾う |
| `delivered` | 少なくとも1つの宛先に届いた |
| `failed` | 宛先はあるが全部失敗した。dispatch が再試行 |
| `no_recipient` | **伝えてよい相手が居ない。** 見守り同意のある教員が居ない。終端（再送しない） |

チャネルが1つも設定されていないときは `no_recipient` ではなく **`pending` のまま**にします。
これは同意の話ではなく設定の穴で、変数を入れれば送れるようになるからです。以前は
`no_recipient` に畳んでいたため、設定を入れる前に起きた危機は永久に届きませんでした（#178）。
送信を試みていないので `attempts` も増やしません。

`no_recipient` は成功ではありません。危機が起きたのに送り先が無いという
**設定の緊急事態**なので、`console.error` を出し、行に残り、
`GET /api/safety/dispatch` が件数を返します。

6回試して届かない行は `stuck` として毎回のdispatchで報告されます。
そこまで来たら問題はネットワークではなく設定です。

## 設定

```
SAFETY_ALERT_WEBHOOK_URL=     # 学校側の受け口（Slack/Teams/当直ゲートウェイ）
RESEND_API_KEY=               # メール経路。FROM とセットで有効
SAFETY_ALERT_EMAIL_FROM=
SAFETY_DISPATCH_TOKEN=        # POST /api/safety/dispatch の共有シークレット。未設定なら全拒否
CRON_SECRET=                  # Vercel Cron 用。未設定ならすべての定期実行が拒否される
SAFETY_RECIPIENT_HASH_KEY=    # 通知ログの recipient_hash 用の HMAC 鍵（base64 32バイト以上）
                              # 未設定なら hash は null。通知自体は止めない
SAFETY_ALERT_ON_ELEVATED=     # 1 で elevated も通知。既定は crisis のみ
NEXT_PUBLIC_SITE_URL=         # 通知に載せるリンクの組み立てに使う
```

**webhook を先に設定してください。** 個人宛てのメールと違い、
「今夜は誰が当番か」を知っているのは学校側の仕組みだけです。
このプロダクトは当直表を持っていません。

### 定期実行

**再送は GitHub Actions が5分ごとに叩きます**（`.github/workflows/safety-dispatch.yml`）。
Vercel に置いていないのは、**Hobby プランの cron が1日1回までだから**です。
`*/5 * * * *` はデプロイ自体が失敗します（"Hobby accounts are limited to daily cron jobs"）。

必要な GitHub secrets:

| secret | 中身 |
| :--- | :--- |
| `PILOT_BASE_URL` | パイロットデプロイのURL（例 `https://pilot.example.jp`） |
| `SAFETY_DISPATCH_TOKEN` | `POST /api/safety/dispatch` の共有シークレット |

どちらか欠けているとワークフローは**赤にせずスキップ**し、「再送は走っていない」とログに出します。
5分ごとに赤いジョブが並ぶと、誰もこのワークフローを見なくなるためです。

**GitHub のスケジューラはベストエフォートです。** 混雑時は遅延・実行されないことがあります。
5分は目標であって保証ではありません。保証が要るなら Vercel を Pro にして
`vercel.json` に戻すのが正解です。

`sentra/frontend/vercel.json` には**保険として1日1回**の同じ呼び出しを残しています
（リポジトリ直下ではありません——Vercel のプロジェクト root が `sentra/frontend` なので、
直下に置いたものは読まれません）。

```json
{ "crons": [
  { "path": "/api/cron/retention-purge", "schedule": "17 3 * * *" },
  { "path": "/api/cron/safety-dispatch", "schedule": "47 4 * * *" }
] }
```

保持期限の purge は元から1日1回でよいので、こちらは Vercel の cron だけで足ります。

Vercel Cron は `GET` と `Authorization: Bearer $CRON_SECRET` しか送れないため、
`POST` + 独自トークンの `/api/safety/dispatch` とは別に `/api/cron/*` を置いています。
中身は両方とも `lib/server/safetyDispatch.ts` を呼ぶだけです。

## 通知が増えすぎないように

`participant + risk_level + surface + 時（UTC）` で重複を抑えています。
取り乱している生徒は連続して何ターンも書き、そのどれもが crisis と判定されます。
4分間に5通は「5倍の重大さ」ではなく1つの状況で、受け取る側にスワイプを学習させます。

`elevated`（明確な危険表明のない不調）は既定では通知しません。実在する兆候ですが
頻度が高く、毎晩鳴らすとチャンネルごと無視されるようになります。
必要な学校が明示的に有効にします。

## 生徒への説明を合わせた

実装と同時に、2か所の文言を書き換えています。**書き換えないまま通知だけ足すと、
プロダクトが生徒に嘘をつくことになります。**

- **チャットのガードレール** — 以前は「You never contact anyone on the student's
  behalf and you cannot notify an adult yourself」で終わっていました。これは
  `escalate()` を配線した瞬間に偽になります。ガードレール自身の第一節が
  「be accurate about privacy」であり、誤った情報を与えられたモデルは、
  正直になるかどうか迷っている生徒にそれを繰り返します。
- **同意画面** — 「危険が疑われるとき」の節を追加。研究への同意とは無関係に
  安全のために行われること、届くのは時刻と「確認が必要」だけであること、
  誰にいつ届いたかを本人が `/audit` で確認できることを書いています。

## このプロダクトがやらないこと

- **緊急対応はしません。** 通知の本文にもそう書いてあります。
- **誰に届けるかを選びません。** 宛先はDBの見守り同意が決めます。
- **保護者には通知しません。** 保護者経路は `pilot_guardian_verifications` の
  別トークン・別経路で、参加登録のためのものです。危機の連絡経路として使うかは
  学校とIRBが決めることで、コードで先に決めるべきことではありません。
