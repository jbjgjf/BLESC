"""Violation codes specific to the transfer study.

They are raised through the shared `ContractViolation`, so a caller branches
on them the same way as on the contract codes. They live here rather than in
`contracts/errors.py` because that package is owned by T0 and the rule there is
"add, never repurpose" through T0. Where an existing code already says the
right thing (`real_data_refused`, `permission_not_granted`, `future_leakage`,
`split_overlap`) it is used instead of a new one.
"""

from __future__ import annotations


class TransferCode:
    """Stable machine codes. Add, never repurpose."""

    PREREGISTRATION_STRUCTURE = "preregistration_structure_changed"
    PREREGISTRATION_NOT_FREEZABLE = "preregistration_not_freezable"
    PREREGISTRATION_NOT_FROZEN = "preregistration_not_frozen"

    APPROVAL_MISSING = "real_data_approval_missing"
    APPROVAL_INCOMPLETE = "real_data_approval_incomplete"
    APPROVAL_VERSION_MISMATCH = "real_data_approval_version_mismatch"
    OPERATION_NOT_PERMITTED = "operation_not_permitted"

    PLAN_NOT_CONFIRMATORY = "analysis_plan_not_confirmatory"
    PLAN_MISMATCH = "analysis_plan_mismatch"
    PROTOCOL_SHAPE_MISMATCH = "protocol_shape_mismatch"
    TRUTH_IN_MODEL_INPUT = "generation_truth_in_model_input"
    SPLIT_KINDS_MIXED = "split_kinds_mixed"

    SEAL_EXISTS = "seal_already_exists"
    SEAL_MISMATCH = "seal_content_mismatch"
    SEAL_NOT_CONFIRMATORY = "seal_not_confirmatory"

    PROVIDER_CALLS_DISABLED = "provider_calls_disabled"
    BUDGET_EXCEEDED = "provider_budget_exceeded"
    NON_SYNTHETIC_PROMPT_INPUT = "non_synthetic_prompt_input"

    AUDIT_METRIC_SET_MISMATCH = "audit_metric_set_mismatch"
    POST_HOC_GENERATOR_MIXED = "post_hoc_generator_mixed"
