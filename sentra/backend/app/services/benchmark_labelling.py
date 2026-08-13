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
from dataclasses import dataclass, field, replace
from typing import Dict, Iterable, List, Sequence, Set, Tuple

from .benchmark_cases import BENCHMARK_CASES, BenchmarkCase
from .benchmark_cases._splits import SPLITS
from .benchmark_retrieval import parse_motifs

#: Bumped whenever the labelled set changes in a way that makes older results
#: incomparable. #98 consumes a pinned version, never "latest".
#:
#: 0.3.0-dev: #88 grew the set from 6 cases to 82, added the
#: `low_frequency_high_severity` and `heavy_decoy` families, and moved splits
#: onto an authored partition of the curated edges. Results from 0.2.0 are not
#: comparable to results from this version — different cases, different splits.
DATASET_VERSION = "0.3.0-dev"

DATASET_METADATA = {
    "name": "blesc-synthetic-retrieval-benchmark",
    "version": DATASET_VERSION,
    "licence": "CC BY 4.0",
    "author": "BLESC / Sentra research",
    "reviewer": None,  # set when a named human has signed off on the labels
    "privacy_class": "synthetic_non_user_data",
    "contains_real_user_content": False,
    "labelling_status": "drafted, not human-labelled; human labelling not yet performed (#88)",
}

#: How many cases both raters label so an agreement coefficient can be computed.
#: #88 asks for 20. Every case could be double-labelled instead, and that would
#: be better — 20 is what the issue budgets for, and the number is named here so
#: a smaller sample is a visible deviation rather than a quiet one.
AGREEMENT_SAMPLE_SIZE = 20


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
    """The authored split, checked against the grouping derived from content.

    Splits used to be assigned here, by rotating hash-ordered leakage groups
    through train/validation/test. At 6 cases that was the only option. At 82 it
    produced 8 / 48 / 24 with one group of 44 spanning two splits, because cases
    reuse the ontology's edges and grouping is transitive — see
    `benchmark_cases/_splits.py` for the whole argument.

    So the split is now authored, by partitioning the curated edges themselves,
    and this function's job changed from deciding to CHECKING. The grouping is
    still derived from case content and still has the last word: a group that
    spans two splits is a leak, and it is reported as one rather than resolved
    by moving a case, because whichever case moved would be a decision made to
    silence a check.
    """
    assignment = {case.case_id: case.split for case in cases}
    groups = leakage_groups(cases)

    warnings: List[str] = []
    for members in groups:
        spans = sorted({assignment[case_id] for case_id in members})
        if len(spans) > 1:
            warnings.append(
                f"LEAKAGE: {len(members)} cases share content but are split across "
                f"{spans} — {', '.join(sorted(members)[:4])}"
                f"{' ...' if len(members) > 4 else ''}. A translation or a shared "
                "chain is about to cross the train/test boundary."
            )
    for split in SPLITS:
        if not any(value == split for value in assignment.values()):
            warnings.append(f"split {split!r} is empty")

    # Reported on every run, not only when it is small. The count that limits a
    # held-out claim is the number of independent groups, and at 82 cases over
    # an ontology of ~40 edges it is an order of magnitude below the case count.
    # Growing the case set does not raise it; growing the ontology does.
    warnings.append(
        f"effective sample size is {len(groups)} independent leakage group(s), not "
        f"{len(cases)} cases. Report the group count for any held-out claim."
    )
    return SplitAssignment(assignment=assignment, groups=groups, warnings=warnings)


# ---------------------------------------------------------------------------
# Handing cases to raters, and taking labels back
# ---------------------------------------------------------------------------


