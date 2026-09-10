"""T4 — the explanation projection, candidate structure and fidelity. Produces C4."""

from .bundle import ABSTRACTION_ID, NODE_SCHEMA_ID, build_explanation_bundle
from .fidelity import FidelityResult, score_fidelity
from .projection import Projection, fit_projection
from .structure import (
    DEFAULT_SELECTION_THRESHOLD,
    ExplanationModel,
    Term,
    fit_explanation_model,
)

__all__ = [
    "ABSTRACTION_ID",
    "DEFAULT_SELECTION_THRESHOLD",
    "ExplanationModel",
    "FidelityResult",
    "NODE_SCHEMA_ID",
    "Projection",
    "Term",
    "build_explanation_bundle",
    "fit_explanation_model",
    "fit_projection",
    "score_fidelity",
]
