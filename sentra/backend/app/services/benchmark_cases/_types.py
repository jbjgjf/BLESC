"""The record types every family module builds.

Split out of the old single-file `benchmark_cases.py` when #88 grew the set from
6 cases to ~80. Nothing here changed shape except `labelled_by`, which gained a
third value — see below.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

#: `expected_evidence_ids` provenance, and the distinction #88 turns on.
#:
#: - ``draft``  — proposed by whoever wrote the case, model or person. NOT an
#:                answer key. A case in this state is excluded from the
#:                confirmatory analysis by `docs/benchmark_preregistration.md`.
#: - ``human``  — set from a rater file by `benchmark_labelling.apply_human_labels`.
#:                Only these count toward `human_labelled_count`.
#: - ``author`` — the pre-#88 development cases, kept as they were.
#:
#: The three exist as separate values rather than a boolean because "the author
#: guessed" and "two raters agreed" are different claims and the report has to
#: be able to say which one it is holding.
LABEL_PROVENANCE = ("author", "draft", "human")


@dataclass(frozen=True)
class EvidenceDay:
    evidence_id: str
    day: str
    text: str
    graph_motifs: Sequence[str]
    safety_label: str = "normal"


@dataclass(frozen=True)
class BenchmarkCase:
    case_id: str
    query: str
    #: Concepts the query is about. In the product these come from running the
    #: extraction over the query itself, so supplying them here is the input
    #: representation, not the answer — which days are relevant is still hidden.
    query_anchors: Sequence[str]
    evidence: Sequence[EvidenceDay]
    expected_evidence_ids: Sequence[str]
    expected_safety: str
    expected_policy: str
    research_note: str
    family: str
    lang: str = "en"
    #: Longest hop count needed to reach a target from an anchor. 0 means the
    #: answer is lexically present; 2 means no single day contains it.
    required_hops: int = 0
    labelled_by: str = "author"
    #: Cases built from the same source record in the other language. Carried
    #: explicitly so a per-language report can state how much of the ja/en
    #: comparison rests on matched material rather than inferring it from ids.
    pair_id: str | None = None
    #: train / validation / test, decided by which pool of curated edges the
    #: case's targets come from. See `_splits.py` — this is authored before the
    #: case is written, not assigned to it afterwards.
    split: str = "train"

    @property
    def is_human_labelled(self) -> bool:
        return self.labelled_by == "human"
