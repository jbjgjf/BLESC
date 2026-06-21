# BLESC Data and Analytics Audit Report

## 1. Data Inventory

BLESC tracks extensive data across interactions, memory, graphs, and reflection.

### Static / Hard-Coded Metrics
- **Interaction Data (`InteractionEvent`)**: field focus/blur, text insertion/deletion (paste vs type), relative timestamps (`relative_ms`), cursor selection bounds.
- **Writing Dynamics (`WritingFeature`)**: event count, input count, first input latency, active typing span, final field length, chars per minute, inter-input median and P90 intervals, pause count (gaps > 1500ms), max pause duration, deletion/revision ratios, large revision count (> 1 char jump).
- **Session Data (`EntrySession`)**: started/submitted timestamps, duration, total event count, timezone, user agent, field interaction order.
- **Longitudinal Aggregations (`LongitudinalFeature` / `LongitudinalPattern`)**: window aggregations over fixed periods (e.g., 90 days) tracking anomaly recurrence, first/last seen days, mean confidence lifts.

### User-Dependent Metrics
- **Graph Elements (`GraphVersion`, `GraphSnapshot`)**: Nodes (`id`, `category` e.g., Protective/Event/Behavior/Trigger/State, `label`, `confidence`, `intensity`), Relations (`source_id`, `target_id`, `type`, `confidence`).
- **Graph Diffing**: Semantic drift scores, counts of added/removed/changed relations.
- **Reflection Signals**: `anomaly_score` based on baseline drift, `protective_decline` (tracking drop in "Protective" node counts), `uncertainty` level.
- **Cognitive Probe Variables (`CognitiveProbeFeature`)**: token counts, character counts, negative/positive term counts, recall valence (positive vs negative density), self-reference density ("I", "me", "my"), recency markers ("now", "today", "just"), perseveration ratio, `semantic_distance_to_journal` (Jaccard distance), `rumination_index`.

### LLM-Generated Metrics
- **Ontology Extraction (`Extraction`)**: raw output identifying nodes and relations.
- **Embeddings (`EntryEmbedding`)**: 1536-dimensional vectors for semantic lookup.
- **Conversation Recalls (`ConversationRecallSummary`)**: LLM-generated summaries of the last `N` messages, top/recurring topics list.
- **Static Knowledge Retrieval**: matching scores from vector store retrieval (`RetrievalEvent`).
- **Tone Trends**: Evaluated metrics showing if positive/protective tones increased or decreased over the early/recent parts of a conversational window.

---

## 2. Storage Layer Analysis

### Core Tracking Tables

| Table Name | Notable Columns | Data Type | Generation Source | Update Frequency |
|---|---|---|---|---|
| `interaction_events` | `field_name`, `event_type`, `relative_ms`, `metadata_json` | text, int, jsonb | Frontend event listeners | Continuous (during typing/focus) |
| `writing_features` | `feature_json` | jsonb | `writing_dynamics.py` on submit | Once per entry submission |
| `cognitive_probe_features` | `probe_name`, `feature_json` | text, jsonb | `cognitive_probe.py` on submit | Once per entry submission |
| `entry_embeddings` | `embedding`, `content_hash` | vector(1536), text | `_generate_embedding` (OpenAI) | Once per entry text/graph |
| `graph_versions` | `nodes_json`, `relations_json` | jsonb | Graph Extraction LLM Pipeline | Per entry or revision |
| `graph_change_events` | `semantic_drift_score`, `change_type` | float, text | Diffing `graph_snapshots` | Per graph snapshot update |
| `insights` | `anomaly_score`, `baseline_deviation_json` | float, jsonb | `baseline.py` / `pattern_mining.py` | Nightly / Post-submission |
| `conversation_recall_summaries` | `summary_json`, `window_turn_count` | jsonb, int | Chat window summary (LLM) | Periodically (min 6 turns) |

*Note: All JSONB structures above aggregate the specific metric keys outlined in the Data Inventory (e.g., `rumination_index` is stored inside `cognitive_probe_features.feature_json`).*

---

## 3. Data Flow Mapping

