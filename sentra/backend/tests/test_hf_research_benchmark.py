import os

os.environ["USE_MOCK_LLM"] = "true"
os.environ["DATABASE_URL"] = "sqlite:///./test_research_pipeline.db"

from fastapi.testclient import TestClient

from app.main import app
from app.services.hf_research_benchmark import (
    HF_REFERENCE_ARTIFACTS,
    hf_dataset_rows,
    run_hf_research_benchmark,
)


def test_hf_research_benchmark_has_reproducible_ablation_summary():
    result = run_hf_research_benchmark()

    assert result["status"] == "completed"
    assert result["privacy_boundary"]["contains_real_user_content"] is False
    assert result["privacy_boundary"]["safe_for_hf_dataset_draft"] is True
    assert "BAAI/bge-reranker-v2-m3" in str(HF_REFERENCE_ARTIFACTS)

    summary = result["summary"]
    assert set(summary.keys()) == {"keyword", "semantic_proxy", "graph_pattern", "hf_reranker_candidate"}
    assert summary["hf_reranker_candidate"]["mean_recall_at_k"] >= summary["keyword"]["mean_recall_at_k"]
    assert summary["hf_reranker_candidate"]["diagnostic_overreach_count"] == 0
    assert summary["hf_reranker_candidate"]["safety_pass_rate"] == 1.0


def test_hf_dataset_rows_are_synthetic_and_exportable():
    rows = hf_dataset_rows()

    assert rows
    assert all(row["privacy_class"] == "synthetic_non_user_data" for row in rows)
    assert all(row["source"] == "synthetic_blesc_isef_seed" for row in rows)
    assert all("expected_evidence_ids" in row for row in rows)


def test_hf_benchmark_endpoint_can_include_dataset_rows():
    with TestClient(app) as client:
        response = client.post("/api/research/hf-benchmark", json={"include_dataset_rows": True})

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "completed"
    assert body["hf_dataset_rows"]
    assert body["summary"]["hf_reranker_candidate"]["target_hit_rate"] == 1.0
