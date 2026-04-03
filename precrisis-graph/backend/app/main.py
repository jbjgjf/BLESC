import hashlib
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
from .schemas.structured import EntrySubmissionResponse, GraphSnapshot, HybridExplanation
from .services.inference_orchestrator import InferenceOrchestrator
from .services.llm_adapter import llm_adapter

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


@app.post("/api/entries", response_model=EntrySubmissionResponse)
def create_entry(user_id: str, text: str, session: Session = Depends(get_session)):
    _clear_expired_raw_text(session)

    entry = Entry(
        user_id=user_id,
        raw_text=text,
        expires_at=get_default_expires_at(),
        provenance_hash=hashlib.sha256(f"{user_id}:{text}".encode("utf-8")).hexdigest()[:16],
    )
    session.add(entry)
    session.commit()
    session.refresh(entry)

    extracted = llm_adapter.extract_structure(text)
    cleaned = validate_extraction(extracted) if extracted else get_fallback_extraction()
    extraction = Extraction(
        entry_id=entry.id,
        nodes_json=cleaned.get("nodes", []),
        relations_json=cleaned.get("relations", []),
        temporal_summary=cleaned.get("temporal_summary", cleaned.get("temporal", {}).get("recency", "unknown")),
    )
    session.add(extraction)
    session.commit()
    session.refresh(extraction)

    graph_snapshot = _persist_graph_snapshot(session, entry, cleaned)

    entry.raw_text = None
    entry.is_masked = True
    session.add(entry)
    session.commit()
    session.refresh(entry)

    orchestrator = InferenceOrchestrator(session)
    anomaly_result = orchestrator.process_day(user_id, entry.created_at.date())
    explanation: Optional[HybridExplanation] = None
    if anomaly_result and anomaly_result.explanation_id:
        explanation = session.get(HybridExplanation, anomaly_result.explanation_id)

    return EntrySubmissionResponse(
        entry=entry,
        extraction=extraction,
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
    explanation = session.get(HybridExplanation, anomaly_result.explanation_id) if anomaly_result and anomaly_result.explanation_id else None

    return EntrySubmissionResponse(
        entry=entry,
        extraction=extraction,
        graph_snapshot=graph_snapshot,
        anomaly_result=anomaly_result,
        explanation=explanation,
    )


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
