"""Entry gates for the learned stages of #102 — Stage 2 partial pooling (#99).

#99 forbids fitting a hierarchical model until four things are true: a
data-sufficiency analysis has defined the required observations, enough real
consented data exists, a governance/ethics review has approved the analysis,
and the estimand and its non-diagnostic use are written down. This module is
that sentence as code. **It fits nothing, reads no data, and estimates nothing.**

**Nothing here opens a gate.** There is no flag, environment variable or
argument that does. A gate opens only when all of these exist at once:

1. a reviewed change that fills in the pre-registration below and the
   observation requirement it points at — today every research decision in
   them is `None`, which is 未決定;
2. counts of real, consented observations, assembled by someone with lawful
   access, passed in as `StageEvidence.observed` — this repository has no path
   that reads them, by design;
3. a pointer to a governance approval whose scope names this stage and this
   pre-registration version.

Until then `evaluate_stage2_entry_gate()` returns `open=False` with every
reason as a stable code, and the stage's output is its fallback,
`not_enough_data` — never a fixed population default (#91).

Three gates sit at three different moments and are not interchangeable:

- the **entry gate** (here) — may fitting begin at all;
- the **evaluation gate** (`evolution/gate.py`) — after a learner proposes
  edges, did it fabricate any;
- the **educator-facing invariant** — may a given output reach an educator.

Passing one says nothing about the others.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Any, Dict, List, Optional, Tuple

from ..analytics.data_sufficiency import (
    REQUIREMENT_EXCEEDS_DESIGN,
    REQUIREMENT_UNDECIDED,
    ObservationRequirement,
    ObservedCounts,
    SufficiencyAssessment,
    assess_observation_sufficiency,
)

#: Reason codes this module adds to the sufficiency codes. Stable strings.
PREREGISTRATION_INCOMPLETE = "preregistration_incomplete"
PREREGISTRATION_NOT_FROZEN = "preregistration_not_frozen"
REQUIREMENT_NOT_FROM_PREREGISTRATION = "observation_requirement_not_from_this_preregistration"
ESTIMAND_UNDECIDED = "estimand_undecided"
INTENDED_USE_UNDECIDED = "intended_use_undecided"
GOVERNANCE_APPROVAL_MISSING = "governance_approval_missing"
GOVERNANCE_APPROVAL_OUT_OF_SCOPE = "governance_approval_out_of_scope"

#: What a closed or rolled-back Stage 2 returns. The same string the
#: orchestrator writes below the personal-baseline gate, so a consumer sees one
#: answer for "not enough data" whichever gate said it.
NOT_ENOUGH_DATA = "not_enough_data"


@dataclass(frozen=True)
class PreregistrationItem:
    """One decision the pre-registration has to record. `decided is None` is 未決定."""

    key: str
    title: str
    decided: Optional[str] = None
    #: Where a decided value came from, when an issue rather than the
    #: pre-registration fixed it.
    fixed_by: str = ""


@dataclass(frozen=True)
class Preregistration:
    stage: str
    issue: str
    version: str
    document: str
    items: Tuple[PreregistrationItem, ...]
    #: Commit at which the document was frozen. `None` until someone freezes it,
    #: after every item is decided and reviewed and before any real data is seen.
    frozen_at: Optional[str] = None

    def __post_init__(self) -> None:
        keys = [item.key for item in self.items]
        if len(keys) != len(set(keys)):
            raise ValueError(f"{self.stage}: duplicate pre-registration keys")

    def item(self, key: str) -> PreregistrationItem:
        for item in self.items:
            if item.key == key:
                return item
        raise KeyError(key)

    def undecided(self) -> Tuple[str, ...]:
        return tuple(item.key for item in self.items if item.decided is None)


@dataclass(frozen=True)
class GovernanceApproval:
    """A pointer to an approval that a person or committee gave — not the approval.

    The gate cannot verify a signature. It can check that the pointer exists and
    that what was approved is this stage at this pre-registration version, so
    that an approval of the pilot protocol, or of last month's draft, is not
    mistaken for an approval of the analysis.
    """

    record_ref: str
    approving_body: str
    stage: str
    preregistration_version: str
    approved_on: date


@dataclass(frozen=True)
class StageEvidence:
    """What a caller can attest to. Empty by default, because that is the truth today."""

    observed: Optional[ObservedCounts] = None
    approvals: Tuple[GovernanceApproval, ...] = ()


def current_evidence() -> StageEvidence:
    """The evidence this repository holds, as of this commit: none.

    No real data is read — there is no code path that could read it — and no
    governance approval of either learned stage has been recorded. Written as a
    function rather than left implicit so the closed state is something a test
    asserts, not something a reader infers.
    """
    return StageEvidence()


@dataclass(frozen=True)
class GateReason:
    #: Which Entry Gate condition this reason belongs to.
    condition: str
    code: str
    detail: str

    def as_dict(self) -> Dict[str, str]:
        return {"condition": self.condition, "code": self.code, "detail": self.detail}


@dataclass(frozen=True)
class EntryGateDecision:
    stage: str
    issue: str
    open: bool
    reasons: Tuple[GateReason, ...]
    #: What the stage returns while closed, and what a rollback returns to.
    fallback: str
    preregistration_version: str
    sufficiency: SufficiencyAssessment

    @property
    def codes(self) -> Tuple[str, ...]:
        return tuple(reason.code for reason in self.reasons)

    @property
    def conditions_failing(self) -> Tuple[str, ...]:
        return tuple(dict.fromkeys(reason.condition for reason in self.reasons))

    def as_dict(self) -> Dict[str, Any]:
        return {
            "stage": self.stage,
            "issue": self.issue,
            "open": self.open,
            "fallback": self.fallback,
            "preregistration_version": self.preregistration_version,
            "conditions_failing": list(self.conditions_failing),
            "reasons": [reason.as_dict() for reason in self.reasons],
            "sufficiency": self.sufficiency.as_dict(),
        }


# ── Stage 2: hierarchical partial pooling (#99) ──────────────────────────────

STAGE2 = "stage2_partial_pooling"

#: Mirrors `sentra/docs/stage2_partial_pooling_preregistration.md`, item for
#: item; `tests/test_learning_gates.py` fails if the two disagree. Values are
#: filled in only by a reviewed change to both — never by the gate's author.
STAGE2_PREREGISTRATION = Preregistration(
    stage=STAGE2,
    issue="#99",
    version="stage2-prereg-draft-0",
    document="sentra/docs/stage2_partial_pooling_preregistration.md",
    items=(
        PreregistrationItem("estimand", "推定対象"),
        PreregistrationItem("intended_use", "非診断の用途"),
        PreregistrationItem("likelihood", "尤度"),
        PreregistrationItem("priors", "事前分布"),
        PreregistrationItem("participant_effects", "参加者効果の構造"),
        PreregistrationItem("missing_data", "欠測の仮定"),
        PreregistrationItem("evaluation_split", "評価分割の方式"),
        PreregistrationItem("posterior_predictive_checks", "事後予測チェック"),
        PreregistrationItem("calibration", "較正の基準"),
        PreregistrationItem("sensitivity_analysis", "感度分析"),
        PreregistrationItem("pooling_check", "プーリングが弱まることの確認"),
        PreregistrationItem("required_observations", "必要な観測量"),
        PreregistrationItem("planning_icc", "計画上の級内相関"),
        PreregistrationItem("consent_scope", "必要な同意の範囲"),
        PreregistrationItem("governance_body", "承認の主体と記録の置き場所"),
        PreregistrationItem(
            "rollback", "ロールバック先", decided=NOT_ENOUGH_DATA, fixed_by="#99 acceptance criteria, #102"
        ),
        PreregistrationItem(
            "comparators",
            "比較対象",
            decided="personal-only estimate; not_enough_data policy",
            fixed_by="#99 acceptance criteria",
        ),
    ),
)

#: The observations Stage 2 needs. Every threshold is 未決定 until the
#: pre-registration's `required_observations` item fixes it.
STAGE2_OBSERVATION_REQUIREMENT = ObservationRequirement(
    stage=STAGE2,
    must_decide=("min_participants", "min_days_per_participant", "min_effective_sample_size"),
)

_REQUIRED_OBSERVATIONS_DEFINED = "required_observations_defined"
_ENOUGH_REAL_CONSENTED_DATA = "enough_real_consented_data"
_GOVERNANCE_APPROVAL = "governance_approval"
_ESTIMAND_DOCUMENTED = "estimand_and_intended_use_documented"
_PREREGISTRATION = "preregistration"


def evaluate_stage2_entry_gate(evidence: Optional[StageEvidence] = None) -> EntryGateDecision:
    """#99's Entry Gate. Closed unless every condition holds; every failure is listed."""
    evidence = evidence if evidence is not None else current_evidence()
    prereg = STAGE2_PREREGISTRATION
    requirement = STAGE2_OBSERVATION_REQUIREMENT

    sufficiency = assess_observation_sufficiency(requirement, evidence.observed)
    reasons = _sufficiency_reasons(sufficiency)
    reasons.extend(_requirement_provenance(requirement, prereg))
    reasons.extend(_approval_reasons(prereg, evidence.approvals))

    for key, code in (("estimand", ESTIMAND_UNDECIDED), ("intended_use", INTENDED_USE_UNDECIDED)):
        if prereg.item(key).decided is None:
            reasons.append(
                GateReason(
                    _ESTIMAND_DOCUMENTED,
                    code,
                    f"{prereg.item(key).title} ({key}) is 未決定 in {prereg.document}",
                )
            )
    reasons.extend(_preregistration_reasons(prereg, exclude=("estimand", "intended_use")))

    return EntryGateDecision(
        stage=prereg.stage,
        issue=prereg.issue,
        open=not reasons,
        reasons=tuple(reasons),
        fallback=NOT_ENOUGH_DATA,
        preregistration_version=prereg.version,
        sufficiency=sufficiency,
    )