def agreement_sample(
    size: int = AGREEMENT_SAMPLE_SIZE,
    cases: Sequence[BenchmarkCase] = BENCHMARK_CASES,
) -> List[BenchmarkCase]:
    """The cases both raters label, stratified by family and language.

    Drawn deterministically so the sample is fixed before any labelling starts —
    choosing which cases to double-label after seeing the labels would let the
    agreement figure be selected rather than measured.

    Stratified because agreement is not one number: raters agree easily on the
    `vocab_disjoint` cases, where one day obviously answers the query, and least
    on `two_hop_chain`, where the judgement is whether a link in a chain counts
    as evidence. A sample drawn at random would report whichever mix it happened
    to draw.
    """
    buckets: Dict[Tuple[str, str], List[BenchmarkCase]] = {}
    for case in cases:
        buckets.setdefault((case.family, case.lang), []).append(case)
    for bucket in buckets.values():
        bucket.sort(key=lambda case: _shuffle_key("agreement", case.case_id))

    chosen: List[BenchmarkCase] = []
    keys = sorted(buckets)
    index = 0
    while len(chosen) < size and any(buckets[key] for key in keys):
        bucket = buckets[keys[index % len(keys)]]
        if bucket:
            chosen.append(bucket.pop(0))
        index += 1
    return sorted(chosen, key=lambda case: case.case_id)


def labelling_file(rater_id: str, cases: Sequence[BenchmarkCase] = BENCHMARK_CASES) -> List[Dict[str, object]]:
    """What one rater is sent: their cases, with an empty slot to fill in.

    `selected_evidence_ids` comes back as the rater's answer. It is the only
    field they write, and the file carries no key to check it against — see
    `labelling_task`, which strips everything that would amount to one.
    """
    return [
        {
            "rater_id": rater_id,
            "dataset_version": DATASET_VERSION,
            **labelling_task(case),
            "selected_evidence_ids": [],
        }
        for case in cases
    ]


def read_rater_labels(rows: Iterable[Dict[str, object]]) -> RaterLabels:
    """A returned labelling file, as `RaterLabels`.

    A case with an empty `selected_evidence_ids` is treated as UNLABELLED, not
    as "this rater found nothing". The two are different claims and only one of
    them is evidence — a rater who worked through a case and concluded nothing
    helps records that by writing `["none"]`, which is the one sentinel this
    format has.
    """
    rows = list(rows)
    rater_ids = {str(row.get("rater_id", "")) for row in rows}
    if len(rater_ids) != 1:
        raise ValueError(f"a labelling file holds exactly one rater, found {sorted(rater_ids)}")

    selections: Dict[str, Set[str]] = {}
    for row in rows:
        picks = list(row.get("selected_evidence_ids") or [])
        if not picks:
            continue
        selections[str(row["case_id"])] = set() if picks == ["none"] else {str(pick) for pick in picks}
    return RaterLabels(rater_id=rater_ids.pop(), selections=selections)


@dataclass(frozen=True)
class Adjudication:
    """What the two raters settled on, and what they could not."""

    agreed: Dict[str, Set[str]]
    disputed: Dict[str, Tuple[Set[str], Set[str]]]
    resolved: Dict[str, Set[str]]

    @property
    def usable(self) -> Dict[str, Set[str]]:
        return {**self.agreed, **self.resolved}


def adjudicate(
    first: RaterLabels,
    second: RaterLabels,
    resolutions: Dict[str, Set[str]] | None = None,
) -> Adjudication:
    """Merge two raters, keeping unresolved disagreement unresolved.

    The pre-registration excludes a case where "the two raters disagree and no
    adjudication was recorded". This is where that exclusion is produced: a
    disputed case stays in `disputed` and out of `usable` until someone records
    a decision in `resolutions`. Taking the union or the intersection instead
    would manufacture an answer key out of a disagreement and there would be
    nothing left to exclude.
    """
    resolutions = dict(resolutions or {})
    agreed: Dict[str, Set[str]] = {}
    disputed: Dict[str, Tuple[Set[str], Set[str]]] = {}

    for case_id in sorted(set(first.selections) & set(second.selections)):
        picks_a, picks_b = first.selections[case_id], second.selections[case_id]
        if picks_a == picks_b:
            agreed[case_id] = set(picks_a)
        else:
            disputed[case_id] = (set(picks_a), set(picks_b))

    # A case only one rater saw is that rater's label. Most of the set is
    # single-labelled by design; only `agreement_sample()` is double-labelled.
    for source, other in ((first, second), (second, first)):
        for case_id, picks in source.selections.items():
            if case_id not in other.selections:
                agreed[case_id] = set(picks)

    resolved = {case_id: set(picks) for case_id, picks in resolutions.items() if case_id in disputed}
    return Adjudication(agreed=agreed, disputed=disputed, resolved=resolved)


