"""Human labelling protocol for the benchmark (#88).

#88 needs 60-100 cases whose `expected_evidence_ids` are labelled by a person.
That work cannot be done here — this module is the scaffolding around it: what a
rater is shown, how two raters' labels are compared, and how cases are split so
the held-out set stays held out.

Three things this deliberately makes hard to get wrong:

**The rater must not see the answer key.** `labelling_task()` strips
`expected_evidence_ids`, `research_note`, `required_hops` and `family` before a
case is handed to a person. A rater shown the intended answer produces a
confirmation, not a label. It also shuffles the candidates deterministically,
because c1..c3 sitting at the top of every list is itself a cue — the same
position bias that let the broken tokeniser score a false 1.0 in #86.

**Agreement can be undefined, and says so.** Cohen's kappa divides by
`1 - p_e`. When a rater marks nearly everything "not evidence" — the expected
shape here, since most candidates are decoys — `p_e` approaches 1 and kappa
becomes unstable or undefined. Reporting 0.0 in that case would read as
"no agreement" when the truth is "this statistic cannot be computed on this
distribution". `AgreementResult.is_defined` carries the distinction.

**Splits are grouped, not per-case.** A matched ja/en pair is one item of
information in two languages; a red-herring case contains another case's target
text verbatim. Assigning those independently puts a translation or a copy of a
test target into the training set. `leakage_groups()` derives the grouping from
the case content rather than from a hand-maintained list, because a
hand-maintained list is the kind of thing that silently stops being true.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from typing import Dict, Iterable, List, Sequence, Set, Tuple

from .benchmark_cases import BENCHMARK_CASES, BenchmarkCase
from .benchmark_retrieval import parse_motifs

#: Bumped whenever the labelled set changes in a way that makes older results
#: incomparable. #98 consumes a pinned version, never "latest".
DATASET_VERSION = "0.2.0-dev"

DATASET_METADATA = {
    "name": "blesc-synthetic-retrieval-benchmark",
    "version": DATASET_VERSION,
    "licence": "CC BY 4.0",
    "author": "BLESC / Sentra research",
    "reviewer": None,  # set when a named human has signed off on the labels
    "privacy_class": "synthetic_non_user_data",
    "contains_real_user_content": False,
    "labelling_status": "author-drafted; human labelling not yet performed (#88)",
}

SPLITS = ("train", "validation", "test")


# ---------------------------------------------------------------------------
# What a rater sees
# ---------------------------------------------------------------------------


def _shuffle_key(case_id: str, evidence_id: str) -> str:
    """Deterministic presentation order that is not the authoring order.

    Hash rather than random.shuffle so the order is reproducible without
    carrying a seed around, and identical for every rater — two raters ranking
    differently because they saw different orders would show up as disagreement
    about the cases.
    """
    return hashlib.sha256(f"{case_id}:{evidence_id}".encode()).hexdigest()


def labelling_task(case: BenchmarkCase) -> Dict[str, object]:
    """One case, as presented to a human rater. No answer key."""
    candidates = sorted(case.evidence, key=lambda day: _shuffle_key(case.case_id, day.evidence_id))
    return {
        "case_id": case.case_id,
        "lang": case.lang,
        "query": case.query,
        "instruction": (
            "Mark every day that helps answer the query. A day can help by "
            "describing the same thing in different words, or by being one link "
            "in a chain that reaches it. Mark nothing if nothing helps."
        ),
        "candidates": [
            {
                "evidence_id": day.evidence_id,
                "day": day.day,
                "text": day.text,
                # Motifs are shown: in the product the graph is visible to the
                # retriever, so a rater judging without it would be labelling a
                # different task than the one being measured.
                "graph_motifs": list(day.graph_motifs),
            }
            for day in candidates
        ],
    }


def labelling_tasks() -> List[Dict[str, object]]:
    return [labelling_task(case) for case in BENCHMARK_CASES]


@dataclass(frozen=True)
class RaterLabels:
    """One rater's evidence selections, keyed by case_id."""

    rater_id: str
    selections: Dict[str, Set[str]]


