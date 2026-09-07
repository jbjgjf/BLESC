"""T2 — the learned encoder. Produces C2 for T3 and T4."""

from .artifact import EncoderArtifact, TrainingRecord, dependency_environment
from .encode import encode, quality_flags
from .model import EncoderConfig, GRUEncoder
from .train import fit_encoder, training_data_hash

__all__ = [
    "EncoderArtifact",
    "EncoderConfig",
    "GRUEncoder",
    "TrainingRecord",
    "dependency_environment",
    "encode",
    "fit_encoder",
    "quality_flags",
    "training_data_hash",
]