# ── shared condition checks ──────────────────────────────────────────────────


def _sufficiency_reasons(sufficiency: SufficiencyAssessment) -> List[GateReason]:
    """Sufficiency reasons, filed under the Entry Gate condition each one fails.

    An undecided or unreachable requirement means the *analysis* has not defined
    what is needed; everything else means the *data* is not there.
    """
    reasons: List[GateReason] = []
    for reason in sufficiency.reasons:
        condition = (
            _REQUIRED_OBSERVATIONS_DEFINED
            if reason.code in (REQUIREMENT_UNDECIDED, REQUIREMENT_EXCEEDS_DESIGN)
            else _ENOUGH_REAL_CONSENTED_DATA
        )
        reasons.append(GateReason(condition, reason.code, reason.detail))
    return reasons


def _requirement_provenance(requirement: ObservationRequirement, prereg: Preregistration) -> List[GateReason]:
    """Thresholds count only if this pre-registration is what fixed them."""
    if requirement.undecided() or requirement.decided_in == prereg.version:
        return []
    return [
        GateReason(
            _REQUIRED_OBSERVATIONS_DEFINED,
            REQUIREMENT_NOT_FROM_PREREGISTRATION,
            f"thresholds were fixed by {requirement.decided_in!r}, not by {prereg.version!r}",
        )
    ]


