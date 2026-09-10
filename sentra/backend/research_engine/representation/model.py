"""T2a (#143) — a small recurrent encoder, actually trained.

The requirement is a *learned* representation, so this is gradient descent with
backpropagation through time written out in numpy, not a random projection with
a confident name. numpy rather than torch because the acceptance condition is
that a fresh checkout runs the whole path with no network, no key and no GPU,
and the model is small enough (latent 8, four features) that the difference is
seconds.

The cell is a gated recurrent unit:

    r_t = σ(W_r [x_t, m_t, δ_t] + U_r h_{t-1} + b_r)
    z_t = σ(W_z [x_t, m_t, δ_t] + U_z h_{t-1} + b_z)
    n_t = tanh(W_n [x_t, m_t, δ_t] + r_t ⊙ (U_n h_{t-1}) + b_n)
    h_t = (1 - z_t) ⊙ n_t + z_t ⊙ h_{t-1}

Three inputs, and the second and third are the point:

`x_t` are the normalised values. `m_t` is the observation mask, passed as its
own channel — without it, a masked feature arrives as 0.0 and the model learns
that "not written about" means "at the population mean". `δ_t` is the elapsed
days since the previous row, so a three-day gap is not a one-day step. S4 is the
scenario that fails loudly when either is dropped, and
`test_t2_representation.py` asserts exactly that.

The training objective is next-step prediction of the observed features, scored
only on positions that were actually observed. Scoring the imputed zeros would
teach the encoder to predict the imputation.

The gate carrying the previous state past the update (`z_t`) is what lets S2's
five-day dependence survive: a plain tanh recurrence with the same parameter
count loses it within two steps.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

import numpy as np

#: Elapsed days enter as log1p(δ). Raw days would let a single long gap dominate
#: the input scale; the log keeps 1 vs 3 days informative without letting 30 vs
#: 3 swamp the value channels.
def _delta_feature(delta_days: np.ndarray) -> np.ndarray:
    return np.log1p(np.maximum(delta_days, 0.0))


def _sigmoid(values: np.ndarray) -> np.ndarray:
    # The two-branch form avoids overflow warnings on large negative inputs,
    # which numpy would otherwise print on every training run.
    out = np.empty_like(values)
    positive = values >= 0
    out[positive] = 1.0 / (1.0 + np.exp(-values[positive]))
    exp_negative = np.exp(values[~positive])
    out[~positive] = exp_negative / (1.0 + exp_negative)
    return out


@dataclass
class EncoderConfig:
    latent_dim: int = 8
    learning_rate: float = 0.03
    epochs: int = 150
    seed: int = 11
    gradient_clip: float = 5.0
    weight_decay: float = 1e-4
    #: Stop when validation loss has not improved for this many epochs. Reported
    #: in the artifact so "trained for 60 epochs" and "stopped at 23" are
    #: distinguishable in the record.
    patience: int = 12

    def as_dict(self) -> Dict[str, Any]:
        return {
            "latent_dim": self.latent_dim,
            "learning_rate": self.learning_rate,
            "epochs": self.epochs,
            "seed": self.seed,
            "gradient_clip": self.gradient_clip,
            "weight_decay": self.weight_decay,
            "patience": self.patience,
        }

    @staticmethod
    def from_dict(payload: Mapping[str, Any]) -> "EncoderConfig":
        return EncoderConfig(**{key: payload[key] for key in payload if key in EncoderConfig().__dict__})


class GRUEncoder:
    """Weights plus forward/backward. Serialisation lives in `artifact.py`."""

    def __init__(self, n_features: int, config: EncoderConfig):
        self.n_features = n_features
        self.config = config
        self.input_dim = 2 * n_features + 1  # values, mask, elapsed days
        rng = np.random.default_rng(config.seed)
        hidden = config.latent_dim
        scale = 1.0 / np.sqrt(max(hidden, 1))

        def uniform(*shape: int) -> np.ndarray:
            return rng.uniform(-scale, scale, size=shape)

        self.params: Dict[str, np.ndarray] = {
            "W_r": uniform(self.input_dim, hidden),
            "U_r": uniform(hidden, hidden),
            "b_r": np.zeros(hidden),
            "W_z": uniform(self.input_dim, hidden),
            "U_z": uniform(hidden, hidden),
            "b_z": np.zeros(hidden),
            "W_n": uniform(self.input_dim, hidden),
            "U_n": uniform(hidden, hidden),
            "b_n": np.zeros(hidden),
            "W_out": uniform(hidden, n_features),
            "b_out": np.zeros(n_features),
        }

    # ---- forward ---------------------------------------------------------

    def _inputs(self, values: np.ndarray, mask: np.ndarray, delta_days: np.ndarray) -> np.ndarray:
        return np.concatenate(
            [values, mask.astype(float), _delta_feature(delta_days)[:, None]], axis=1
        )

    def forward(
        self, values: np.ndarray, mask: np.ndarray, delta_days: np.ndarray
    ) -> Tuple[np.ndarray, np.ndarray, List[Dict[str, np.ndarray]]]:
        """Return hidden states, per-step predictions, and the cache for BPTT."""

        inputs = self._inputs(values, mask, delta_days)
        steps = len(inputs)
        hidden = self.config.latent_dim
        state = np.zeros(hidden)
        states = np.zeros((steps, hidden))
        cache: List[Dict[str, np.ndarray]] = []

        for t in range(steps):
            x = inputs[t]
            previous = state
            r = _sigmoid(x @ self.params["W_r"] + previous @ self.params["U_r"] + self.params["b_r"])
            z = _sigmoid(x @ self.params["W_z"] + previous @ self.params["U_z"] + self.params["b_z"])
            u_n = previous @ self.params["U_n"]
            n = np.tanh(x @ self.params["W_n"] + r * u_n + self.params["b_n"])
            state = (1.0 - z) * n + z * previous
            states[t] = state
            cache.append({"x": x, "previous": previous, "r": r, "z": z, "n": n, "u_n": u_n})

        predictions = states @ self.params["W_out"] + self.params["b_out"]
        return states, predictions, cache

    def step(
        self, previous: np.ndarray, values: np.ndarray, mask: np.ndarray, delta_days: float
    ) -> np.ndarray:
        """Advance the state by one step from an explicit previous state.

        Exposed for T3's model-internal rollout: feeding the model's own
        prediction back in is how a multi-step forecast is produced, and doing
        it through the same cell keeps the rollout and the encoding one model
        rather than two that happen to agree.
        """

        x = np.concatenate([values, mask.astype(float), [np.log1p(max(delta_days, 0.0))]])
        r = _sigmoid(x @ self.params["W_r"] + previous @ self.params["U_r"] + self.params["b_r"])
        z = _sigmoid(x @ self.params["W_z"] + previous @ self.params["U_z"] + self.params["b_z"])
        n = np.tanh(
            x @ self.params["W_n"] + r * (previous @ self.params["U_n"]) + self.params["b_n"]
        )
        return (1.0 - z) * n + z * previous

    def encode(self, values: np.ndarray, mask: np.ndarray, delta_days: np.ndarray) -> np.ndarray:
        states, _, _ = self.forward(values, mask, delta_days)
        return states

    # ---- loss and backward ----------------------------------------------

    def _targets(
        self, values: np.ndarray, mask: np.ndarray
    ) -> Tuple[np.ndarray, np.ndarray]:
        """Next-step targets, scored only where the next row was observed."""

        return values[1:], mask[1:]

    def loss_and_grads(
        self, values: np.ndarray, mask: np.ndarray, delta_days: np.ndarray
    ) -> Tuple[float, int, Dict[str, np.ndarray]]:
        states, predictions, cache = self.forward(values, mask, delta_days)
        targets, target_mask = self._targets(values, mask)
        steps = len(targets)
        grads = {name: np.zeros_like(value) for name, value in self.params.items()}
        if steps == 0 or not target_mask.any():
            return 0.0, 0, grads

        # Prediction at step t is scored against the observation at t+1.
        used = predictions[:steps]
        residual = (used - targets) * target_mask
        n_scored = int(target_mask.sum())
        loss = float(np.sum(residual**2) / n_scored)

        d_predictions = np.zeros_like(predictions)
        d_predictions[:steps] = 2.0 * residual / n_scored

        grads["W_out"] = states.T @ d_predictions
        grads["b_out"] = d_predictions.sum(axis=0)
        d_states = d_predictions @ self.params["W_out"].T

        d_next = np.zeros(self.config.latent_dim)
        for t in range(len(states) - 1, -1, -1):
            entry = cache[t]
            d_h = d_states[t] + d_next
            z, n, r = entry["z"], entry["n"], entry["r"]
            previous, x, u_n = entry["previous"], entry["x"], entry["u_n"]

            d_n = d_h * (1.0 - z)
            d_z = d_h * (previous - n)
            d_previous = d_h * z

            d_n_raw = d_n * (1.0 - n**2)
            grads["W_n"] += np.outer(x, d_n_raw)
            grads["b_n"] += d_n_raw
            grads["U_n"] += np.outer(previous, d_n_raw * r)
            d_r = d_n_raw * u_n
            d_previous = d_previous + (d_n_raw * r) @ self.params["U_n"].T

            d_z_raw = d_z * z * (1.0 - z)
            grads["W_z"] += np.outer(x, d_z_raw)
            grads["b_z"] += d_z_raw
            grads["U_z"] += np.outer(previous, d_z_raw)
            d_previous = d_previous + d_z_raw @ self.params["U_z"].T

            d_r_raw = d_r * r * (1.0 - r)
            grads["W_r"] += np.outer(x, d_r_raw)
            grads["b_r"] += d_r_raw
            grads["U_r"] += np.outer(previous, d_r_raw)
            d_previous = d_previous + d_r_raw @ self.params["U_r"].T

            d_next = d_previous

        return loss, n_scored, grads

    def evaluate_loss(
        self, sequences: Sequence[Tuple[np.ndarray, np.ndarray, np.ndarray]]
    ) -> float:
        total, count = 0.0, 0
        for values, mask, delta_days in sequences:
            _, predictions, _ = self.forward(values, mask, delta_days)
            targets, target_mask = self._targets(values, mask)
            steps = len(targets)
            if steps == 0 or not target_mask.any():
                continue
            residual = (predictions[:steps] - targets) * target_mask
            total += float(np.sum(residual**2))
            count += int(target_mask.sum())
        return total / count if count else float("nan")
