from sqlmodel import SQLModel, create_engine, Session
from sqlalchemy.orm import sessionmaker
import os

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./precrisis_graph.db")

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})

def create_db_and_tables():
    # Import all models to ensure they are registered with SQLModel
    from .schemas.entry import Entry
    from .schemas.extraction import Extraction
    from .schemas.analytics import DailyFeatureAggregation, BaselineStats, AnomalyResult, Embedding
    from .schemas.structured import GraphSnapshot, HybridExplanation
    SQLModel.metadata.create_all(engine)

def get_session():
    with Session(engine) as session:
        yield session
