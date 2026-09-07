"""T5a (#149) — the S1–S5 synthetic scenarios, and the truth kept away from the learner.

Each scenario exists to make one specific way of looking good actually fail.

| Scenario | The failure it is built to expose |
| --- | --- |
| S1 stable linear VAR | a complex model looking good where a linear one suffices |
| S2 same present, different history | a memoryless model returning the same future for both |
| S3 product interaction | an additive model missing a combination |
| S4 missing and irregular timing | treating a gap as zero, or seven days as one |
| S5 unobserved common cause | reporting a correlation as a real-world cause |

All five share one feature schema (`x1..x4`), so a single encoder can be trained
across them and the scenario-level breakdown in the report compares like with
like. What differs is the mechanism behind those four numbers.

**The truth does not travel with the data.** `generate()` returns a bundle *and*
a `SealedTruth`. Only the bundle is ever handed to T1/T2/T3/T4; the latent
trajectories, the true edges and the noise scale live in the sealed half, which
the evaluator holds. This is not ceremony — a latent that leaked into the
encoder's inputs would produce exactly the numbers the project most wants to
see, and nobody would be able to tell from the report.

**Structure is only "known" where it is actually expressible.** S2's dependence
is on a five-day moving average, and the v0 explanation model only carries
single-lag terms; its `structure_defined` is False and every structure metric
for it is reported as unsupported rather than as a bad score. Grading a model
against a truth it cannot represent produces a number that means nothing.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

import numpy as np

from ..contracts.observation import DatasetManifest, Observation, ObservationBundle
from ..contracts.versions import OBSERVATION_SCHEMA_VERSION

#: The four observed features every scenario emits. Fixed here so the feature
#: schema id means one thing across the whole engine.
FEATURE_NAMES: Tuple[str, ...] = ("x1", "x2", "x3", "x4")
FEATURE_UNITS: Tuple[str, ...] = tuple("simulation_unit" for _ in FEATURE_NAMES)
FEATURE_SCHEMA_ID = "synthetic-features-v0"

SCENARIOS: Tuple[str, ...] = ("S1", "S2", "S3", "S4", "S5")

#: Fixed before any model was fitted, per the H6 rule: the tolerances and the
#: split shape may not be relaxed after seeing a score.
DEFAULT_PARTICIPANTS = 18
DEFAULT_DAYS = 40
DEFAULT_NOISE = 0.08

#: Process noise. Kept separate from observation noise on purpose: with one
#: knob doing both jobs, a value small enough to keep the observations clean
#: also shrinks the state toward zero, and an interaction term built from two
#: near-zero features disappears under the noise it was supposed to stand out
#: from. The first draft of S3 failed exactly that way.
DEFAULT_INNOVATION = 0.35

#: S2 and S3 carry a *structural* signal that has to stand above the process
#: noise for the scenario to discriminate at all. Both ratios shrink the noise
#: on the channel under test rather than inflating the effect, so the mechanism
#: stays the modest one the scenario describes.
S2_INNOVATION_RATIO = 0.28

#: S2 isolates *memory*. Observation noise blurs which history a moment came
#: from, so the scenario would end up testing measurement error as much as
#: memory. Halving it keeps the question the one the scenario is named for;
#: S4 is where measurement degradation is the subject.
S2_OBSERVATION_RATIO = 0.5
S3_TARGET_INNOVATION_RATIO = 0.30
S3_INTERACTION_COEFFICIENT = -1.40

#: Day zero of every scenario. A fixed epoch keeps `dataset_hash` stable across
#: runs; a `datetime.now()` here would make every rerun a different dataset.
EPOCH = datetime(2026, 1, 5, 12, 0, 0, tzinfo=timezone.utc)


@dataclass(frozen=True)
class GeneratorConfig:
    scenario: str
    seed: int = 11
    n_participants: int = DEFAULT_PARTICIPANTS
    n_days: int = DEFAULT_DAYS
    noise_scale: float = DEFAULT_NOISE
    innovation_scale: float = DEFAULT_INNOVATION
    dataset_id: Optional[str] = None

    @property
    def resolved_dataset_id(self) -> str:
        return self.dataset_id or f"synthetic-{self.scenario.lower()}-seed{self.seed}-v0"


@dataclass(frozen=True)
class TrueEdge:
    """One term of the generating mechanism, in observed-feature space.

    Expressed over feature names rather than latent axes on purpose: an
    explanation graph over unaligned latent axes cannot be compared to a truth,
    and the evaluation spec forbids pretending otherwise.
    """

    source_names: Tuple[str, ...]
    target_name: str
    lag_days: float
    coefficient: float

    @property
    def interaction_order(self) -> int:
        return len(self.source_names)

    def key(self) -> Tuple[Tuple[str, ...], str, float]:
        return (tuple(sorted(self.source_names)), self.target_name, self.lag_days)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "source_names": list(self.source_names),
            "target_name": self.target_name,
            "lag_days": self.lag_days,
            "interaction_order": self.interaction_order,
            "coefficient": self.coefficient,
        }


@dataclass(frozen=True)
class SealedTruth:
    """What the evaluator knows and the learner must not see."""

    scenario: str
    seed: int
    true_edges: Tuple[TrueEdge, ...]
    structure_defined: bool
    structure_undefined_reason_ja: Optional[str]
    latent_values: Mapping[str, Tuple[Tuple[float, ...], ...]]
    split_groups: Mapping[str, str]
    noise_scale: float
    mechanism_ja: str
    exposes_ja: str

    def edge_keys(self) -> set:
        return {edge.key() for edge in self.true_edges}

    def as_dict(self) -> Dict[str, Any]:
        return {
            "scenario": self.scenario,
            "seed": self.seed,
            "true_edges": [edge.as_dict() for edge in self.true_edges],
            "structure_defined": self.structure_defined,
            "structure_undefined_reason_ja": self.structure_undefined_reason_ja,
            "split_groups": dict(self.split_groups),
            "noise_scale": self.noise_scale,
            "mechanism_ja": self.mechanism_ja,
            "exposes_ja": self.exposes_ja,
        }


@dataclass(frozen=True)
class SyntheticDataset:
    bundle: ObservationBundle
    truth: SealedTruth
    config: GeneratorConfig


def _times_for_day(day_index: int) -> Tuple[datetime, datetime]:
    """`recorded_at` and `available_at` for a day index.

    One second apart, and both after the event: the gap is small but it exists,
    so that code which confuses "written" with "usable" fails somewhere rather
    than passing by coincidence.
    """

    recorded_at = EPOCH + timedelta(days=day_index)
    return recorded_at, recorded_at + timedelta(seconds=1)


def _stable_matrix(rng: np.random.Generator, dim: int, spectral_radius: float = 0.72) -> np.ndarray:
    """A sparse transition matrix scaled to be stable.

    Without the rescaling a random matrix routinely has spectral radius above 1
    and the trajectories diverge; the "scenario" would then be measuring float
    overflow rather than a stable linear system.
    """

    matrix = rng.normal(0.0, 0.6, size=(dim, dim))
    mask = rng.random((dim, dim)) < 0.45
    matrix = matrix * mask
    np.fill_diagonal(matrix, rng.uniform(0.35, 0.65, size=dim))
    radius = max(float(np.max(np.abs(np.linalg.eigvals(matrix)))), 1e-9)
    return matrix * (spectral_radius / radius)


def _edges_from_matrix(matrix: np.ndarray, threshold: float = 0.05) -> Tuple[TrueEdge, ...]:
    edges: List[TrueEdge] = []
    for target_index, target_name in enumerate(FEATURE_NAMES):
        for source_index, source_name in enumerate(FEATURE_NAMES):
            coefficient = float(matrix[target_index, source_index])
            if abs(coefficient) >= threshold:
                edges.append(
                    TrueEdge(
                        source_names=(source_name,),
                        target_name=target_name,
                        lag_days=1.0,
                        coefficient=coefficient,
                    )
                )
    return tuple(edges)


def _participant_key(config: GeneratorConfig, index: int) -> str:
    return f"{config.scenario.lower()}-p{index:03d}"


def _rng_for(config: GeneratorConfig, index: int) -> np.random.Generator:
    """One independent stream per participant, derived from the scenario seed.

    Deriving rather than sharing means adding a participant does not perturb the
    trajectories of the existing ones, so a dataset grown from 18 to 30 keeps
    the earlier results comparable.
    """

    return np.random.default_rng([config.seed, SCENARIOS.index(config.scenario), index])


def _observation(
    config: GeneratorConfig,
    participant_key: str,
    day_index: int,
    values: Sequence[Optional[float]],
    mask: Sequence[bool],
) -> Observation:
    recorded_at, available_at = _times_for_day(day_index)
    return Observation(
        dataset_id=config.resolved_dataset_id,
        participant_key=participant_key,
        event_id=f"{participant_key}-d{day_index:03d}",
        occurred_at=recorded_at,
        recorded_at=recorded_at,
        available_at=available_at,
        timezone="Asia/Tokyo",
        feature_schema_id=FEATURE_SCHEMA_ID,
        feature_names=FEATURE_NAMES,
        units=FEATURE_UNITS,
        values=tuple(values),
        observed_mask=tuple(mask),
        source_kind="synthetic",
        source_refs=(f"generator-v0/{config.scenario}/seed-{config.seed}/day-{day_index:03d}",),
        permitted_uses=("synthetic_training", "synthetic_evaluation"),
    )


# --------------------------------------------------------------------------
# The five mechanisms
# --------------------------------------------------------------------------


def _simulate_linear(config: GeneratorConfig, matrix: np.ndarray, index: int) -> np.ndarray:
    rng = _rng_for(config, index)
    dim = len(FEATURE_NAMES)
    state = rng.normal(0.0, 0.5, size=dim)
    rows = []
    for _ in range(config.n_days):
        rows.append(state + rng.normal(0.0, config.noise_scale, size=dim))
        state = matrix @ state + rng.normal(0.0, config.innovation_scale, size=dim)
    return np.asarray(rows)


def _simulate_moving_average(config: GeneratorConfig, index: int, window: int = 5) -> np.ndarray:
    """S2: the next x1 depends on the mean of the last five, not on the last one.

    Two participants can pass through the same present value from different
    histories; a model that only reads the current row must give them the same
    future and be wrong about at least one.
    """

    rng = _rng_for(config, index)
    dim = len(FEATURE_NAMES)
    history: List[float] = list(rng.normal(0.0, 0.5, size=window))
    others = rng.normal(0.0, 0.5, size=dim - 1)
    rows = []
    for _ in range(config.n_days):
        current = history[-1]
        observed = np.concatenate([[current], others]) + rng.normal(
            0.0, config.noise_scale * S2_OBSERVATION_RATIO, size=dim
        )
        rows.append(observed)
        window_mean = float(np.mean(history[-window:]))
        # 0.10 + 0.80 < 1: the two coefficients have to sum below one or the
        # series diverges and the scenario measures overflow instead of memory.
        history.append(
            0.10 * current
            + 0.80 * window_mean
            + float(rng.normal(0.0, config.innovation_scale * S2_INNOVATION_RATIO))
        )
        others = 0.55 * others + rng.normal(0.0, config.innovation_scale, size=dim - 1)
    return np.asarray(rows)


def _simulate_interaction(config: GeneratorConfig, index: int) -> np.ndarray:
    """S3: x4 responds to the *product* of x1 and x2 as well as to each alone."""

    rng = _rng_for(config, index)
    x1, x2, x3, x4 = rng.normal(0.0, 0.5, size=4)
    rows = []
    for _ in range(config.n_days):
        rows.append(np.array([x1, x2, x3, x4]) + rng.normal(0.0, config.noise_scale, size=4))
        next_x1 = 0.55 * x1 + float(rng.normal(0.0, config.innovation_scale))
        next_x2 = 0.50 * x2 + float(rng.normal(0.0, config.innovation_scale))
        next_x3 = 0.45 * x3 + float(rng.normal(0.0, config.innovation_scale))
        next_x4 = (
            0.60 * x1
            + 0.50 * x2
            + S3_INTERACTION_COEFFICIENT * x1 * x2
            + 0.20 * x4
            + float(rng.normal(0.0, config.innovation_scale * S3_TARGET_INNOVATION_RATIO))
        )
        x1, x2, x3, x4 = next_x1, next_x2, next_x3, next_x4
    return np.asarray(rows)


def _simulate_confounded(config: GeneratorConfig, index: int) -> Tuple[np.ndarray, np.ndarray]:
    """S5: one unobserved driver reaches x1 at lag 1 and x2 at lag 2.

    x1 and x2 end up correlated with a one-day offset, which is exactly the
    shape a lag-1 edge fitter will happily report as x1 → x2. There is no such
    edge. Returns the observed rows and the sealed latent u.
    """

    rng = _rng_for(config, index)
    latent = 0.0
    latent_history: List[float] = [0.0, 0.0]
    x3, x4 = rng.normal(0.0, 0.5, size=2)
    rows = []
    latents = []
    for _ in range(config.n_days):
        latent = 0.80 * latent + float(rng.normal(0.0, config.innovation_scale))
        latent_history.append(latent)
        x1 = 0.90 * latent_history[-2] + float(rng.normal(0.0, config.noise_scale))
        x2 = 0.85 * latent_history[-3] + float(rng.normal(0.0, config.noise_scale))
        x3 = 0.50 * x3 + float(rng.normal(0.0, config.innovation_scale))
        x4 = 0.40 * x4 + float(rng.normal(0.0, config.innovation_scale))
        rows.append(np.array([x1, x2, x3, x4]))
        latents.append(np.array([latent]))
    return np.asarray(rows), np.asarray(latents)


def _apply_missingness(
    config: GeneratorConfig, rows: np.ndarray, index: int, drop_rate: float = 0.35
) -> Tuple[List[int], List[List[Optional[float]]], List[List[bool]]]:
    """S4: drop values *and* whole days.

    Dropped values become null with `observed_mask=false` — never zero. Dropped
    days leave a real gap in `day_index`, so `delta_days` is sometimes 3 and a
    model that assumes one row per day is wrong about the elapsed time rather
    than merely about the value.
    """

    rng = np.random.default_rng([config.seed, 99, index])
    day_indices: List[int] = []
    values: List[List[Optional[float]]] = []
    masks: List[List[bool]] = []
    day = 0
    while day < config.n_days and len(day_indices) < config.n_days:
        if day_indices and rng.random() < 0.30:
            day += int(rng.integers(1, 4))  # a gap of one to three days
            if day >= config.n_days:
                break
        row = rows[min(day, len(rows) - 1)]
        mask = [bool(flag) for flag in (rng.random(len(FEATURE_NAMES)) >= drop_rate)]
        if not any(mask):
            mask[0] = True  # an all-null row carries nothing; keep one channel
        day_indices.append(day)
        values.append([float(value) if keep else None for value, keep in zip(row, mask)])
        masks.append(mask)
        day += 1
    return day_indices, values, masks


def generate(config: GeneratorConfig) -> SyntheticDataset:
    """Build one scenario's bundle and its sealed truth."""

    if config.scenario not in SCENARIOS:
        raise ValueError(f"未知のシナリオです: {config.scenario}")

    matrix_rng = np.random.default_rng([config.seed, 7, SCENARIOS.index(config.scenario)])
    matrix = _stable_matrix(matrix_rng, len(FEATURE_NAMES))

    observations: List[Observation] = []
    latents: Dict[str, Tuple[Tuple[float, ...], ...]] = {}
    split_groups: Dict[str, str] = {}

    for index in range(config.n_participants):
        participant_key = _participant_key(config, index)
        latent_rows: Optional[np.ndarray] = None

        if config.scenario == "S1":
            rows = _simulate_linear(config, matrix, index)
        elif config.scenario == "S2":
            rows = _simulate_moving_average(config, index)
        elif config.scenario == "S3":
            rows = _simulate_interaction(config, index)
        elif config.scenario == "S4":
            rows = _simulate_linear(config, matrix, index)
        else:
            rows, latent_rows = _simulate_confounded(config, index)

        if config.scenario == "S4":
            day_indices, values, masks = _apply_missingness(config, rows, index)
        else:
            day_indices = list(range(len(rows)))
            values = [[float(value) for value in row] for row in rows]
            masks = [[True] * len(FEATURE_NAMES) for _ in rows]

        for day_index, row_values, row_mask in zip(day_indices, values, masks):
            observations.append(_observation(config, participant_key, day_index, row_values, row_mask))

        latents[participant_key] = tuple(
            tuple(float(value) for value in row)
            for row in (latent_rows if latent_rows is not None else rows)
        )
        # S2 generates its participants as crossing pairs: two members of a pair
        # share a present value at some point and must never straddle a split,
        # or "generalises to unseen participants" would be measured on a copy.
        split_groups[participant_key] = (
            f"{config.scenario}-pair{index // 2:02d}" if config.scenario == "S2" else f"{config.scenario}-solo{index:03d}"
        )

    if config.scenario in ("S1", "S4"):
        true_edges = _edges_from_matrix(matrix)
        structure_defined = True
        undefined_reason = None
    elif config.scenario == "S3":
        true_edges = (
            TrueEdge(("x1",), "x1", 1.0, 0.55),
            TrueEdge(("x2",), "x2", 1.0, 0.50),
            TrueEdge(("x3",), "x3", 1.0, 0.45),
            TrueEdge(("x1",), "x4", 1.0, 0.60),
            TrueEdge(("x2",), "x4", 1.0, 0.50),
            TrueEdge(("x4",), "x4", 1.0, 0.20),
            TrueEdge(("x1", "x2"), "x4", 1.0, S3_INTERACTION_COEFFICIENT),
        )
        structure_defined = True
        undefined_reason = None
    elif config.scenario == "S5":
        # The truth among *observed* features is that there are no edges at all.
        # Any x1 → x2 edge a fitter reports is a false positive produced by the
        # unobserved driver, and that is the number this scenario exists to get.
        true_edges = (
            TrueEdge(("x3",), "x3", 1.0, 0.50),
            TrueEdge(("x4",), "x4", 1.0, 0.40),
        )
        structure_defined = True
        undefined_reason = None
    else:
        true_edges = ()
        structure_defined = False
        undefined_reason = (
            "S2の依存は5日移動平均であり、v0の説明モデル（lag=1の線形＋積項）では"
            "表現できない。表現できない真値に対する構造回復は算出しない。"
        )

    manifest = DatasetManifest(
        dataset_id=config.resolved_dataset_id,
        feature_schema_id=FEATURE_SCHEMA_ID,
        file_hashes={},
        split_id="unassigned",
        split_assignment_ref="pending",
        generation_or_collection_protocol=(
            f"research_engine.evaluation.generators/{config.scenario}"
            f"?seed={config.seed}&participants={config.n_participants}&days={config.n_days}"
            f"&noise={config.noise_scale}&innovation={config.innovation_scale}"
        ),
        permitted_uses=("synthetic_training", "synthetic_evaluation"),
        created_at=EPOCH,
        feature_names=FEATURE_NAMES,
        units=FEATURE_UNITS,
        schema_version=OBSERVATION_SCHEMA_VERSION,
    )
    bundle = ObservationBundle(manifest=manifest, observations=observations)
    bundle.validate()

    truth = SealedTruth(
        scenario=config.scenario,
        seed=config.seed,
        true_edges=true_edges,
        structure_defined=structure_defined,
        structure_undefined_reason_ja=undefined_reason,
        latent_values=latents,
        split_groups=split_groups,
        noise_scale=config.noise_scale,
        mechanism_ja=_MECHANISM_JA[config.scenario],
        exposes_ja=_EXPOSES_JA[config.scenario],
    )
    return SyntheticDataset(bundle=bundle, truth=truth, config=config)