def apply_human_labels(
    adjudication: Adjudication,
    cases: Sequence[BenchmarkCase] = BENCHMARK_CASES,
) -> List[BenchmarkCase]:
    """Cases with human `expected_evidence_ids`, and `labelled_by="human"`.

    The one place a drafted key becomes an answer key. A case the raters did not
    reach keeps its drafted ids and its `labelled_by="draft"`, so it stays
    excluded from the confirmatory analysis rather than being silently promoted
    by the fact that a labelling pass happened.

    Selections are ordered by the case's own evidence order rather than by
    whatever the rater typed, so two raters who picked the same days in a
    different order produce the same case.
    """
    usable = adjudication.usable
    out: List[BenchmarkCase] = []
    for case in cases:
        if case.case_id not in usable:
            out.append(case)
            continue
        picks = usable[case.case_id]
        known = {day.evidence_id for day in case.evidence}
        unknown = picks - known
        if unknown:
            raise ValueError(
                f"{case.case_id}: rater selected {sorted(unknown)}, which is not among its candidates"
            )
        out.append(
            replace(
                case,
                expected_evidence_ids=tuple(
                    day.evidence_id for day in case.evidence if day.evidence_id in picks
                ),
                labelled_by="human",
            )
        )
    return out


def labelling_status(
    agreement: AgreementResult | None = None,
    cases: Sequence[BenchmarkCase] = BENCHMARK_CASES,
) -> Dict[str, object]:
    """Reported alongside benchmark results so the gap is visible in the output.

    `agreement` is passed in rather than computed, because computing it requires
    two rater files and there are none. A `None` here means "not measured", and
    it is reported as that word — never as 0, which would read as "the raters
    disagreed completely".
    """
    split = assign_splits(cases)
    human = [case for case in cases if case.labelled_by == "human"]
    sample = agreement_sample(cases=cases)

    warnings = list(split.warnings)
    if len(human) < len(cases):
        warnings.append(
            f"{len(human)}/{len(cases)} cases carry a human label. Every retrieval "
            "number from this dataset is PRELIMINARY until that reaches the case "
            "count — the rest are drafted keys (#88)."
        )
    if agreement is None:
        warnings.append(
            "inter-rater agreement has not been measured: no rater files exist. "
            "The pre-registration makes an unmeasured coefficient grounds for "
            "making no claim from the retrieval numbers at all."
        )
    elif not agreement.meets_threshold:
        warnings.append(
            f"inter-rater agreement is {agreement.kappa if agreement.is_defined else 'undefined'}, "
            "below the 0.67 convention fixed in advance. The labels are not yet "
            "reliable enough to interpret a retrieval result."
        )

    return {
        "dataset": dict(DATASET_METADATA),
        "case_count": len(cases),
        "target_case_count": "60-100 (#88)",
        "composition": {
            family: len([case for case in cases if case.family == family])
            for family in sorted({case.family for case in cases})
        },
        "by_language": {
            lang: len([case for case in cases if case.lang == lang])
            for lang in sorted({case.lang for case in cases})
        },
        "human_labelled_count": len(human),
        "drafted_not_labelled_count": len([case for case in cases if case.labelled_by == "draft"]),
        "inter_rater_agreement": agreement.kappa if agreement and agreement.is_defined else None,
        "inter_rater_agreement_measured": agreement is not None,
        "agreement_sample": [case.case_id for case in sample],
        "agreement_sample_size": len(sample),
        "leakage_groups": split.groups,
        "independent_group_count": len(split.groups),
        "splits": {name: split.cases_in(name) for name in SPLITS},
        "warnings": warnings,
    }
