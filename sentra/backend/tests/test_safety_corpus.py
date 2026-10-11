"""The backend half of the Japanese safety-corpus measurement.

`sentra/shared/safety_corpus/` holds a synthetic corpus of crisis expressions
(kana, katakana, half-width, masking, slang, euphemism, negation, hypothesis,
quotation) and of harmless sentences the lexicons can hit. This suite runs the
backend's two crisis detectors over it and compares the result to a recorded
baseline.

It is built so that it cannot be the thing that stops the lexicon fix (#388,
#392) from merging:

- An item the detectors miss today is listed in `baseline.json` as a known gap,
  with the issue that tracks it. A known gap that starts being caught raises a
  `SafetyCorpusNotice` warning that names the entries to delete. It never fails.
- The suite fails only when something gets worse: an item caught at the
  baseline is no longer caught, an expected-crisis item loses its `crisis`
  grade, or a harmless item becomes (or becomes more of) a false positive.

The expected verdicts are a model's draft and every item says `reviewed: false`.
Until a human reviewer has been through them the numbers are a measurement of
agreement with that draft, not of coverage.
"""

from __future__ import annotations

import json
import warnings
from typing import Dict

import pytest

from app.evaluation.safety_corpus import (
    BACKEND_DETECTORS,
    CORPUS_DIR,
    POSITIVE,
    compare,
    format_table,
    is_flagged,
    load_baseline,
    load_corpus,
    observe,
    pruned_entry,
    summarize,
    validate_baseline,
    validate_corpus,
)

#: The categories the corpus exists to cover (see README.md). A category that
#: silently disappears would make every rate above it look better.
REQUIRED_CATEGORIES = {
    "kanji_control", "hiragana", "katakana", "width_mixed", "masked", "slang",
    "euphemism", "negation", "hypothetical", "quotation", "confusable",
}
#: Categories that must hold harmless items, or there is no false-positive rate
#: to protect for exactly the constructions most likely to produce one.
NEEDS_NEGATIVES = {"negation", "hypothetical", "quotation", "confusable"}
ALL_DETECTORS = {"frontend.assessSafety", *BACKEND_DETECTORS}


class SafetyCorpusNotice(UserWarning):
    """Something improved. The baseline should be tidied; nothing is wrong."""


@pytest.fixture(scope="module")
def corpus() -> dict:
    return load_corpus()


@pytest.fixture(scope="module")
def baseline() -> dict:
    return load_baseline()


# ── the corpus itself ────────────────────────────────────────────────────────


def test_corpus_is_well_formed(corpus):
    assert validate_corpus(corpus) == []


def test_corpus_covers_every_category_it_claims(corpus):
    assert REQUIRED_CATEGORIES <= set(corpus["categories"])
    by_category: Dict[str, Dict[str, int]] = {}
    for item in corpus["items"]:
        row = by_category.setdefault(item["category"], {"positive": 0, "negative": 0})
        row["positive" if item["expected"] in POSITIVE else "negative"] += 1
    for category in REQUIRED_CATEGORIES - {"confusable"}:
        assert by_category[category]["positive"] >= 2, category
    for category in NEEDS_NEGATIVES:
        assert by_category[category]["negative"] >= 3, category


def test_readme_says_the_verdicts_need_human_review():
    # The completion condition is a sentence in a document, which is exactly
    # the kind of thing that gets edited away. Pinned so that it cannot be.
    readme = (CORPUS_DIR / "README.md").read_text(encoding="utf-8")
    assert "reviewed: false" in readme
    assert "人のレビュー" in readme
    assert "網羅" in readme


def test_baseline_points_at_real_items_of_the_right_kind(corpus, baseline):
    assert set(baseline["detectors"]) == ALL_DETECTORS
    assert validate_baseline(corpus, baseline) == []


def test_every_known_gap_names_where_it_is_tracked(baseline):
    # The gaps the lexicon fix is meant to close carry its issue number, so
    # the fix landing is recognisable in the notice it produces.
    assert {r["issue"] for r in baseline["detectors"]["frontend.assessSafety"]["known_gaps"].values()} >= {"#388"}
    assert {r["issue"] for r in baseline["detectors"]["backend.assess_safety"]["known_gaps"].values()} >= {"#388"}
    assert {r["issue"] for r in baseline["detectors"]["backend.has_crisis_language"]["known_gaps"].values()} >= {"#392"}


# ── the measurement ──────────────────────────────────────────────────────────


@pytest.mark.parametrize("name", sorted(BACKEND_DETECTORS))
def test_detector_has_not_regressed_against_the_baseline(corpus, baseline, name):
    detector = BACKEND_DETECTORS[name]
    entry = baseline["detectors"][name]
    observations = observe(corpus, detector.run)
    drift = compare(corpus, observations, entry)

    if drift.notices:
        pruned = pruned_entry(corpus, entry, drift, observations)
        warnings.warn(
            SafetyCorpusNotice(
                f"{name} improved against the safety corpus: {drift.notices}. "
                "Nothing failed. Update sentra/shared/safety_corpus/baseline.json "
                f"(`python scripts/report_safety_corpus.py --prune`), so this entry reads:\n"
                + json.dumps(pruned, ensure_ascii=False, indent=2)
            )
        )

    assert not drift.failures, (
        f"{name} got worse against the safety corpus: {drift.failures}. "
        "regressions / lost_crisis_grade: an item caught at the baseline is no longer "
        "caught at that level. new_false_positives / escalated_false_positives: a "
        "harmless item is flagged where it was not. If the change is deliberate, "
        "record it by hand in baseline.json in the same pull request, with the reason."
        f"\n\n{format_table(corpus, summarize(corpus, observations, detector.graded))}"
    )


