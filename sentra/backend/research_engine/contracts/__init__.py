"""C1–C6 types. Only T0 edits this package; other teams propose changes.

Importing from here rather than from the individual modules keeps the handoff
surface visible in one file: if a name is not exported below, it is not part of
the contract.
"""

from .capabilities import CapabilityFlags
from .common import (
    canonical_json,
    content_hash,
    elapsed_days,
    file_hash,
    format_time,
    parse_optional_time,
    parse_time,
)
from .encoded import EncodedSequence, EncoderDescriptor
from .errors import Code, ContractViolation, Reason
from .evaluation import (
    EvaluationReport,
    LeakageCheck,
    LedgerEntry,
    MeasuredUsage,
    Metric,
)
from .explanation import CandidateEdge, ExplanationBundle, ExplanationNode
from .forecast import ForecastBundle, failed_forecast, stable_forecast_id
from .observation import (
    DatasetManifest,
    Observation,
    ObservationBundle,
    refuse_real_source_kinds,
    refuse_unpermitted_uses,
)
from .versions import (
    CAPABILITY_FLAGS,
    CONTRACT_VERSION,
    DISTRIBUTION_METHODS,
    ENCODED_SCHEMA_VERSION,
    EVALUATION_REPORT_VERSION,
    EXPLANATION_SCHEMA_VERSION,
    FORECAST_SCHEMA_VERSION,
    OBSERVATION_SCHEMA_VERSION,
    SECONDS_PER_DAY,
)

__all__ = [
    "CAPABILITY_FLAGS",
    "CONTRACT_VERSION",
    "CandidateEdge",
    "CapabilityFlags",
    "Code",
    "ContractViolation",
    "DISTRIBUTION_METHODS",
    "DatasetManifest",
    "ENCODED_SCHEMA_VERSION",
    "EVALUATION_REPORT_VERSION",
    "EXPLANATION_SCHEMA_VERSION",
    "EncodedSequence",
    "EncoderDescriptor",
    "EvaluationReport",
    "ExplanationBundle",
    "ExplanationNode",
    "FORECAST_SCHEMA_VERSION",
    "ForecastBundle",
    "LeakageCheck",
    "LedgerEntry",
    "MeasuredUsage",
    "Metric",
    "OBSERVATION_SCHEMA_VERSION",
    "Observation",
    "ObservationBundle",
    "Reason",
    "SECONDS_PER_DAY",
    "canonical_json",
    "content_hash",
    "elapsed_days",
    "failed_forecast",
    "file_hash",
    "format_time",
    "parse_optional_time",
    "parse_time",
    "refuse_real_source_kinds",
    "refuse_unpermitted_uses",
    "stable_forecast_id",
]
