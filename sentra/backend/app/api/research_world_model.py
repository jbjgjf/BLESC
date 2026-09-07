"""C6 (#140) — the research API for the world-model runs.

Four endpoints, and the constraints on them are the interesting part.

**Training does not happen inside the request.** `POST /runs` returns 202 with a
run id and schedules the work on a single background worker. A synchronous fit
would hold an HTTP connection for a minute and time out behind any proxy, and
the contract says not to do it.

**The endpoints fail closed.** Without `RESEARCH_API_TOKEN` configured, every
route returns 503 rather than running unauthenticated. An endpoint that trains
models and returns internal state is not one to leave open by default because a
deployment forgot to set a variable.

**Ownership is decided on the server.** A run belongs to the credential that
created it; the path's run id is not the authorisation. v0 has a single research
credential, so "owner" is that credential — per-researcher accounts are named as
a follow-up rather than faked with a client-supplied id.

**Nothing here returns a checkpoint.** The report and the explanation bundles
are JSON about a run. Model weights and service-role keys stay on the server.

Run state is in process memory. A restart loses the queue, and the endpoints say
so with 404 rather than inventing a status. Persisting runs belongs with the
research environment work, not with the API skeleton.
"""

from __future__ import annotations

import hashlib
import logging
import os
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional

from fastapi import APIRouter, Header, HTTPException, status
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/research/world-model", tags=["research-world-model"])

#: Datasets a request may name. Only synthetic ids: v0 refuses real data at the
#: contract boundary too, and this list keeps the refusal from depending on that
#: one check being reached.
ALLOWED_DATASET_IDS = ("synthetic-dev-v0", "synthetic-scenarios-v0")

#: Configurations a request may name, mapped to the file that defines them.
ALLOWED_CONFIGS = {
    "research-smoke-v0": "research_engine/configs/smoke.json",
    "research-ci-v0": "research_engine/configs/ci.json",
}

#: One worker. Two concurrent fits on a shared CPU make both slower and make the
#: measured elapsed time in the report meaningless.
_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="research-run")
_lock = threading.Lock()


@dataclass
class RunRecord:
    run_id: str
    owner: str
    dataset_id: str
    config_id: str
    idempotency_key: str
    request_hash: str
    state: str = "queued"
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    run_dir: Optional[str] = None
    report: Optional[Dict[str, Any]] = None
    explanations: Optional[List[Dict[str, Any]]] = None
    error: Optional[str] = None
    artifact_versions: Dict[str, str] = field(default_factory=dict)


_runs: Dict[str, RunRecord] = {}
_by_idempotency_key: Dict[str, str] = {}


class CreateRunRequest(BaseModel):
    dataset_id: str = Field(..., description="許可された合成datasetのid")
    config_id: str = Field(..., description="許可された設定のid")
    idempotency_key: str = Field(..., min_length=8, max_length=200)


class CreateRunResponse(BaseModel):
    run_id: str
    state: str
    dataset_id: str
    config_id: str


def _configured_token() -> Optional[str]:
    token = os.getenv("RESEARCH_API_TOKEN")
    return token.strip() if token and token.strip() else None


def _require_researcher(authorization: Optional[str]) -> str:
    """Return the owner id for the credential, or raise.

    503 when the deployment has no research credential configured, because
    "misconfigured" and "forbidden" are different problems and an operator
    reading the logs needs to tell them apart.
    """

    expected = _configured_token()
    if expected is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="研究APIは未設定です（RESEARCH_API_TOKEN）。既定では誰にも開きません。",
        )
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="研究権限が必要です。")

    presented = authorization.split(" ", 1)[1].strip()
    # Constant-time compare: a timing side channel on a shared research token is
    # cheap to avoid and awkward to explain later.
    if not _constant_time_equals(presented, expected):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="研究権限がありません。")

    return "research:" + hashlib.sha256(expected.encode("utf-8")).hexdigest()[:12]


def _constant_time_equals(left: str, right: str) -> bool:
    import hmac

    return hmac.compare_digest(left, right)


def _request_hash(payload: CreateRunRequest) -> str:
    return hashlib.sha256(
        f"{payload.dataset_id}|{payload.config_id}".encode("utf-8")
    ).hexdigest()


def _run_root() -> Path:
    return Path(os.getenv("RESEARCH_RUN_ROOT", "/tmp/blesc-research-runs"))


