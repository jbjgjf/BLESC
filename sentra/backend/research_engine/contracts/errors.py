"""One exception type for every contract violation, with a machine code.

The contracts require refusals to be *legible*: a rejected handoff has to say
which rule it broke in a form another program can branch on, and in a form a
Japanese-reading researcher can act on. A bare `ValueError("bad input")` gives
neither, so every check in this package raises `ContractViolation` with a code
from `Code` and a Japanese explanation.

The codes are also the vocabulary of `reasons` in C3 and of `leakage_checks` in
C5, which is why they live here rather than next to whichever check first
needed them.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence


class Code:
    """Machine-readable violation codes. Stable; add, never repurpose."""

    MISSING_FIELD = "missing_field"
    UNKNOWN_FIELD = "unknown_field"
    WRONG_TYPE = "wrong_type"
    EMPTY_VALUE = "empty_value"

    NON_FINITE_NUMBER = "non_finite_number"
    NAIVE_TIMESTAMP = "naive_timestamp"
    BAD_TIMESTAMP = "bad_timestamp"

    LENGTH_MISMATCH = "length_mismatch"
    SHAPE_MISMATCH = "shape_mismatch"
    MASK_VALUE_MISMATCH = "mask_value_mismatch"

    SCHEMA_VERSION_MISMATCH = "schema_version_mismatch"
    FEATURE_SCHEMA_MISMATCH = "feature_schema_mismatch"
    ENCODER_MISMATCH = "encoder_mismatch"
    NORMALIZER_MISMATCH = "normalizer_mismatch"
    DIMENSION_MISMATCH = "dimension_mismatch"

    FUTURE_LEAKAGE = "future_leakage"
    TARGET_NOT_IN_FUTURE = "target_not_in_future"
    SMOOTHING_IN_ONLINE_EVAL = "smoothing_in_online_evaluation"
    SPLIT_OVERLAP = "split_overlap"
    NORMALIZER_FIT_ON_HELDOUT = "normalizer_fit_on_heldout"
    DUPLICATE_EVENT_ID = "duplicate_event_id"

    UNKNOWN_ENUM_VALUE = "unknown_enum_value"
    FORBIDDEN_CAPABILITY = "forbidden_capability"
    PERMISSION_NOT_GRANTED = "permission_not_granted"
    REAL_DATA_REFUSED = "real_data_refused"
    UNSUPPORTED_INTERVENTION = "unsupported_intervention"
    STATUS_PAYLOAD_MISMATCH = "status_payload_mismatch"
    UNCERTAINTY_WITHOUT_METHOD = "uncertainty_without_method"
    IDEMPOTENCY_CONFLICT = "idempotency_conflict"


@dataclass(frozen=True)
class ContractViolation(Exception):
    """A refused handoff.

    `path` is the dotted location inside the payload (`values[3]`,
    `metrics[1].interval`) so a producer can find the offending element without
    re-deriving it from the message.
    """

    code: str
    message_ja: str
    path: str = ""
    detail: Dict[str, Any] = field(default_factory=dict)

    def __str__(self) -> str:  # pragma: no cover - formatting only
        where = f" ({self.path})" if self.path else ""
        return f"[{self.code}]{where} {self.message_ja}"

    def as_dict(self) -> Dict[str, Any]:
        return {
            "code": self.code,
            "message_ja": self.message_ja,
            "path": self.path,
            "detail": dict(self.detail),
        }


@dataclass
class Reason:
    """A machine code plus a Japanese sentence, as C3 `reasons` requires."""

    code: str
    message_ja: str

    def as_dict(self) -> Dict[str, str]:
        return {"code": self.code, "message_ja": self.message_ja}

    @staticmethod
    def from_dict(payload: Dict[str, Any]) -> "Reason":
        return Reason(code=str(payload["code"]), message_ja=str(payload["message_ja"]))

    @staticmethod
    def list_as_dicts(reasons: Sequence["Reason"]) -> List[Dict[str, str]]:
        return [reason.as_dict() for reason in reasons]


def violations_as_dicts(errors: Sequence[ContractViolation]) -> List[Dict[str, Any]]:
    return [error.as_dict() for error in errors]


def first_or_none(errors: Sequence[ContractViolation]) -> Optional[ContractViolation]:
    return errors[0] if errors else None
