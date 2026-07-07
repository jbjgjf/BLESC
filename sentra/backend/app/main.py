import hashlib
import io
import logging
import os
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import Body, Depends, FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from openai import OpenAI
from dotenv import load_dotenv
from pydantic import BaseModel
from sqlmodel import Session, select, func

from .analytics.graph_features import build_graph_summary, build_temporal_graph_diff, summarize_temporal_diff
from .database import create_db_and_tables, get_session
from .seed import seed_data
from .ontology.repair import get_fallback_extraction
from .ontology.validator import validate_extraction
from .schemas.analytics import AnomalyResult, BaselineStats, DailyFeatureAggregation, Embedding
from .schemas.entry import Entry, get_default_expires_at
from .schemas.extraction import Extraction
from .schemas.research import EvalExample
from .schemas.structured import EntrySubmissionResponse, ExtractionResponse, GraphSnapshot, HybridExplanation
from .services.inference_orchestrator import InferenceOrchestrator
from .services.llm_adapter import llm_adapter
from .services.reflection_intelligence import analyze_reflection, run_reflection_eval
from .services.research_pipeline import (
    create_fine_tuning_dataset_export,
    create_openai_fine_tuning_job,
    create_research_export,
    generate_research_chat_response,
    get_conversation_memory_objects,
    get_latest_conversation_recall_30,
    get_longitudinal_patterns,
    get_personalization_profile,
    link_entry_to_session,
    mine_longitudinal_patterns,
    record_consent,
    record_entry_embeddings,
    record_entry_session,
    record_cognitive_probe_features,
    record_eval_candidate,
    record_graph_version,
    record_model_run,
    record_writing_features,
    reconstruct_entry_replay,
    recompute_longitudinal_features,
    search_similar_embeddings,
    summarize_eval_readiness,
    update_eval_example_review_status,
)
from .services.static_knowledge import get_or_create_blesc_vector_store, static_knowledge_config

logger = logging.getLogger(__name__)

_ENV_DIR = Path(__file__).resolve().parents[1]
load_dotenv(_ENV_DIR / ".env.local")
load_dotenv(_ENV_DIR / ".env")

app = FastAPI(title="Sentra API")

AUDIO_MAX_BYTES = int(os.getenv("OPENAI_TRANSCRIPTION_MAX_BYTES", str(24 * 1024 * 1024)))
AUDIO_EXTENSIONS = {".webm", ".wav", ".mp3", ".m4a", ".mp4", ".mpeg", ".mpga"}
AUDIO_CONTENT_TYPES = {
    "audio/webm",
    "audio/wav",
    "audio/wave",
    "audio/x-wav",
    "audio/mpeg",
    "audio/mp4",
    "audio/mpga",
    "audio/m4a",
    "video/webm",
}

TRANSCRIPTION_SAFE_ERRORS = {
    "AuthenticationError",
    "BadRequestError",
    "NotFoundError",
    "PermissionDeniedError",
    "RateLimitError",
}

