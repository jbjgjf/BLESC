"""The evaluation gate a structure-learning experiment must pass (#101).

#101's last acceptance criterion is that graph-structure-learning experiments are
evaluated against held-out labelled edges and negative/red-herring cases **before
any product use**. This module is that evaluation. It does no learning: it takes
a set of proposed edges from whatever produced them and reports whether the
proposals clear a pre-declared bar.

The bar is deliberately asymmetric. Missing a real edge costs a feature; adding a
plausible-sounding wrong one adds a clinical-looking claim to a product shown to
people who support children. So `max_red_herring_rate` is much tighter than
`min_recall`, and a learner that proposes nothing at all fails on recall rather
than passing by silence.

**The gate fails closed.** Too few labelled cases, or too many proposals the
labelled set says nothing about, and the result is `passed = False` with the
reason — not a pass by default. An evaluation set too small to catch a bad
learner has not cleared one.

The cases live in `held_out_edges.yaml`, declared before any learner existed and
alongside the reason each red herring is tempting. A red herring without a
written reason is indistinguishable from an edge somebody forgot to curate,
which is why the loader requires one.

This module is the thing #99 and #100 are gated on. It is not a substitute for
review: passing here makes a candidate eligible for a human to look at, and
`revision.promote` still requires a named reviewer.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from enum import Enum
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import yaml

from .layers import CandidateEdge, EdgeKey

CASES_PATH = Path(__file__).parent / "held_out_edges.yaml"


class EdgeLabel(str, Enum):
    #: A real curated edge, withheld from whatever the learner was trained on.
    HELD_OUT_TRUE = "held_out_true"
    #: Plausible and not curated. The case that decides whether a learner ships.
    RED_HERRING = "red_herring"
    #: Unrelated. The easy case, present so a red-herring failure cannot be
    #: dismissed as the gate being uniformly harsh.
    NEGATIVE = "negative"


@dataclass(frozen=True)
class LabelledEdge:
    edge_key: EdgeKey
    label: EdgeLabel
    rationale: str
    source_refs: Tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if not self.rationale.strip():
            raise ValueError(
                f"{self.edge_key}: every labelled case states its rationale. A red herring "
                "without one cannot be told apart from an edge nobody got round to curating."
            )

    def as_dict(self) -> Dict[str, Any]:
        return {
            "edge_key": list(self.edge_key),
            "label": self.label.value,
            "rationale": self.rationale,
            "source_refs": list(self.source_refs),
        }


@dataclass(frozen=True)
class GateThresholds:
    """Pre-declared, and echoed into every result.

    Engineering choices rather than measured values, and asymmetric on purpose:
    the cost of a fabricated clinical edge is not the cost of a missed one.
    """

    min_recall: float = 0.60
    max_red_herring_rate: float = 0.10
    max_false_positive_rate: float = 0.20
    min_labelled_edges: int = 20
    #: Proposals the labelled set says nothing about. Above this share, the
    #: evaluation is not measuring the learner — it is measuring the fraction of
    #: its output anybody happened to label.
    max_unlabelled_proposal_rate: float = 0.30

    def as_dict(self) -> Dict[str, Any]:
        return {
            "min_recall": self.min_recall,
            "max_red_herring_rate": self.max_red_herring_rate,
            "max_false_positive_rate": self.max_false_positive_rate,
            "min_labelled_edges": self.min_labelled_edges,
            "max_unlabelled_proposal_rate": self.max_unlabelled_proposal_rate,
            "declared_before_results": True,
        }


@dataclass(frozen=True)
class GateResult:
    """Whether an experiment may proceed, and every number behind that.

    `passed` is never the only thing reported. A gate that returned a bare
    boolean would be read as a certificate, and this is a threshold comparison
    on ~24 hand-labelled edges from three curated subgraphs — enough to catch a
    learner that fabricates, nowhere near enough to establish that one works.
    """

    passed: bool
    experiment: str
    model_version: str
    data_version: str
    proposals_scored: int
    held_out_total: int
    held_out_recovered: int
    red_herrings_total: int
    red_herrings_proposed: int
    negatives_total: int
    negatives_proposed: int
    unlabelled_proposals: int
    thresholds: GateThresholds
    blocking_reasons: Tuple[str, ...]
    recovered_edges: Tuple[EdgeKey, ...]
    proposed_red_herrings: Tuple[EdgeKey, ...]

    @property
    def recall(self) -> Optional[float]:
        if not self.held_out_total:
            return None
        return round(self.held_out_recovered / self.held_out_total, 6)

    @property
    def red_herring_rate(self) -> Optional[float]:
        if not self.red_herrings_total:
            return None
        return round(self.red_herrings_proposed / self.red_herrings_total, 6)

    @property
    def false_positive_rate(self) -> Optional[float]:
        if not self.negatives_total:
            return None
        return round(self.negatives_proposed / self.negatives_total, 6)

    @property
    def unlabelled_rate(self) -> Optional[float]:
        if not self.proposals_scored:
            return None
        return round(self.unlabelled_proposals / self.proposals_scored, 6)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "passed": self.passed,
            "experiment": self.experiment,
            "model_version": self.model_version,
            "data_version": self.data_version,
            "recall": self.recall,
            "red_herring_rate": self.red_herring_rate,
            "false_positive_rate": self.false_positive_rate,
            "unlabelled_rate": self.unlabelled_rate,
            "counts": {
                "proposals_scored": self.proposals_scored,
                "held_out_total": self.held_out_total,
                "held_out_recovered": self.held_out_recovered,
                "red_herrings_total": self.red_herrings_total,
                "red_herrings_proposed": self.red_herrings_proposed,
                "negatives_total": self.negatives_total,
                "negatives_proposed": self.negatives_proposed,
                "unlabelled_proposals": self.unlabelled_proposals,
            },
            "thresholds": self.thresholds.as_dict(),
            "blocking_reasons": list(self.blocking_reasons),
            "recovered_edges": [list(key) for key in self.recovered_edges],
            "proposed_red_herrings": [list(key) for key in self.proposed_red_herrings],
            "interpretation": (
                "A threshold comparison over a small hand-labelled set from three curated "
                "subgraphs. Passing means a learner did not fabricate on the cases we "
                "thought to write down; it is not evidence that the learner works, and it "
                "does not substitute for the human review `revision.promote` requires."
            ),
        }


@lru_cache(maxsize=None)
def load_cases(path: Optional[Path] = None) -> Tuple[Tuple[LabelledEdge, ...], GateThresholds]:
    """The pre-declared cases and thresholds.

    Cached, because the file is a constant of the build. Pass an explicit path to
    load an alternative set — a test does, and an experiment that does should say
    so in its write-up, because a gate whose cases were chosen after the results
    is not a gate.
    """
    document = yaml.safe_load((path or CASES_PATH).read_text(encoding="utf-8"))

    cases: List[LabelledEdge] = []
    for entry in document.get("cases", []):
        edge = entry["edge"]
        cases.append(
            LabelledEdge(
                edge_key=(str(edge[0]), str(edge[1]), str(edge[2])),
                label=EdgeLabel(entry["label"]),
                rationale=str(entry.get("rationale", "")),
                source_refs=tuple(entry.get("source_refs", ()) or ()),
            )
        )

    declared = document.get("thresholds", {})
    thresholds = GateThresholds(
        min_recall=float(declared.get("min_recall", 0.60)),
        max_red_herring_rate=float(declared.get("max_red_herring_rate", 0.10)),
        max_false_positive_rate=float(declared.get("max_false_positive_rate", 0.20)),
        min_labelled_edges=int(declared.get("min_labelled_edges", 20)),
        max_unlabelled_proposal_rate=float(declared.get("max_unlabelled_proposal_rate", 0.30)),
    )
    return tuple(cases), thresholds


def evaluate_proposals(
    proposals: Sequence[CandidateEdge],
    experiment: str,
    cases: Optional[Sequence[LabelledEdge]] = None,
    thresholds: Optional[GateThresholds] = None,
) -> GateResult:
    """Score a set of proposed edges against the pre-declared cases.

    `proposals` are `CandidateEdge`s because that is the only shape a learner may
    emit — carrying model version, data version, confidence and counterevidence.
    A proposal set is not scored at all if its members disagree about which model
    produced them, since the result would describe no single experiment.

    Confidence is deliberately not used as a filter. A learner that wants a
    threshold applies it before calling; the gate scores what it is given, so
    "we would have passed at 0.9" is a claim someone has to make out loud rather
    than one the gate makes for them.
    """
    loaded_cases, loaded_thresholds = load_cases()
    cases = tuple(cases) if cases is not None else loaded_cases
    thresholds = thresholds or loaded_thresholds

    model_versions = {proposal.model_version for proposal in proposals}
    data_versions = {proposal.data_version for proposal in proposals}

    proposed_keys = {proposal.edge_key for proposal in proposals}
    by_label: Dict[EdgeLabel, List[LabelledEdge]] = {label: [] for label in EdgeLabel}
    for case in cases:
        by_label[case.label].append(case)

    labelled_keys = {case.edge_key for case in cases}
    held_out = by_label[EdgeLabel.HELD_OUT_TRUE]
    red_herrings = by_label[EdgeLabel.RED_HERRING]
    negatives = by_label[EdgeLabel.NEGATIVE]

    recovered = tuple(sorted(case.edge_key for case in held_out if case.edge_key in proposed_keys))
    proposed_red_herrings = tuple(
        sorted(case.edge_key for case in red_herrings if case.edge_key in proposed_keys)
    )
    proposed_negatives = [case for case in negatives if case.edge_key in proposed_keys]
    unlabelled = sorted(key for key in proposed_keys if key not in labelled_keys)

    result = GateResult(
        passed=False,
        experiment=experiment,
        model_version=_single(model_versions),
        data_version=_single(data_versions),
        proposals_scored=len(proposed_keys),
        held_out_total=len(held_out),
        held_out_recovered=len(recovered),
        red_herrings_total=len(red_herrings),
        red_herrings_proposed=len(proposed_red_herrings),
        negatives_total=len(negatives),
        negatives_proposed=len(proposed_negatives),
        unlabelled_proposals=len(unlabelled),
        thresholds=thresholds,
        blocking_reasons=(),
        recovered_edges=recovered,
        proposed_red_herrings=proposed_red_herrings,
    )

    blocking = _blocking_reasons(result, len(cases), model_versions, data_versions)
    return replace(result, blocking_reasons=tuple(blocking), passed=not blocking)


def _blocking_reasons(
    result: GateResult,
    case_count: int,
    model_versions: Iterable[str],
    data_versions: Iterable[str],
) -> List[str]:
    """Everything that stops this experiment proceeding. Fails closed."""
    thresholds = result.thresholds
    reasons: List[str] = []

    if case_count < thresholds.min_labelled_edges:
        reasons.append(
            f"{case_count} labelled case(s); {thresholds.min_labelled_edges} required. "
            "A learner is not cleared by an evaluation set too small to catch it."
        )

    model_set, data_set = set(model_versions), set(data_versions)
    if len(model_set) > 1 or len(data_set) > 1:
        reasons.append(
            f"proposals come from {len(model_set)} model version(s) and {len(data_set)} data "
            "version(s); a mixed set describes no single experiment and cannot be retracted by version"
        )
    if not result.proposals_scored:
        reasons.append("no proposals were supplied; there is nothing to evaluate")

    recall = result.recall
    if recall is None:
        reasons.append("no held-out edges in the case set; recall is undefined")
    elif recall < thresholds.min_recall:
        reasons.append(
            f"recall {recall} is below the declared minimum {thresholds.min_recall} — "
            "the learner did not recover enough structure that is actually there"
        )

    red_herring_rate = result.red_herring_rate
    if red_herring_rate is None:
        reasons.append("no red-herring cases in the set; the failure mode that matters is unmeasured")
    elif red_herring_rate > thresholds.max_red_herring_rate:
        reasons.append(
            f"red-herring rate {red_herring_rate} exceeds {thresholds.max_red_herring_rate} — "
            f"proposed {', '.join('->'.join(key) for key in result.proposed_red_herrings)}. "
            "These are plausible-sounding claims the curation deliberately declines to make."
        )

    false_positive_rate = result.false_positive_rate
    if false_positive_rate is not None and false_positive_rate > thresholds.max_false_positive_rate:
        reasons.append(
            f"false-positive rate {false_positive_rate} on unrelated pairs exceeds "
            f"{thresholds.max_false_positive_rate}"
        )

    unlabelled_rate = result.unlabelled_rate
    if unlabelled_rate is not None and unlabelled_rate > thresholds.max_unlabelled_proposal_rate:
        reasons.append(
            f"{unlabelled_rate} of proposals are unlabelled, above {thresholds.max_unlabelled_proposal_rate}. "
            "The evaluation would be measuring how much of the output happened to be labelled, "
            "not how good it is."
        )

    return reasons


def _single(values: Iterable[str]) -> str:
    ordered = sorted(set(values))
    if not ordered:
        return "none"
    return ordered[0] if len(ordered) == 1 else "mixed:" + ",".join(ordered)


def gate_summary() -> Dict[str, Any]:
    """The declared cases and thresholds, for a doc test or a response."""
    cases, thresholds = load_cases()
    counts: Dict[str, int] = {label.value: 0 for label in EdgeLabel}
    for case in cases:
        counts[case.label.value] += 1
    return {
        "cases_path": str(CASES_PATH.name),
        "case_counts": counts,
        "thresholds": thresholds.as_dict(),
        "purpose": (
            "Structure-learning experiments (#99, #100) are evaluated here before any "
            "product use. Passing makes a candidate eligible for human review; it is not "
            "a substitute for the review `revision.promote` requires."
        ),
    }
