"""Entry gates for the learned stages of #102 — Stage 2 partial pooling (#99)
and Stage 3 relation-specific attention (#100).

#99 forbids fitting a hierarchical model until four things are true: a
data-sufficiency analysis has defined the required observations, enough real
consented data exists, a governance/ethics review has approved the analysis,
and the estimand and its non-diagnostic use are written down. #100 forbids
training relation-specific attention until the deterministic baseline is
stable, training volume and label quality pass a documented sufficiency gate,
and a #90-style pre-registration states the hypothesis and what would falsify
it. This module is those sentences as code. **It fits nothing, trains nothing,
reads no data, and estimates nothing.**

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

Until then each `evaluate_stage*_entry_gate()` returns `open=False` with every
reason as a stable code, and the stage's output is its fallback: Stage 2's is
`not_enough_data`, never a fixed population default (#91); Stage 3's is the
deterministic relation-aware traversal (#96), which is what ships today.

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
from typing import Any, Dict, List, Mapping, Optional, Tuple

from ..analytics.data_sufficiency import (
    REQUIREMENT_EXCEEDS_DESIGN,
    REQUIREMENT_UNDECIDED,
    ObservationRequirement,
    ObservedCounts,
    SufficiencyAssessment,
    assess_observation_sufficiency,
)
from .schema import RELATIONS

#: Reason codes this module adds to the sufficiency codes. Stable strings.
PREREGISTRATION_INCOMPLETE = "preregistration_incomplete"
PREREGISTRATION_NOT_FROZEN = "preregistration_not_frozen"
REQUIREMENT_NOT_FROM_PREREGISTRATION = "observation_requirement_not_from_this_preregistration"
ESTIMAND_UNDECIDED = "estimand_undecided"
INTENDED_USE_UNDECIDED = "intended_use_undecided"
GOVERNANCE_APPROVAL_MISSING = "governance_approval_missing"
GOVERNANCE_APPROVAL_OUT_OF_SCOPE = "governance_approval_out_of_scope"
HYPOTHESIS_UNDECIDED = "hypothesis_undecided"
FALSIFICATION_UNDECIDED = "falsification_undecided"
BASELINE_NOT_PINNED = "deterministic_baseline_not_pinned"
BASELINE_CHANGED_SINCE_PINNED = "deterministic_baseline_changed_since_pinned"
LABEL_REQUIREMENT_UNDECIDED = "label_requirement_undecided"
HUMAN_LABELS_UNCOUNTED = "human_labels_uncounted"
TOO_FEW_HUMAN_LABELS = "too_few_human_labelled_cases"
AGREEMENT_UNMEASURED = "inter_rater_agreement_unmeasured"
AGREEMENT_BELOW_REQUIREMENT = "inter_rater_agreement_below_requirement"

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
    #: Stage 3 only. Benchmark cases whose evidence paths a human labelled (#88),
    #: and the measured agreement between raters. `None` is "not counted" /
    #: "not measured", which is not the same as zero.
    human_labelled_cases: Optional[int] = None
    inter_rater_agreement: Optional[float] = None


def current_evidence() -> StageEvidence:
    """The evidence this repository holds, as of this commit.

    No real data is read — there is no code path that could read it — and no
    governance approval of either learned stage has been recorded. The one thing
    the repository can count is how many #88 benchmark cases carry human labels;
    no inter-rater agreement has been measured. Written as a function rather than
    left implicit so the closed state is something a test asserts, not something
    a reader infers.
    """
    # Imported here, not at module level: the benchmark belongs to another
    # workstream, and the gates should not fail to import because it moved.
    from ..services.benchmark_cases import CASE_COMPOSITION

    return StageEvidence(human_labelled_cases=int(CASE_COMPOSITION["human_labelled"]))


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


# ── Stage 3: relation-specific attention (#100) ──────────────────────────────

STAGE3 = "stage3_relation_attention"

#: What a closed Stage 3 leaves in place: the fixed-rule traversal of #96, the
#: only path-producing output the product has.
DETERMINISTIC_TRAVERSAL = "deterministic_traversal"

#: Mirrors `sentra/docs/stage3_relation_attention_preregistration.md`.
STAGE3_PREREGISTRATION = Preregistration(
    stage=STAGE3,
    issue="#100",
    version="stage3-prereg-draft-0",
    document="sentra/docs/stage3_relation_attention_preregistration.md",
    items=(
        PreregistrationItem("hypothesis", "仮説"),
        PreregistrationItem("falsification", "反証条件"),
        PreregistrationItem("primary_metric", "主要評価指標"),
        PreregistrationItem("baseline_versions", "比較に固定する決定論的基準の版"),
        PreregistrationItem("ablations", "ablation の組"),
        PreregistrationItem("per_language_reporting", "言語別の報告と判定"),
        PreregistrationItem("train_split", "版付きの学習分割"),
        PreregistrationItem("seeds", "seed の数と分散の報告"),
        PreregistrationItem("calibration", "較正の基準"),
        PreregistrationItem("failure_families", "失敗ファミリー"),
        PreregistrationItem("attribution_evaluation", "帰属の評価"),
        PreregistrationItem("required_observations", "必要な観測量"),
        PreregistrationItem("label_requirement", "人手ラベルの量と一致度"),
        PreregistrationItem("consent_scope", "必要な同意の範囲"),
        PreregistrationItem("governance_body", "承認の主体と記録の置き場所"),
        PreregistrationItem(
            "comparators",
            "比較対象",
            decided="keyword; deterministic traversal (#96); relation-agnostic GNN; type/provenance ablations",
            fixed_by="#100 acceptance criteria",
        ),
        PreregistrationItem(
            "educator_exposure",
            "教職員向けの出力",
            decided="outputs without an attributable observation path are excluded",
            fixed_by="#100 acceptance criteria, #102",
        ),
        PreregistrationItem(
            "online_learning", "参加者からのオンライン学習", decided="none", fixed_by="#100 acceptance criteria"
        ),
        PreregistrationItem(
            "attention_as_explanation",
            "注意重みの扱い",
            decided="raw attention weights are model internals, not validated explanations",
            fixed_by="#100 acceptance criteria, #102",
        ),
    ),
)

#: One learned parameter set per relation type, so each type needs its own data.
STAGE3_OBSERVATION_REQUIREMENT = ObservationRequirement(
    stage=STAGE3,
    must_decide=(
        "min_participants",
        "min_days_per_participant",
        "min_effective_sample_size",
        "min_edges_per_relation_type",
    ),
    relation_types=tuple(RELATIONS),
)


@dataclass(frozen=True)
class LabelRequirement:
    """Label quality #100 needs. `None` is 未決定 — a pre-registration item."""

    min_human_labelled_cases: Optional[int] = None
    min_inter_rater_agreement: Optional[float] = None
    #: Which statistic `min_inter_rater_agreement` is stated in (kappa, alpha, ...).
    agreement_statistic: Optional[str] = None

    def undecided(self) -> Tuple[str, ...]:
        return tuple(
            name
            for name in ("min_human_labelled_cases", "min_inter_rater_agreement", "agreement_statistic")
            if getattr(self, name) is None
        )