# ---------------------------------------------------------------------------
# Agreement
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class AgreementResult:
    kappa: float | None
    observed_agreement: float
    expected_agreement: float
    judgements: int
    #: False when kappa is undefined or numerically unstable. Callers must not
    #: substitute 0.0 — "cannot be computed" and "no agreement" are different
    #: findings and only one of them means the labels are bad.
    is_defined: bool
    note: str

    @property
    def meets_threshold(self) -> bool:
        """#88 asks for the coefficient to be reported, not to clear a bar.

        0.67 is the conventional floor below which a coding scheme is usually
        treated as not yet usable (Krippendorff's lower bound for tentative
        conclusions). It is a convention, not a law, and it is recorded here so
        the number is compared against something stated in advance rather than
        against whatever the labels happen to produce.
        """
        return self.is_defined and self.kappa is not None and self.kappa >= 0.67


def cohens_kappa(first: RaterLabels, second: RaterLabels, cases: Sequence[BenchmarkCase] = BENCHMARK_CASES) -> AgreementResult:
    """Agreement over per-(case, candidate) binary "is this evidence" judgements.

    Only cases both raters labelled are counted. Silently treating an unlabelled
    case as "selected nothing" would manufacture agreement out of missing work.
    """
    shared = [case for case in cases if case.case_id in first.selections and case.case_id in second.selections]
    if not shared:
        return AgreementResult(None, 0.0, 0.0, 0, False, "no case was labelled by both raters")

    both = neither = only_first = only_second = 0
    for case in shared:
        picks_a = first.selections[case.case_id]
        picks_b = second.selections[case.case_id]
        for day in case.evidence:
            in_a = day.evidence_id in picks_a
            in_b = day.evidence_id in picks_b
            if in_a and in_b:
                both += 1
            elif in_a:
                only_first += 1
            elif in_b:
                only_second += 1
            else:
                neither += 1

    total = both + neither + only_first + only_second
    observed = (both + neither) / total
    positive_a = (both + only_first) / total
    positive_b = (both + only_second) / total
    expected = (positive_a * positive_b) + ((1 - positive_a) * (1 - positive_b))

    if expected >= 0.99:
        return AgreementResult(
            None,
            round(observed, 4),
            round(expected, 4),
            total,
            False,
            (
                "kappa is undefined here: both raters marked almost every candidate "
                "the same way, so agreement by chance is already ~100%. This is the "
                "expected shape when most candidates are decoys. Report the positive "
                "counts and per-case overlap instead; do not read this as kappa = 0."
            ),
        )

    kappa = (observed - expected) / (1 - expected)
    return AgreementResult(
        round(kappa, 4),
        round(observed, 4),
        round(expected, 4),
        total,
        True,
        f"{both} agreed selections over {len(shared)} shared cases",
    )


# ---------------------------------------------------------------------------
# Leakage-safe splits
# ---------------------------------------------------------------------------


def _target_texts(case: BenchmarkCase) -> Set[str]:
    expected = set(case.expected_evidence_ids)
    return {day.text for day in case.evidence if day.evidence_id in expected}


def _target_triples(case: BenchmarkCase) -> Set[Tuple[str, str, str]]:
    expected = set(case.expected_evidence_ids)
    out: Set[Tuple[str, str, str]] = set()
    for day in case.evidence:
        if day.evidence_id in expected:
            for triple in parse_motifs(day.graph_motifs):
                out.add((triple.subject, triple.relation, triple.object))
    return out


def _all_texts(case: BenchmarkCase) -> Set[str]:
    return {day.text for day in case.evidence}


