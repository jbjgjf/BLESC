"""T0b (#140): the CLI, the research API and the fresh-checkout acceptance condition.

The Day 3 acceptance condition is that "the documented command works on a fresh
checkout with no key, generating, training, saving, reloading, predicting,
explaining and scoring". `test_the_documented_command_runs_end_to_end` is that
sentence, executed as a subprocess so it tests the entry point rather than the
functions behind it.

The API tests are about refusals as much as results: an unauthenticated call, a
deployment with no credential configured, another researcher's run, a report
asked for while the run is still training, and the same idempotency key with a
different body.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[2]


def _run_cli(args, env=None):
    environment = dict(os.environ)
    environment.setdefault("PYTHONDONTWRITEBYTECODE", "1")
    environment.update(env or {})
    return subprocess.run(
        [sys.executable, "-m", "research_engine.cli", *args],
        cwd=BACKEND,
        capture_output=True,
        text=True,
        env=environment,
        timeout=900,
    )


@pytest.fixture(scope="module")
def cli_run(tmp_path_factory):
    out = tmp_path_factory.mktemp("cli")
    result = _run_cli(
        ["smoke", "--config", "research_engine/configs/ci.json", "--out", str(out)]
    )
    return result, out


def test_the_documented_command_runs_end_to_end(cli_run):
    result, out = cli_run
    assert result.returncode == 0, result.stderr
    assert "status: ok" in result.stdout
    assert "== 漏洩・健全性の検査 ==" in result.stdout
    assert (out / "report.json").exists()
    assert (out / "predictions.jsonl").exists()
    assert (out / "explanations.json").exists()
    assert (out / "encoder" / "weights.npz").exists()


def test_the_run_needed_no_provider_call(cli_run):
    """The measured evidence that the path needs no key and no network."""

    result, out = cli_run
    report = json.loads((out / "report.json").read_text(encoding="utf-8"))
    assert report["measured_usage"]["provider_calls"] == 0
    assert report["measured_usage"]["input_tokens"] == 0


def test_evaluate_re_reads_a_finished_run(cli_run):
    _, out = cli_run
    result = _run_cli(["evaluate", "--run", str(out)])
    assert result.returncode == 0, result.stderr
    assert "run_id:" in result.stdout


def test_evaluate_refuses_a_split_it_does_not_score(cli_run):
    _, out = cli_run
    result = _run_cli(["evaluate", "--run", str(out), "--split", "train"])
    assert result.returncode == 2
    assert "heldout" in result.stderr


def test_evaluate_on_a_missing_run_fails_loudly(tmp_path):
    result = _run_cli(["evaluate", "--run", str(tmp_path / "nothing")])
    assert result.returncode == 2
    assert "report" in result.stderr


# ---- the research API (C6) ------------------------------------------------

TOKEN = "test-research-token-0001"


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("USE_MOCK_LLM", "true")
    monkeypatch.setenv("RESEARCH_API_TOKEN", TOKEN)
    monkeypatch.setenv("RESEARCH_RUN_ROOT", str(tmp_path / "runs"))

    from fastapi.testclient import TestClient

    from app.api import research_world_model
    from app.main import app

    research_world_model.reset_state_for_tests()
    with TestClient(app) as test_client:
        yield test_client


def _authorized(client, path, method="get", **kwargs):
    headers = kwargs.pop("headers", {})
    headers["Authorization"] = f"Bearer {TOKEN}"
    return getattr(client, method)(path, headers=headers, **kwargs)


def _await_run(client, run_id, timeout_seconds=180):
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        state = _authorized(client, f"/api/research/world-model/runs/{run_id}").json()["state"]
        if state in ("succeeded", "failed"):
            return state
        time.sleep(0.25)
    pytest.fail("run did not finish in time")


def test_creating_a_run_returns_202_and_does_not_train_in_the_request(client):
    response = _authorized(
        client,
        "/api/research/world-model/runs",
        method="post",
        json={
            "dataset_id": "synthetic-dev-v0",
            "config_id": "research-ci-v0",
            "idempotency_key": "smoke-key-0001",
        },
    )
    assert response.status_code == 202
    body = response.json()
    assert body["state"] == "queued"
    assert body["run_id"].startswith("run-")


def test_the_report_is_409_until_the_run_finishes_then_200(client):
    created = _authorized(
        client,
        "/api/research/world-model/runs",
        method="post",
        json={
            "dataset_id": "synthetic-dev-v0",
            "config_id": "research-ci-v0",
            "idempotency_key": "smoke-key-0002",
        },
    ).json()
    run_id = created["run_id"]

    early = _authorized(client, f"/api/research/world-model/runs/{run_id}/report")
    assert early.status_code in (200, 409)

    assert _await_run(client, run_id) == "succeeded"

    report = _authorized(client, f"/api/research/world-model/runs/{run_id}/report")
    assert report.status_code == 200
    assert report.json()["report_version"] == "evaluation-report-v0"

    explanations = _authorized(client, f"/api/research/world-model/runs/{run_id}/explanations")
    assert explanations.status_code == 200
    assert explanations.json()["status"] == "ok"
    assert explanations.json()["explanations"]


def test_the_same_key_returns_the_same_run_and_a_different_body_conflicts(client):
    payload = {
        "dataset_id": "synthetic-dev-v0",
        "config_id": "research-ci-v0",
        "idempotency_key": "smoke-key-0003",
    }
    first = _authorized(client, "/api/research/world-model/runs", method="post", json=payload)
    again = _authorized(client, "/api/research/world-model/runs", method="post", json=payload)
    assert first.json()["run_id"] == again.json()["run_id"]

    changed = dict(payload, dataset_id="synthetic-scenarios-v0")
    conflict = _authorized(client, "/api/research/world-model/runs", method="post", json=changed)
    assert conflict.status_code == 409


def test_an_unauthenticated_request_is_refused(client):
    response = client.post(
        "/api/research/world-model/runs",
        json={
            "dataset_id": "synthetic-dev-v0",
            "config_id": "research-ci-v0",
            "idempotency_key": "smoke-key-0004",
        },
    )
    assert response.status_code == 401


def test_a_wrong_credential_is_refused(client):
    response = client.post(
        "/api/research/world-model/runs",
        headers={"Authorization": "Bearer not-the-token"},
        json={
            "dataset_id": "synthetic-dev-v0",
            "config_id": "research-ci-v0",
            "idempotency_key": "smoke-key-0005",
        },
    )
    assert response.status_code == 403


def test_without_a_configured_credential_the_api_fails_closed(client, monkeypatch):
    """A deployment that forgot the variable must not serve an open training endpoint."""

    monkeypatch.delenv("RESEARCH_API_TOKEN", raising=False)
    response = client.post(
        "/api/research/world-model/runs",
        headers={"Authorization": f"Bearer {TOKEN}"},
        json={
            "dataset_id": "synthetic-dev-v0",
            "config_id": "research-ci-v0",
            "idempotency_key": "smoke-key-0006",
        },
    )
    assert response.status_code == 503


def test_an_unlisted_dataset_or_config_is_refused(client):
    for payload in (
        {
            "dataset_id": "participant-pilot-2026",
            "config_id": "research-ci-v0",
            "idempotency_key": "smoke-key-0007",
        },
        {
            "dataset_id": "synthetic-dev-v0",
            "config_id": "whatever-i-like",
            "idempotency_key": "smoke-key-0008",
        },
    ):
        response = _authorized(
            client, "/api/research/world-model/runs", method="post", json=payload
        )
        assert response.status_code == 400


def test_an_unknown_run_is_404_not_a_hint(client):
    response = _authorized(client, "/api/research/world-model/runs/run-does-not-exist")
    assert response.status_code == 404


def test_no_endpoint_returns_model_weights(client):
    created = _authorized(
        client,
        "/api/research/world-model/runs",
        method="post",
        json={
            "dataset_id": "synthetic-dev-v0",
            "config_id": "research-ci-v0",
            "idempotency_key": "smoke-key-0009",
        },
    ).json()
    _await_run(client, created["run_id"])

    for path in ("", "/report", "/explanations"):
        body = _authorized(
            client, f"/api/research/world-model/runs/{created['run_id']}{path}"
        ).text
        assert "W_out" not in body
        assert "weights" not in body.lower() or "weights_hash" in body
