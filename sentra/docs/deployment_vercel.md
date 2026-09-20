# Vercel Deployment Guide for Sentra

Sentra はモノリポ構造（一つのリポジトリにフロントエンドとバックエンドが同居）になっているため、Vercel でデプロイする際は以下の設定が必要です。

## フロントエンド (Next.js) の設定

Vercel のプロジェクト作成画面で以下のように設定してください。

### 1. Root Directory
ここが最も重要です。リポジトリのルートではなく、フロントエンドのディレクトリを指定します。

- **Root Directory**: `sentra/frontend`

> [!TIP]
> Vercel のインポート画面でディレクトリを選択する際、`sentra` フォルダの中の `frontend` を選んで「Edit」ボタンを押すか、設定画面の "Root Directory" に `sentra/frontend` と入力してください。

> [!IMPORTANT]
> Root Directory を `sentra/frontend` にすると、Vercel が読む `vercel.json` も
> **`sentra/frontend/vercel.json`** になります。リポジトリ直下に置いた
> `vercel.json` は一度も読まれません。`crons` や `headers` をそこに書いても
> 何も起きないので、設定はすべて `sentra/frontend/vercel.json` に入れて
> ください。実際にこれで cron が一度も走らなかったため（#179 #197）、
> 紛らわしいリポジトリ直下の `vercel.json` は削除してあります。

### 2. Framework Preset
- **Framework Preset**: `Next.js` (自動で認識されるはずです)

### 3. Environment Variables (環境変数)
フロントエンドがバックエンドと通信するために、以下の設定が必要です。

- **`NEXT_PUBLIC_API_URL`**: バックエンドの URL（例: `https://sentra-backend.example.com`）
  - デフォルトでは `http://localhost:8000` を見に行くようになっている場合があります。
- **`CRON_SECRET`**: `/api/cron/*` の定期実行を認証する共有シークレット。
  **未設定だとすべての定期実行が 403 で拒否されます** — 保持期限の purge も、
  危機エスカレーションの再送も走りません。設定すると Vercel が cron の
  リクエストに `Authorization: Bearer <この値>` を付けます。
- **`SAFETY_DISPATCH_TOKEN`**: 5分間隔の再送を回している GitHub Actions
  （`.github/workflows/safety-dispatch.yml`）が `POST /api/safety/dispatch` に
  提示するシークレット。リポジトリ側の Secrets にも同じ値を入れます。

### 4. Cron Jobs

`sentra/frontend/vercel.json` が2本の日次ジョブを宣言しています。

| パス | 何をするか | 動いていないと |
| :--- | :--- | :--- |
| `/api/cron/retention-purge` | 保持期限の切れた原文を消す (#185) | 「最長90日」が日付の付いた永久保存になる |
| `/api/cron/safety-dispatch` | 届かなかった危機通知を再送する (#179) | 一度失敗した通知が誰にも届かない |

> [!WARNING]
> **Hobby プランの cron は1日1回までで、`*/5 * * * *` のような式はデプロイ
> そのものを失敗させます**（降格ではなく失敗です）。日次の再送では危機通知の
> 意味が無いため、5分間隔は `.github/workflows/safety-dispatch.yml` に置いて
> あり、`vercel.json` の日次ジョブはそのワークフローが止まっているときの
> 予備です。5分間隔を Vercel に戻すのは Pro への変更であって、コードの
> 変更ではありません。

デプロイ後、Vercel の Cron Jobs タブで**実行が 200 を返しているか**を確認して
ください。403 が並んでいる場合は `CRON_SECRET` が未設定です。詳細は
[`crisis_escalation.md`](./crisis_escalation.md) を参照してください。

---

## バックエンド (FastAPI) について

Vercel はフロントエンド（Next.js）のデプロイには最適ですが、Python の FastAPI バックエンド（特に SQLite を使用するもの）をそのまま Vercel にデプロイするのはおすすめしません。理由は以下の通りです：

1. **SQLite の制限**: Vercel はサーバーレス環境のため、ファイルシステムが読み取り専用、または一時的です。`sentra.db` への書き込みが保存されません。
2. **起動時間**: Python のサーバーレス関数は、リクエストごとに起動するため、グラフ分析のような重い処理には向かない場合があります。

### おすすめの構成
- **フロントエンド**: Vercel
- **バックエンド**: [Render](https://render.com/), [Railway](https://railway.app/), または [Heroku]
  - これらは SQLite ファイルを永続化（Persistent Disk）できるプランがあり、Python サーバーを常時起動させるのに向いています。

## まとめ：Vercel 設定値の早見表

| 設定項目 | 設定値 |
| :--- | :--- |
| **Project Name** | `sentra-frontend` |
| **Framework Preset** | `Next.js` |
| **Root Directory** | `sentra/frontend` |
| **Build Command** | `npm run build` |
| **Output Directory** | `.next` |
| **Install Command** | `npm install` |
