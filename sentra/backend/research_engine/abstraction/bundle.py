"""Assembling C4 from the fitted projection, the explanation model and fidelity.

Every honesty field of C4 is filled here, and each is filled with the least
flattering true value available:

- `semantic_status` is `synthetic_axis`. These coordinates correspond to
  simulation quantities; they are not measurements of a person and must not be
  rendered as clinical constructs.
- `evidence_scope` is `model_candidate` on every edge. Nothing here was observed
  or read in a paper.
- `uncertainty_method` is `bootstrap_frequency`, never a posterior.
- `residual_summary` reports what the projection failed to carry, rather than
  letting a small fidelity number imply the compression was lossless.
- `assumptions` names the shape of the explanation model (single lag, linear
  plus pairwise products), because a reader looking at a graph with no arrows of
  order three should know whether that is a finding or a restriction.
"""

from __future__ import annotations

from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

import numpy as np

from ..contracts.capabilities import CapabilityFlags
from ..contracts.explanation import CandidateEdge, ExplanationBundle, ExplanationNode
from .fidelity import FidelityResult
from .projection import Projection
from .structure import ExplanationModel

NODE_SCHEMA_ID = "synthetic-axes-v0"
ABSTRACTION_ID = "sparse-projection-v0"


def build_explanation_bundle(
    *,
    run_id: str,
    forecast_id: str,
    projection: Optional[Projection],
    explanation: Optional[ExplanationModel],
    fidelity: Optional[FidelityResult],
    state_values: Optional[Sequence[float]],
    capability_flags: CapabilityFlags,
    source_refs: Sequence[str] = (),
    status_reason_ja: Optional[str] = None,
) -> ExplanationBundle:
    if projection is None or explanation is None:
        return ExplanationBundle(
            run_id=run_id,
            forecast_id=forecast_id,
            abstraction_id=ABSTRACTION_ID,
            node_schema_id=NODE_SCHEMA_ID,
            states=(),
            candidate_edges=(),
            residual_summary={},
            fidelity_metrics={},
            capability_flags=capability_flags,
            source_refs=tuple(source_refs),
            assumptions=(
                status_reason_ja
                or "説明モデルを学習できなかったため、nodeもedgeも返していません。",
            ),
            status="not_enough_data",
        )

    nodes: List[ExplanationNode] = []
    for index, axis in enumerate(projection.axis_names):
        value = (
            float(state_values[index])
            if state_values is not None and index < len(state_values)
            else None
        )
        r2 = projection.reconstruction_r2[index] if index < len(projection.reconstruction_r2) else None
        nodes.append(
            ExplanationNode(
                id=axis,
                label=f"説明軸 {axis}",
                # A synthetic coordinate, not a measured construct. The renderer
                # keys off this field rather than off the label.
                semantic_status="synthetic_axis",
                unit="normalized",
                value=value,
                # 1 - R² of the projection onto this axis: how much of the axis
                # the internal state could not reconstruct.
                uncertainty=(
                    None if r2 is None or np.isnan(r2) else float(max(0.0, 1.0 - float(r2)))
                ),
            )
        )

    edges: List[CandidateEdge] = []
    for term, coefficient, frequency in explanation.selected_terms():
        edges.append(
            CandidateEdge(
                source_ids=tuple(term.source_axes),
                target_id=term.target_axis,
                lag_days=explanation.lag_days,
                interaction_order=term.order,
                interaction_function="identity" if term.order == 1 else "product",
                coefficient=coefficient,
                uncertainty_method="bootstrap_frequency" if explanation.bootstrap_rounds else None,
                uncertainty=frequency if explanation.bootstrap_rounds else None,
                model_id=ABSTRACTION_ID,
                evidence_scope="model_candidate",
                source_refs=(),
            )
        )

    r2_values = [value for value in projection.reconstruction_r2 if not np.isnan(value)]
    residual = {
        "mean_unexplained_variance_ratio": (
            float(np.mean([max(0.0, 1.0 - value) for value in r2_values])) if r2_values else None
        ),
        "worst_axis_unexplained_variance_ratio": (
            float(max(max(0.0, 1.0 - value) for value in r2_values)) if r2_values else None
        ),
        "explanation_terms_kept": float(len(edges)),
        "explanation_terms_considered": float(
            len(explanation.term_sources) * len(explanation.axis_names)
        ),
    }

    fidelity_metrics: Dict[str, Optional[float]] = (
        {
            "paired_rollout_mae": fidelity.paired_rollout_mae,
            "paired_rollout_max_error": fidelity.paired_rollout_max_error,
            "paired_rollout_mae_under_intervention": fidelity.paired_rollout_mae_under_intervention,
            "n_pairs": float(fidelity.n_pairs),
            "steps": float(fidelity.steps),
        }
        if fidelity is not None
        else {}
    )

    bundle = ExplanationBundle(
        run_id=run_id,
        forecast_id=forecast_id,
        abstraction_id=ABSTRACTION_ID,
        node_schema_id=NODE_SCHEMA_ID,
        states=tuple(nodes),
        candidate_edges=tuple(edges),
        residual_summary=residual,
        fidelity_metrics=fidelity_metrics,
        capability_flags=capability_flags,
        source_refs=tuple(source_refs),
        assumptions=(
            f"説明モデルはlag={explanation.lag_days}日の線形項と2次の積項に限定している。3次以上の項は探索していない。",
            f"係数は標準化後の絶対値が{explanation.selection_threshold}未満のとき0にしている。",
            "uncertaintyはbootstrap再標本での選択割合であり、辺が存在する事後確率ではない。",
            "係数はモデル内の候補であり、現実の人への介入効果ではない。",
            "軸は合成データの観測特徴に対応する座標であり、臨床尺度ではない。",
        ),
        status="ok",
    )
    bundle.validate()
    return bundle
