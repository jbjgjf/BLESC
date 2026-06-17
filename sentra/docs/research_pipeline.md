# Sentra Research Pipeline

This document describes the research-grade backend added behind the simple
student UI. The UI should stay centered on two fields: `journal_entry` and
`first_recall_30`.

## Data Collection

The frontend records low-level interaction replay data without adding student
workflow complexity:

- field focus and blur events
- input timestamps and relative timing
- pause intervals, edit counts, deletion counts, paste counts, revision counts
- field order, total duration, client timezone, user agent

Raw keystroke text is not stored in interaction events. Final field text is
sent for normal analysis, then represented in research tables by hashes and
derived artifacts.

Replay is available through:

```bash
curl "http://localhost:8000/api/research/replay/1?user_id=research_user_01"
```

The replay payload returns ordered focus, blur, paste, and input events,
relative timestamps, length deltas, selections, field metrics, and final text
hashes. It reconstructs the writing process without returning raw field text.

## Backend Artifacts

Each submission creates or updates these research records:

- `consent_records`: app, research, anonymized export, and fine-tuning scopes
- `entry_sessions`, `entry_fields`, `interaction_events`: raw replay and field metrics
- `model_runs`: reproducibility metadata for extraction, embeddings, chat, evals, and fine-tuning jobs
- `entry_embeddings`: one embedding artifact per text or structural content kind
- `graph_versions`, `graph_change_events`: longitudinal graph evolution
- `longitudinal_features`: 7-day and 30-day trend, consistency, volatility, recurrence, and change-rate metrics
- `longitudinal_patterns`: mined recurring motifs, leading indicators (lift), and feature trends
- `eval_examples`: unreviewed extraction examples for evaluation and later fine-tuning review
- `export_jobs`: CSV, JSONL, Parquet, and fine-tuning dataset exports

Every model-generated artifact records provider, model, prompt version, schema
version, temperature, retrieval config, input provenance, output hash, pipeline
version, and status.

## Research Exports

`POST /api/research/exports` supports `csv`, `jsonl`, and `parquet`:

```bash
curl -X POST http://localhost:8000/api/research/exports \
  -H 'content-type: application/json' \
  -d '{"user_id":"research_user_01","export_format":"jsonl"}'
```

Exports require both `research_analysis=true` and `anonymized_export=true` in
the latest consent record. Export rows replace direct user identifiers with a
stable salted `subject_id`, hash client session identifiers, and scrub raw text
fields such as chat message previews and evidence snippets into hashes plus
character counts. Semantic graph labels and aggregate metrics are retained for
analysis, so exports should still be treated as consent-gated research data,
not public anonymous data.

## OpenAI Key Handling

Do not put `OPENAI_API_KEY` in tracked files or frontend env vars.

Use:

```bash
cd sentra/backend
printf 'OPENAI_API_KEY=...\n' >> .env.local
printf 'OPENAI_EXTRACTION_MODEL=gpt-4.1-mini\n' >> .env.local
printf 'OPENAI_CHAT_MODEL=gpt-4.1-mini\n' >> .env.local
printf 'OPENAI_EMBEDDING_MODEL=text-embedding-3-small\n' >> .env.local
```

`backend/.env.local` is ignored. The tracked `backend/.env` is only for
non-secret local defaults.

OpenAI Responses calls set `store=false` for extraction and chat. If no backend
key is present, Sentra records deterministic fallback metadata and keeps the
submission path working.

## Retrieval And Chat

`POST /api/research/similar` computes a query embedding when a backend OpenAI
key is available and records a `retrieval_events` trace. The response now
returns usable evidence context for each match: entry day, graph summary,
key nodes, key relations, temporal diff metadata, and the matched content kind.
Without a key, Sentra falls back to derived graph/search terms rather than raw
entry text.

`POST /api/chat` creates a research chat session, retrieves evidence refs, and
generates a student-friendly answer. Chat retrieval is hybrid:

- Semantic RAG: vector similarity over `entry_embeddings`
- Graph RAG: graph-pattern similarity over extracted nodes and relations
- Pattern RAG: mined longitudinal patterns ranked against the query

Graph RAG is intentionally structural. It can surface earlier days that share a
Trigger -> State, Protective -> State, or other relation pattern even when the
wording is not identical. Pattern RAG goes one step further: instead of a single
similar day, it surfaces *learned* patterns ("this motif has recurred N times",
"this leading indicator precedes harder next days"). The assistant must ground
claims in retrieved evidence dates and avoid diagnosis.

Supabase projects use `match_entry_embeddings(...)` for filtered pgvector
search and `match_graph_patterns(...)` for owner-scoped graph-pattern search.
Both functions are `security invoker`, so RLS remains active.

## Longitudinal Pattern Learning

