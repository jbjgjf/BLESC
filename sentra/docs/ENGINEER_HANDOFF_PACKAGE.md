# Sentra Engineer Handoff Package

This file is for sharing non-secret onboarding information with a new engineer.
Do not put real API keys, database passwords, service role keys, or production
secrets in this file or in Google Drive unless the file is access-controlled and
intended as a secret handoff.

## What To Send

Send these project files as the base handoff package:

- `sentra/README.md`
- `sentra/frontend/README.md`
- `sentra/frontend/.env.example`
- `sentra/docs/ENGINEER_HANDOFF_PACKAGE.md`
- `sentra/docs/product_policy.md`
- `sentra/docs/safety_escalation_policy.md`
- `sentra/docs/vector_store_knowledge_plan.md`
- `sentra/docs/research_pipeline.md`
- `sentra/docs/DATA_AUDIT.md`
- `sentra/docs/deployment_vercel.md`
- `sentra/supabase/migrations/`

Recommended folder layout in Google Drive:

```text
BLESC-Sentra-engineer-handoff/
  README-start-here.md
  sentra-docs/
  env-templates/
  local-setup-notes.md
```

The Git repository remains the source of truth. The Drive folder is only for
onboarding context and secret-transfer notes.

## What Not To Send In Plain Text

Do not paste these into Slack, GitHub issues, or public docs:

- `OPENAI_API_KEY`
- Supabase service role key
- direct database password or pooled database URL with password
- production `DATABASE_URL`
- any private Vercel token
- any user export, journal data, chat logs, embeddings, or local database files
- `sentra/backend/sentra.db`
- `.env.local` files with real values

If secrets must be shared, use a password manager or the relevant platform's own
environment variable UI. Prefer per-engineer credentials that can be revoked.

## Required Local Tools

The engineer should install:

- Git
- Node.js 20 or newer
- npm
- Python 3.12
- Supabase CLI, only if they will run local Supabase or apply migrations from CLI
- Vercel CLI, only if they will inspect or deploy Vercel projects
- Optional: Ollama, only for local non-OpenAI fallback development

## Repository Structure

```text
sentra/
  backend/       FastAPI backend, research pipeline, OpenAI calls, analytics
  frontend/      Next.js frontend and browser API routes
  supabase/      Supabase config and SQL migrations
  docs/          product policy, research docs, deployment notes
```

Important backend areas:

- `sentra/backend/app/main.py`
- `sentra/backend/app/services/research_pipeline.py`
- `sentra/backend/app/services/static_knowledge.py`
- `sentra/backend/app/analytics/`
- `sentra/backend/tests/`

Important frontend areas:

- `sentra/frontend/src/api/client.ts`
- `sentra/frontend/src/app/api/`
- `sentra/frontend/src/app/recall/page.tsx`
- `sentra/frontend/src/components/VoiceInputButton.tsx`
- `sentra/frontend/src/components/graph/GraphViewer3D.tsx`

## Environment Variables

Create local env files manually. Do not commit them.

### Frontend: `sentra/frontend/.env.local`

```bash
NEXT_PUBLIC_SUPABASE_URL=https://your-project-ref.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_publishable_or_anon_key
NEXT_PUBLIC_API_URL=http://localhost:8000/api
```

Notes:

- `NEXT_PUBLIC_*` values are exposed to the browser.
- Never put a Supabase service role key in the frontend.
- If `NEXT_PUBLIC_API_URL` is absent in production, the frontend may fall back to
  Next.js `/api` routes.

### Backend: `sentra/backend/.env.local`

```bash
OPENAI_API_KEY=
OPENAI_EXTRACTION_MODEL=gpt-4.1-mini
OPENAI_CHAT_MODEL=gpt-4.1-mini
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
OPENAI_TRANSCRIPTION_MODEL=gpt-4o-mini-transcribe

BLESC_VECTOR_STORE_ID=
OPENAI_VECTOR_STORE_ID=
BLESC_STATIC_KNOWLEDGE_ENABLED=true
BLESC_STATIC_KNOWLEDGE_MAX_RESULTS=5

DATABASE_URL=sqlite:///./sentra.db
CORS_ALLOW_ORIGINS=http://localhost:3000,http://127.0.0.1:3000
USE_MOCK_LLM=false
```

Optional research tuning variables:

```bash
SENTRA_CONVERSATION_RECALL_TURNS=30
SENTRA_MIN_CONVERSATION_RECALL_TURNS=6
SENTRA_PATTERN_WINDOW_DAYS=90
SENTRA_MIN_PERSONALIZATION_EXAMPLES=100
SENTRA_PERSONAL_EXTRACTION_MODEL_MAP={}
SENTRA_EXPORT_SALT=
SENTRA_EXPORT_DIR=./exports
```

