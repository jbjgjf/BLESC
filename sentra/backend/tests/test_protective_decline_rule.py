"""`protective_decline` must not fire on a day with nothing to measure (#310).

`aggregate_daily_features` computes

    protective_ratio = protective_count / max(1, state + trigger + behavior)

so a day with no risk nodes reports 0 — the same number a day full of risk and
no support reports. `RuleEngine.check_rules` read the two alike and fired a
protective decline on the first, which is what `get_fallback_extraction()`
returns on every repaired response: an empty graph. Both implementations default
a *missing* `protective_ratio` to 1.0 for exactly this reason, but the key is
always present, so that default was unreachable.

The frontend half is `checkRules` in `sentra/frontend/src/lib/baseline.ts`,
covered by `tests/baseline.test.mjs`. The two must stay in agreement.
"""

from datetime import date

from app.analytics.aggregation import aggregate_daily_features
from app.analytics.explanation_gen import RuleEngine
from app.schemas.extraction import Extraction


def _features(nodes):
    aggregation = aggregate_daily_features(
        "user-1", date(2026, 10, 1), [Extraction(nodes_json=nodes, relations_json=[])]
    )
    return aggregation.feature_vector_json


def _rules(feature_vector, graph_diff=None):
    hits = RuleEngine().check_rules(feature_vector, {}, {"event_count": 0}, graph_diff or {})
    return [hit.rule for hit in hits]


class TestNothingToMeasure:
    def test_an_empty_graph_reports_no_rules(self):
        features = _features([])
        assert features["protective_ratio"] == 0, "the ratio is still reported as 0"
        assert _rules(features) == []

    def test_a_day_of_event_nodes_alone_reports_no_rules(self):
        features = _features([
            {"id": "a", "category": "Event", "label": "文化祭", "intensity": 0.5},
            {"id": "b", "category": "Event", "label": "部活の試合", "intensity": 0.5},
        ])
        assert features["protective_ratio"] == 0
        assert _rules(features) == []

    def test_an_empty_graph_after_a_supported_day_reports_no_drop(self):
        # The fallback graph is empty; yesterday's real one had support. The
        # difference is the extraction failing, not the entry.
        features = _features([])
        diff = {"protective_decline": {"drop_in_protective_nodes": 2}}
        assert _rules(features, diff) == []


class TestTheMeasurementItExistsFor:
    def test_risk_without_support_still_reports_a_decline(self):
        features = _features([
            {"id": "a", "category": "State", "label": "眠れない", "intensity": 0.6},
            {"id": "b", "category": "Trigger", "label": "テスト", "intensity": 0.6},
        ])
        assert features["protective_ratio"] == 0
        assert _rules(features) == ["protective_decline"]

    def test_a_drop_reports_a_decline_even_with_a_healthy_ratio(self):
        features = _features([
            {"id": "a", "category": "State", "label": "眠れない", "intensity": 0.6},
            {"id": "b", "category": "Protective", "label": "友達と話した", "intensity": 0.6},
        ])
        assert features["protective_ratio"] > 0.2
        diff = {"protective_decline": {"drop_in_protective_nodes": 2}}
        assert _rules(features, diff) == ["protective_decline"]