**1. Observation Entry Pipeline:**
- **User Action**: User types into "Journal Entry" and "30-First-Recall" textareas on `/`.
- **Frontend Processing**: `page.tsx` aggregates telemetry (focus, blur, input, paste, pauses > 1500ms) in an in-memory ref.
- **Backend Processing**: `ApiClient.createEntry()` triggers `record_interaction`, `record_writing_features`, and `record_cognitive_probe_features` which calculates Jaccard distance and rumination indices.
- **LLM Processing**: The journal text is embedded and simultaneously sent to an ontology extractor to generate `GraphVersion`.
- **Database Storage**: The backend saves raw data to `entries`, `interaction_events`, `writing_features`, `cognitive_probe_features`, and vector stores the `entry_embeddings`.
- **UI Usage**: The saved entry feeds into the latest `graph_snapshots` and baseline triggers for Reflection Signal UI updating.

**2. Chat / Conversation Pipeline:**
- **User Action**: User sends a chat message.
- **Frontend Processing**: Text sent to `ApiClient.createChat()`.
- **Backend Processing**: `generate_research_chat_response` runs `build_research_retrieval_context` to fetch Semantic, Graph, and Pattern matches.
- **LLM Processing**: The LLM forms a response grounded in the retrieved graph/semantic data. Periodically, `analyze_conversation_recall_30` builds a 30-turn recall summary.
- **Database Storage**: Saved to `chat_messages` and `conversation_recall_summaries`.
- **UI Usage**: Dashboard renders the `chatResponse.answer` and the updated `conversationRecall.summary_json`.

---

## 4. RAG Integration

RAG context construction occurs in `build_research_retrieval_context()` inside `research_pipeline.py`.

- **Semantic Evidence**: Uses cosine similarity (`1 - (embedding <=> query_embedding)`) via the `match_entry_embeddings` Postgres function against `entry_embeddings`.
- **Graph Evidence**: Uses text matching on `nodes_json` and `relations_json` using the Postgres function `match_graph_patterns`.
  - *Formula:* Score = `(1.0 if node matches else 0.0) + (1.5 if relation matches else 0.0)`. Matches are case-insensitive substring `LIKE`.
- **Longitudinal Patterns**: Queries `LongitudinalPattern` table for trends matching the query timeframe.
- **Static Knowledge**: Falls back to an OpenAI Vector Store (BLESC documentation) via `search_static_knowledge()`.

**Retrieval Weighting & Construction**: The orchestrator caps limits (default 5, bounded 1..12). It injects all 4 streams of data directly into the final LLM prompt. There is no cross-encoder re-ranking implemented; it relies purely on Postgres/pgvector heuristics.

---

## 5. Graph System Analysis

The Ontology Graph converts raw text into conceptual memory traces.

- **Node Types**: Categorized strictly into `Protective`, `Event`, `Behavior`, `Trigger`, and `State`.
- **Edge Types**: Directed relations (`source_id` → `target_id`) representing `co_occurs`, `causes`, or transitions.
- **Graph Generation**: The LLM extracts nodes/relations (`extraction.py`). `research_pipeline.py` assigns stable UUID hashes to nodes based on their textual signature.
- **Graph Visualization Pipeline**: Data is stored in `graph_snapshots` and aggregated. The dashboard reads the 5 "Key Observations" by sorting nodes based on category priority (`Protective` first, `State` last).
- **Temporal Diffing**: `graph_features.py` calculates `build_temporal_graph_diff()`. It detects `changed_relations` if the confidence score shifts by `>= 0.15`.

---

## 6. Reflection Signal Analysis

The Reflection Signal (`anomaly_score`) visible on the dashboard is **real, but utilizes a blended fallback heuristic if data is sparse.**

- **Generation**: Created by `get_effective_baseline()` in `baseline.py`.
- **Data Feed**: It consumes `DailyFeatureAggregation` representing structural graph states.
- **Pipeline**: If a user has `< 14` days of data, it blends their data with a hard-coded `POPULATION_BASELINE` containing mocked assumptions: `{"protective_ratio": {"mean": 0.45, "std": 0.25}, "isolation_signal": {"mean": 0.20}}`.
- **Storage**: The resulting score and baseline deviation is stored in the `insights` table (`anomaly_score` column).
- **UI Display**: If `baseline_deviation_json.status` is `"not_enough_data"`, the UI explicitly masks the score. Otherwise, it renders the raw anomaly score.

---

## 7. Recall System Analysis

The 30-Turn Recall feature summarizes the latest session conversations.

