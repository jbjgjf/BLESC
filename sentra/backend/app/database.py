import os
from pathlib import Path

from sqlalchemy import text
from sqlmodel import SQLModel, create_engine, Session

DEFAULT_SQLITE_PATH = Path(__file__).resolve().parents[1] / "sentra.db"
DATABASE_URL = os.getenv("DATABASE_URL", f"sqlite:///{DEFAULT_SQLITE_PATH}")

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})


def _apply_migrations() -> None:
    """
    Idempotently add columns that were introduced after the initial schema
    creation.  SQLite does not support IF NOT EXISTS on ALTER TABLE, so we
    check PRAGMA table_info first.
    """
    migrations = [
        # (table_name, column_name, column_ddl)
        ("hybridexplanation", "key_relations", "JSON DEFAULT '[]'"),
        ("entry", "observation_type", "TEXT DEFAULT 'daily'"),
        ("extraction", "emotional_state_json", "JSON DEFAULT '{}'"),
        ("extraction", "reflection_cards_json", "JSON DEFAULT '[]'"),
        ("extraction", "safety_flags_json", "JSON DEFAULT '[]'"),
        ("extraction", "safety_assessment_json", "JSON DEFAULT '{}'"),
        ("extraction", "prompt_version", "TEXT DEFAULT 'unknown'"),
        ("extraction", "extraction_provider", "TEXT DEFAULT 'unknown'"),
        ("extraction", "extraction_model", "TEXT DEFAULT 'unknown'"),
        ("graphsnapshot", "extraction_provider", "TEXT DEFAULT 'unknown'"),
        ("graphsnapshot", "extraction_model", "TEXT DEFAULT 'unknown'"),
        ("graphchangeevent", "user_id", "TEXT DEFAULT 'unknown'"),
        ("graphchangeevent", "participant_code", "TEXT DEFAULT 'unknown'"),
        ("conversationrecallsummary", "memory_object_ids_json", "JSON DEFAULT '[]'"),
        ("modelrun", "output_summary_json", "JSON DEFAULT '{}'"),
    ]
    with engine.connect() as conn:
        for table, column, ddl in migrations:
            rows = conn.execute(text(f"PRAGMA table_info({table})")).fetchall()
            existing = {row[1] for row in rows}
            if column not in existing:
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}"))
                conn.commit()


def create_db_and_tables():
    # Import all models to ensure they are registered with SQLModel
    from .schemas.entry import Entry
    from .schemas.extraction import Extraction
    from .schemas.analytics import DailyFeatureAggregation, BaselineStats, AnomalyResult, Embedding
    from .schemas.structured import GraphSnapshot, HybridExplanation
    from .schemas.research import (
        ChatMessage,
        ChatSession,
        ConversationMemoryObject,
        ConversationRecallSummary,
        ConsentRecord,
        CognitiveProbeFeature,
        EntryEmbedding,
        EntryField,
        EntrySession,
        EvalExample,
        ExportJob,
        GraphChangeEvent,
        GraphEdge,
        GraphNode,
        GraphVersion,
        InteractionEvent,
        LongitudinalFeature,
        LongitudinalPattern,
        ModelRun,
        ResearchEntryLink,
        RetrievalEvent,
        WritingFeature,
    )
    SQLModel.metadata.create_all(engine)
    _apply_migrations()

def get_session():
    with Session(engine) as session:
        yield session
