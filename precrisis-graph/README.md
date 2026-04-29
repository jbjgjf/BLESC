# Precrisis-Graph

このプロジェクトは、ジャーナリングの内容を構造化グラフとして抽出し、心の変化を分析するためのアプリです。

## セットアップと起動方法

### 1. バックエンド (FastAPI)
バックエンドは Python で動作し、グラフ抽出と分析を担います。

```bash
cd backend
# 仮想環境の有効化 (Mac)
source venv/bin/activate
# 依存関係のインストール (初回のみ)
pip install -r requirements.txt
# サーバー起動 (ポート 8001)
USE_MOCK_LLM=false uvicorn app.main:app --reload --port 8001
```

> [!TIP]
> **LLMの選択:**
> - **OpenAI (推奨):** `backend/.env` に `OPENAI_API_KEY` を記入してください。自動的に OpenAI の API が使用されます。
> - **Mock Mode:** `USE_MOCK_LLM=true` を設定すると、LLMを使わずにダミーデータで動作します（メモリ消費ゼロ）。
> - **Local (Ollama):** APIキーが未設定の場合、ローカルの Ollama (`qwen2.5:7b`) を探します。

### 2. フロントエンド (Next.js)
フロントエンドは React/Next.js で構築されており、3Dグラフの可視化を行います。

```bash
cd frontend
# 依存関係のインストール (初回のみ)
npm install
# 開発サーバー起動
npm run dev
```

起動後、ブラウザで [http://localhost:3000](http://localhost:3000) を開いてください。

---

## 開発ツール
- **APIドキュメント**: [http://localhost:8001/docs](http://localhost:8001/docs)
- **テストスクリプト**: `backend/reproduce_issue.py` を実行して API の動作確認ができます。
