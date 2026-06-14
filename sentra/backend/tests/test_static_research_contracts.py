from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"
MIGRATION = ROOT / "supabase/migrations/20260611000000_research_grade_data_layer.sql"
RAG_MIGRATION = ROOT / "supabase/migrations/20260614130320_rag_retrieval_context.sql"


RESEARCH_TABLES = [
    "consent_records",
    "entry_sessions",
    "entry_fields",
    "interaction_events",
    "entry_research_links",
    "model_runs",
    "extractions",
    "graph_versions",
    "graph_change_events",
    "entry_embeddings",
    "retrieval_events",
    "chat_sessions",
    "chat_messages",
    "longitudinal_features",
    "eval_examples",
    "export_jobs",
]


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_supabase_research_tables_have_rls_policy_and_grants():
    sql = _read(MIGRATION).lower()

    assert "create extension if not exists vector" in sql
    assert "embedding extensions.vector(1536)" in sql
    assert "using hnsw (embedding vector_cosine_ops)" in sql
    assert "security invoker" in sql
    assert "security definer" not in sql

    for table in RESEARCH_TABLES:
        assert f"create table if not exists public.{table}" in sql
        assert f"alter table public.{table} enable row level security" in sql
        assert f"on public.{table} for all to authenticated" in sql
        assert f"grant select, insert, update, delete on public.{table} to authenticated" in sql


def test_vector_search_function_is_owner_scoped():
    sql = _read(MIGRATION).lower()
    function_start = sql.index("create or replace function public.match_entry_embeddings")
    function_sql = sql[function_start: sql.index("alter table public.consent_records", function_start)]

    assert "where entry_embeddings.owner_user_id = (select auth.uid())" in function_sql
    assert "entry_embeddings.embedding is not null" in function_sql
    assert "limit greatest(1, least(match_count, 50))" in function_sql


def test_rag_migration_adds_filtered_vector_and_graph_pattern_search():
    sql = _read(RAG_MIGRATION).lower()

    assert "drop function if exists public.match_entry_embeddings(extensions.vector, integer)" in sql
    assert "participant_filter uuid default null" in sql
    assert "content_kinds text[] default null" in sql
    assert "min_similarity double precision default 0" in sql
    assert "entry_embeddings.owner_user_id = (select auth.uid())" in sql
    assert "create or replace function public.match_graph_patterns" in sql
    assert "security invoker" in sql
    assert "security definer" not in sql
    assert "graph_versions.owner_user_id = (select auth.uid())" in sql
    assert "grant execute on function public.match_graph_patterns" in sql


def test_openai_keys_are_backend_only_and_not_tracked_as_active_values():
    frontend_source = "\n".join(
        path.read_text(encoding="utf-8")
        for path in (ROOT / "frontend/src").rglob("*")
        if path.is_file() and path.suffix in {".ts", ".tsx"}
    )
    assert "NEXT_PUBLIC_OPENAI" not in frontend_source
    assert "OPENAI_API_KEY" not in frontend_source

    tracked_env = _read(BACKEND / ".env")
    active_secret_lines = [
        line for line in tracked_env.splitlines()
        if "OPENAI_API_KEY" in line and not line.strip().startswith("#")
    ]
    assert active_secret_lines == []

    gitignore = _read(BACKEND / ".gitignore")
    assert ".env.local" in gitignore
    assert ".env.*.local" in gitignore


def test_openai_calls_disable_storage_and_record_reproducibility_metadata():
    llm_adapter = _read(BACKEND / "app/services/llm_adapter.py")
    research_pipeline = _read(BACKEND / "app/services/research_pipeline.py")

    assert "store=False" in llm_adapter
    assert "store=False" in research_pipeline

    for required in [
        "prompt_version",
        "schema_version",
        "pipeline_version",
        "temperature",
        "retrieval_config_json",
        "input_provenance_json",
        "output_hash",
    ]:
        assert required in research_pipeline or required in _read(BACKEND / "app/schemas/research.py")


def test_fine_tuning_export_is_consent_and_review_gated():
    pipeline = _read(BACKEND / "app/services/research_pipeline.py")

    assert "future_fine_tuning" in pipeline
    assert 'review_status == "reviewed"' in pipeline
    assert "Consent scope does not allow future fine-tuning dataset inclusion." in pipeline
    assert "client.fine_tuning.jobs.create" in pipeline
    assert "MIN_REVIEWED_EXAMPLES_FOR_PERSONALIZATION" in pipeline
    assert "ready_for_personal_adapter" in pipeline
