"""Benchmark cases: 80 across four families, grown from 6 for #88.

Was one module until #88 needed 60-100 cases; the families now sit in their own
files because each carries a different argument for why its cases are shaped the
way they are, and those arguments were the part worth keeping legible.

Read the family modules for the design. What is true across all four:

- **targets** paraphrase the query and share no content word with it
- **distractors** are lexical decoys that deliberately reuse the query's words

so a lexical method is actively misled rather than merely uninformative, which
is what it takes to drive a keyword baseline to or below chance.

WHAT #88 DID NOT DO. `expected_evidence_ids` on all 74 new cases is
`labelled_by="draft"` — proposed by whoever wrote the case, not labelled by a
person. They are NOT an answer key and the pre-registration excludes them from
the confirmatory analysis until `benchmark_labelling.apply_human_labels()` has
overwritten them from a rater file. A model that writes both the question and
the answer key produces a benchmark shaped like that model's strengths, and
nothing about drafting 80 of them changes that. `labelling_status()` reports the
gap in the output rather than leaving it to be worked out.

The six pre-#88 cases keep their ids (`sleep_chain_en`, `chain_red_herring_ja`
and so on) so a historical result set still matches, and keep
`labelled_by="author"`: they are development data, listed as such in
`docs/benchmark_preregistration.md`, and excluded from the confirmatory analysis
for a different reason.
"""

from __future__ import annotations

from typing import Dict, List, Sequence

from . import heavy_decoy, low_frequency, two_hop, vocab_disjoint
from ._build import CaseDesignError, CaseDraft, Step, expand_all, motif_for
from ._types import LABEL_PROVENANCE, BenchmarkCase, EvidenceDay

RETIRED_CASES = {
    # Kept as a record rather than deleted. All four were answerable from a
    # single day's wording and cannot be migrated to the new shape without
    # being rewritten into different cases — which is what the new families
    # are. Their case_ids are retained so a historical result set can still be
    # matched against something.
    "deadline_pressure_returns": "single-day, distractor shared no vocabulary with the query",
    "protective_decline": "single-day, distractor shared no vocabulary with the query",
    "crisis_escalation": "single-day; the safety-label bonus dominated the ranking",
    "study_overload_recovery": "single-day, distractor shared no vocabulary with the query",
}

#: The five cases the harness was built and debugged on, by case_id. Development
#: data: a result on them is a result about the harness, so the pre-registration
#: excludes them from the confirmatory analysis. Listed here rather than in the
#: document alone so the exclusion can be applied in code.
DEVELOPMENT_CASE_IDS = (
    "sleep_chain_en",
    "sleep_chain_ja",
    "chain_red_herring_en",
    "chain_red_herring_ja",
    "vocab_disjoint_en",
    "vocab_disjoint_ja",
)

DRAFTS: Sequence[CaseDraft] = (
    *two_hop.DRAFTS,
    *vocab_disjoint.DRAFTS,
    *low_frequency.DRAFTS,
    *heavy_decoy.DRAFTS,
)

FAMILIES = (
    two_hop.FAMILY,
    vocab_disjoint.FAMILY,
    low_frequency.FAMILY,
    heavy_decoy.FAMILY,
)

#: The composition #88 fixed in advance, so a family that quietly shrank is a
#: test failure rather than a footnote in a result table.
TARGET_COMPOSITION: Dict[str, int] = {
    two_hop.FAMILY: 26,
    vocab_disjoint.FAMILY: 26,
    # 16, not the 14 the issue sketched: the severity material clusters on the
    # social subgraph, so an eighth draft was added on academic-pressure edges
    # to stop the validation split holding no high-severity cases at all.
    low_frequency.FAMILY: 16,
    heavy_decoy.FAMILY: 14,
}


def _build() -> List[BenchmarkCase]:
    cases = expand_all(DRAFTS)
    # The pre-#88 cases were written by hand and are development data. Their
    # provenance is "author", not "draft", and conflating the two would let the
    # confirmatory set quietly include the cases the thresholds were chosen on.
    return [
        case if case.case_id not in DEVELOPMENT_CASE_IDS else _as_development(case)
        for case in cases
    ]


def _as_development(case: BenchmarkCase) -> BenchmarkCase:
    from dataclasses import replace

    return replace(case, labelled_by="author")


BENCHMARK_CASES: Sequence[BenchmarkCase] = tuple(_build())


def cases_by_family(family: str) -> List[BenchmarkCase]:
    return [case for case in BENCHMARK_CASES if case.family == family]


#: Composition, so a thin family is visible rather than implicit.
CASE_COMPOSITION = {
    **{family: len(cases_by_family(family)) for family in FAMILIES},
    "ja": len([case for case in BENCHMARK_CASES if case.lang == "ja"]),
    "en": len([case for case in BENCHMARK_CASES if case.lang == "en"]),
    "human_labelled": len([case for case in BENCHMARK_CASES if case.labelled_by == "human"]),
    "drafted_not_labelled": len([case for case in BENCHMARK_CASES if case.labelled_by == "draft"]),
    "development": len([case for case in BENCHMARK_CASES if case.labelled_by == "author"]),
    "total": len(BENCHMARK_CASES),
}

__all__ = [
    "BENCHMARK_CASES",
    "BenchmarkCase",
    "CASE_COMPOSITION",
    "CaseDesignError",
    "CaseDraft",
    "DEVELOPMENT_CASE_IDS",
    "DRAFTS",
    "EvidenceDay",
    "FAMILIES",
    "LABEL_PROVENANCE",
    "RETIRED_CASES",
    "Step",
    "TARGET_COMPOSITION",
    "cases_by_family",
    "motif_for",
]