allowed_origins = [
    origin.strip()
    for origin in os.getenv("CORS_ALLOW_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000").split(",")
    if origin.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class EntryCreateRequest(BaseModel):
    text: Optional[str] = None
    journal_text: Optional[str] = None
    recall_text: Optional[str] = None
    telemetry: Optional[Dict[str, Any]] = None
    consent: Optional[Dict[str, Any]] = None


class ExportCreateRequest(BaseModel):
    user_id: str
    participant_code: Optional[str] = None
    export_format: str


class ChatCreateRequest(BaseModel):
    user_id: str
    participant_code: Optional[str] = None
    message: str
    limit: int = 5


class SimilarQueryRequest(BaseModel):
    user_id: str
    participant_code: Optional[str] = None
    query: str
    limit: int = 5


class FineTuningDatasetRequest(BaseModel):
    user_id: str
    participant_code: Optional[str] = None


class FineTuningJobRequest(BaseModel):
    user_id: str
    participant_code: Optional[str] = None
    export_job_id: int
    model: Optional[str] = None


class EvalReviewRequest(BaseModel):
    user_id: str
    participant_code: Optional[str] = None
    review_status: str


class ReflectionAnalyzeRequest(BaseModel):
    reflection_id: str
    content: str
    locale: str = "en-US"
    recent_context: List[Dict[str, Any]] = []


class ReflectionEvalRequest(BaseModel):
    case_ids: Optional[List[str]] = None


@app.on_event("startup")
def on_startup():
    create_db_and_tables()
    seed_data()


@app.get("/api/health")
def health():
    return {"status": "ok", "version": "2.0.0"}


def _has_openai_key() -> bool:
    return bool(os.getenv("OPENAI_API_KEY")) and os.getenv("USE_MOCK_LLM", "").lower() != "true"


def _audio_extension(filename: Optional[str]) -> str:
    if not filename or "." not in filename:
        return ""
    return "." + filename.rsplit(".", 1)[-1].lower()


def _audio_content_type(content_type: Optional[str]) -> str:
    return (content_type or "").split(";", 1)[0].strip().lower()


@app.post("/api/audio/transcriptions")
async def transcribe_audio(file: UploadFile = File(...)):
    extension = _audio_extension(file.filename)
    content_type = _audio_content_type(file.content_type)
    if extension not in AUDIO_EXTENSIONS and content_type not in AUDIO_CONTENT_TYPES:
        raise HTTPException(
            status_code=415,
            detail="Unsupported audio format. Use webm, wav, mp3, mp4, mpeg, mpga, or m4a.",
        )

    audio_bytes = await file.read()
    if not audio_bytes:
        raise HTTPException(status_code=422, detail="Audio file is empty.")
    if len(audio_bytes) > AUDIO_MAX_BYTES:
        raise HTTPException(status_code=413, detail="Audio file is too large.")
    if not _has_openai_key():
        logger.info("[audio] transcription blocked: OPENAI_API_KEY unavailable or mock mode active")
        raise HTTPException(
            status_code=503,
            detail="Voice transcription is not configured. Set OPENAI_API_KEY and ensure USE_MOCK_LLM is not true.",
        )

    model = os.getenv("OPENAI_TRANSCRIPTION_MODEL", "gpt-4o-mini-transcribe")
    logger.info(
        "[audio] transcription start filename=%s content_type=%s bytes=%s model=%s",
        file.filename,
        content_type,
        len(audio_bytes),
        model,
    )
    audio_buffer = io.BytesIO(audio_bytes)
    audio_buffer.name = file.filename or f"recording{extension or '.webm'}"
    try:
        transcription = OpenAI(api_key=os.getenv("OPENAI_API_KEY")).audio.transcriptions.create(
            model=model,
            file=audio_buffer,
            response_format="json",
            prompt="Transcribe the student's spoken reflection accurately. Preserve Japanese or English as spoken.",
        )
    except Exception as exc:
        error_type = exc.__class__.__name__
        logger.exception("[audio] transcription failed type=%s", error_type)
        expose_safe_errors = os.getenv("OPENAI_TRANSCRIPTION_EXPOSE_SAFE_ERRORS", "true").lower() == "true"
        if expose_safe_errors or error_type in TRANSCRIPTION_SAFE_ERRORS:
            detail = f"Audio transcription failed at provider: {error_type}."
        else:
            detail = "Audio transcription failed at provider."
        raise HTTPException(status_code=502, detail=detail) from exc

    text = getattr(transcription, "text", "") or ""
    logger.info("[audio] transcription completed chars=%s model=%s", len(text), model)
    return {
        "text": text,
        "provider": "openai",
        "model": model,
        "status": "completed",
    }


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
    extraction_provider: str,
    extraction_model: str,
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
        extraction_provider=extraction_provider,
        extraction_model=extraction_model,
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
        emotional_state_json=extraction.emotional_state_json or {},
        reflection_cards_json=extraction.reflection_cards_json or [],
        safety_flags_json=extraction.safety_flags_json or [],
        prompt_version=extraction.prompt_version,
        extractor_version=extraction.extractor_version,
        extraction_provider=extraction.extraction_provider,
        extraction_model=extraction.extraction_model,
        created_at=extraction.created_at,
    )


