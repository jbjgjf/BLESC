"""
Longitudinal pattern mining.

The daily pipeline already produces per-day graphs (``GraphSnapshot``),
per-day anomaly scores (``AnomalyResult``), and per-window descriptive
statistics (``LongitudinalFeature``).  Those answer "what happened today" and
"how noisy is this window", but they do not *learn* the patterns that repeat
across a participant's history.

This module is the learning layer.  Given a participant's day-ordered graphs
plus their anomaly scores, it mines three kinds of pattern:

1. ``recurring_motif`` -- a relation motif (e.g. ``Trigger:deadline ->
   escalates -> State:anxiety``) that shows up on multiple days.  This is what
   makes Graph RAG answer "this pattern has happened before, here are the
   dates" instead of just "here is one similar day".
2. ``leading_indicator`` -- a motif or a protective-resource decline whose
   presence on one day is followed by an elevated anomaly score on the next
   observed day.  We quantify this with a simple lift ratio so the product can
   surface "when this happens, the next day tends to be harder".
3. ``feature_trend`` -- a longitudinal feature whose window trend is large
   enough to be worth narrating (e.g. protective ratio declining over 30 days).

Everything here is intentionally dependency-free and deterministic: no numpy,
no sklearn, no model weights.  It takes plain dicts/lists and returns plain
dicts, so it is trivial to unit test and safe to run inside the request path.
"""

from __future__ import annotations

import re
from datetime import date
from typing import Any, Dict, List, Optional, Sequence, Tuple

# ── thresholds ───────────────────────────────────────────────────────────────
# Kept as module constants so tests and docs can reference the exact values.
MIN_MOTIF_RECURRENCE = 2          # a motif must appear on >= N days to "recur"
MIN_LEAD_LAG_OCCURRENCES = 2      # an antecedent must occur >= N times to score lift
LEAD_LAG_LIFT_THRESHOLD = 1.2     # next-day score must be >= 1.2x the baseline
FEATURE_TREND_THRESHOLD = 0.08    # |window trend| must clear this to be narrated
PATTERN_MINING_VERSION = "sentra-pattern-mining-v1"

# Feature-trend narration: feature name -> (rising_phrase, falling_phrase).
# "rising" means the value increased across the window.
_FEATURE_NARRATION: Dict[str, Tuple[str, str]] = {
    "protective_ratio": ("protective resources strengthening", "protective resources declining"),
    "protective_count": ("more protective factors appearing", "fewer protective factors appearing"),
    "protective_buffer_ratio": ("more buffering relations", "fewer buffering relations"),
    "isolation_signal": ("isolation rising", "isolation easing"),
    "trigger_count": ("more triggers surfacing", "fewer triggers surfacing"),
    "state_count": ("more internal states named", "fewer internal states named"),
    "behavior_count": ("more behaviors logged", "fewer behaviors logged"),
    "relation_density": ("graph becoming denser", "graph becoming sparser"),
}
# Features where a *rising* trend is the concerning direction (used to flag risk).
_RISK_WHEN_RISING = {"isolation_signal", "trigger_count", "state_count", "behavior_count"}
_RISK_WHEN_FALLING = {"protective_ratio", "protective_count", "protective_buffer_ratio"}