def _approval_reasons(prereg: Preregistration, approvals: Tuple[GovernanceApproval, ...]) -> List[GateReason]:
    if not approvals:
        return [
            GateReason(
                _GOVERNANCE_APPROVAL,
                GOVERNANCE_APPROVAL_MISSING,
                f"no governance/ethics approval of {prereg.stage} is recorded. Approvals of the pilot "
                "protocol or consent documents (docs/pilot/approvals.md) do not approve this analysis.",
            )
        ]
    in_scope = [
        approval
        for approval in approvals
        if approval.record_ref.strip()
        and approval.approving_body.strip()
        and approval.stage == prereg.stage
        and approval.preregistration_version == prereg.version
    ]
    if in_scope:
        return []
    seen = ", ".join(
        f"{approval.stage}@{approval.preregistration_version or '?'}" for approval in approvals
    )
    return [
        GateReason(
            _GOVERNANCE_APPROVAL,
            GOVERNANCE_APPROVAL_OUT_OF_SCOPE,
            f"approvals on record cover {seen}; none names {prereg.stage}@{prereg.version} with a "
            "record reference and an approving body",
        )
    ]


def _preregistration_reasons(prereg: Preregistration, exclude: Tuple[str, ...] = ()) -> List[GateReason]:
    reasons: List[GateReason] = []
    undecided = [key for key in prereg.undecided() if key not in exclude]
    if undecided:
        reasons.append(
            GateReason(
                _PREREGISTRATION,
                PREREGISTRATION_INCOMPLETE,
                f"未決定 in {prereg.document}: {', '.join(undecided)}",
            )
        )
    if prereg.frozen_at is None:
        reasons.append(
            GateReason(
                _PREREGISTRATION,
                PREREGISTRATION_NOT_FROZEN,
                f"{prereg.version} has not been frozen; a pre-registration frozen after real data "
                "was seen is not one",
            )
        )
    return reasons
