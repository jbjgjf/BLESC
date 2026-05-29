# Vercel Deployment Guide for Sentra

Sentra はモノリポ構造（一つのリポジトリにフロントエンドとバックエンドが同居）になっているため、Vercel でデプロイする際は以下の設定が必要です。

## フロントエンド (Next.js) の設定

Vercel のプロジェクト作成画面で以下のように設定してください。

### 1. Root Directory
ここが最も重要です。リポジトリのルートではなく、フロントエンドのディレクトリを指定します。

- **Root Directory**: `sentra/frontend`

> [!TIP]
> Vercel のインポート画面でディレクトリを選択する際、`sentra` フォルダの中の `frontend` を選んで「Edit」ボタンを押すか、設定画面の "Root Directory" に `sentra/frontend` と入力してください。

### 2. Framework Preset
- **Framework Preset**: `Next.js` (自動で認識されるはずです)

### 3. Environment Variables (環境変数)
フロントエンドがバックエンドと通信するために、以下の設定が必要です。

- **`NEXT_PUBLIC_API_URL`**: バックエンドの URL（例: `https://sentra-backend.example.com`）
  - デフォルトでは `http://localhost:8000` を見に行くようになっている場合があります。

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
