"""Unit tests for the dependency-free longitudinal pattern miner."""

from datetime import date

from app.analytics.pattern_mining import (
    LEAD_LAG_LIFT_THRESHOLD,
    mine_feature_trends,
    mine_leading_indicators,
    mine_recurring_motifs,
    relation_motifs,
    summarize_patterns,
)


def _graph(deadline_to_anxiety: bool, protective: bool):
    nodes = [
        {"node_id": "deadline", "category": "Trigger", "label": "deadline pressure"},
        {"node_id": "anxiety", "category": "State", "label": "anxiety"},
    ]
    relations = []
    if deadline_to_anxiety:
        relations.append(
            {"source_node_id": "deadline", "target_node_id": "anxiety", "type": "escalates", "confidence": 0.8}
        )
    if protective:
        nodes.append({"node_id": "run", "category": "Protective", "label": "running"})
        relations.append(
            {"source_node_id": "run", "target_node_id": "anxiety", "type": "buffers", "confidence": 0.7}
        )
    return nodes, relations


def test_relation_motifs_keys_are_structural_and_stable():
    nodes, relations = _graph(deadline_to_anxiety=True, protective=False)
    motifs = relation_motifs(nodes, relations)
    assert len(motifs) == 1
    assert motifs[0]["key"] == "trigger:deadline pressure->escalates->state:anxiety"
    assert "escalates" in motifs[0]["label"]


def test_recurring_motifs_require_min_recurrence_and_track_days():
    days = [
        (date(2026, 6, 1), *_graph(True, True)),
        (date(2026, 6, 2), *_graph(True, False)),   # deadline->anxiety repeats
        (date(2026, 6, 3), *_graph(False, True)),   # only buffer motif here
    ]
    recurring = mine_recurring_motifs(days)
    keys = {item["pattern_key"]: item for item in recurring}
    escalate = keys["trigger:deadline pressure->escalates->state:anxiety"]
    assert escalate["recurrence_count"] == 2
    assert escalate["support_days"] == ["2026-06-01", "2026-06-02"]
    assert escalate["first_seen"] == "2026-06-01"
    assert escalate["last_seen"] == "2026-06-02"
    # A motif seen on only one day is dropped at the default threshold.
    assert all(item["recurrence_count"] >= 2 for item in recurring)


def test_leading_indicator_detects_protective_decline_before_spike():
    # Protective resource toggles on/off, so a "decline vs previous day" lands on
    # 6/2 and 6/4. The day *after* each decline (6/3, 6/5) carries a high anomaly.
    days = [
        (date(2026, 6, 1), *_graph(True, True)),
        (date(2026, 6, 2), *_graph(True, False)),   # decline vs 6/1
        (date(2026, 6, 3), *_graph(True, True)),
        (date(2026, 6, 4), *_graph(True, False)),   # decline vs 6/3
        (date(2026, 6, 5), *_graph(True, True)),
    ]
    anomaly = {
        date(2026, 6, 1): 1.0,
        date(2026, 6, 2): 1.0,
        date(2026, 6, 3): 8.0,   # consequent of the 6/2 decline
        date(2026, 6, 4): 1.0,
        date(2026, 6, 5): 8.0,   # consequent of the 6/4 decline
    }
    leading = mine_leading_indicators(days, anomaly)
    decline = [item for item in leading if item["detail"].get("is_protective_decline")]
    assert decline, "protective decline should be flagged as a leading indicator"
    assert decline[0]["lift"] >= LEAD_LAG_LIFT_THRESHOLD
    assert decline[0]["recurrence_count"] >= 2
    assert decline[0]["detail"]["next_day_mean_anomaly"] > decline[0]["detail"]["baseline_next_day_mean_anomaly"]


def test_feature_trends_flag_protective_decline_as_risk():
    feature_json = {
        "window_days": 30,
        "n_days_observed": 12,
        "trend": {"protective_ratio": -0.2, "isolation_signal": 0.15, "event_count": 0.01},
        "volatility": {"protective_ratio": 0.05},
        "mean": {"protective_ratio": 0.4},
    }
    trends = mine_feature_trends(feature_json)
    by_feature = {item["detail"]["feature"]: item for item in trends}
    # Sub-threshold trend (event_count 0.01) is excluded.
    assert "event_count" not in by_feature
    assert by_feature["protective_ratio"]["detail"]["flagged_as_risk"] is True
    assert by_feature["isolation_signal"]["detail"]["flagged_as_risk"] is True


def test_summarize_patterns_builds_headline():
    recurring = mine_recurring_motifs(
        [
            (date(2026, 6, 1), *_graph(True, False)),
            (date(2026, 6, 2), *_graph(True, False)),
        ]
    )
    summary = summarize_patterns(recurring, [], [])
    assert summary["recurring_motif_count"] == 1
    assert "top recurring pattern" in summary["headline"]