def generate_all(
    seed: int = 11,
    scenarios: Sequence[str] = SCENARIOS,
    n_participants: int = DEFAULT_PARTICIPANTS,
    n_days: int = DEFAULT_DAYS,
) -> Dict[str, SyntheticDataset]:
    return {
        scenario: generate(
            GeneratorConfig(
                scenario=scenario, seed=seed, n_participants=n_participants, n_days=n_days
            )
        )
        for scenario in scenarios
    }


_MECHANISM_JA = {
    "S1": "安定な線形VAR。状態は s_{t+1} = A s_t + 過程ノイズ、観測は x_t = s_t + 観測ノイズ。",
    "S2": "x1の次の値が直前5日の移動平均に依存する（0.10·現在 + 0.80·移動平均）。現在値が同じでも履歴が違えば未来が違う。",
    "S3": f"x4が x1, x2 の和に加えて積 x1·x2 に係数{S3_INTERACTION_COEFFICIENT}で依存する。",
    "S4": "S1と同じ機構に、値の欠測（35%）と1〜3日の日跨ぎ欠落を加える。",
    "S5": "観測されない駆動変数uがx1にlag1、x2にlag2で作用する。x1とx2の間に辺はない。",
}

_EXPOSES_JA = {
    "S1": "単純な線形で足りる場面で複雑なモデルが優れて見えること。",
    "S2": "記憶を使わないモデルが同じ未来を返すこと。",
    "S3": "加算型モデルが組合せ効果を取り逃がすこと。",
    "S4": "欠測を0、7日を1日として扱うこと。",
    "S5": "相関を現実の因果として表示すること。",
}