@pytest.mark.parametrize("name", sorted(BACKEND_DETECTORS))
def test_rates_add_up(corpus, name):
    detector = BACKEND_DETECTORS[name]
    summary = summarize(corpus, observe(corpus, detector.run), detector.graded)
    total = summary["total"]
    assert total["positives"] + total["negatives"] == len(corpus["items"])
    assert sum(row["positives"] for row in summary["categories"].values()) == total["positives"]
    assert 0 <= total["detected"] <= total["positives"]


# ── why a lexicon fix cannot turn this red ───────────────────────────────────
#
# These run the comparison on constructed observations rather than on the
# detectors, so they pin the design rather than today's numbers.


def _baseline_observations(corpus, entry) -> Dict[str, str]:
    """Observations exactly consistent with a baseline entry."""
    graded = entry["graded"]
    out: Dict[str, str] = {}
    for item in corpus["items"]:
        item_id = item["id"]
        if item_id in entry["known_gaps"]:
            out[item_id] = "none"
        elif item_id in entry.get("known_under_graded", {}):
            out[item_id] = entry["known_under_graded"][item_id]["observed"]
        elif item_id in entry["known_false_positives"]:
            out[item_id] = entry["known_false_positives"][item_id]["observed"]
        elif item["expected"] in POSITIVE:
            out[item_id] = (item["expected"] if graded else "flagged")
        else:
            out[item_id] = "none"
    return out


@pytest.mark.parametrize("name", sorted(ALL_DETECTORS))
def test_closing_every_known_gap_is_a_notice_not_a_failure(corpus, baseline, name):
    entry = baseline["detectors"][name]
    fixed = _baseline_observations(corpus, entry)
    for item in corpus["items"]:
        if item["expected"] in POSITIVE:
            fixed[item["id"]] = item["expected"] if entry["graded"] else "flagged"
        else:
            fixed[item["id"]] = "none"
    drift = compare(corpus, fixed, entry)
    assert drift.failures == {}
    assert set(drift.closed_gaps) == set(entry["known_gaps"])
    assert set(drift.cleared_false_positives) == set(entry["known_false_positives"])


@pytest.mark.parametrize("name", sorted(ALL_DETECTORS))
def test_the_baseline_is_its_own_fixed_point(corpus, baseline, name):
    entry = baseline["detectors"][name]
    drift = compare(corpus, _baseline_observations(corpus, entry), entry)
    assert drift.failures == {} and drift.notices == {}


def test_a_gap_closed_below_crisis_moves_to_under_graded(corpus, baseline):
    entry = baseline["detectors"]["frontend.assessSafety"]
    items = {item["id"]: item for item in corpus["items"]}
    gap = next(i for i in entry["known_gaps"] if items[i]["expected"] == "crisis")
    observations = _baseline_observations(corpus, entry)
    observations[gap] = "caution"

    drift = compare(corpus, observations, entry)
    assert drift.failures == {}
    assert drift.closed_gaps == [gap]

    pruned = pruned_entry(corpus, entry, drift, observations)
    assert gap not in pruned["known_gaps"]
    assert pruned["known_under_graded"][gap] == {"issue": entry["known_gaps"][gap]["issue"], "observed": "caution"}
    # From here on, losing that caution is a regression.
    observations[gap] = "none"
    assert compare(corpus, observations, pruned).regressions == [gap]


def test_losing_a_detection_fails(corpus, baseline):
    entry = baseline["detectors"]["backend.assess_safety"]
    observations = _baseline_observations(corpus, entry)
    caught = next(i for i, v in observations.items() if v == "crisis")
    observations[caught] = "none"
    assert compare(corpus, observations, entry).failures == {"regressions": [caught]}


def test_losing_the_crisis_grade_fails(corpus, baseline):
    entry = baseline["detectors"]["backend.assess_safety"]
    items = {item["id"]: item for item in corpus["items"]}
    observations = _baseline_observations(corpus, entry)
    caught = next(i for i, v in observations.items() if v == "crisis" and items[i]["expected"] == "crisis")
    observations[caught] = "caution"
    assert compare(corpus, observations, entry).failures == {"lost_crisis_grade": [caught]}


def test_a_new_false_positive_fails(corpus, baseline):
    entry = baseline["detectors"]["backend.assess_safety"]
    observations = _baseline_observations(corpus, entry)
    clean = next(
        item["id"] for item in corpus["items"]
        if item["expected"] == "none" and not is_flagged(observations[item["id"]])
    )
    observations[clean] = "caution"
    assert compare(corpus, observations, entry).failures == {"new_false_positives": [clean]}


def test_a_known_false_positive_getting_more_severe_fails(corpus, baseline):
    entry = baseline["detectors"]["backend.assess_safety"]
    observations = _baseline_observations(corpus, entry)
    mild = next(i for i, r in entry["known_false_positives"].items() if r["observed"] == "caution")
    observations[mild] = "crisis"
    assert compare(corpus, observations, entry).failures == {"escalated_false_positives": [mild]}
