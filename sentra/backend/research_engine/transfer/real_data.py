"""#215 — the real-data side: built, wired, and stopped.

`score_real_export` is the function that will score the pilot. Every step it
will need exists and is the same code the synthetic dry run exercises — the
same `evaluate_dataset`, `rank_evaluations` and `compare_rankings`. What stops
it is the order of the checks, each of which refuses on its own:

1. an approval record from every required role, for evaluation (and for
   fitting, if the plan fits on real data) — `real_data_approval_*`;
2. a frozen pre-registration — `preregistration_not_frozen`;
3. a plan built from that frozen pre-registration — `analysis_plan_not_confirmatory`;
4. a confirmatory seal of the synthetic ranking, unchanged since sealing, made
   under this pre-registration and this plan — `seal_*`;
5. the consent gate and, inside it, the v0 contract — `real_data_refused`.

Step 5 refuses every real row today, whatever steps 1–4 found. That is the
"stopped" in "built and stopped": when the server-side consent check the
contract describes exists and a reviewed change lets real rows through, this
function runs as written. Until then, the only way to see it work is the dry
run, with synthetic data in the real data's place.
"""

from __future__ import annotations

from typing import Any, Dict, Iterable, Mapping, Optional, Sequence

from ..contracts.errors import ContractViolation
from .codes import TransferCode
from .consent_gate import (
    OPERATION_EVALUATE,
    OPERATION_FIT,
    RealDataApproval,
    dataset_from_research_export,
    require_real_data_approval,
)
from .forecasting import evaluate_dataset
from .plan import FIT_TARGET_SPLIT, AnalysisPlan
from .preregistration import Preregistration, require_frozen
from .ranking import compare_rankings, rank_evaluations
from .schema import TransferDataset
from .seal import require_confirmatory_seal, verify_seal


def score_real_export(
    rows: Sequence[Mapping[str, Any]],
    *,
    approvals: Optional[Sequence[RealDataApproval]],
    preregistration: Optional[Preregistration],
    plan: AnalysisPlan,
    seal: Any,
    selection: TransferDataset,
    withdrawn_codes: Iterable[str] = (),
    dataset_id: str = "pilot-research-export",
) -> Dict[str, Any]:
    require_real_data_approval(approvals, OPERATION_EVALUATE)
    if FIT_TARGET_SPLIT in plan.fit_modes:
        require_real_data_approval(approvals, OPERATION_FIT)
    if preregistration is None:
        raise ContractViolation(
            TransferCode.PREREGISTRATION_NOT_FROZEN, "事前登録が渡されていません。", "preregistration"
        )
    frozen = require_frozen(preregistration)
    plan.require_confirmatory()
    if plan.preregistration_hash != frozen.content_hash:
        raise ContractViolation(
            TransferCode.PLAN_MISMATCH,
            "解析計画が、いま凍結されている事前登録から作られていません。",
            "plan.preregistration_hash",
        )

    record = verify_seal(seal)
    require_confirmatory_seal(record)
    if record["preregistration_hash"] != frozen.content_hash:
        raise ContractViolation(
            TransferCode.SEAL_MISMATCH,
            "封印は別の事前登録の下で作られています。",
            "seal.preregistration_hash",
        )
    if record["plan_hash"] != plan.content_hash():
        raise ContractViolation(TransferCode.PLAN_MISMATCH, "封印と採点で解析計画が違います。", "seal.plan_hash")

    dataset = dataset_from_research_export(rows, dataset_id=dataset_id)
    gate = {"approvals": approvals, "preregistration": preregistration, "withdrawn_codes": tuple(withdrawn_codes)}
    results: Dict[str, Any] = {}
    for fit_mode in plan.fit_modes:
        evaluated = evaluate_dataset(dataset, plan, fit_mode=fit_mode, selection=selection, gate_kwargs=gate)
        ranking = rank_evaluations(evaluated, plan)
        results[fit_mode] = {"ranking": ranking, "comparison": compare_rankings(record["ranking"], ranking)}
    return {"seal_hash": record["seal_hash"], "results": results}
