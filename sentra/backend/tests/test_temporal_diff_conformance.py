"""The backend half of the shared temporal-diff contract (#106).

Two implementations of one contract is what produced the defect: the backend
computed a real day-over-day diff while the Next.js production path wrote a
fixed placeholder claiming everything was new, every day. Nothing compared them.

Both are now pinned to `sentra/shared/temporal_diff_conformance.json`. If either
side changes its semantics, one of the two suites goes red instead of the two
silently disagreeing in the database.
"""

import json
from pathlib import Path

import pytest

from app.analytics.graph_features import build_temporal_graph_diff

CONTRACT_PATH = Path(__file__).resolve().parents[2] / "shared" / "temporal_diff_conformance.json"


def _relation_key(relation: dict) -> str:
    return f"{relation.get('source_id')}|{relation.get('target_id')}|{relation.get('type')}"


@pytest.fixture(scope="module")
def contract() -> dict:
    assert CONTRACT_PATH.exists(), f"shared contract missing at {CONTRACT_PATH}"
    return json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))


def test_contract_is_the_shared_file(contract):
    assert contract["contract"] == "temporal_diff"
    assert len(contract["cases"]) >= 8


def test_every_case(contract):
    """Ordering is deliberately not asserted.

    A JS Map and a Python dict comprehension emit these in different orders and
    the difference carries no meaning. Pinning it would make the contract fail
    for a reason nobody cares about, which is how contracts get deleted.
    """
    failures = []
    for case in contract["cases"]:
        diff = build_temporal_graph_diff(
            case["current"]["nodes"],
            case["current"]["relations"],
            case["previous"]["nodes"],
            case["previous"]["relations"],
        )
        expected = case["expected"]
        actual = {
            "added_node_ids": sorted(node["id"] for node in diff["added_nodes"]),
            "removed_node_ids": sorted(node["id"] for node in diff["removed_nodes"]),
            "added_relation_keys": sorted(_relation_key(r) for r in diff["added_relations"]),
            "removed_relation_keys": sorted(_relation_key(r) for r in diff["removed_relations"]),
            "changed_relation_keys": sorted(_relation_key(r) for r in diff["changed_relations"]),
        }
        for key, want in expected.items():
            if actual[key] != sorted(want):
                failures.append(f"{case['name']}.{key}: expected {sorted(want)}, got {actual[key]}")

    assert not failures, "backend diverges from the shared contract:\n  " + "\n  ".join(failures)


def test_an_unchanged_day_adds_nothing(contract):
    """The defect in one assertion, on the backend side.

    Production wrote `added_relations: extraction.relations` unconditionally.
    This is what it should have produced.
    """
    case = next(c for c in contract["cases"] if c["name"] == "recurrence_nothing_changes")
    diff = build_temporal_graph_diff(
        case["current"]["nodes"],
        case["current"]["relations"],
        case["previous"]["nodes"],
        case["previous"]["relations"],
    )
    assert diff["added_relations"] == []
    assert diff["added_nodes"] == []


def test_japanese_and_english_cases_both_present(contract):
    """A contract that only exercised English would not have caught the
    extraction defect this work started from."""
    names = {case["name"] for case in contract["cases"]}
    assert "english_pair_behaves_identically" in names
    japanese = [
        case for case in contract["cases"]
        if any("぀" <= ch <= "ヿ" or "一" <= ch <= "鿿"
               for node in case["current"]["nodes"] for ch in str(node.get("id", "")))
    ]
    assert len(japanese) >= 4