@app.post("/api/reflections/analyze")
def analyze_reflection_endpoint(payload: ReflectionAnalyzeRequest):
    if not payload.content.strip():
        raise HTTPException(status_code=422, detail="Reflection content is required")
    return analyze_reflection(
        reflection_id=payload.reflection_id,
        content=payload.content,
        locale=payload.locale,
        recent_context=payload.recent_context,
    )


@app.post("/api/reflections/eval")
def run_reflection_eval_endpoint(payload: ReflectionEvalRequest = Body(default=ReflectionEvalRequest())):
    result = run_reflection_eval(payload.case_ids)
    if result["status"] != "passed":
        raise HTTPException(status_code=500, detail=result)
    return result


@app.post("/api/entries", response_model=EntrySubmissionResponse)
def create_entry(
    user_id: str,
    payload: Optional[EntryCreateRequest] = Body(default=None),
    text: Optional[str] = None,
    observation_type: str = "daily",
    session: Session = Depends(get_session),
):
    journal_text = (payload.journal_text if payload else None) or (payload.text if payload else None) or text or ""
    recall_text = (payload.recall_text if payload else None) or ""
    entry_text = "\n\n".join(
        part for part in [
            f"Journal entry:\n{journal_text.strip()}" if journal_text.strip() else "",
            f"30-first-recall:\n{recall_text.strip()}" if recall_text.strip() else "",
        ]
        if part
    )
    if not entry_text or not entry_text.strip():
        raise HTTPException(status_code=422, detail="Entry text is required")

    _clear_expired_raw_text(session)
    logger.info("[submit] start user=%s text_len=%d observation_type=%s", user_id, len(entry_text), observation_type)
    participant_code = user_id
    personalization_profile: Dict[str, Any] = {}

    research_session = None
    try:
        consent_snapshot = payload.consent if payload else None
        record_consent(session, user_id, participant_code, consent_snapshot)
        personalization_profile = get_personalization_profile(session, user_id, participant_code)
        research_session = record_entry_session(
            session,
            user_id=user_id,
            participant_code=participant_code,
            telemetry=(payload.telemetry if payload else None) or {},
            field_texts={
                "journal_entry": journal_text,
                "first_recall_30": recall_text,
            },
            consent=consent_snapshot,
        )
    except Exception:
        logger.exception("[research] session/consent capture failed; continuing with submission")
        consent_snapshot = payload.consent if payload else None

    active_personal_model = (
        personalization_profile.get("adapter_model")
        if personalization_profile.get("ready_for_personal_adapter")
        else None
    )
    model_metadata = llm_adapter.metadata(model_override=active_personal_model)

    # ── 1. Persist raw entry ─────────────────────────────────────────────────
    entry = Entry(
        user_id=user_id,
        raw_text=entry_text,
        expires_at=get_default_expires_at(),
        provenance_hash=hashlib.sha256(f"{user_id}:{entry_text}".encode("utf-8")).hexdigest()[:16],
        observation_type=observation_type,
    )
    session.add(entry)
    session.commit()
    session.refresh(entry)
    logger.info("[submit] entry persisted id=%s", entry.id)
    link_entry_to_session(session, entry, research_session, "combined_submission", entry_text)
    writing_feature_artifacts: List[Dict[str, Any]] = []
    cognitive_probe_artifact: Optional[Dict[str, Any]] = None
    try:
        writing_feature_artifacts = record_writing_features(
            session=session,
            user_id=user_id,
            participant_code=participant_code,
            entry=entry,
            entry_session=research_session,
            telemetry=(payload.telemetry if payload else None) or {},
        )
        cognitive_probe_artifact = record_cognitive_probe_features(
            session=session,
            user_id=user_id,
            participant_code=participant_code,
            entry=entry,
            entry_session=research_session,
            journal_text=journal_text,
            recall_text=recall_text,
        )
    except Exception:
        logger.exception("[research] writing/cognitive feature capture failed")

    # ── 2. Extract structure (LLM or mock) ───────────────────────────────────
    try:
        extracted = llm_adapter.extract_structure(entry_text, model_override=active_personal_model)
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

    reflection_analysis = analyze_reflection(
        reflection_id=f"entry:{entry.id}",
        content=entry_text,
        locale="en-US",
        graph_extraction=cleaned,
    )
    emotional_state = reflection_analysis["emotional_state"]
    reflection_cards = reflection_analysis["reflection_cards"]
    safety_flags = emotional_state.get("safety_classification", {}).get("flags", [])

    # ── 4. Persist extraction ────────────────────────────────────────────────
    try:
        extraction = Extraction(
            entry_id=entry.id,
            nodes_json=cleaned.get("nodes", []),
            relations_json=cleaned.get("relations", []),
            temporal_summary=temporal_summary,
            emotional_state_json=emotional_state,
            reflection_cards_json=reflection_cards,
            safety_flags_json=safety_flags,
            prompt_version=emotional_state.get("prompt_version", "unknown"),
            extractor_version=model_metadata["extractor_version"],
            extraction_provider=model_metadata["provider"],
            extraction_model=model_metadata["model"],
        )
        session.add(extraction)
        session.commit()
        session.refresh(extraction)
        logger.info("[submit] extraction persisted id=%s", extraction.id)
        try:
            record_eval_candidate(
                session,
                user_id=user_id,
                participant_code=participant_code,
                entry=entry,
                journal_text=journal_text,
                recall_text=recall_text,
                cleaned_extraction=cleaned,
                consent=consent_snapshot,
            )
        except Exception:
            logger.exception("[research] eval candidate capture failed")
        try:
            record_model_run(
                session,
                user_id=user_id,
                participant_code=participant_code,
                artifact_type="extraction",
                artifact_id=extraction.id,
                provider=model_metadata["provider"],
                model=model_metadata["model"],
                output=cleaned,
                input_provenance={
                    "entry_id": entry.id,
                    "entry_session_id": research_session.id if research_session else None,
                    "field_names": ["journal_entry", "first_recall_30"],
                    "personalization": personalization_profile,
                },
            )
        except Exception:
            logger.exception("[research] model run capture failed")
    except Exception:
        logger.exception("[submit] extraction DB write failed; using in-memory fallback")
        extraction = Extraction(
            entry_id=entry.id,
            nodes_json=[],
            relations_json=[],
            temporal_summary="unknown",
            emotional_state_json=emotional_state,
            reflection_cards_json=reflection_cards,
            safety_flags_json=safety_flags,
            prompt_version=emotional_state.get("prompt_version", "unknown"),
            extractor_version=model_metadata["extractor_version"],
            extraction_provider=model_metadata["provider"],
            extraction_model=model_metadata["model"],
        )

    # ── 5. Persist graph snapshot ────────────────────────────────────────────
    graph_snapshot: Optional[GraphSnapshot] = None
    try:
        graph_snapshot = _persist_graph_snapshot(
            session,
            entry,
            cleaned,
            model_metadata["provider"],
            model_metadata["model"],
        )
        logger.info("[submit] graph snapshot persisted id=%s", graph_snapshot.id)
        try:
            record_graph_version(session, user_id, participant_code, entry, graph_snapshot)
        except Exception:
            logger.exception("[research] graph version capture failed")
    except Exception:
        logger.exception("[submit] graph snapshot failed; continuing without snapshot")

    embedding_artifacts: List[Dict[str, Any]] = []
    try:
        embedding_artifacts = record_entry_embeddings(
            session,
            user_id=user_id,
            participant_code=participant_code,
            entry=entry,
            contents={
                "journal_entry": journal_text,
                "first_recall_30": recall_text,
                "combined_submission": entry_text,
            },
            extraction=extraction,
        )
    except Exception:
        logger.exception("[research] embedding queue capture failed")

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
        try:
            recompute_longitudinal_features(session, user_id, participant_code, entry.created_at.date())
        except Exception:
            logger.exception("[research] longitudinal feature recompute failed")
        try:
            mine_longitudinal_patterns(session, user_id, participant_code)
        except Exception:
            logger.exception("[research] longitudinal pattern mining failed")
    except Exception:
        logger.exception("[submit] inference orchestrator raised; returning empty anomaly")

    # ── 8. Resolve explanation ───────────────────────────────────────────────
    try:
        explanation: Optional[HybridExplanation] = _empty_explanation(user_id, entry.created_at, graph_snapshot)
        if anomaly_result and anomaly_result.explanation_id:
            fetched = session.get(HybridExplanation, anomaly_result.explanation_id)
            explanation = fetched or explanation
        elif anomaly_result is None:
            not_enough_query = (
                select(HybridExplanation)
                .where(
                    HybridExplanation.user_id == user_id,
                    func.date(HybridExplanation.day) == entry.created_at.date(),
                )
                .order_by(HybridExplanation.created_at.desc())
                .limit(1)
            )
            fetched = session.exec(not_enough_query).first()
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
        research_artifacts={
            "embedding_artifacts": embedding_artifacts,
            "writing_feature_artifacts": writing_feature_artifacts,
            "cognitive_probe_artifact": cognitive_probe_artifact,
            "pipeline_version": "research-pipeline-v1",
            "personalization": personalization_profile,
        },
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
        research_artifacts={},
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
    query = entry.raw_text or entry.provenance_hash or str(entry.id)
    results = search_similar_embeddings(session, entry.user_id, entry.user_id, query, limit=k)
    return {"entry_id": entry_id, "similar": results}


