from datetime import date, datetime
from typing import Optional, Dict, Any, List
from sqlmodel import Field, SQLModel, JSON, Column, Relationship

class DailyFeatureAggregation(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: str = Field(index=True)
    day: date = Field(index=True)
    state_count: int = 0
    trigger_count: int = 0
    protective_count: int = 0
    behavior_count: int = 0
    event_count: int = 0
    event_avg_duration: float = 0.0
    protective_ratio: float = 1.0  # protective / (state + trigger + behavior)
    isolation_signal: float = 0.0  # weighted from specific nodes
    feature_vector_json: Dict[str, Any] = Field(sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=datetime.utcnow)

class BaselineStats(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: str = Field(index=True)
    window_start: date
    window_end: date
    stats_json: Dict[str, Any] = Field(sa_column=Column(JSON))  # Means/stds per feature
    created_at: datetime = Field(default_factory=datetime.utcnow)

class AnomalyResult(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: str = Field(index=True)
    day: date = Field(index=True)
    anomaly_score: float = 0.0
    z_scores_json: Dict[str, Any] = Field(sa_column=Column(JSON))
    explanation_id: Optional[int] = None  # Refers to ExplanationPayload
    created_at: datetime = Field(default_factory=datetime.utcnow)

class Embedding(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    entry_id: int = Field(foreign_key="entry.id", index=True)
    vector_json: List[float] = Field(sa_column=Column(JSON))
    cluster_id: Optional[int] = None
    umap_x: Optional[float] = None
    umap_y: Optional[float] = None
    created_at: datetime = Field(default_factory=datetime.utcnow)

    # Re-importing entry to avoid circular refs? Or use Relationship
    entry: "Entry" = Relationship(back_populates="embeddings")