STAGE3_LABEL_REQUIREMENT = LabelRequirement()

_BASELINE_STABLE = "deterministic_baseline_stable"
_TRAINING_DATA_SUFFICIENT = "training_data_sufficient"
_LABEL_QUALITY = "label_quality_sufficient"
_HYPOTHESIS_PREREGISTERED = "hypothesis_and_falsification_preregistered"


def current_baseline_versions() -> Dict[str, str]:
    """The deterministic contract a Stage 3 model would be compared against."""
    from ..temporal.model import CONTRACT_VERSION
    from ..traversal.relations import RELATION_RULES_VERSION
    from ..traversal.walk import GRAPH_TRAVERSAL_VERSION

    return {
        "temporal_graph": CONTRACT_VERSION,
        "relation_rules": RELATION_RULES_VERSION,
        "traversal": GRAPH_TRAVERSAL_VERSION,
    }


def evaluate_stage3_entry_gate(evidence: Optional[StageEvidence] = None) -> EntryGateDecision:
    """#100's Entry Gate. Closed unless every condition holds; every failure is listed."""
    evidence = evidence if evidence is not None else current_evidence()
    prereg = STAGE3_PREREGISTRATION
    requirement = STAGE3_OBSERVATION_REQUIREMENT

    reasons = _baseline_reasons(prereg, current_baseline_versions())

    sufficiency = assess_observation_sufficiency(requirement, evidence.observed)
    reasons.extend(
        GateReason(_TRAINING_DATA_SUFFICIENT, reason.code, reason.detail) for reason in sufficiency.reasons
    )
    reasons.extend(_requirement_provenance(requirement, prereg))
    reasons.extend(_label_reasons(STAGE3_LABEL_REQUIREMENT, evidence))

    for key, code in (("hypothesis", HYPOTHESIS_UNDECIDED), ("falsification", FALSIFICATION_UNDECIDED)):
        if prereg.item(key).decided is None:
            reasons.append(
                GateReason(
                    _HYPOTHESIS_PREREGISTERED,
                    code,
                    f"{prereg.item(key).title} ({key}) is 未決定 in {prereg.document}",
                )
            )
    # Real data needs an approval whatever the claim; #100 makes no synthetic-only exception
    # for anything that could reach a product surface.
    reasons.extend(_approval_reasons(prereg, evidence.approvals))
    reasons.extend(
        _preregistration_reasons(prereg, exclude=("hypothesis", "falsification", "baseline_versions"))
    )

    return EntryGateDecision(
        stage=prereg.stage,
        issue=prereg.issue,
        open=not reasons,
        reasons=tuple(reasons),
        fallback=DETERMINISTIC_TRAVERSAL,
        preregistration_version=prereg.version,
        sufficiency=sufficiency,
    )