def _linked(left: BenchmarkCase, right: BenchmarkCase) -> bool:
    """Would putting these two in different splits leak?

    Yes if either case's *target* text appears anywhere in the other — including
    as a distractor, which is how the red-herring case carries a verbatim copy
    of another case's answer. Yes if they share a target motif triple, which is
    how a matched ja/en pair is caught: the translations share no words but the
    graph structure is identical, and the graph is the thing under test.

    Deliberately scoped to targets. Decoy days are generated from a shared word
    list and are identical across cases by construction; linking on those would
    collapse every case into one group and make the guard useless.
    """
    if _target_texts(left) & _all_texts(right):
        return True
    if _target_texts(right) & _all_texts(left):
        return True
    return bool(_target_triples(left) & _target_triples(right))


def leakage_groups(cases: Sequence[BenchmarkCase] = BENCHMARK_CASES) -> List[List[str]]:
    """Cases that must share a split, derived from their content."""
    parent: Dict[str, str] = {case.case_id: case.case_id for case in cases}

    def find(node: str) -> str:
        while parent[node] != node:
            parent[node] = parent[parent[node]]
            node = parent[node]
        return node

    def union(a: str, b: str) -> None:
        root_a, root_b = find(a), find(b)
        if root_a != root_b:
            parent[root_b] = root_a

    for index, left in enumerate(cases):
        for right in cases[index + 1 :]:
            if _linked(left, right):
                union(left.case_id, right.case_id)

    grouped: Dict[str, List[str]] = {}
    for case in cases:
        grouped.setdefault(find(case.case_id), []).append(case.case_id)
    return [sorted(members) for _, members in sorted(grouped.items())]


@dataclass(frozen=True)
class SplitAssignment:
    assignment: Dict[str, str]
    groups: List[List[str]]
    warnings: List[str] = field(default_factory=list)

    def cases_in(self, split: str) -> List[str]:
        return sorted(case_id for case_id, value in self.assignment.items() if value == split)


def assign_splits(cases: Sequence[BenchmarkCase] = BENCHMARK_CASES) -> SplitAssignment:
    """Deterministic group-level split, for #98 to consume.

    Groups are ordered by a hash of their members rather than by size or by
    authoring order, so growing the set does not reshuffle existing assignments
    in a way that quietly moves a case from test to train between runs.
    """
    groups = leakage_groups(cases)
    ordered = sorted(groups, key=lambda members: hashlib.sha256("|".join(members).encode()).hexdigest())

    assignment: Dict[str, str] = {}
    # test first: the held-out set is the one that must exist. If there is only
    # enough material for one split, it should be the one #98 is forbidden to
    # train on.
    for index, members in enumerate(ordered):
        split = SPLITS[(index + 2) % len(SPLITS)]
        for case_id in members:
            assignment[case_id] = split

    warnings: List[str] = []
    for split in SPLITS:
        if not any(value == split for value in assignment.values()):
            warnings.append(
                f"split {split!r} is empty: {len(ordered)} leakage group(s) cannot fill "
                f"{len(SPLITS)} splits. #88 raises the case count; until then this "
                f"dataset cannot support train/validation/test separation."
            )
    if len(ordered) < len(SPLITS):
        warnings.append(
            f"only {len(ordered)} independent group(s) exist across {len(cases)} cases — "
            "the effective sample size for any held-out claim is the group count, not "
            "the case count."
        )
    return SplitAssignment(assignment=assignment, groups=groups, warnings=warnings)


def labelling_status() -> Dict[str, object]:
    """Reported alongside benchmark results so the gap is visible in the output."""
    split = assign_splits()
    return {
        "dataset": dict(DATASET_METADATA),
        "case_count": len(BENCHMARK_CASES),
        "target_case_count": "60-100 (#88)",
        "human_labelled_count": len([case for case in BENCHMARK_CASES if case.labelled_by == "human"]),
        "inter_rater_agreement": None,
        "leakage_groups": split.groups,
        "independent_group_count": len(split.groups),
        "splits": {name: split.cases_in(name) for name in SPLITS},
        "warnings": split.warnings,
    }