- **Trigger**: Called automatically by the frontend fetching `/api/recall` or when chatting.
- **Pipeline Logic**: Handled by `analyze_conversation_recall_30()` in `research_pipeline.py`. It requires a minimum of 6 turns (`MIN_CONVERSATION_RECALL_TURNS = 6`), otherwise it sets `status = "not_enough_history"`.
- **Tone/Trend Heuristics**: Analyzes the first half ("early") vs second half ("recent") of the window. It counts matches against hardcoded sets: `NEGATIVE_TONE_TERMS` ("anxious", "stuck") and `PROTECTIVE_TONE_TERMS` ("calm", "safe"). It notes trends like "negative language decreased".
- **Storage**: Stored in `conversation_recall_summaries`.
- **Why only one result appears**: It only updates/saves a new summary record once the active sliding window hits the threshold, summarizing the *whole block* as one entity rather than individual memory fragments.

---

## 8. Supabase Mapping

**Core Schema Entities:**
- `entries` & `entry_sessions`: Producer (UI Form) -> Consumer (Graph Extractor, Analytics Pipeline).
- `entry_fields` & `interaction_events`: Producer (UI Telemetry Listeners) -> Consumer (Research Analytics DB, never shown to user).
- `writing_features` & `cognitive_probe_features`: Producer (Python Analytics Engine) -> Consumer (LLM Prompts for pattern mining).
- `graph_snapshots`, `graph_versions`, `insights`: Producer (Research Pipeline) -> Consumer (Dashboard UI, Reflection Signal).
- `conversation_recall_summaries`: Producer (Chat Pipeline) -> Consumer (Dashboard 30-Turn Recall widget).

**RPC Functions & Views:**
- `match_entry_embeddings`: Cosine similarity matcher. Producer: Backend RAG pipeline.
- `match_graph_patterns`: Substring logic matcher. Producer: Backend RAG pipeline.

**Realtime Subscriptions:**
- The frontend explicitly subscribes to `entries` (via `participant_id=eq.[id]`) to auto-refresh the dashboard without a page reload when the background worker completes processing.

---

## 9. Dashboard Metric Mapping

**"Record Today" Telemetry:**
- UI triggers `handleFieldFocus`, `handleFieldChange` populating `telemetryRef` memory. Generates metrics like pauses (`>= 1500ms`) and `delta` character insertions. Sent hidden payload.

**Reflection Signal Widget:**
- *Source*: `insights.anomaly_score`.
- *Update Trigger*: Reloads on `entries` realtime channel trigger.
- *Transformation*: If `reflectionStatus === 'not_enough_data'`, shows "Not enough data", else `score.toFixed(2)`.

**Key Observations Badges:**
- *Source*: `graph_snapshots.nodes_json`.
- *Transformation*: Sorted by category (`Protective > Event > Behavior > Trigger > State`). Takes the top 5.

**30-Turn Recall Widget:**
- *Source*: `conversation_recall_summaries.summary_json`.
- *Transformation*: Renders the `.summary` string and loops over `.recurring_topics` (rendering Topic · Count).

---

## 10. Missing / Partially Implemented Features

| Feature | Status | Evidence / Notes |
|---|---|---|
| **Interaction Telemetry** | **Implemented** | `page.tsx` fully captures cursors, pauses, and revisions. Persisted to `interaction_events`. |
| **Cognitive Probe** | **Implemented** | `cognitive_probe.py` accurately calculates rumination and perseveration metrics. |
| **RAG Semantic Re-ranking** | **Missing** | `build_research_retrieval_context` naively concatenates graph and vector matches without intelligent cross-scoring. |
| **Reflection Baseline** | **Placeholder** | `baseline.py` heavily relies on `POPULATION_BASELINE` hardcoded values (e.g. `event_transition_signal: 0.5`) until 14 days of data accumulate. |
| **Graph Pattern RAG** | **Partially Implemented** | `match_graph_patterns` in SQL uses simple `LIKE '%term%'` substring matching, missing semantic graph querying. |
| **Diagnostic Mode** | **Unused / Mocked** | All frontend and backend systems explicitly flag outputs with `"non_diagnostic": True` and avoid strict clinical tagging. |
| **Longitudinal Insights UI** | **Missing** | `LongitudinalPattern` and `LongitudinalFeature` tables exist and are populated, but are not rendered on the main dashboard UI. |