def _baseline_reasons(prereg: Preregistration, versions: Mapping[str, str]) -> List[GateReason]:
    """Whether the baseline is stable is a declaration, so the pre-registration pins it.

    Pinned as `name=version` pairs separated by `;`. A pin that no longer matches
    the code means the baseline moved after the comparison was registered.
    """
    current = "; ".join(f"{name}={version}" for name, version in sorted(versions.items()))
    pinned = prereg.item("baseline_versions").decided
    if pinned is None:
        return [
            GateReason(
                _BASELINE_STABLE,
                BASELINE_NOT_PINNED,
                f"no deterministic baseline version is pinned in {prereg.document}; current: {current}",
            )
        ]
    if pinned != current:
        return [
            GateReason(
                _BASELINE_STABLE,
                BASELINE_CHANGED_SINCE_PINNED,
                f"pinned {pinned!r}, but the code is now {current!r}",
            )
        ]
    return []


def _label_reasons(requirement: LabelRequirement, evidence: StageEvidence) -> List[GateReason]:
    reasons: List[GateReason] = []
    count = evidence.human_labelled_cases
    undecided = requirement.undecided()
    if undecided:
        reasons.append(
            GateReason(
                _LABEL_QUALITY,
                LABEL_REQUIREMENT_UNDECIDED,
                f"{', '.join(undecided)} 未決定 (label_requirement). #88 sized the case set at 60-100; "
                "how many must be human-labelled, and at what agreement, is not decided",
            )
        )
    if count is None:
        reasons.append(GateReason(_LABEL_QUALITY, HUMAN_LABELS_UNCOUNTED, "human-labelled cases were not counted"))
    elif requirement.min_human_labelled_cases is None or count < requirement.min_human_labelled_cases:
        reasons.append(
            GateReason(
                _LABEL_QUALITY,
                TOO_FEW_HUMAN_LABELS,
                f"{count} benchmark case(s) carry human-labelled evidence paths"
                + (
                    f"; {requirement.min_human_labelled_cases} required"
                    if requirement.min_human_labelled_cases is not None
                    else "; the minimum is undecided, and no count clears an undecided minimum"
                ),
            )
        )
    agreement = evidence.inter_rater_agreement
    if agreement is None:
        reasons.append(
            GateReason(_LABEL_QUALITY, AGREEMENT_UNMEASURED, "no inter-rater agreement has been measured")
        )
    elif requirement.min_inter_rater_agreement is None or agreement < requirement.min_inter_rater_agreement:
        reasons.append(
            GateReason(
                _LABEL_QUALITY,
                AGREEMENT_BELOW_REQUIREMENT,
                f"agreement {agreement} does not clear "
                + (
                    str(requirement.min_inter_rater_agreement)
                    if requirement.min_inter_rater_agreement is not None
                    else "an undecided minimum"
                ),
            )
        )
    return reasons


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