`recompute_longitudinal_features` produces per-window descriptive statistics
(trend, consistency, volatility, recurrence) but does not learn patterns.
`mine_longitudinal_patterns` is the learning layer. After each submission (and
on demand) it loads the participant's day-ordered `graph_snapshots`, their
`anomaly_results`, and their most recent `longitudinal_features` window, then
mines three pattern kinds into `longitudinal_patterns`:

- `recurring_motif`: a relation motif (e.g. `Trigger:deadline -> escalates ->
  State:anxiety`) that appears on two or more distinct days. Each row carries
  `recurrence_count`, `support_days`, and first/last seen.
- `leading_indicator`: an antecedent — a motif, or a synthetic
  `__protective_decline__` signal (a day whose protective-node count dropped
  versus the prior observed day) — whose presence is followed by an elevated
  anomaly score on the next observed day. Strength is a `lift` ratio:
  `mean(next-day score | antecedent present) / mean(next-day score)`.
- `feature_trend`: a longitudinal feature whose window trend clears a threshold,
  narrated (e.g. "protective resources declining over 30 days") with a
  `flagged_as_risk` boolean for concerning directions.

The miner in `app/analytics/pattern_mining.py` is dependency-free and
deterministic (no numpy/sklearn), so it runs safely in the request path and is
unit-tested in `tests/test_pattern_mining.py`. Mining is idempotent per
participant+window: each run replaces that window's rows rather than appending.

Read patterns (optionally forcing a re-mine) with:

```bash
curl "http://localhost:8000/api/research/patterns?user_id=research_user_01&refresh=true"
curl "http://localhost:8000/api/research/patterns?user_id=research_user_01&pattern_kind=leading_indicator"
```

The response groups patterns into `recurring_motifs`, `leading_indicators`, and
`feature_trends`. `support_days` and `last_seen` are well suited to timeline
visualisations; `lift` is well suited to a "leading indicator" callout.

Supabase projects persist these in `longitudinal_patterns`
(`supabase/migrations/20260614140000_longitudinal_patterns.sql`), owner-scoped
with the same RLS conventions as the rest of the research data layer.

## Evaluation And Fine-Tuning

Each extraction creates an `eval_examples` candidate with `review_status =
unreviewed`.

Review flow:

```bash
curl -X POST http://localhost:8000/api/research/eval-examples/1/review \
  -H 'content-type: application/json' \
  -d '{"user_id":"research_user_01","review_status":"reviewed"}'
```

Only reviewed examples and `future_fine_tuning=true` consent can enter the
fine-tuning JSONL export:

```bash
curl -X POST http://localhost:8000/api/research/fine-tuning-dataset \
  -H 'content-type: application/json' \
  -d '{"user_id":"research_user_01"}'
```

If a backend OpenAI key exists and the export job is complete, a fine-tuning job
can be submitted:

```bash
curl -X POST http://localhost:8000/api/research/fine-tuning-jobs \
  -H 'content-type: application/json' \
  -d '{"user_id":"research_user_01","export_job_id":1}'
```

Personal adaptation is gated before use. Check readiness with:

```bash
curl "http://localhost:8000/api/research/personalization?user_id=research_user_01"
```

The backend requires `future_fine_tuning=true` and at least
`SENTRA_MIN_PERSONALIZATION_EXAMPLES` reviewed Eval Examples before an adapter
model is selected for extraction. The default threshold is `100`. Once a
participant-specific model exists, set it through
`SENTRA_PERSONAL_EXTRACTION_MODEL_MAP`, for example:

```bash
printf 'SENTRA_PERSONAL_EXTRACTION_MODEL_MAP={"research_user_01":"ft:gpt-4.1-mini:org:sentra-user-01"}\n' >> .env.local
```

This keeps the generic model as the default while allowing reviewed,
consented users to route extraction through their personal adapter/fine-tuned
model.

## Supabase Migration

The research data layer is in
`supabase/migrations/20260611000000_research_grade_data_layer.sql`.

It adds RLS-protected append-only research tables, `entry_embeddings` with
`extensions.vector(1536)`, an HNSW cosine index, and
`match_entry_embeddings(...)` as a `security invoker` function so RLS remains
active during vector search.

`supabase/migrations/20260614130320_rag_retrieval_context.sql` extends retrieval
with participant/content-kind/min-similarity filters and adds
`match_graph_patterns(...)` for graph RAG.

`supabase/migrations/20260614140000_longitudinal_patterns.sql` adds the
owner-scoped `longitudinal_patterns` table for the pattern-learning layer.

Apply after the Supabase local stack or remote project is available:

```bash
cd sentra
supabase migration list --local
supabase db push
```

If local Docker is unavailable, `supabase migration list --local` will fail
before reaching SQL validation because the local Postgres container is not
running.
