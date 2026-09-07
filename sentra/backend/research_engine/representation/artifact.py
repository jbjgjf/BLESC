"""T2b (#144) — the checkpoint, and what has to be in it for a reload to mean anything.

Saving weights is the easy half. The contract asks for a checkpoint that can be
*re-read by the CLI* and known to be the same model, so the artifact carries the
input schema, the normaliser id, the hash of the training data, the seed, the
config and the dependency environment alongside the arrays.

Two consequences are load-bearing:

`encoder_id` is derived from the content — config, training data hash, seed and
final weights. Retraining on different rows produces a different id, so a
dynamics model fitted against the old encoder refuses the new one instead of
consuming coordinates that no longer mean what it learned.

`training_status` is honest. An artifact built but never fitted is
`untrained`, and every consumer checks it. "Trained for zero epochs" and
"trained" must not be the same artifact, because the second is the claim the
whole run rests on.
"""

from __future__ import annotations

import json
import platform
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

import numpy as np

from ..contracts.common import content_hash, require
from ..contracts.encoded import EncoderDescriptor
from ..contracts.errors import Code
from .model import EncoderConfig, GRUEncoder

ARTIFACT_FORMAT = "encoder-artifact-v0"
WEIGHTS_FILE = "weights.npz"
META_FILE = "encoder.json"


@dataclass
class TrainingRecord:
    """What actually happened during the fit, kept for the report."""

    epochs_run: int
    best_epoch: int
    train_loss: float
    validation_loss: Optional[float]
    train_loss_history: Tuple[float, ...]
    validation_loss_history: Tuple[float, ...]
    n_train_sequences: int
    n_validation_sequences: int
    stopped_early: bool
    elapsed_seconds: float

    def as_dict(self) -> Dict[str, Any]:
        return {
            "epochs_run": self.epochs_run,
            "best_epoch": self.best_epoch,
            "train_loss": self.train_loss,
            "validation_loss": self.validation_loss,
            "train_loss_history": list(self.train_loss_history),
            "validation_loss_history": list(self.validation_loss_history),
            "n_train_sequences": self.n_train_sequences,
            "n_validation_sequences": self.n_validation_sequences,
            "stopped_early": self.stopped_early,
            "elapsed_seconds": self.elapsed_seconds,
        }

    @staticmethod
    def from_dict(payload: Mapping[str, Any]) -> "TrainingRecord":
        return TrainingRecord(
            epochs_run=int(payload["epochs_run"]),
            best_epoch=int(payload["best_epoch"]),
            train_loss=float(payload["train_loss"]),
            validation_loss=payload.get("validation_loss"),
            train_loss_history=tuple(float(value) for value in payload["train_loss_history"]),
            validation_loss_history=tuple(
                float(value) for value in payload["validation_loss_history"]
            ),
            n_train_sequences=int(payload["n_train_sequences"]),
            n_validation_sequences=int(payload["n_validation_sequences"]),
            stopped_early=bool(payload["stopped_early"]),
            elapsed_seconds=float(payload["elapsed_seconds"]),
        )


@dataclass
class EncoderArtifact:
    config: EncoderConfig
    feature_schema_id: str
    feature_names: Tuple[str, ...]
    normalizer_id: str
    training_data_hash: str
    params: Dict[str, np.ndarray]
    training_status: str = "trained"
    training_record: Optional[TrainingRecord] = None
    dependency_environment: Mapping[str, str] = field(default_factory=dict)
    artifact_format: str = ARTIFACT_FORMAT

    # ---- identity --------------------------------------------------------

    @property
    def latent_dim(self) -> int:
        return self.config.latent_dim

    def weights_hash(self) -> str:
        return content_hash(
            {
                name: np.round(value, 9).tolist()
                for name, value in sorted(self.params.items())
            }
        )

    def config_hash(self) -> str:
        return content_hash(self.config.as_dict())

    @property
    def encoder_id(self) -> str:
        digest = content_hash(
            {
                "config": self.config.as_dict(),
                "feature_schema_id": self.feature_schema_id,
                "normalizer_id": self.normalizer_id,
                "training_data_hash": self.training_data_hash,
                "training_status": self.training_status,
                "weights": self.weights_hash(),
            }
        )
        return "encoder-gru-" + digest.split(":", 1)[1][:16]

    def descriptor(self) -> EncoderDescriptor:
        return EncoderDescriptor(
            encoder_id=self.encoder_id,
            feature_schema_id=self.feature_schema_id,
            normalizer_id=self.normalizer_id,
            latent_dim=self.latent_dim,
            training_status=self.training_status,
            training_data_hash=self.training_data_hash,
            config_hash=self.config_hash(),
            seed=self.config.seed,
        )

    def to_model(self) -> GRUEncoder:
        model = GRUEncoder(len(self.feature_names), self.config)
        for name, value in self.params.items():
            model.params[name] = np.array(value, dtype=float)
        return model

    # ---- persistence -----------------------------------------------------

    def save(self, directory: Path) -> Path:
        directory = Path(directory)
        directory.mkdir(parents=True, exist_ok=True)
        np.savez(directory / WEIGHTS_FILE, **{name: value for name, value in self.params.items()})
        meta = {
            "artifact_format": self.artifact_format,
            "encoder_id": self.encoder_id,
            "config": self.config.as_dict(),
            "feature_schema_id": self.feature_schema_id,
            "feature_names": list(self.feature_names),
            "normalizer_id": self.normalizer_id,
            "training_data_hash": self.training_data_hash,
            "training_status": self.training_status,
            "weights_hash": self.weights_hash(),
            "training_record": self.training_record.as_dict() if self.training_record else None,
            "dependency_environment": dict(self.dependency_environment),
        }
        (directory / META_FILE).write_text(
            json.dumps(meta, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )
        return directory

    @staticmethod
    def load(directory: Path) -> "EncoderArtifact":
        directory = Path(directory)
        meta = json.loads((directory / META_FILE).read_text(encoding="utf-8"))
        require(
            meta.get("artifact_format") == ARTIFACT_FORMAT,
            Code.SCHEMA_VERSION_MISMATCH,
            f"未知のartifact形式です: {meta.get('artifact_format')}",
            "encoder.artifact_format",
        )
        with np.load(directory / WEIGHTS_FILE) as archive:
            params = {name: np.array(archive[name], dtype=float) for name in archive.files}

        artifact = EncoderArtifact(
            config=EncoderConfig.from_dict(meta["config"]),
            feature_schema_id=meta["feature_schema_id"],
            feature_names=tuple(meta["feature_names"]),
            normalizer_id=meta["normalizer_id"],
            training_data_hash=meta["training_data_hash"],
            params=params,
            training_status=meta["training_status"],
            training_record=(
                TrainingRecord.from_dict(meta["training_record"]) if meta.get("training_record") else None
            ),
            dependency_environment=meta.get("dependency_environment", {}),
        )
        # The reload is only worth anything if it round-trips to the same
        # identity. A checkpoint that loads into a different encoder_id would
        # let a run silently continue with weights it did not save.
        require(
            artifact.encoder_id == meta["encoder_id"],
            Code.ENCODER_MISMATCH,
            "再読込したencoderのidが保存時と一致しません。",
            "encoder.encoder_id",
            saved=meta["encoder_id"],
            loaded=artifact.encoder_id,
        )
        return artifact


def dependency_environment() -> Dict[str, str]:
    """Recorded per run: the same seed on a different numpy is not the same run."""

    return {
        "python": platform.python_version(),
        "numpy": np.__version__,
        "platform": platform.platform(),
    }
