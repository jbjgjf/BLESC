"""Train-only normalisation, with an id that changes when the fit input does.

Standardising with statistics computed over the whole dataset is the quietest
leak available: nothing crashes, the heldout scores improve, and the improvement
is the heldout data's own mean and variance being handed to the model. So the
fit takes an explicit row set, records the hash of exactly those rows, and
derives `normalizer_id` from that hash. C2 then refuses a sequence whose
`normalizer_id` does not match the one the dynamics model was fitted against.

Masked positions are excluded from the fit — averaging over "null" as if it were
zero would shift every mean toward zero in proportion to how much data is
missing. After centring, masked positions are filled with 0.0 *and* the mask is
passed alongside, so the model can tell "at the mean" from "not measured".
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

import numpy as np

from ..contracts.common import content_hash, require
from ..contracts.errors import Code
from ..contracts.observation import Observation

#: Below this, a feature's spread is treated as unusable and left unscaled:
#: dividing by a near-zero standard deviation turns rounding noise into a
#: dominant signal.
MIN_STD = 1e-6


@dataclass(frozen=True)
class Normalizer:
    normalizer_id: str
    feature_schema_id: str
    feature_names: Tuple[str, ...]
    means: Tuple[float, ...]
    stds: Tuple[float, ...]
    fit_input_hash: str
    fit_split: str
    n_rows_fitted: int
    n_observed_per_feature: Tuple[int, ...]

    def transform(
        self, values: Sequence[Optional[float]], mask: Sequence[bool]
    ) -> Tuple[List[float], List[bool]]:
        out: List[float] = []
        for index, (value, observed) in enumerate(zip(values, mask)):
            if not observed or value is None:
                out.append(0.0)
                continue
            out.append((float(value) - self.means[index]) / self.stds[index])
        return out, [bool(flag) for flag in mask]

    def inverse_transform_matrix(self, matrix: np.ndarray) -> np.ndarray:
        """Back to simulation units, so metrics are reported in the unit the data has."""

        means = np.asarray(self.means)
        stds = np.asarray(self.stds)
        return matrix * stds + means

    def as_dict(self) -> Dict[str, Any]:
        return {
            "normalizer_id": self.normalizer_id,
            "feature_schema_id": self.feature_schema_id,
            "feature_names": list(self.feature_names),
            "means": [float(value) for value in self.means],
            "stds": [float(value) for value in self.stds],
            "fit_input_hash": self.fit_input_hash,
            "fit_split": self.fit_split,
            "n_rows_fitted": self.n_rows_fitted,
            "n_observed_per_feature": [int(count) for count in self.n_observed_per_feature],
        }


def fit_normalizer(
    rows: Sequence[Observation],
    *,
    feature_schema_id: str,
    feature_names: Sequence[str],
    fit_split: str = "train",
) -> Normalizer:
    """Fit on the rows given. The caller is responsible for passing train only —
    and `fit_split` is recorded so a report can show which side it claims."""

    require(len(rows) > 0, Code.EMPTY_VALUE, "正規化をfitする行がありません。", "normalizer.rows")

    width = len(feature_names)
    sums = np.zeros(width)
    squares = np.zeros(width)
    counts = np.zeros(width, dtype=int)

    for row in rows:
        require(
            row.feature_schema_id == feature_schema_id,
            Code.FEATURE_SCHEMA_MISMATCH,
            "fit対象にfeature_schemaの違う行が混ざっています。",
            "normalizer.rows",
        )
        for index, (value, observed) in enumerate(zip(row.values, row.observed_mask)):
            if observed and value is not None:
                number = float(value)
                sums[index] += number
                squares[index] += number * number
                counts[index] += 1

    means: List[float] = []
    stds: List[float] = []
    for index in range(width):
        if counts[index] == 0:
            # A feature nobody observed in train: leave it untouched rather than
            # invent a centre. Scaling by a made-up mean would be indistinguishable
            # from having measured it.
            means.append(0.0)
            stds.append(1.0)
            continue
        mean = sums[index] / counts[index]
        variance = max(squares[index] / counts[index] - mean * mean, 0.0)
        std = float(np.sqrt(variance))
        means.append(float(mean))
        stds.append(std if std >= MIN_STD else 1.0)

    fit_input_hash = content_hash(
        {
            "feature_schema_id": feature_schema_id,
            "feature_names": list(feature_names),
            "event_ids": sorted(row.event_id for row in rows),
        }
    )
    normalizer_id = "train-zscore-" + fit_input_hash.split(":", 1)[1][:16]

    return Normalizer(
        normalizer_id=normalizer_id,
        feature_schema_id=feature_schema_id,
        feature_names=tuple(feature_names),
        means=tuple(means),
        stds=tuple(stds),
        fit_input_hash=fit_input_hash,
        fit_split=fit_split,
        n_rows_fitted=len(rows),
        n_observed_per_feature=tuple(int(count) for count in counts),
    )
