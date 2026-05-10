from __future__ import annotations

from datetime import date, datetime
from typing import Any, Dict, List, Optional

from sqlmodel import Column, Field, JSON, SQLModel, Relationship

from .analytics import AnomalyResult
from .entry import Entry
from .extraction import Extraction


class GraphNode(SQLModel):
    id: str
    category: str
    label: str
    intensity: float = 0.5
    confidence: float = 1.0
    start_time: Optional[datetime] = None
    end_time: Optional[datetime] = None
    duration: Optional[float] = None


class GraphRelation(SQLModel):
    source_id: str
    target_id: str
    type: str
    confidence: float = 1.0


class ExtractionResponse(SQLModel):
    id: Optional[int] = None
    entry_id: int
    nodes_json: List[Dict[str, Any]] = Field(default_factory=list)
    relations_json: List[Dict[str, Any]] = Field(default_factory=list)
    temporal_summary: Optional[str] = None
    extractor_version: str = ""
    created_at: datetime


class GraphLayerSummary(SQLModel):
    node_count: int = 0
    relation_count: int = 0
    event_count: int = 0
    key_nodes: List[Dict[str, Any]] = Field(default_factory=list)
    key_relations: List[Dict[str, Any]] = Field(default_factory=list)
    summary: str = ""


class TemporalGraphDiff(SQLModel):
    added_nodes: List[Dict[str, Any]] = Field(default_factory=list)
    removed_nodes: List[Dict[str, Any]] = Field(default_factory=list)
    added_relations: List[Dict[str, Any]] = Field(default_factory=list)
    removed_relations: List[Dict[str, Any]] = Field(default_factory=list)
    changed_relations: List[Dict[str, Any]] = Field(default_factory=list)
    relation_shift_summary: str = ""
    protective_decline: Dict[str, Any] = Field(default_factory=dict)
    uncertainty: Dict[str, Any] = Field(default_factory=dict)


class GraphSnapshot(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    entry_id: int = Field(foreign_key="entry.id", index=True)
    user_id: str = Field(index=True)
    day: date = Field(index=True)
    nodes_json: List[Dict[str, Any]] = Field(sa_column=Column(JSON))
    relations_json: List[Dict[str, Any]] = Field(sa_column=Column(JSON))
    graph_summary_json: Dict[str, Any] = Field(sa_column=Column(JSON))
    temporal_diff_json: Dict[str, Any] = Field(sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=datetime.utcnow)

    entry: Entry = Relationship(back_populates="graph_snapshots")


class HybridExplanation(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: str = Field(index=True)
    day: datetime = Field(index=True)
    triggered_rules_json: List[Dict[str, Any]] = Field(sa_column=Column(JSON))
    baseline_deviation_json: Dict[str, Any] = Field(sa_column=Column(JSON))
    changed_relations_json: List[Dict[str, Any]] = Field(sa_column=Column(JSON))
    protective_decline_json: Dict[str, Any] = Field(sa_column=Column(JSON))
    uncertainty_json: Dict[str, Any] = Field(sa_column=Column(JSON))
    evidence_summaries: List[str] = Field(sa_column=Column(JSON))
    graph_summary_json: Dict[str, Any] = Field(sa_column=Column(JSON))
    score_breakdown_json: Dict[str, Any] = Field(sa_column=Column(JSON))
    key_relations: List[Dict[str, Any]] = Field(sa_column=Column(JSON), default_factory=list)
    created_at: datetime = Field(default_factory=datetime.utcnow)


class EntrySubmissionResponse(SQLModel):
    entry: Entry
    extraction: ExtractionResponse
    graph_snapshot: Optional[GraphSnapshot] = None
    anomaly_result: Optional[AnomalyResult] = None
    explanation: Optional[HybridExplanation] = None