@app.post("/api/research/similar")
def research_similar(payload: SimilarQueryRequest, session: Session = Depends(get_session)):
    participant_code = payload.participant_code or payload.user_id
    return {
        "query_hash_only": True,
        "similar": search_similar_embeddings(
            session=session,
            user_id=payload.user_id,
            participant_code=participant_code,
            query=payload.query,
            limit=payload.limit,
        ),
    }


@app.get("/api/research/static-knowledge")
def static_knowledge_status():
    config = static_knowledge_config()
    connection = get_or_create_blesc_vector_store(create_if_missing=False)
    return {
        "enabled": config.enabled,
        "source": "openai_vector_store",
        "vector_store_configured": bool(config.vector_store_id),
        "vector_store_id": config.vector_store_id,
        "max_results": config.max_results,
        "allowed_source_dirs": [str(path) for path in config.allowed_source_dirs],
        "connection_status": connection.get("status"),
    }


@app.post("/api/chat")
def create_chat(payload: ChatCreateRequest, session: Session = Depends(get_session)):
    if not payload.message.strip():
        raise HTTPException(status_code=422, detail="Message is required")
    participant_code = payload.participant_code or payload.user_id
    return generate_research_chat_response(
        session=session,
        user_id=payload.user_id,
        participant_code=participant_code,
        message=payload.message,
        limit=payload.limit,
    )


