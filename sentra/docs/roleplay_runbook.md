# 4人ロールプレイ手順（社内・生徒役3人＋先生役1人・1か月）

参加者は社内メンバー（成人）だけです。研究パイロットの参加者登録（`/pilot/join`）は使いません。

## 実施方式（2026-11-15 決定）

| 項目 | 決定 | 理由 |
|---|---|---|
| 場所 | 本番（blesc.online）ではなく試験環境 | 研究データと混ざらない。終了後に消せる |
| DB | ロールプレイ専用の Supabase プロジェクト | 危機通知・研究エクスポートにテストが混入しない |
| アカウント | 4人それぞれ別アカウント | 共有1つでは「ログイン」「共有権限」を本物の形で検証できない |
| メール | 本物のメールアドレス | — |
| 表示名 | 本名（seed スクリプトの `--names` で指定） | — |

本名と実メールを使うため、試験環境にも本物の個人情報が入る。**終了後はプロジェクトごと削除する。**

## 開始前に満たすこと（運用者）

| # | 条件 | 確認方法 |
|---|---|---|
| 1 | 公開サイトが参照する Supabase プロジェクトが存在し、名前解決できる | `nslookup <ref>.supabase.co` が NXDOMAIN にならない |
| 2 | そのプロジェクトに `sentra/supabase/migrations` がすべて適用済み | `supabase migration list` |
| 3 | デプロイの環境変数：`NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` が設定済み | 未設定だと日記の保存が 502 になる |
| 4 | `NEXT_PUBLIC_API_URL` は空。`PILOT_STUDY_SLUG` も空 | slug を入れると参加登録・保護者確認のゲートがかかる |
| 5 | 先生の「毎日の提出」表示を含むビルドが配備済み | `/educator/roster` に「毎日の提出」が出る |

### 読み取り専用の点検（1〜5をまとめて確認）

通常のネットワーク（手元のPCなど）で実行します。何も書き込まず、サービスロールキーも不要です。

```bash
cd sentra/frontend
SITE_URL=https://blesc.online NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co \
  NEXT_PUBLIC_SUPABASE_ANON_KEY=<公開キー> node scripts/roleplay-preflight.mjs
```

最後の行が `READY` なら前提はそろっています。`FAIL` の行が止めている原因です。

## アカウント準備（運用者・1回だけ）

```bash
cd sentra/frontend
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... ROLEPLAY_SEED_ALLOW_PROJECT_REF=<ref> \
  node scripts/seed-roleplay.mjs --teacher <先生のメール> --students <A>,<B>,<C>
```

- 新規アカウントのパスワードは一度だけ表示されます。本人に個別に渡してください。
- スクリプトは共有の同意を作りません。先生には、生徒が自分でオンにするまで何も見えません。

## 初日

1. 生徒役：ログイン → `/sharing` で「BLESC ロールプレイ」の共有をオンにする。
2. 生徒役：`/journal` で日記を書いて「日記を提出する」。
3. 先生役：`/educator/roster` で「今日の提出 n / 3人」と、7日分の●（提出あり）を確認する。

## 毎日

- 生徒役：1日1回、日記を提出する（日本時間の日付で数えます。0時を過ぎたら翌日分です）。
- 先生役：`/educator/roster` で提出状況を確認する。「要確認」の印がある生徒は、名前を押して「安全に関する記録」と「繰り返し見られる話題」を見る。

## 先生に見えないもの（仕様）

- 日記の本文。見えるのは提出の有無と、記録から抽出した話題ラベル、安全ルールに一致した事実だけです。
- 共有をオフにした生徒のすべて。

## 「要確認」について

決まった言い回し（例：「もう限界」）に一致したときだけ付きます。ロールプレイで試すときは、本番の危機通知の宛先（`SAFETY_ALERT_WEBHOOK_URL` など）が設定されていないか、事前に確認してください。crisis 相当の文は通知を実際に送ります。