Optional graph and memory retrieval tuning:

```bash
SENTRA_GRAPH_RAG_WEIGHT_SEMANTIC=0.35
SENTRA_GRAPH_RAG_WEIGHT_DISTANCE=0.15
SENTRA_GRAPH_RAG_WEIGHT_CONFIDENCE=0.15
SENTRA_GRAPH_RAG_WEIGHT_RECENCY=0.15
SENTRA_GRAPH_RAG_WEIGHT_RECURRENCE=0.10
SENTRA_GRAPH_RAG_WEIGHT_MEMORY=0.10

SENTRA_MEMORY_RAG_WEIGHT_SEMANTIC=0.4
SENTRA_MEMORY_RAG_WEIGHT_IMPORTANCE=0.25
SENTRA_MEMORY_RAG_WEIGHT_RECURRENCE=0.15
SENTRA_MEMORY_RAG_WEIGHT_CONFIDENCE=0.1
SENTRA_MEMORY_RAG_WEIGHT_RECENCY=0.1
SENTRA_MEMORY_RAG_RECENCY_HALF_LIFE_DAYS=14
```

## Local Setup

Backend:

```bash
cd sentra/backend
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
USE_MOCK_LLM=false python -m uvicorn app.main:app --reload --port 8000
```

Frontend:

```bash
cd sentra/frontend
npm install
npm run dev
```

Open:

```text
http://localhost:3000
http://localhost:8000/docs
```

## Tests And Verification

Backend tests should be run from `sentra`:

```bash
cd sentra
PYTHONPATH=backend backend/.venv/bin/python -m pytest backend/tests/test_research_pipeline.py backend/tests/test_static_research_contracts.py -q
```

Frontend checks:

```bash
cd sentra/frontend
npm run lint
npm run build
```

Useful endpoint checks:

```bash
curl http://localhost:8000/api/research/static-knowledge
curl "http://localhost:8000/api/research/replay/1?user_id=research_user_01"
```

## Supabase Migration Notes

The SQL migrations live in:

```text
sentra/supabase/migrations/
```

The current system depends on tables and RPCs for:

- auth-owned user data
- entries and graph snapshots
- entry embeddings and graph-pattern retrieval
- conversation recall summaries
- graph index nodes and edges
- memory objects
- research exports and eval examples

If the engineer cannot use the Supabase CLI, migrations can be applied through
the Supabase Dashboard SQL editor by a project owner. Apply migrations in
filename order.

## Data Boundary Rules

Sentra has two retrieval layers:

- Supabase stores user-specific application data, including journal-derived
  embeddings and graph snapshots.
- OpenAI Vector Store stores static curated knowledge only.

OpenAI Vector Store may contain:

- product policy
- safety escalation policy
- public educational or support references
- curated static BLESC knowledge docs

OpenAI Vector Store must not contain:

- user journal entries
- chat history
- personal graph snapshots
- user embeddings
- research exports
- fine-tuning examples tied to a user
- local databases or uploaded user files

The product must avoid diagnostic or definitive mental-health claims. Use
non-diagnostic language and route high-risk cases toward human support.

## Production Notes

Vercel frontend settings:

```text
Root Directory: sentra/frontend
Framework: Next.js
Build Command: npm run build
Install Command: npm install
Output Directory: .next
```

Production env should be configured in the Vercel project UI, not passed around
as a plaintext file. The engineer should be able to inspect:

- deployments
- environment variables
- function logs
- build logs

If production browser traffic uses `/api`, check the Next.js routes under:

```text
sentra/frontend/src/app/api/
```

## First-Day Checklist

1. Clone the Git repository.
2. Create `sentra/frontend/.env.local`.
3. Create `sentra/backend/.env.local`.
4. Start backend on port `8000`.
5. Start frontend on port `3000`.
6. Confirm login/signup works against the intended Supabase project.
7. Confirm `GET /api/research/static-knowledge` returns a status response.
8. Run backend tests.
9. Run frontend lint and build.
10. Read the product and safety docs before changing research or chat behavior.

## Suggested Message To Include With The Drive Link

```text
This Drive folder contains non-secret onboarding docs for BLESC/Sentra.
It does not contain real API keys or service role credentials.

Please use the env templates to create your local .env.local files.
Actual secrets will be provided through the platform dashboard or password
manager, not through GitHub or Slack.

Start with:
- sentra/docs/ENGINEER_HANDOFF_PACKAGE.md
- sentra/README.md
- sentra/docs/product_policy.md
- sentra/docs/vector_store_knowledge_plan.md
- sentra/docs/research_pipeline.md
```