@app.get("/api/research/conversation-recall")
def get_conversation_recall(
    user_id: str,
    participant_code: Optional[str] = None,
    refresh: bool = False,
    session: Session = Depends(get_session),
):
    participant = participant_code or user_id
    return get_latest_conversation_recall_30(
        session=session,
        user_id=user_id,
        participant_code=participant,
        refresh=refresh,
    )


@app.get("/api/research/conversation-recall/memory-objects")
def get_conversation_memory_objects_route(
    user_id: str,
    participant_code: Optional[str] = None,
    active_only: bool = True,
    limit: int = 50,
    session: Session = Depends(get_session),
):
    participant = participant_code or user_id
    return {
        "memory_objects": get_conversation_memory_objects(
            session=session,
            user_id=user_id,
            participant_code=participant,
            active_only=active_only,
            limit=limit,
        )
    }


@app.post("/api/research/exports")
def create_export(payload: ExportCreateRequest, session: Session = Depends(get_session)):
    participant_code = payload.participant_code or payload.user_id
    return create_research_export(
        session=session,
        user_id=payload.user_id,
        participant_code=participant_code,
        export_format=payload.export_format,
    )


@app.get("/api/research/replay/{entry_session_id}")
def get_entry_replay(
    entry_session_id: int,
    user_id: str,
    participant_code: Optional[str] = None,
    session: Session = Depends(get_session),
):
    participant = participant_code or user_id
    replay = reconstruct_entry_replay(
        session=session,
        user_id=user_id,
        participant_code=participant,
        entry_session_id=entry_session_id,
    )
    if not replay:
        raise HTTPException(status_code=404, detail="Entry session replay not found")
    return replay


