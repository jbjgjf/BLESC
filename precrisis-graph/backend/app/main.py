from fastapi import FastAPI, Depends, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from sqlmodel import Session, select, func
from typing import List, Optional
from datetime import date, datetime

from .database import engine, create_db_and_tables, get_session
from .schemas.entry import Entry
from .schemas.extraction import Extraction
from .schemas.analytics import DailyFeatureAggregation, BaselineStats, AnomalyResult, Embedding
from .schemas.explanation import ExplanationPayload
from .services.llm_adapter import llm_adapter
from .services.inference_orchestrator import InferenceOrchestrator

app = FastAPI(title="precrisis-graph API")

# Enable CORS for frontend development
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
    return {"status": "ok", "version": "1.0.0"}

# --- Entries & Extraction ---

@app.post("/api/entries", response_model=Entry)
def create_entry(user_id: str, text: str, session: Session = Depends(get_session)):
    entry = Entry(user_id=user_id, raw_text=text)
    session.add(entry)
    session.commit()
    session.refresh(entry)
    
    # Trigger extraction automatically for the MVP
    extractions_data = llm_adapter.extract_structure(text)
    extraction = Extraction(
        entry_id=entry.id,
        nodes_json=extractions_data.get("nodes", []),
        relations_json=extractions_data.get("relations", []),
        temporal_summary=extractions_data.get("temporal", {}).get("recency")
    )
    session.add(extraction)
    session.commit()
    
    # Trigger daily analytics for this user and day
    orchestrator = InferenceOrchestrator(session)
    orchestrator.process_day(user_id, entry.created_at.date())
    
    return entry

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

# --- Analytics & Timeline ---

@app.get("/api/timeline", response_model=List[AnomalyResult])
def get_timeline(user_id: str, session: Session = Depends(get_session)):
    query = select(AnomalyResult).where(AnomalyResult.user_id == user_id).order_by(AnomalyResult.day.asc())
    return session.exec(query).all()

@app.get("/api/explanations/{explanation_id}", response_model=ExplanationPayload)
def get_explanation(explanation_id: int, session: Session = Depends(get_session)):
    expl = session.get(ExplanationPayload, explanation_id)
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

# --- Embeddings & Similarity ---

@app.get("/api/embeddings")
def get_embeddings(user_id: str, session: Session = Depends(get_session)):
    query = select(Embedding).join(Entry).where(Entry.user_id == user_id)
    return session.exec(query).all()

@app.get("/api/similar")
def get_similar(entry_id: int, k: int = 5, session: Session = Depends(get_session)):
    # Placeholder for Phase 1 similarity lookup
    entry = session.get(Entry, entry_id)
    if not entry:
        raise HTTPException(status_code=404, detail="Entry not found")
    return {"entry_id": entry_id, "similar_ids": []}