# ── normalization helpers ─────────────────────────────────────────────────────
def _normalize(value: Any) -> str:
    text = str(value or "").lower()
    text = re.sub(r"[^a-z0-9_\-\sぁ-んァ-ン一-龥]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def _node_id(node: Dict[str, Any]) -> str:
    return str(node.get("node_id") or node.get("id") or node.get("label") or "")


def _node_label(node: Dict[str, Any]) -> str:
    return str(node.get("label") or _node_id(node))


def _node_category(node: Dict[str, Any]) -> str:
    return str(node.get("category") or "Unknown")


def _relation_source(relation: Dict[str, Any]) -> str:
    return str(relation.get("source_node_id") or relation.get("source_id") or "")


def _relation_target(relation: Dict[str, Any]) -> str:
    return str(relation.get("target_node_id") or relation.get("target_id") or "")


def _as_date(value: Any) -> Optional[date]:
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        try:
            return date.fromisoformat(value[:10])
        except ValueError:
            return None
    return None


def relation_motifs(nodes: Sequence[Dict[str, Any]], relations: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Turn one day's graph into a list of structural motifs.

    A motif is keyed on category+label of both endpoints plus the relation
    type, so ``deadline -> escalates -> anxiety`` recurs even when the exact
    node ids differ from day to day.  The human-readable ``label`` keeps the
    original casing for display.
    """
    nodes_by_id = {_node_id(node): node for node in nodes}
    motifs: List[Dict[str, Any]] = []
    seen: set[str] = set()
    for relation in relations:
        source = nodes_by_id.get(_relation_source(relation), {})
        target = nodes_by_id.get(_relation_target(relation), {})
        source_label = _node_label(source) if source else _relation_source(relation)
        target_label = _node_label(target) if target else _relation_target(relation)
        source_cat = _node_category(source) if source else "Unknown"
        target_cat = _node_category(target) if target else "Unknown"
        rel_type = str(relation.get("type") or "co_occurs")
        key = (
            f"{_normalize(source_cat)}:{_normalize(source_label)}"
            f"->{_normalize(rel_type)}->"
            f"{_normalize(target_cat)}:{_normalize(target_label)}"
        )
        if not key or key in seen:
            continue
        seen.add(key)
        motifs.append(
            {
                "key": key,
                "label": f"{source_label} —{rel_type}→ {target_label}",
                "source_category": source_cat,
                "target_category": target_cat,
                "relation_type": rel_type,
                "confidence": float(relation.get("confidence") or 0.0),
            }
        )
    return motifs


def _protective_count(nodes: Sequence[Dict[str, Any]]) -> int:
    return sum(1 for node in nodes if _node_category(node) == "Protective")


# ── mining: recurring motifs ──────────────────────────────────────────────────
def mine_recurring_motifs(
    daily_graphs: Sequence[Tuple[Any, Sequence[Dict[str, Any]], Sequence[Dict[str, Any]]]],
    min_recurrence: int = MIN_MOTIF_RECURRENCE,
) -> List[Dict[str, Any]]:
    """
    ``daily_graphs`` is an iterable of ``(day, nodes, relations)`` tuples.

    Returns one record per motif that appears on ``min_recurrence`` or more
    distinct days, sorted by recurrence then recency.
    """
    by_key: Dict[str, Dict[str, Any]] = {}
    for raw_day, nodes, relations in daily_graphs:
        day = _as_date(raw_day)
        day_iso = day.isoformat() if day else None
        for motif in relation_motifs(nodes, relations):
            record = by_key.setdefault(
                motif["key"],
                {
                    "pattern_key": motif["key"],
                    "label": motif["label"],
                    "relation_type": motif["relation_type"],
                    "source_category": motif["source_category"],
                    "target_category": motif["target_category"],
                    "support_days": [],
                    "_confidences": [],
                },
            )
            if day_iso and day_iso not in record["support_days"]:
                record["support_days"].append(day_iso)
            record["_confidences"].append(motif["confidence"])

    results: List[Dict[str, Any]] = []
    for record in by_key.values():
        support_days = sorted(d for d in record["support_days"] if d)
        recurrence = len(support_days)
        if recurrence < min_recurrence:
            continue
        confidences = record.pop("_confidences")
        mean_conf = round(sum(confidences) / len(confidences), 4) if confidences else 0.0
        results.append(
            {
                "pattern_kind": "recurring_motif",
                "pattern_key": record["pattern_key"],
                "label": record["label"],
                "recurrence_count": recurrence,
                "support_days": support_days,
                "first_seen": support_days[0] if support_days else None,
                "last_seen": support_days[-1] if support_days else None,
                "lift": 0.0,
                "mean_confidence": mean_conf,
                "detail": {
                    "relation_type": record["relation_type"],
                    "source_category": record["source_category"],
                    "target_category": record["target_category"],
                },
            }
        )
    results.sort(key=lambda item: (item["recurrence_count"], item["last_seen"] or ""), reverse=True)
    return results


# ── mining: leading indicators ────────────────────────────────────────────────
def mine_leading_indicators(
    daily_graphs: Sequence[Tuple[Any, Sequence[Dict[str, Any]], Sequence[Dict[str, Any]]]],
    anomaly_by_day: Dict[Any, float],
    min_occurrences: int = MIN_LEAD_LAG_OCCURRENCES,
    lift_threshold: float = LEAD_LAG_LIFT_THRESHOLD,
) -> List[Dict[str, Any]]:
    """
    Detect antecedents whose presence on day *d* is followed by an elevated
    anomaly score on the next observed day *d+1*.

    We build (antecedent_day -> consequent_score) pairs from consecutive
    observed days, then for each candidate antecedent compute::

        lift = mean(consequent score | antecedent present) / mean(consequent score)

    Antecedents are motifs plus a synthetic ``protective_decline`` signal (a day
    whose protective-node count dropped versus the prior observed day).
    """
    # Order days and resolve a clean date -> score map.
    scores: Dict[date, float] = {}
    for raw_day, score in anomaly_by_day.items():
        day = _as_date(raw_day)
        if day is not None:
            scores[day] = float(score)

    ordered: List[Tuple[date, Sequence[Dict[str, Any]], Sequence[Dict[str, Any]]]] = []
    for raw_day, nodes, relations in daily_graphs:
        day = _as_date(raw_day)
        if day is not None:
            ordered.append((day, nodes, relations))
    ordered.sort(key=lambda item: item[0])
    if len(ordered) < min_occurrences + 1:
        return []

    # Build antecedent sets per day and the consequent score (next observed day).
    antecedents_by_day: Dict[date, Dict[str, str]] = {}
    prev_protective: Optional[int] = None
    for day, nodes, relations in ordered:
        labels: Dict[str, str] = {}
        for motif in relation_motifs(nodes, relations):
            labels[motif["key"]] = motif["label"]
        protective = _protective_count(nodes)
        if prev_protective is not None and protective < prev_protective:
            labels["__protective_decline__"] = "protective resources dropped vs. previous day"
        prev_protective = protective
        antecedents_by_day[day] = labels

    pairs: List[Tuple[Dict[str, str], float]] = []
    for index in range(len(ordered) - 1):
        antecedent_day = ordered[index][0]
        consequent_day = ordered[index + 1][0]
        if consequent_day not in scores:
            continue
        pairs.append((antecedents_by_day.get(antecedent_day, {}), scores[consequent_day]))

    if not pairs:
        return []
    overall_mean = sum(score for _, score in pairs) / len(pairs)
    if overall_mean <= 0:
        return []

    # Aggregate consequent scores per candidate antecedent key.
    agg: Dict[str, Dict[str, Any]] = {}
    for labels, consequent_score in pairs:
        for key, label in labels.items():
            bucket = agg.setdefault(key, {"label": label, "scores": []})
            bucket["scores"].append(consequent_score)

    results: List[Dict[str, Any]] = []
    for key, bucket in agg.items():
        observed = bucket["scores"]
        if len(observed) < min_occurrences:
            continue
        present_mean = sum(observed) / len(observed)
        lift = present_mean / overall_mean
        if lift < lift_threshold:
            continue
        results.append(
            {
                "pattern_kind": "leading_indicator",
                "pattern_key": key,
                "label": bucket["label"],
                "recurrence_count": len(observed),
                "support_days": [],
                "first_seen": None,
                "last_seen": None,
                "lift": round(lift, 3),
                "mean_confidence": 0.0,
                "detail": {
                    "next_day_mean_anomaly": round(present_mean, 3),
                    "baseline_next_day_mean_anomaly": round(overall_mean, 3),
                    "is_protective_decline": key == "__protective_decline__",
                },
            }
        )
    results.sort(key=lambda item: (item["lift"], item["recurrence_count"]), reverse=True)
    return results


# ── mining: feature trends ────────────────────────────────────────────────────
def mine_feature_trends(
    feature_json: Optional[Dict[str, Any]],
    trend_threshold: float = FEATURE_TREND_THRESHOLD,
) -> List[Dict[str, Any]]:
    """
    Turn a ``LongitudinalFeature.feature_json`` window into narratable signals.

    Only features in ``_FEATURE_NARRATION`` with |trend| >= ``trend_threshold``
    are emitted, sorted by absolute trend magnitude.
    """
    if not feature_json:
        return []
    trends = feature_json.get("trend") or {}
    volatility = feature_json.get("volatility") or {}
    means = feature_json.get("mean") or {}
    window_days = feature_json.get("window_days")
    n_days = feature_json.get("n_days_observed")

    results: List[Dict[str, Any]] = []
    for name, (rising_phrase, falling_phrase) in _FEATURE_NARRATION.items():
        trend = float(trends.get(name) or 0.0)
        if abs(trend) < trend_threshold:
            continue
        rising = trend > 0
        phrase = rising_phrase if rising else falling_phrase
        is_risk = (rising and name in _RISK_WHEN_RISING) or (not rising and name in _RISK_WHEN_FALLING)
        results.append(
            {
                "pattern_kind": "feature_trend",
                "pattern_key": f"trend:{name}:{'up' if rising else 'down'}",
                "label": f"{phrase} over {window_days or '?'} days",
                "recurrence_count": int(n_days or 0),
                "support_days": [],
                "first_seen": None,
                "last_seen": None,
                "lift": 0.0,
                "mean_confidence": round(float(means.get(name) or 0.0), 4),
                "detail": {
                    "feature": name,
                    "trend": round(trend, 4),
                    "volatility": round(float(volatility.get(name) or 0.0), 4),
                    "direction": "rising" if rising else "falling",
                    "flagged_as_risk": is_risk,
                },
            }
        )
    results.sort(key=lambda item: abs(item["detail"]["trend"]), reverse=True)
    return results


def summarize_patterns(
    recurring: Sequence[Dict[str, Any]],
    leading: Sequence[Dict[str, Any]],
    trends: Sequence[Dict[str, Any]],
) -> Dict[str, Any]:
    """Build a compact, human-readable headline payload over the mined sets."""
    headline_bits: List[str] = []
    if recurring:
        top = recurring[0]
        headline_bits.append(f"top recurring pattern '{top['label']}' x{top['recurrence_count']}")
    if leading:
        top = leading[0]
        headline_bits.append(f"leading indicator '{top['label']}' (lift {top['lift']})")
    flagged_trends = [trend for trend in trends if trend["detail"].get("flagged_as_risk")]
    if flagged_trends:
        headline_bits.append(flagged_trends[0]["label"])

    return {
        "pattern_mining_version": PATTERN_MINING_VERSION,
        "recurring_motif_count": len(recurring),
        "leading_indicator_count": len(leading),
        "feature_trend_count": len(trends),
        "flagged_trend_count": len(flagged_trends),
        "headline": "; ".join(headline_bits) if headline_bits else "no recurring patterns yet",
    }
