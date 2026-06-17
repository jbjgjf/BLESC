# BLESC Vector Store Knowledge Plan

## Architecture

BLESC uses two separate retrieval layers:

1. Supabase Postgres with pgvector stores user-specific application data, including journal-derived embeddings in `public.entry_embeddings`.
2. OpenAI Vector Store stores static, curated BLESC knowledge documents only.

These layers must not be merged. Supabase remains the primary application database and owner-scoped user-data vector layer. OpenAI Vector Store is a static knowledge layer for policy, safety, and educational reference material.

## Approved OpenAI Vector Store Content

The OpenAI Vector Store may contain:

- Crisis response guidelines
- Self-harm and suicide risk guidance
- Student mental health support resources
- CBT and psychoeducation basics
- BLESC original product policy
- BLESC safety escalation policy

The OpenAI Vector Store must not contain:

- User journal entries
- Chat history
- Per-user mental health content
- Personal graph snapshots
- User embeddings from `entry_embeddings`
- Exported research datasets
- Fine-tuning examples or eval examples tied to a user
- Any file copied from user uploads or application databases

## Ingestion Controls

The backend ingestion pipeline accepts only approved file extensions from configured static knowledge directories. The default source directory is `sentra/docs`, and the default allowlist is:

- `docs/product_policy.md`
- `docs/safety_escalation_policy.md`
- `docs/vector_store_knowledge_plan.md`

The ingestion code rejects paths that look like user data, exports, journals, entries, chats, uploads, or local databases. Static documents must be reviewed before upload.

## Runtime Retrieval

During chat response generation, BLESC can combine:

- Supabase semantic evidence from `entry_embeddings`
- Supabase graph-pattern evidence from extracted graph snapshots
- Supabase longitudinal pattern evidence
- OpenAI Vector Store static knowledge matches
- BLESC safety and product-policy constraints

The response prompt must keep source boundaries explicit. User-specific evidence comes from Supabase. Static policy and educational evidence comes from OpenAI Vector Store. BLESC must not imply that user journal content was uploaded to the OpenAI Vector Store.

## Configuration

Required for live OpenAI Vector Store retrieval:

- `OPENAI_API_KEY`
- `BLESC_VECTOR_STORE_ID`

Optional:

- `BLESC_VECTOR_STORE_NAME`
- `BLESC_STATIC_KNOWLEDGE_ENABLED`
- `BLESC_STATIC_KNOWLEDGE_MAX_RESULTS`
- `BLESC_STATIC_KNOWLEDGE_SOURCE_DIRS`

If `BLESC_VECTOR_STORE_ID` is missing, the application keeps running and static knowledge retrieval is reported as `missing_vector_store_id`. The ingestion script can create a vector store and prints the resulting ID.

## Operational Verification

Use the ingestion script from `sentra/backend`:

```bash
PYTHONPATH=. .venv/bin/python scripts/ingest_static_knowledge.py
```

Then set:

```bash
BLESC_VECTOR_STORE_ID=vs_...
```

The status endpoint is:

```text
GET /api/research/static-knowledge
```

Chat retrieval logs include source counts for Supabase semantic retrieval, Supabase graph retrieval, Supabase pattern retrieval, and OpenAI Vector Store retrieval.
