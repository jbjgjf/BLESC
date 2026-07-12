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


class WritingFeature(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    entry_id: Optional[int] = Field(default=None, foreign_key="entry.id", index=True)
    entry_session_id: int = Field(foreign_key="entrysession.id", index=True)
    user_id: str = Field(index=True)
    participant_code: str = Field(index=True)
    field_name: str = Field(index=True)
    feature_json: Dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    pipeline_version: str = "writing-dynamics-v1"
    created_at: datetime = Field(default_factory=datetime.utcnow)


class CognitiveProbeFeature(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    entry_id: Optional[int] = Field(default=None, foreign_key="entry.id", index=True)
    entry_session_id: Optional[int] = Field(default=None, foreign_key="entrysession.id", index=True)
    user_id: str = Field(index=True)
    participant_code: str = Field(index=True)
    probe_name: str = Field(default="first_recall_30", index=True)
    journal_text_hash: str
    recall_text_hash: str
    feature_json: Dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    pipeline_version: str = "cognitive-probe-v1"
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
    output_summary_json: Dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
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


class ConversationRecallSummary(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: str = Field(index=True)
    participant_code: str = Field(index=True)
    window_turn_count: int = Field(index=True)
    message_start: Optional[datetime] = Field(default=None, index=True)
    message_end: Optional[datetime] = Field(default=None, index=True)
    summary_json: Dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    source_message_hashes_json: List[str] = Field(default_factory=list, sa_column=Column(JSON))
    memory_object_ids_json: List[int] = Field(default_factory=list, sa_column=Column(JSON))
    pipeline_version: str = "conversation-recall-30-v1"
    status: str = Field(default="completed", index=True)
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


class GraphNode(SQLModel, table=True):
    """A deduplicated graph entity, derived from graph_versions.

    node_key is the stable identity (normalized "category:label" signature) so the
    same concept dedupes across days even when raw casing/wording drifts. Counts and
    confidence are rolling aggregates over every occurrence seen so far.
    """

    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: str = Field(index=True)
    participant_code: str = Field(index=True)
    node_key: str = Field(index=True)
    category: str = Field(index=True)
    label: str = ""
    embedding_model: str = "not_generated"
    vector_json: List[float] = Field(default_factory=list, sa_column=Column(JSON))
    embedding_status: str = "pending_no_openai_key"
    confidence: float = 1.0
    intensity: float = 0.5
    occurrence_count: int = 0
    first_seen_day: Optional[date] = Field(default=None, index=True)
    last_seen_day: Optional[date] = Field(default=None, index=True)
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)


class GraphEdge(SQLModel, table=True):
    """A deduplicated directed relation between two GraphNode rows.

    Keyed on (source_node_id, target_node_id, relation_type); occurrence_count and
    mean_confidence accumulate across every graph_version that re-observes the edge.
    """

    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: str = Field(index=True)
    participant_code: str = Field(index=True)
    source_node_id: int = Field(foreign_key="graphnode.id", index=True)
    target_node_id: int = Field(foreign_key="graphnode.id", index=True)
    relation_type: str = Field(default="co_occurs", index=True)
    embedding_model: str = "not_generated"
    vector_json: List[float] = Field(default_factory=list, sa_column=Column(JSON))
    embedding_status: str = "pending_no_openai_key"
    confidence: float = 1.0
    mean_confidence: float = 1.0
    confidence_count: int = 0
    occurrence_count: int = 0
    first_seen_day: Optional[date] = Field(default=None, index=True)
    last_seen_day: Optional[date] = Field(default=None, index=True)
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)


class ConversationMemoryObject(SQLModel, table=True):
    """A single reusable memory fragment extracted from a 30-turn recall window.

    Replaces the single-blob-per-window approach: one window produces N of these.
    Scores (importance/recurrence/confidence) are always computed deterministically
    after segmentation, never trusted blindly from an LLM, and score_breakdown_json
    keeps every weighted component inspectable.
    """

    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: str = Field(index=True)
    participant_code: str = Field(index=True)
    window_id: Optional[int] = Field(default=None, foreign_key="conversationrecallsummary.id", index=True)
    source_message_ids_json: List[int] = Field(default_factory=list, sa_column=Column(JSON))
    topic: str = Field(default="", index=True)
    summary: str = ""
    emotional_tone_json: Dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    importance_score: float = 0.0
    score_breakdown_json: Dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    recurrence_score: float = 0.0
    recurrence_count: int = 0
    confidence_score: float = 0.0
    extraction_mode: str = "deterministic_fallback"
    embedding_model: str = "not_generated"
    vector_json: List[float] = Field(default_factory=list, sa_column=Column(JSON))
    embedding_status: str = "pending_no_openai_key"
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)
    last_reinforced_at: datetime = Field(default_factory=datetime.utcnow)
    merged_into_id: Optional[int] = Field(default=None, foreign_key="conversationmemoryobject.id", index=True)
    merge_reason: Optional[str] = None
    superseded_by_id: Optional[int] = Field(default=None, foreign_key="conversationmemoryobject.id", index=True)
    contradiction_status: str = Field(default="none", index=True)
    contradiction_detail_json: Dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    pipeline_version: str = "conversation-memory-object-v1"
