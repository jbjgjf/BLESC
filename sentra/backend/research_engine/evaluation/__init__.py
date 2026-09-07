"""T5 — the independent evaluation side: generators, sealed truth, scoring.

This package holds the answers. The learner never imports from it beyond the
`ObservationBundle` a generator emits: the latent trajectories, the true edges
and the noise parameters stay behind `SealedTruth`, which is what makes the
scores it produces worth reading.
"""

from .generators import (
    SCENARIOS,
    GeneratorConfig,
    SealedTruth,
    SyntheticDataset,
    generate,
    generate_all,
)

__all__ = [
    "SCENARIOS",
    "GeneratorConfig",
    "SealedTruth",
    "SyntheticDataset",
    "generate",
    "generate_all",
]
