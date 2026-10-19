"""Score the crisis detectors against the synthetic Japanese corpus.

`sentra/shared/safety_corpus/corpus.json` holds short synthetic texts, each with
the verdict a reader would expect (`crisis` / `caution` / `none`). This module
runs them through the detectors the backend actually uses and reports, per
category, how many were caught and how many harmless texts were flagged.

It is a ruler, not a gate on progress. The lexicons are being fixed elsewhere
(#388, #392), and a test built on this module must never be what stops that fix
from merging. So the comparison is against a recorded baseline
(`baseline.json`), and only two kinds of change are failures:

- **a regression** — an item the detector caught at the baseline is no longer
  caught, or an expected-crisis item it graded `crisis` is graded lower. The
  second is a loss of `escalation_required`, which is what pages an adult.
- **more false positives** — a harmless item that was not flagged now is, or a
  recorded false positive is now flagged more severely.

Everything else is a *notice*: a known gap that is now caught, a recorded false
positive that is now clean. A fix landing must read as good news that asks for
the baseline to be tidied, never as a red build.

The detectors are imported and called; nothing here edits a lexicon, a
threshold or a rule. Expected verdicts are a model's draft (`reviewed: false`
on every item) until a human reviewer has been through them, which is why no
number from here may be quoted as coverage.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence

CORPUS_DIR = Path(__file__).resolve().parents[3] / "shared" / "safety_corpus"
CORPUS_PATH = CORPUS_DIR / "corpus.json"
BASELINE_PATH = CORPUS_DIR / "baseline.json"

VERDICTS = ("none", "caution", "crisis")
POSITIVE = frozenset({"caution", "crisis"})
#: Graded detectors return one of VERDICTS. An ungraded detector says only
#: whether it fired, which is recorded as this.
FLAGGED = "flagged"

#: `assess_safety` grades in four steps; the corpus in three. `low` is distress
#: with no danger signal and drives no intervention, so it is not a flag.
RISK_TO_VERDICT = {"none": "none", "low": "none", "elevated": "caution", "crisis": "crisis"}

#: Where a gap or a false positive is tracked. "unfiled" means no issue covers
#: it yet; the README says how to replace it with a number once one exists.
# "#290": 「今日」 stopped being an imminence term (option A), which deliberately
# moved kc-010 from crisis to caution in both assess_safety implementations.
TRACKING_REFS = frozenset({"#388", "#392", "#374", "#290", "unfiled"})

REQUIRED_ITEM_FIELDS = ("id", "text", "category", "topic", "expected", "rationale", "author", "reviewed")


def _level(verdict: str) -> int:
    return 1 if verdict == FLAGGED else VERDICTS.index(verdict)


def is_flagged(verdict: str) -> bool:
    return verdict != "none"


# ── detectors ────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Detector:
    name: str
    source: str
    graded: bool
    run: Callable[[str], str]


def _assess_safety(text: str) -> str:
    # Imported here, not at module level: the evaluator must stay importable
    # (to validate the corpus, to compare a recorded observation) even when the
    # thing being measured is mid-rewrite.
    from app.models.safety import SafetyAssessmentInput
    from app.services.safety import assess_safety

    result = assess_safety(SafetyAssessmentInput(reflection_id="safety-corpus", content=text))
    return RISK_TO_VERDICT[result.risk_level]


def _has_crisis_language(text: str) -> str:
    from app.analytics.memory_objects import has_crisis_language

    return FLAGGED if has_crisis_language(text) else "none"


BACKEND_DETECTORS: Dict[str, Detector] = {
    detector.name: detector
    for detector in (
        Detector(
            name="backend.assess_safety",
            source="sentra/backend/app/services/safety.py",
            graded=True,
            run=_assess_safety,
        ),
        Detector(
            # Not a safety gate: it raises a memory object's importance score.
            # Measured because a crisis it misses is ranked as unimportant (#392).
            name="backend.has_crisis_language",
            source="sentra/backend/app/analytics/memory_objects.py",
            graded=False,
            run=_has_crisis_language,
        ),
    )
}


# ── loading and validation ───────────────────────────────────────────────────


def load_json(path: Path) -> Dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def load_corpus(path: Path = CORPUS_PATH) -> Dict[str, Any]:
    return load_json(path)


def load_baseline(path: Path = BASELINE_PATH) -> Dict[str, Any]:
    return load_json(path)


def validate_corpus(corpus: Mapping[str, Any]) -> List[str]:
    """Problems that would make a number from this corpus mean something else."""
    errors: List[str] = []
    if corpus.get("synthetic") is not True:
        errors.append("corpus must declare synthetic: true")
    categories = corpus.get("categories", {})
    topics = corpus.get("topics", {})
    seen: set = set()
    texts: Dict[str, str] = {}
    for item in corpus.get("items", []):
        item_id = item.get("id", "<no id>")
        for name in REQUIRED_ITEM_FIELDS:
            if name not in item:
                errors.append(f"{item_id}: missing {name}")
        if item_id in seen:
            errors.append(f"{item_id}: duplicate id")
        seen.add(item_id)
        if item.get("category") not in categories:
            errors.append(f"{item_id}: unknown category {item.get('category')!r}")
        if item.get("topic") not in topics:
            errors.append(f"{item_id}: unknown topic {item.get('topic')!r}")
        if item.get("expected") not in VERDICTS:
            errors.append(f"{item_id}: unknown expected verdict {item.get('expected')!r}")
        if (item.get("topic") == "none") != (item.get("expected") == "none"):
            errors.append(f"{item_id}: topic 'none' and expected 'none' must go together")
        if not isinstance(item.get("reviewed"), bool):
            errors.append(f"{item_id}: reviewed must be true or false")
        elif item["reviewed"] and not (item.get("reviewed_by") and item.get("reviewed_on")):
            # A role, not a name, is enough; what is not enough is a bare `true`
            # that nobody can trace.
            errors.append(f"{item_id}: reviewed: true needs reviewed_by and reviewed_on")
        text = item.get("text", "")
        if not str(text).strip():
            errors.append(f"{item_id}: empty text")
        elif text in texts:
            errors.append(f"{item_id}: same text as {texts[text]}")
        else:
            texts[text] = item_id
    return errors


def validate_baseline(corpus: Mapping[str, Any], baseline: Mapping[str, Any]) -> List[str]:
    """Every baseline entry must point at an item of the kind it describes."""
    items = {item["id"]: item for item in corpus["items"]}
    errors: List[str] = []
    for name, entry in baseline.get("detectors", {}).items():
        for key, expect in (
            ("known_gaps", POSITIVE),
            ("known_under_graded", frozenset({"crisis"})),
            ("known_false_positives", frozenset({"none"})),
        ):
            for item_id, record in entry.get(key, {}).items():
                item = items.get(item_id)
                if item is None:
                    errors.append(f"{name}.{key}: {item_id} is not in the corpus")
                    continue
                if item["expected"] not in expect:
                    errors.append(f"{name}.{key}: {item_id} is expected {item['expected']!r}")
                if record.get("issue") not in TRACKING_REFS:
                    errors.append(f"{name}.{key}: {item_id} has issue {record.get('issue')!r}")
        if not entry.get("graded", True) and entry.get("known_under_graded"):
            errors.append(f"{name}: an ungraded detector cannot under-grade")
        overlap = set(entry.get("known_gaps", {})) & set(entry.get("known_under_graded", {}))
        if overlap:
            errors.append(f"{name}: {sorted(overlap)} listed as both missed and under-graded")
    return errors


# ── measuring ────────────────────────────────────────────────────────────────


def observe(corpus: Mapping[str, Any], run: Callable[[str], str]) -> Dict[str, str]:
    return {item["id"]: run(item["text"]) for item in corpus["items"]}


def _rate(numerator: int, denominator: int) -> Optional[float]:
    # None, never 0.0, for an empty denominator: a category with no harmless
    # items has no false-positive rate, which is not the same as a perfect one.
    return round(numerator / denominator, 4) if denominator else None


def summarize(corpus: Mapping[str, Any], observations: Mapping[str, str], graded: bool) -> Dict[str, Any]:
    """Per-category detection and false-positive counts, plus the total."""
    rows: Dict[str, Dict[str, Any]] = {}
    order = list(corpus["categories"])
    for category in order + ["_total"]:
        rows[category] = {
            "positives": 0, "detected": 0,
            "crisis_expected": 0, "crisis_graded": 0,
            "negatives": 0, "false_positives": 0, "false_positive_crisis": 0,
        }
    for item in corpus["items"]:
        verdict = observations[item["id"]]
        for key in (item["category"], "_total"):
            row = rows[key]
            if item["expected"] in POSITIVE:
                row["positives"] += 1
                row["detected"] += is_flagged(verdict)
                if item["expected"] == "crisis":
                    row["crisis_expected"] += 1
                    row["crisis_graded"] += verdict == "crisis"
            else:
                row["negatives"] += 1
                row["false_positives"] += is_flagged(verdict)
                row["false_positive_crisis"] += verdict == "crisis"
    for row in rows.values():
        row["detection_rate"] = _rate(row["detected"], row["positives"])
        row["false_positive_rate"] = _rate(row["false_positives"], row["negatives"])
        if graded:
            row["crisis_grade_rate"] = _rate(row["crisis_graded"], row["crisis_expected"])
        else:
            # An ungraded detector cannot say "crisis"; reporting 0% would read
            # as a detector that grades everything too low.
            row["crisis_graded"] = None
            row["false_positive_crisis"] = None
            row["crisis_grade_rate"] = None
    return {"categories": {key: rows[key] for key in order}, "total": rows["_total"]}


@dataclass
class Drift:
    """How the observations differ from the recorded baseline."""

    regressions: List[str] = field(default_factory=list)
    lost_crisis_grade: List[str] = field(default_factory=list)
    new_false_positives: List[str] = field(default_factory=list)
    escalated_false_positives: List[str] = field(default_factory=list)
    closed_gaps: List[str] = field(default_factory=list)
    regained_crisis_grade: List[str] = field(default_factory=list)
    cleared_false_positives: List[str] = field(default_factory=list)

    @property
    def failures(self) -> Dict[str, List[str]]:
        return {
            key: ids
            for key, ids in (
                ("regressions", self.regressions),
                ("lost_crisis_grade", self.lost_crisis_grade),
                ("new_false_positives", self.new_false_positives),
                ("escalated_false_positives", self.escalated_false_positives),
            )
            if ids
        }

    @property
    def notices(self) -> Dict[str, List[str]]:
        return {
            key: ids
            for key, ids in (
                ("closed_gaps", self.closed_gaps),
                ("regained_crisis_grade", self.regained_crisis_grade),
                ("cleared_false_positives", self.cleared_false_positives),
            )
            if ids
        }


def compare(
    corpus: Mapping[str, Any],
    observations: Mapping[str, str],
    entry: Mapping[str, Any],
) -> Drift:
    """Classify every difference from the baseline as a failure or a notice.

    The asymmetry is the design. Anything that moves toward catching more
    crises or flagging fewer harmless texts is a notice; only movement the
    other way fails. That is what lets a lexicon fix merge without touching
    this corpus, and what stops a regression from merging without someone
    deciding, in the baseline, that it is acceptable.
    """
    graded = entry.get("graded", True)
    gaps = entry.get("known_gaps", {})
    under = entry.get("known_under_graded", {})
    false_positives = entry.get("known_false_positives", {})
    drift = Drift()
    for item in corpus["items"]:
        item_id, expected = item["id"], item["expected"]
        verdict = observations[item_id]
        if expected in POSITIVE:
            if not is_flagged(verdict):
                if item_id not in gaps:
                    drift.regressions.append(item_id)
                continue
            if item_id in gaps:
                drift.closed_gaps.append(item_id)
            if graded and expected == "crisis":
                if verdict == "crisis" and item_id in under:
                    drift.regained_crisis_grade.append(item_id)
                elif verdict != "crisis" and item_id not in under and item_id not in gaps:
                    drift.lost_crisis_grade.append(item_id)
        else:
            recorded = false_positives.get(item_id)
            if is_flagged(verdict):
                if recorded is None:
                    drift.new_false_positives.append(item_id)
                elif graded and _level(verdict) > _level(recorded["observed"]):
                    drift.escalated_false_positives.append(item_id)
            elif recorded is not None:
                drift.cleared_false_positives.append(item_id)
    return drift


def pruned_entry(
    corpus: Mapping[str, Any],
    entry: Mapping[str, Any],
    drift: Drift,
    observations: Mapping[str, str],
) -> Dict[str, Any]:
    """The baseline entry with every notice applied, and nothing else.

    It only ever removes or lowers: a closed gap leaves `known_gaps`, a cleared
    false positive leaves `known_false_positives`. A gap that is now caught but
    still under-graded moves to `known_under_graded`, because it is caught now
    and losing that must fail from here on. Nothing a failure would report is
    ever added here — accepting a regression is a decision for a person, made
    by editing the file by hand in the same pull request.
    """
    gaps = {k: v for k, v in entry.get("known_gaps", {}).items() if k not in drift.closed_gaps}
    under = {
        k: v for k, v in entry.get("known_under_graded", {}).items() if k not in drift.regained_crisis_grade
    }
    expected = {item["id"]: item["expected"] for item in corpus["items"]}
    if entry.get("graded", True):
        for item_id in drift.closed_gaps:
            verdict = observations[item_id]
            if expected[item_id] == "crisis" and verdict != "crisis":
                under[item_id] = {"issue": entry["known_gaps"][item_id]["issue"], "observed": verdict}
    false_positives = {
        k: v
        for k, v in entry.get("known_false_positives", {}).items()
        if k not in drift.cleared_false_positives
    }
    # Corpus order, which is the order the file is written in, so pruning a
    # baseline that has nothing to prune leaves it byte-for-byte unchanged.
    position = {item["id"]: index for index, item in enumerate(corpus["items"])}

    def ordered(mapping: Dict[str, Any]) -> Dict[str, Any]:
        return dict(sorted(mapping.items(), key=lambda pair: position[pair[0]]))

    out = dict(entry)
    out["known_gaps"] = ordered(gaps)
    if entry.get("graded", True):
        out["known_under_graded"] = ordered(under)
    out["known_false_positives"] = ordered(false_positives)
    return out


# ── reporting ────────────────────────────────────────────────────────────────


def _pct(value: Optional[float]) -> str:
    return "—" if value is None else f"{value:.0%}"


def _count(value: Optional[int]) -> str:
    return "—" if value is None else str(value)


def format_table(corpus: Mapping[str, Any], summary: Mapping[str, Any]) -> str:
    """Markdown, so the same text goes into a PR body or a report unchanged."""
    lines = [
        "| 区分 | 陽性 | 検知 | 検知率 | 危機の期待 | 危機と判定 | 陰性 | 偽陽性 | 偽陽性率 |",
        "| :-- | --: | --: | --: | --: | --: | --: | --: | --: |",
    ]
    rows = list(summary["categories"].items()) + [("合計", summary["total"])]
    for key, row in rows:
        label = key if key == "合計" else f"{key}（{re.split('[（。]', corpus['categories'][key])[0]}）"
        lines.append(
            f"| {label} | {row['positives']} | {row['detected']} | {_pct(row['detection_rate'])} "
            f"| {row['crisis_expected']} | {_count(row['crisis_graded'])} "
            f"| {row['negatives']} | {row['false_positives']} | {_pct(row['false_positive_rate'])} |"
        )
    return "\n".join(lines)


def evaluate_backend(corpus: Optional[Mapping[str, Any]] = None) -> Dict[str, Dict[str, Any]]:
    corpus = corpus if corpus is not None else load_corpus()
    out: Dict[str, Dict[str, Any]] = {}
    for name, detector in BACKEND_DETECTORS.items():
        observations = observe(corpus, detector.run)
        out[name] = {
            "detector": detector,
            "observations": observations,
            "summary": summarize(corpus, observations, detector.graded),
        }
    return out


def misses(corpus: Mapping[str, Any], observations: Mapping[str, str]) -> Sequence[str]:
    return [
        item["id"]
        for item in corpus["items"]
        if item["expected"] in POSITIVE and not is_flagged(observations[item["id"]])
    ]


def dump_baseline(baseline: Mapping[str, Any]) -> str:
    """The baseline as committed: one record per line, so a diff is one line per item."""

    def records(mapping: Mapping[str, Any], indent: str) -> str:
        if not mapping:
            return "{}"
        body = ",\n".join(
            f'{indent}  "{key}": {json.dumps(value, ensure_ascii=False)}' for key, value in mapping.items()
        )
        return "{\n" + body + "\n" + indent + "}"

    head = {key: value for key, value in baseline.items() if key != "detectors"}
    lines = ["{"]
    for key, value in head.items():
        lines.append(f'  "{key}": {json.dumps(value, ensure_ascii=False)},')
    lines.append('  "detectors": {')
    detector_blocks = []
    for name, entry in baseline["detectors"].items():
        parts = []
        for key, value in entry.items():
            if key.startswith("known_"):
                parts.append(f'      "{key}": {records(value, "      ")}')
            else:
                parts.append(f'      "{key}": {json.dumps(value, ensure_ascii=False)}')
        detector_blocks.append(f'    "{name}": {{\n' + ",\n".join(parts) + "\n    }")
    lines.append(",\n".join(detector_blocks))
    lines.append("  }")
    lines.append("}")
    return "\n".join(lines) + "\n"
