from __future__ import annotations

from datetime import date, datetime
from typing import Any, Dict, List, Optional

from sqlmodel import Column, Field, JSON, SQLModel


class ConsentRecord(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: str = Field(index=True)
    participant_code: str = Field(index=True)
    app_use: bool = True
    research_analysis: bool = True
    anonymized_export: bool = False
    future_fine_tuning: bool = False
    consent_version: str = "research-consent-v1"
    source: str = "student_ui"
    created_at: datetime = Field(default_factory=datetime.utcnow)


class EntrySession(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    client_session_id: str = Field(index=True)
    user_id: str = Field(index=True)
    participant_code: str = Field(index=True)
    status: str = "submitted"
    started_at: datetime
    submitted_at: Optional[datetime] = None
    client_timezone: Optional[str] = None
    user_agent: Optional[str] = None
    consent_snapshot_json: Dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    aggregate_metrics_json: Dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=datetime.utcnow)


class EntryField(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    entry_session_id: int = Field(foreign_key="entrysession.id", index=True)
    field_name: str = Field(index=True)
    final_text_hash: str
    char_count: int = 0
    word_count: int = 0
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    metrics_json: Dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=datetime.utcnow)


class InteractionEvent(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    entry_session_id: int = Field(foreign_key="entrysession.id", index=True)
    field_name: str = Field(index=True)
    event_type: str = Field(index=True)
    occurred_at: datetime = Field(index=True)
    relative_ms: int = 0
    value_length: Optional[int] = None
    selection_start: Optional[int] = None
    selection_end: Optional[int] = None
    metadata_json: Dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=datetime.utcnow)


class ResearchEntryLink(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    entry_id: int = Field(foreign_key="entry.id", index=True)
    entry_session_id: int = Field(foreign_key="entrysession.id", index=True)
    field_name: str = Field(index=True)
    source_hash: str
    created_at: datetime = Field(default_factory=datetime.utcnow)


class ModelRun(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: str = Field(index=True)
    participant_code: str = Field(index=True)
    artifact_type: str = Field(index=True)
    artifact_id: Optional[str] = Field(default=None, index=True)
    provider: str = "unknown"
    model: str = "unknown"
    prompt_version: str = "unknown"
    schema_version: str = "unknown"
    pipeline_version: str = "research-pipeline-v1"
    temperature: float = 0.0
    retrieval_config_json: Dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    input_provenance_json: Dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    output_hash: Optional[str] = None
    status: str = "completed"
    error_message: Optional[str] = None
    created_at: datetime = Field(default_factory=datetime.utcnow)


class GraphVersion(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: str = Field(index=True)
    participant_code: str = Field(index=True)
    entry_id: Optional[int] = Field(default=None, foreign_key="entry.id", index=True)
    graph_snapshot_id: Optional[int] = Field(default=None, foreign_key="graphsnapshot.id", index=True)
    version_index: int = Field(index=True)
    nodes_json: List[Dict[str, Any]] = Field(default_factory=list, sa_column=Column(JSON))
    relations_json: List[Dict[str, Any]] = Field(default_factory=list, sa_column=Column(JSON))
    summary_json: Dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=datetime.utcnow)


class GraphChangeEvent(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: str = Field(index=True)
    participant_code: str = Field(index=True)
    graph_version_id: int = Field(foreign_key="graphversion.id", index=True)
    change_type: str = Field(index=True)
    entity_type: str = Field(index=True)
    entity_key: str = Field(index=True)
    previous_json: Optional[Dict[str, Any]] = Field(default=None, sa_column=Column(JSON))
    current_json: Optional[Dict[str, Any]] = Field(default=None, sa_column=Column(JSON))
    semantic_drift_score: float = 0.0
    trajectory_tags: List[str] = Field(default_factory=list, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=datetime.utcnow)


class EntryEmbedding(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    entry_id: Optional[int] = Field(default=None, foreign_key="entry.id", index=True)
    user_id: str = Field(index=True)
    participant_code: str = Field(index=True)
    content_kind: str = Field(index=True)
    embedding_model: str = "not_generated"
    vector_json: List[float] = Field(default_factory=list, sa_column=Column(JSON))
    content_hash: str = Field(index=True)
    metadata_json: Dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=datetime.utcnow)


class RetrievalEvent(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: str = Field(index=True)
    participant_code: str = Field(index=True)
    query_hash: str
    retrieval_config_json: Dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    result_refs_json: List[Dict[str, Any]] = Field(default_factory=list, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=datetime.utcnow)


class ChatSession(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: str = Field(index=True)
    participant_code: str = Field(index=True)
    consent_snapshot_json: Dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=datetime.utcnow)


class ChatMessage(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    chat_session_id: int = Field(foreign_key="chatsession.id", index=True)
    role: str = Field(index=True)
    content_hash: str
    content_redacted: Optional[str] = None
    evidence_refs_json: List[Dict[str, Any]] = Field(default_factory=list, sa_column=Column(JSON))
    model_run_id: Optional[int] = Field(default=None, foreign_key="modelrun.id", index=True)
    created_at: datetime = Field(default_factory=datetime.utcnow)


class LongitudinalFeature(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: str = Field(index=True)
    participant_code: str = Field(index=True)
    window_days: int = Field(index=True)
    window_start: date = Field(index=True)
    window_end: date = Field(index=True)
    feature_json: Dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    pipeline_version: str = "longitudinal-v1"
    created_at: datetime = Field(default_factory=datetime.utcnow)


class LongitudinalPattern(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: str = Field(index=True)
    participant_code: str = Field(index=True)
    window_days: int = Field(index=True)
    pattern_kind: str = Field(index=True)  # recurring_motif | leading_indicator | feature_trend
    pattern_key: str = Field(index=True)
    label: str = ""
    recurrence_count: int = 0
    lift: float = 0.0
    mean_confidence: float = 0.0
    first_seen: Optional[date] = Field(default=None, index=True)
    last_seen: Optional[date] = Field(default=None, index=True)
    support_days_json: List[str] = Field(default_factory=list, sa_column=Column(JSON))
    detail_json: Dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    pipeline_version: str = "sentra-pattern-mining-v1"
    created_at: datetime = Field(default_factory=datetime.utcnow)


class EvalExample(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: str = Field(index=True)
    participant_code: str = Field(index=True)
    source_entry_id: Optional[int] = Field(default=None, foreign_key="entry.id", index=True)
    task_type: str = Field(index=True)
    input_json: Dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    expected_output_json: Dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    consent_snapshot_json: Dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    review_status: str = "unreviewed"
    created_at: datetime = Field(default_factory=datetime.utcnow)


class ExportJob(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: str = Field(index=True)
    participant_code: str = Field(index=True)
    export_format: str = Field(index=True)
    status: str = "pending"
    consent_filter_json: Dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    manifest_json: Dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    output_path: Optional[str] = None
    error_message: Optional[str] = None
    created_at: datetime = Field(default_factory=datetime.utcnow)
    completed_at: Optional[datetime] = None
