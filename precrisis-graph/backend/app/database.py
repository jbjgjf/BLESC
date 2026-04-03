from sqlmodel import SQLModel, create_engine, Session
from sqlalchemy.orm import sessionmaker
from sqlalchemy import text
import os

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./precrisis_graph.db")

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
    SQLModel.metadata.create_all(engine)
    _apply_migrations()

def get_session():
    with Session(engine) as session:
        yield session
