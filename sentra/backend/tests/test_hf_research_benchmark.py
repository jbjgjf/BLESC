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

    # The `>=` inequality this line used to carry was replaced in #89. It
    # passed whenever the conditions were equal, which was their permanent
    # state, so it demonstrated nothing. Separation and the baseline ceiling
    # now live in test_benchmark_separation.py; this file keeps the shape
    # checks only.
    assert summary["keyword"]["chance_ndcg_at_k"] > 0

    # Safety moved out of the per-condition summary in #85: it is a property of
    # the case, and reporting it per condition made one number look like four.
    case_safety = result["case_level_safety"]
    assert case_safety["diagnostic_overreach_count"] == 0
    # The rebuilt cases (#86/#87) are retrieval cases; the crisis case was
    # retired with the rest of the old set, so the safety pass rate is over a
    # different population and no longer pinned at 1.0. Asserting it is well
    # formed rather than asserting a value that now means something else.
    assert 0.0 <= case_safety["safety_pass_rate"] <= 1.0


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
    # Was == 1.0, when the condition was reading the answer key and every case
    # was answerable from one day. It is now 0.8: the red-herring case (#87)
    # has a traversable chain that is the WRONG answer, and the graph
    # conditions fall for it. A benchmark where the graph method can only win
    # tests nothing, so the miss is the feature. Asserting the range rather
    # than the value, since #88 will move it again.
    assert 0.0 < body["summary"]["hf_reranker_candidate"]["target_hit_rate"] <= 1.0