@app.post("/api/research/fine-tuning-dataset")
def create_fine_tuning_dataset(payload: FineTuningDatasetRequest, session: Session = Depends(get_session)):
    participant_code = payload.participant_code or payload.user_id
    return create_fine_tuning_dataset_export(
        session=session,
        user_id=payload.user_id,
        participant_code=participant_code,
    )


@app.get("/api/research/eval-examples")
def list_eval_examples(user_id: str, participant_code: Optional[str] = None, session: Session = Depends(get_session)):
    participant = participant_code or user_id
    query = (
        select(EvalExample)
        .where(EvalExample.user_id == user_id, EvalExample.participant_code == participant)
        .order_by(EvalExample.created_at.desc())
    )
    return session.exec(query).all()


@app.post("/api/research/eval-examples/{eval_example_id}/review")
def review_eval_example(eval_example_id: int, payload: EvalReviewRequest, session: Session = Depends(get_session)):
    participant_code = payload.participant_code or payload.user_id
    try:
        example = update_eval_example_review_status(
            session,
            user_id=payload.user_id,
            participant_code=participant_code,
            eval_example_id=eval_example_id,
            review_status=payload.review_status,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if not example:
        raise HTTPException(status_code=404, detail="Eval example not found")
    return example


@app.get("/api/research/evals/summary")
def get_eval_summary(user_id: str, participant_code: Optional[str] = None, session: Session = Depends(get_session)):
    participant = participant_code or user_id
    return summarize_eval_readiness(session, user_id, participant)


@app.get("/api/research/personalization")
def get_personalization(user_id: str, participant_code: Optional[str] = None, session: Session = Depends(get_session)):
    participant = participant_code or user_id
    return get_personalization_profile(session, user_id, participant)


@app.get("/api/research/patterns")
def get_patterns(
    user_id: str,
    participant_code: Optional[str] = None,
    pattern_kind: Optional[str] = None,
    refresh: bool = False,
    session: Session = Depends(get_session),
):
    participant = participant_code or user_id
    if refresh:
        try:
            mine_longitudinal_patterns(session, user_id, participant)
        except Exception:
            logger.exception("[research] pattern refresh failed; returning persisted patterns")
    return get_longitudinal_patterns(session, user_id, participant, pattern_kind=pattern_kind)


@app.post("/api/research/fine-tuning-jobs")
def create_fine_tuning_job(payload: FineTuningJobRequest, session: Session = Depends(get_session)):
    participant_code = payload.participant_code or payload.user_id
    return create_openai_fine_tuning_job(
        session=session,
        user_id=payload.user_id,
        participant_code=participant_code,
        export_job_id=payload.export_job_id,
        model=payload.model,
    )
