import hashlib
import logging
from datetime import datetime
from typing import List, Optional

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlmodel import Session, select, func

from .analytics.graph_features import build_graph_summary, build_temporal_graph_diff, summarize_temporal_diff
from .database import create_db_and_tables, get_session
from .ontology.repair import get_fallback_extraction
from .ontology.validator import validate_extraction
from .schemas.analytics import AnomalyResult, BaselineStats, DailyFeatureAggregation, Embedding
from .schemas.entry import Entry, get_default_expires_at
from .schemas.extraction import Extraction
from .schemas.structured import EntrySubmissionResponse, ExtractionResponse, GraphSnapshot, HybridExplanation
from .services.inference_orchestrator import InferenceOrchestrator
from .services.llm_adapter import llm_adapter

logger = logging.getLogger(__name__)

app = FastAPI(title="precrisis-graph API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def on_startup():
    create_db_and_tables()


@app.get("/api/health")
def health():
    return {"status": "ok", "version": "2.0.0"}


def _clear_expired_raw_text(session: Session) -> None:
    now = datetime.utcnow()
    query = select(Entry).where(Entry.raw_text.is_not(None), Entry.expires_at.is_not(None), Entry.expires_at <= now)
    expired = session.exec(query).all()
    for entry in expired:
        entry.raw_text = None
        entry.is_masked = True
        session.add(entry)
    if expired:
        session.commit()


def _latest_graph_snapshot(session: Session, user_id: str, before_day) -> Optional[GraphSnapshot]:
    query = (
        select(GraphSnapshot)
        .where(GraphSnapshot.user_id == user_id, GraphSnapshot.day < before_day)
        .order_by(GraphSnapshot.day.desc(), GraphSnapshot.created_at.desc())
        .limit(1)
    )
    return session.exec(query).first()


def _persist_graph_snapshot(
    session: Session,
    entry: Entry,
    cleaned: dict,
) -> GraphSnapshot:
    previous = _latest_graph_snapshot(session, entry.user_id, entry.created_at.date())
    previous_nodes = previous.nodes_json if previous else []
    previous_relations = previous.relations_json if previous else []
    graph_summary = cleaned.get("graph_summary") or build_graph_summary(cleaned.get("nodes", []), cleaned.get("relations", []))
    diff = build_temporal_graph_diff(cleaned.get("nodes", []), cleaned.get("relations", []), previous_nodes, previous_relations)
    temporal_diff = summarize_temporal_diff(diff, graph_summary, previous.graph_summary_json if previous else None)

    snapshot = GraphSnapshot(
        entry_id=entry.id,
        user_id=entry.user_id,
        day=entry.created_at.date(),
        nodes_json=cleaned.get("nodes", []),
        relations_json=cleaned.get("relations", []),
        graph_summary_json=graph_summary,
        temporal_diff_json=temporal_diff,
    )
    session.add(snapshot)
    session.commit()
    session.refresh(snapshot)
    return snapshot


def _empty_explanation(user_id: str, day: datetime, graph_snapshot: Optional[GraphSnapshot] = None) -> HybridExplanation:
    graph_summary = graph_snapshot.graph_summary_json if graph_snapshot else {
        "node_count": 0,
        "relation_count": 0,
        "event_count": 0,
        "key_nodes": [],
        "key_relations": [],
        "summary": "empty graph",
    }
    return HybridExplanation(
        user_id=user_id,
        day=day,
        triggered_rules_json=[],
        baseline_deviation_json={"baseline_available": False, "feature_zscores": {}, "top_features": [], "score": 0.0},
        changed_relations_json=[],
        protective_decline_json={},
        uncertainty_json={"level": "high", "reasons": ["No explanation available"], "missing_signals": ["baseline", "graph"]},
        evidence_summaries=[],
        graph_summary_json=graph_summary,
        score_breakdown_json={"rule_score": 0.0, "deviation_score": 0.0, "temporal_shift_score": 0.0, "final_score": 0.0},
        key_relations=graph_summary.get("key_relations", []),
    )


def _to_extraction_response(extraction: Extraction) -> ExtractionResponse:
    return ExtractionResponse(
        id=extraction.id,
        entry_id=extraction.entry_id,
        nodes_json=extraction.nodes_json or [],
        relations_json=extraction.relations_json or [],
        temporal_summary=extraction.temporal_summary,
        extractor_version=extraction.extractor_version,
        created_at=extraction.created_at,
    )


@app.post("/api/entries", response_model=EntrySubmissionResponse)
def create_entry(user_id: str, text: str, session: Session = Depends(get_session)):
    _clear_expired_raw_text(session)
    logger.info("[submit] start user=%s text_len=%d", user_id, len(text))

    # ── 1. Persist raw entry ─────────────────────────────────────────────────
    entry = Entry(
        user_id=user_id,
        raw_text=text,
        expires_at=get_default_expires_at(),
        provenance_hash=hashlib.sha256(f"{user_id}:{text}".encode("utf-8")).hexdigest()[:16],
    )
    session.add(entry)
    session.commit()
    session.refresh(entry)
    logger.info("[submit] entry persisted id=%s", entry.id)

    # ── 2. Extract structure (LLM or mock) ───────────────────────────────────
    try:
        extracted = llm_adapter.extract_structure(text)
        logger.info(
            "[submit] extraction result nodes=%d relations=%d error_flag=%s",
            len(extracted.get("nodes", [])),
            len(extracted.get("relations", [])),
            extracted.get("error_flag", False),
        )
        cleaned = validate_extraction(extracted) if extracted else get_fallback_extraction()
    except Exception:
        logger.exception("[submit] extraction step raised; using fallback")
        cleaned = get_fallback_extraction()

    # ── 3. Normalize temporal_summary ────────────────────────────────────────
    try:
        temporal_raw = cleaned.get("temporal") or {}
        temporal_summary: str = (
            cleaned.get("temporal_summary")
            or (temporal_raw.get("recency") if isinstance(temporal_raw, dict) else None)
            or "unknown"
        )
    except Exception:
        logger.exception("[submit] temporal_summary normalization failed; using 'unknown'")
        temporal_summary = "unknown"

    # ── 4. Persist extraction ────────────────────────────────────────────────
    try:
        extraction = Extraction(
            entry_id=entry.id,
            nodes_json=cleaned.get("nodes", []),
            relations_json=cleaned.get("relations", []),
            temporal_summary=temporal_summary,
        )
        session.add(extraction)
        session.commit()
        session.refresh(extraction)
        logger.info("[submit] extraction persisted id=%s", extraction.id)
    except Exception:
        logger.exception("[submit] extraction DB write failed; using in-memory fallback")
        extraction = Extraction(
            entry_id=entry.id,
            nodes_json=[],
            relations_json=[],
            temporal_summary="unknown",
        )

    # ── 5. Persist graph snapshot ────────────────────────────────────────────
    graph_snapshot: Optional[GraphSnapshot] = None
    try:
        graph_snapshot = _persist_graph_snapshot(session, entry, cleaned)
        logger.info("[submit] graph snapshot persisted id=%s", graph_snapshot.id)
    except Exception:
        logger.exception("[submit] graph snapshot failed; continuing without snapshot")

    # ── 6. Mask raw text ─────────────────────────────────────────────────────
    try:
        entry.raw_text = None
        entry.is_masked = True
        session.add(entry)
        session.commit()
        session.refresh(entry)
    except Exception:
        logger.exception("[submit] failed to mask raw_text; non-critical, continuing")

    # ── 7. Run hybrid inference pipeline ────────────────────────────────────
    anomaly_result = None
    try:
        orchestrator = InferenceOrchestrator(session)
        anomaly_result = orchestrator.process_day(user_id, entry.created_at.date())
        logger.info("[submit] anomaly_result id=%s", anomaly_result.id if anomaly_result else None)
    except Exception:
        logger.exception("[submit] inference orchestrator raised; returning empty anomaly")

    # ── 8. Resolve explanation ───────────────────────────────────────────────
    try:
        explanation: Optional[HybridExplanation] = _empty_explanation(user_id, entry.created_at, graph_snapshot)
        if anomaly_result and anomaly_result.explanation_id:
            fetched = session.get(HybridExplanation, anomaly_result.explanation_id)
            explanation = fetched or explanation
        logger.info("[submit] explanation id=%s", explanation.id if explanation and explanation.id else None)
    except Exception:
        logger.exception("[submit] explanation resolution failed; using empty explanation")
        explanation = _empty_explanation(user_id, entry.created_at, graph_snapshot)

    # ── 9. Serialize response ───────────────────────────────────────────────
    logger.info("[submit] returning EntrySubmissionResponse for entry id=%s", entry.id)
    return EntrySubmissionResponse(
        entry=entry,
        extraction=_to_extraction_response(extraction),
        graph_snapshot=graph_snapshot,
        anomaly_result=anomaly_result,
        explanation=explanation,
    )


@app.get("/api/entries", response_model=List[Entry])
def list_entries(user_id: str, session: Session = Depends(get_session)):
    query = select(Entry).where(Entry.user_id == user_id).order_by(Entry.created_at.desc())
    return session.exec(query).all()


@app.get("/api/entries/{entry_id}", response_model=Entry)
def get_entry(entry_id: int, session: Session = Depends(get_session)):
    entry = session.get(Entry, entry_id)
    if not entry:
        raise HTTPException(status_code=404, detail="Entry not found")
    return entry


@app.get("/api/entries/{entry_id}/structure", response_model=EntrySubmissionResponse)
def get_entry_structure(entry_id: int, session: Session = Depends(get_session)):
    entry = session.get(Entry, entry_id)
    if not entry:
        raise HTTPException(status_code=404, detail="Entry not found")

    extraction_query = select(Extraction).where(Extraction.entry_id == entry_id).order_by(Extraction.created_at.desc()).limit(1)
    extraction = session.exec(extraction_query).first()
    graph_query = select(GraphSnapshot).where(GraphSnapshot.entry_id == entry_id).order_by(GraphSnapshot.created_at.desc()).limit(1)
    graph_snapshot = session.exec(graph_query).first()
    if not extraction or not graph_snapshot:
        raise HTTPException(status_code=404, detail="Structure not available")

    anomaly_query = select(AnomalyResult).where(AnomalyResult.user_id == entry.user_id, AnomalyResult.day == entry.created_at.date()).order_by(AnomalyResult.created_at.desc()).limit(1)
    anomaly_result = session.exec(anomaly_query).first()
    explanation = session.get(HybridExplanation, anomaly_result.explanation_id) if anomaly_result and anomaly_result.explanation_id else _empty_explanation(entry.user_id, entry.created_at, graph_snapshot)
    explanation = explanation or _empty_explanation(entry.user_id, entry.created_at, graph_snapshot)

    return EntrySubmissionResponse(
        entry=entry,
        extraction=_to_extraction_response(extraction),
        graph_snapshot=graph_snapshot,
        anomaly_result=anomaly_result,
        explanation=explanation,
    )


@app.get("/api/graph-snapshots", response_model=List[GraphSnapshot])
def list_graph_snapshots(user_id: str, limit: int = 12, session: Session = Depends(get_session)):
    query = (
        select(GraphSnapshot)
        .where(GraphSnapshot.user_id == user_id)
        .order_by(GraphSnapshot.day.asc(), GraphSnapshot.created_at.asc())
        .limit(limit)
    )
    snapshots = session.exec(query).all()
    logger.info(
        "[graph-snapshots] user=%s limit=%s returned=%s empty=%s",
        user_id,
        limit,
        len(snapshots),
        all(len(snapshot.nodes_json or []) == 0 for snapshot in snapshots) if snapshots else True,
    )
    return snapshots


@app.get("/api/timeline", response_model=List[AnomalyResult])
def get_timeline(user_id: str, session: Session = Depends(get_session)):
    query = select(AnomalyResult).where(AnomalyResult.user_id == user_id).order_by(AnomalyResult.day.asc())
    return session.exec(query).all()


@app.get("/api/explanations/{explanation_id}", response_model=HybridExplanation)
def get_explanation(explanation_id: int, session: Session = Depends(get_session)):
    expl = session.get(HybridExplanation, explanation_id)
    if not expl:
        raise HTTPException(status_code=404, detail="Explanation not found")
    return expl


@app.get("/api/features")
def get_features(user_id: str, session: Session = Depends(get_session)):
    query = select(DailyFeatureAggregation).where(DailyFeatureAggregation.user_id == user_id).order_by(DailyFeatureAggregation.day.asc())
    return session.exec(query).all()


@app.get("/api/baseline")
def get_baseline(user_id: str, session: Session = Depends(get_session)):
    query = select(BaselineStats).where(BaselineStats.user_id == user_id).order_by(BaselineStats.created_at.desc()).limit(1)
    res = session.exec(query).first()
    if not res:
        raise HTTPException(status_code=404, detail="No baseline found")
    return res


@app.get("/api/anomaly")
def get_current_anomaly(user_id: str, session: Session = Depends(get_session)):
    query = select(AnomalyResult).where(AnomalyResult.user_id == user_id).order_by(AnomalyResult.day.desc()).limit(1)
    res = session.exec(query).first()
    if not res:
        raise HTTPException(status_code=404, detail="No anomaly data found")
    return res


@app.get("/api/embeddings")
def get_embeddings(user_id: str, session: Session = Depends(get_session)):
    query = select(Embedding).join(Entry).where(Entry.user_id == user_id)
    return session.exec(query).all()


@app.get("/api/similar")
def get_similar(entry_id: int, k: int = 5, session: Session = Depends(get_session)):
    entry = session.get(Entry, entry_id)
    if not entry:
        raise HTTPException(status_code=404, detail="Entry not found")
    return {"entry_id": entry_id, "similar_ids": []}
