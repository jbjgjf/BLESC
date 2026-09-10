"""C4 — ExplanationBundle: the readable state z, the candidate edges, and the honesty fields.

An explanation graph is the part of this system most likely to be believed
without evidence, so the type is built to make three specific
over-claims impossible to express by accident.

**A node says what kind of thing it is.** `semantic_status` is
`unvalidated_latent` unless something anchored it to a measurement. A learned
axis from synthetic data has no meaning beyond "coordinate 3"; labelling it
"anxiety" in the UI would invent a construct the run never measured. The
renderer keys off this field, not off the label.

**An edge says where its support comes from.** v0 emits `model_candidate` and
only that. A bootstrap resample frequency is recorded as
`uncertainty_method="bootstrap_frequency"` — it is how often the fit selected an
edge, not a posterior probability that it exists, and calling it one would be a
category error, not a rounding.

**Residuals are kept, not absorbed.** `residual_summary` says how much of the
detailed model's behaviour the explanation fails to reproduce. An explanation
that reports no residual is claiming the compressed state is sufficient, which
the architecture note explicitly refuses to assume up front.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Sequence

from .capabilities import CapabilityFlags
from .common import (
    check_finite,
    check_optional_finite,
    content_hash,
    require,
    require_enum,
    require_fields,
)
from .errors import Code
from .versions import BUNDLE_STATUSES, EVIDENCE_SCOPES, EXPLANATION_SCHEMA_VERSION, SEMANTIC_STATUSES

EXPLANATION_FIELDS = (
    "schema_version",
    "run_id",
    "forecast_id",
    "abstraction_id",
    "node_schema_id",
    "states",
    "candidate_edges",
    "residual_summary",
    "fidelity_metrics",
    "source_refs",
    "assumptions",
    "capability_flags",
    "status",
)


@dataclass(frozen=True)
class ExplanationNode:
    id: str
    label: str
    semantic_status: str
    unit: str
    value: Optional[float] = None
    uncertainty: Optional[float] = None

    def validate(self, path: str = "node") -> None:
        require(bool(self.id), Code.EMPTY_VALUE, "node idは空にできません。", f"{path}.id")
        require_enum(self.semantic_status, SEMANTIC_STATUSES, f"{path}.semantic_status")
        check_optional_finite(self.value, f"{path}.value")
        uncertainty = check_optional_finite(self.uncertainty, f"{path}.uncertainty")
        if uncertainty is not None:
            require(uncertainty >= 0.0, Code.WRONG_TYPE, "uncertaintyは非負です。", f"{path}.uncertainty")

    def as_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "semantic_status": self.semantic_status,
            "unit": self.unit,
            "value": None if self.value is None else float(self.value),
            "uncertainty": None if self.uncertainty is None else float(self.uncertainty),
        }

    @staticmethod
    def from_dict(payload: Mapping[str, Any], path: str = "node") -> "ExplanationNode":
        require_fields(payload, ("id", "label", "semantic_status", "unit"), path)
        node = ExplanationNode(
            id=str(payload["id"]),
            label=str(payload["label"]),
            semantic_status=str(payload["semantic_status"]),
            unit=str(payload["unit"]),
            value=payload.get("value"),
            uncertainty=payload.get("uncertainty"),
        )
        node.validate(path)
        return node


@dataclass(frozen=True)
class CandidateEdge:
    """One term of the explanation model, with its order and its lag.

    `source_ids` is a list because an interaction term has more than one source.
    `interaction_order` must equal `len(source_ids)`: an order-2 term with one
    source would silently render as a plain arrow and lose the fact that the
    effect only appears when both sources move.
    """

    source_ids: Sequence[str]
    target_id: str
    lag_days: float
    interaction_order: int
    coefficient: float
    model_id: str
    uncertainty_method: Optional[str] = None
    uncertainty: Optional[float] = None
    evidence_scope: str = "model_candidate"
    source_refs: Sequence[str] = field(default_factory=tuple)
    interaction_function: str = "product"

    def validate(self, path: str = "edge") -> None:
        require(
            len(self.source_ids) > 0,
            Code.EMPTY_VALUE,
            "source_idsが空です。",
            f"{path}.source_ids",
        )
        require(bool(self.target_id), Code.EMPTY_VALUE, "target_idは空にできません。", f"{path}.target_id")
        require_enum(self.evidence_scope, EVIDENCE_SCOPES, f"{path}.evidence_scope")
        require(
            self.interaction_order == len(self.source_ids),
            Code.SHAPE_MISMATCH,
            f"interaction_orderとsource_idsの数が違います: {self.interaction_order} != {len(self.source_ids)}",
            f"{path}.interaction_order",
        )
        lag = check_finite(self.lag_days, f"{path}.lag_days")
        require(lag >= 0.0, Code.BAD_TIMESTAMP, "lag_daysは非負です。", f"{path}.lag_days")
        check_finite(self.coefficient, f"{path}.coefficient")
        uncertainty = check_optional_finite(self.uncertainty, f"{path}.uncertainty")
        if uncertainty is not None:
            require(
                bool(self.uncertainty_method),
                Code.UNCERTAINTY_WITHOUT_METHOD,
                "uncertaintyには推定方法の名前が必要です。bootstrapの出現割合をBayesian posteriorと表示しません。",
                f"{path}.uncertainty_method",
            )

    def as_dict(self) -> Dict[str, Any]:
        return {
            "source_ids": list(self.source_ids),
            "target_id": self.target_id,
            "lag_days": float(self.lag_days),
            "interaction_order": int(self.interaction_order),
            "interaction_function": self.interaction_function,
            "coefficient": float(self.coefficient),
            "uncertainty_method": self.uncertainty_method,
            "uncertainty": None if self.uncertainty is None else float(self.uncertainty),
            "model_id": self.model_id,
            "evidence_scope": self.evidence_scope,
            "source_refs": list(self.source_refs),
        }

    @staticmethod
    def from_dict(payload: Mapping[str, Any], path: str = "edge") -> "CandidateEdge":
        require_fields(
            payload,
            ("source_ids", "target_id", "lag_days", "interaction_order", "coefficient", "model_id"),
            path,
        )
        edge = CandidateEdge(
            source_ids=tuple(str(value) for value in payload["source_ids"]),
            target_id=str(payload["target_id"]),
            lag_days=float(payload["lag_days"]),
            interaction_order=int(payload["interaction_order"]),
            interaction_function=str(payload.get("interaction_function", "product")),
            coefficient=float(payload["coefficient"]),
            uncertainty_method=payload.get("uncertainty_method"),
            uncertainty=payload.get("uncertainty"),
            model_id=str(payload["model_id"]),
            evidence_scope=str(payload.get("evidence_scope", "model_candidate")),
            source_refs=tuple(str(ref) for ref in payload.get("source_refs", ())),
        )
        edge.validate(path)
        return edge


@dataclass
class ExplanationBundle:
    run_id: str
    forecast_id: str
    abstraction_id: str
    node_schema_id: str
    states: Sequence[ExplanationNode]
    candidate_edges: Sequence[CandidateEdge]
    residual_summary: Mapping[str, Optional[float]]
    fidelity_metrics: Mapping[str, Optional[float]]
    capability_flags: CapabilityFlags
    source_refs: Sequence[str] = field(default_factory=tuple)
    assumptions: Sequence[str] = field(default_factory=tuple)
    status: str = "ok"
    schema_version: str = EXPLANATION_SCHEMA_VERSION

    def validate(self, path: str = "explanation") -> None:
        require(
            self.schema_version == EXPLANATION_SCHEMA_VERSION,
            Code.SCHEMA_VERSION_MISMATCH,
            f"explanation schemaの版が違います: {self.schema_version}",
            f"{path}.schema_version",
        )
        require_enum(self.status, BUNDLE_STATUSES, f"{path}.status")
        self.capability_flags.validate(f"{path}.capability_flags")
        for name in ("run_id", "forecast_id", "abstraction_id", "node_schema_id"):
            require(bool(getattr(self, name)), Code.EMPTY_VALUE, f"{name}は空にできません。", f"{path}.{name}")

        if self.status != "ok":
            require(
                len(self.states) == 0 and len(self.candidate_edges) == 0,
                Code.STATUS_PAYLOAD_MISMATCH,
                f"status={self.status}でnodeやedgeを返しません。",
                f"{path}.states",
            )
            return

        node_ids = set()
        for index, node in enumerate(self.states):
            node.validate(f"{path}.states[{index}]")
            require(
                node.id not in node_ids,
                Code.DUPLICATE_EVENT_ID,
                f"node idが重複しています: {node.id}",
                f"{path}.states[{index}].id",
            )
            node_ids.add(node.id)

        for index, edge in enumerate(self.candidate_edges):
            edge_path = f"{path}.candidate_edges[{index}]"
            edge.validate(edge_path)
            for position, source_id in enumerate(edge.source_ids):
                require(
                    source_id in node_ids,
                    Code.MISSING_FIELD,
                    f"存在しないnodeを参照しています: {source_id}",
                    f"{edge_path}.source_ids[{position}]",
                )
            require(
                edge.target_id in node_ids,
                Code.MISSING_FIELD,
                f"存在しないnodeを参照しています: {edge.target_id}",
                f"{edge_path}.target_id",
            )

        for key, value in self.residual_summary.items():
            check_optional_finite(value, f"{path}.residual_summary.{key}")
        for key, value in self.fidelity_metrics.items():
            check_optional_finite(value, f"{path}.fidelity_metrics.{key}")

    def as_dict(self) -> Dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "run_id": self.run_id,
            "forecast_id": self.forecast_id,
            "abstraction_id": self.abstraction_id,
            "node_schema_id": self.node_schema_id,
            "states": [node.as_dict() for node in self.states],
            "candidate_edges": [edge.as_dict() for edge in self.candidate_edges],
            "residual_summary": {
                key: (None if value is None else float(value))
                for key, value in self.residual_summary.items()
            },
            "fidelity_metrics": {
                key: (None if value is None else float(value))
                for key, value in self.fidelity_metrics.items()
            },
            "source_refs": list(self.source_refs),
            "assumptions": list(self.assumptions),
            "capability_flags": self.capability_flags.as_dict(),
            "status": self.status,
        }

    @staticmethod
    def from_dict(payload: Mapping[str, Any], path: str = "explanation") -> "ExplanationBundle":
        require_fields(payload, EXPLANATION_FIELDS, path)
        bundle = ExplanationBundle(
            schema_version=str(payload["schema_version"]),
            run_id=str(payload["run_id"]),
            forecast_id=str(payload["forecast_id"]),
            abstraction_id=str(payload["abstraction_id"]),
            node_schema_id=str(payload["node_schema_id"]),
            states=tuple(
                ExplanationNode.from_dict(item, f"{path}.states[{index}]")
                for index, item in enumerate(payload["states"])
            ),
            candidate_edges=tuple(
                CandidateEdge.from_dict(item, f"{path}.candidate_edges[{index}]")
                for index, item in enumerate(payload["candidate_edges"])
            ),
            residual_summary=dict(payload["residual_summary"]),
            fidelity_metrics=dict(payload["fidelity_metrics"]),
            source_refs=tuple(str(ref) for ref in payload["source_refs"]),
            assumptions=tuple(str(item) for item in payload["assumptions"]),
            capability_flags=CapabilityFlags.from_dict(
                payload["capability_flags"], f"{path}.capability_flags"
            ),
            status=str(payload["status"]),
        )
        bundle.validate(path)
        return bundle

    def content_hash(self) -> str:
        return content_hash(self.as_dict())