def _execute(run_id: str, config_path: str) -> None:
    import json

    from research_engine.pipeline import RunConfig, run_pipeline

    with _lock:
        record = _runs.get(run_id)
        if record is None:
            return
        record.state = "running"
        record.started_at = datetime.now(timezone.utc)

    try:
        backend_root = Path(__file__).resolve().parents[2]
        config = RunConfig.from_dict(
            json.loads((backend_root / config_path).read_text(encoding="utf-8"))
        )
        result = run_pipeline(config, _run_root() / run_id, run_id=run_id)
        with _lock:
            record = _runs[run_id]
            record.state = "succeeded" if result.report.status == "ok" else "failed"
            record.report = result.report.as_dict()
            record.explanations = result.explanations
            record.run_dir = str(result.run_dir)
            record.artifact_versions = {
                "report_version": result.report.report_version,
                "config_hash": result.report.artifact_hashes.get("config_hash", ""),
                "model_hash": result.report.artifact_hashes.get("model_hash", ""),
            }
            record.finished_at = datetime.now(timezone.utc)
            if record.state == "failed":
                record.error = "漏洩・健全性の検査に失敗しました。reportのleakage_checksを確認してください。"
    except Exception as exc:  # pragma: no cover - defensive
        logger.exception("research world-model run failed: %s", run_id)
        with _lock:
            record = _runs[run_id]
            record.state = "failed"
            record.error = f"{type(exc).__name__}: {exc}"
            record.finished_at = datetime.now(timezone.utc)


def _owned_run(run_id: str, owner: str) -> RunRecord:
    record = _runs.get(run_id)
    if record is None or record.owner != owner:
        # Same answer for "does not exist" and "belongs to someone else": the
        # difference is itself information about other researchers' runs.
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="runが見つかりません。")
    return record


@router.post("/runs", status_code=status.HTTP_202_ACCEPTED, response_model=CreateRunResponse)
def create_run(
    payload: CreateRunRequest, authorization: Optional[str] = Header(default=None)
) -> CreateRunResponse:
    owner = _require_researcher(authorization)

    if payload.dataset_id not in ALLOWED_DATASET_IDS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"許可されていないdataset_idです。許可: {', '.join(ALLOWED_DATASET_IDS)}",
        )
    config_path = ALLOWED_CONFIGS.get(payload.config_id)
    if config_path is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"許可されていないconfig_idです。許可: {', '.join(sorted(ALLOWED_CONFIGS))}",
        )

    request_hash = _request_hash(payload)
    scoped_key = f"{owner}:{payload.idempotency_key}"

    with _lock:
        existing_id = _by_idempotency_key.get(scoped_key)
        if existing_id is not None:
            existing = _runs[existing_id]
            if existing.request_hash != request_hash:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="同じidempotency_keyで内容の違う要求が来ています。",
                )
            return CreateRunResponse(
                run_id=existing.run_id,
                state=existing.state,
                dataset_id=existing.dataset_id,
                config_id=existing.config_id,
            )

        run_id = f"run-{uuid.uuid4().hex[:16]}"
        record = RunRecord(
            run_id=run_id,
            owner=owner,
            dataset_id=payload.dataset_id,
            config_id=payload.config_id,
            idempotency_key=payload.idempotency_key,
            request_hash=request_hash,
        )
        _runs[run_id] = record
        _by_idempotency_key[scoped_key] = run_id

    _executor.submit(_execute, run_id, config_path)
    return CreateRunResponse(
        run_id=run_id, state="queued", dataset_id=payload.dataset_id, config_id=payload.config_id
    )


@router.get("/runs/{run_id}")
def get_run(run_id: str, authorization: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    owner = _require_researcher(authorization)
    record = _owned_run(run_id, owner)
    return {
        "run_id": record.run_id,
        "state": record.state,
        "dataset_id": record.dataset_id,
        "config_id": record.config_id,
        "created_at": record.created_at.isoformat(),
        "started_at": record.started_at.isoformat() if record.started_at else None,
        "finished_at": record.finished_at.isoformat() if record.finished_at else None,
        "artifact_versions": record.artifact_versions,
        "error": record.error,
    }


@router.get("/runs/{run_id}/report")
def get_report(run_id: str, authorization: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    owner = _require_researcher(authorization)
    record = _owned_run(run_id, owner)
    if record.state in ("queued", "running"):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"runはまだ完了していません（state={record.state}）。",
        )
    if record.report is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=record.error or "reportが生成されていません。",
        )
    return record.report


@router.get("/runs/{run_id}/explanations")
def get_explanations(
    run_id: str, authorization: Optional[str] = Header(default=None)
) -> Dict[str, Any]:
    owner = _require_researcher(authorization)
    record = _owned_run(run_id, owner)
    if record.state in ("queued", "running"):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"runはまだ完了していません（state={record.state}）。",
        )
    if record.explanations is None:
        # Explicitly "unsupported for this run" rather than an empty list, which
        # a UI would render as "no relationships found".
        return {
            "run_id": record.run_id,
            "status": "unsupported",
            "reason_ja": record.error or "このrunは説明バンドルを生成していません。",
            "explanations": [],
        }
    return {"run_id": record.run_id, "status": "ok", "explanations": record.explanations}


def reset_state_for_tests() -> None:
    """Clear the in-process registry. Used by tests, not by request handlers."""

    with _lock:
        _runs.clear()
        _by_idempotency_key.clear()
