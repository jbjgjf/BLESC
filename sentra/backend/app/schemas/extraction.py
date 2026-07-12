from datetime import datetime
from typing import Optional, List, Dict, Any
from sqlmodel import Field, SQLModel, Relationship, JSON, Column
from .entry import Entry

class ExtractionNode(SQLModel):
    id: str  # local id in extraction
    category: str  # State, Trigger, Protective, Behavior, Event
    label: str
    intensity: float = 0.5
    confidence: float = 1.0
    # For Events
    start_time: Optional[datetime] = None
    end_time: Optional[datetime] = None
    duration: Optional[float] = None  # in minutes or hours

class ExtractionRelation(SQLModel):
    source_id: str
    target_id: str
    type: str  # causes, escalates, buffers, avoids, co_occurs, precedes
    confidence: float = 1.0

class Extraction(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    entry_id: int = Field(foreign_key="entry.id", index=True)
    nodes_json: List[Dict[str, Any]] = Field(sa_column=Column(JSON))
    relations_json: List[Dict[str, Any]] = Field(sa_column=Column(JSON))
    temporal_summary: Optional[str] = None
    emotional_state_json: Dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    reflection_cards_json: List[Dict[str, Any]] = Field(default_factory=list, sa_column=Column(JSON))
    safety_flags_json: List[str] = Field(default_factory=list, sa_column=Column(JSON))
    safety_assessment_json: Dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    prompt_version: str = "unknown"
    extractor_version: str = "qwen-2.5-7b-v1"
    extraction_provider: str = "unknown"
    extraction_model: str = "unknown"
    created_at: datetime = Field(default_factory=datetime.utcnow)

    # Relationship to entries
    entry: Entry = Relationship(back_populates="extractions")
