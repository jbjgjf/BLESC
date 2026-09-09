"""The one path: generate → split → train → forecast → explain → score.

This is what `python -m research_engine.cli smoke` runs and what the research
API schedules. Everything it produces is written to a run directory: the encoder
checkpoint, the sealed prediction ledger, the explanation bundles and the
evaluation report.

Three ordering decisions are load-bearing and easy to get wrong in a refactor.

**Forecasts are sealed before they are scored.** Every bundle is appended to the
ledger at issue time; scoring reads the ledger back and checks nothing moved.
Scoring first and recording afterwards would make the ledger a transcript of the
result rather than a seal on the prediction.

**The normaliser and the encoder see train only.** The split is computed first,
the normaliser is fitted on train rows, and validation is used for selection.
Heldout is touched exactly once, at scoring.

**A model that declines is recorded as declining.** The comparison set is the
intersection across models, so a baseline that answers where another abstains
cannot win by answering an easier subset.
"""

from __future__ import annotations

import dataclasses
import json
import platform
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

import numpy as np

from .abstraction import (
    build_explanation_bundle,
    fit_explanation_model,
    fit_projection,
    score_fidelity,
)
from .contracts.capabilities import CapabilityFlags
from .contracts.common import content_hash, elapsed_days, format_time
from .contracts.evaluation import EvaluationReport, LeakageCheck, MeasuredUsage, Metric
from .contracts.forecast import ForecastBundle
from .data import (
    fit_normalizer,
    load_observations,
    make_sequences,
    participant_split,
)
from .dynamics import (
    LinearARForecaster,
    MemoryForecaster,
    PersistenceForecaster,
    TrainMeanForecaster,
    build_context,
)
from .evaluation import GeneratorConfig, generate
from .evaluation import leakage as leakage_checks
from .evaluation.ledger import PredictionLedger, input_hash_for
from .evaluation.metrics import (
    Prediction,
    interval_coverage,
    interval_width,
    mae,
    rmse,
    structure_metrics,
)
from .representation import EncoderConfig, EncoderArtifact, encode, fit_encoder

REPRODUCIBILITY_COMMAND = (
    "cd sentra/backend && python -m research_engine.cli smoke "
    "--config research_engine/configs/smoke.json --out /tmp/blesc-research-smoke"
)

#: v0 limitations, attached to every report. Written here rather than in the
#: renderer so they travel with the JSON to whoever reads it next.
LIMITATIONS_JA = (
    "合成データのみ。実在の人物についての証拠ではなく、臨床的有効性の主張でもない。",
    "hashは内容の一致確認であり、単独で改ざん不能を保証しない。台帳の保存先と追記権限も併せて検証する必要がある。",
    "seedは再現性の初期点検であり、統計的検出力の保証ではない。",
    "evaluation_mode=historical_simulation。既存データの再生であり、事前の実参加者予測ではない。",
    "不確実性はvalidationで測った残差の広がりであり、較正済みではない。被覆率と区間幅を併せて読む。",
    "構造回復は真の構造が定義できるシナリオに限る。潜在軸そのものの比較はしていない。",
)


@dataclass
class RunConfig:
    config_id: str = "research-smoke-v0"
    scenarios: Tuple[str, ...] = ("S1", "S2", "S3", "S4", "S5")
    seeds: Tuple[int, ...] = (11, 12, 13)
    n_participants: int = 18
    n_days: int = 40
    latent_dim: int = 8
    epochs: int = 150
    horizons: Tuple[int, ...] = (1, 2, 3)
    cutoff_fraction: float = 0.7
    bootstrap_rounds: int = 40
    fidelity_steps: int = 3

    def as_dict(self) -> Dict[str, Any]:
        return {
            "config_id": self.config_id,
            "scenarios": list(self.scenarios),
            "seeds": list(self.seeds),
            "n_participants": self.n_participants,
            "n_days": self.n_days,
            "latent_dim": self.latent_dim,
            "epochs": self.epochs,
            "horizons": list(self.horizons),
            "cutoff_fraction": self.cutoff_fraction,
            "bootstrap_rounds": self.bootstrap_rounds,
            "fidelity_steps": self.fidelity_steps,
        }

    @staticmethod
    def from_dict(payload: Mapping[str, Any]) -> "RunConfig":
        defaults = RunConfig()
        return RunConfig(
            config_id=str(payload.get("config_id", defaults.config_id)),
            scenarios=tuple(payload.get("scenarios", defaults.scenarios)),
            seeds=tuple(int(seed) for seed in payload.get("seeds", defaults.seeds)),
            n_participants=int(payload.get("n_participants", defaults.n_participants)),
            n_days=int(payload.get("n_days", defaults.n_days)),
            latent_dim=int(payload.get("latent_dim", defaults.latent_dim)),
            epochs=int(payload.get("epochs", defaults.epochs)),
            horizons=tuple(int(value) for value in payload.get("horizons", defaults.horizons)),
            cutoff_fraction=float(payload.get("cutoff_fraction", defaults.cutoff_fraction)),
            bootstrap_rounds=int(payload.get("bootstrap_rounds", defaults.bootstrap_rounds)),
            fidelity_steps=int(payload.get("fidelity_steps", defaults.fidelity_steps)),
        )

    def config_hash(self) -> str:
        return content_hash(self.as_dict())


@dataclass
class RunResult:
    run_id: str
    report: EvaluationReport
    explanations: List[Dict[str, Any]]
    run_dir: Path
    forecast_previews: List[Dict[str, Any]] = field(default_factory=list)
    predictions: List[Prediction] = field(default_factory=list)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "run_id": self.run_id,
            "report": self.report.as_dict(),
            "explanations": self.explanations,
            "run_dir": str(self.run_dir),
        }


BASELINE_IDS = ("persistence", "train_mean", "linear_ar")
MODEL_IDS = BASELINE_IDS + ("memory_gru",)


def _scenario_seed_pass(
    config: RunConfig,
    scenario: str,
    seed: int,
    run_id: str,
    ledger: PredictionLedger,
    run_dir: Path,
) -> Dict[str, Any]:
    dataset = generate(
        GeneratorConfig(
            scenario=scenario, seed=seed, n_participants=config.n_participants, n_days=config.n_days
        )
    )
    bundle = load_observations(dataset.bundle)
    split = participant_split(bundle, dataset.truth.split_groups, seed=seed)

    train_rows = [
        row for row in bundle.observations if split.assignment[row.participant_key] == "train"
    ]
    normalizer = fit_normalizer(
        train_rows,
        feature_schema_id=bundle.manifest.feature_schema_id,
        feature_names=bundle.manifest.feature_names,
    )
    train = make_sequences(bundle, normalizer, split.assignment, splits=["train"])
    validation = make_sequences(bundle, normalizer, split.assignment, splits=["validation"])
    heldout = make_sequences(bundle, normalizer, split.assignment, splits=["heldout"])

    artifact = fit_encoder(
        train,
        validation,
        EncoderConfig(latent_dim=config.latent_dim, epochs=config.epochs, seed=seed),
    )
    if scenario == config.scenarios[0] and seed == config.seeds[0]:
        artifact.save(run_dir / "encoder")

    models = {
        "persistence": PersistenceForecaster(),
        "train_mean": TrainMeanForecaster.fit(train),
        "linear_ar": LinearARForecaster.fit(train),
        "memory_gru": MemoryForecaster.fit(
            train, validation, artifact, normalizer, horizons=config.horizons
        ),
    }

    # ---- forecasts, sealed then scored --------------------------------
    predictions: List[Prediction] = []
    forecasts: List[ForecastBundle] = []
    answered: Dict[str, set] = {model_id: set() for model_id in MODEL_IDS}
    per_model_bundles: Dict[str, List[Tuple[ForecastBundle, Any, int]]] = {
        model_id: [] for model_id in MODEL_IDS
    }

    for sequence in heldout:
        index = max(1, int(sequence.length * config.cutoff_fraction))
        if index >= sequence.length - 1:
            continue
        cutoff = sequence.available_times[index]
        context = build_context(
            run_id=run_id,
            dataset_id=bundle.manifest.dataset_id,
            split_id=split.split_id,
            sequence=sequence,
            normalizer=normalizer,
            cutoff_at=cutoff,
            horizons=config.horizons,
        )
        for model_id, model in models.items():
            forecast = model.forecast(context, encoder_id=artifact.encoder_id)
            ledger.append(
                forecast,
                input_hash=input_hash_for(context.sequence.event_ids, cutoff),
                model_hash=model.model_hash(),
            )
            forecasts.append(forecast)
            if forecast.status == "ok":
                answered[model_id].add(sequence.participant_key)
                per_model_bundles[model_id].append((forecast, sequence, index))

    # The comparison set: participants every model answered for. A baseline
    # that answers where another abstains would otherwise be scored on an
    # easier subset and win for the wrong reason.
    comparable = set.intersection(*(answered[model_id] for model_id in MODEL_IDS)) if forecasts else set()

    for model_id, entries in per_model_bundles.items():
        for forecast, sequence, index in entries:
            if sequence.participant_key not in comparable:
                continue
            # Score each target against the observation that actually falls on
            # its `target_time`, not against "the Nth later row". Those are the
            # same thing only when the data is daily. In S4 they are not: with
            # a three-day gap, the Nth later row sits three days out while the
            # forecast promised one, and 42% of S4's scored rows were compared
            # against the wrong date before this lookup existed. A target with
            # no observation on its date is skipped — there is nothing to score
            # it against, and the nearest row is a different question.
            by_time = {time: position for position, time in enumerate(sequence.available_times)}
            for h_index, target_time in enumerate(forecast.target_times):
                target_index = by_time.get(target_time)
                if target_index is None:
                    continue
                actual_row = sequence.raw_values[target_index]
                observed = sequence.mask[target_index]
                scales = forecast.scales_or_samples
                for feature_index, feature_name in enumerate(forecast.target_names):
                    if not observed[feature_index]:
                        continue
                    predictions.append(
                        Prediction(
                            participant_key=sequence.participant_key,
                            model_id=model_id,
                            scenario=scenario,
                            horizon_days=elapsed_days(target_time, forecast.cutoff_at),
                            target_name=feature_name,
                            predicted=float(forecast.means[h_index][feature_index]),
                            actual=float(actual_row[feature_index]),
                            scale=(
                                float(scales[h_index][feature_index]) if scales is not None else None
                            ),
                        )
                    )

    # ---- explanation ---------------------------------------------------
    projection = fit_projection(train, artifact)
    explanation = None
    fidelity = None
    if projection is not None:
        model = artifact.to_model()
        trajectories = [
            projection.apply(
                model.encode(
                    sequence.values, sequence.mask, np.asarray(sequence.delta_days, dtype=float)
                )
            )
            for sequence in train
        ]
        explanation = fit_explanation_model(
            trajectories,
            list(normalizer.feature_names),
            bootstrap_rounds=config.bootstrap_rounds,
            seed=seed,
        )
        if explanation is not None:
            fidelity = score_fidelity(
                heldout,
                models["memory_gru"],
                projection,
                explanation,
                steps=config.fidelity_steps,
            )

    # One participant's history and forecast, saved so the research screen can
    # draw a time series without the browser ever receiving a checkpoint or a
    # whole dataset. Preview only: it is one heldout participant, chosen as the
    # first in sorted order rather than the one that looks best.
    preview = None
    if per_model_bundles["memory_gru"]:
        preview_forecast, preview_sequence, preview_index = per_model_bundles["memory_gru"][0]
        baseline = next(
            (
                entry[0]
                for entry in per_model_bundles["persistence"]
                if entry[1].participant_key == preview_sequence.participant_key
            ),
            None,
        )
        preview = {
            "scenario": scenario,
            "seed": seed,
            "participant_key": preview_sequence.participant_key,
            "feature_names": list(preview_sequence.feature_names),
            "cutoff_at": format_time(preview_forecast.cutoff_at),
            # Up to and including the cutoff only. Carrying the whole sequence
            # here would let the screen draw observations to the right of the
            # cutoff line, and the cutoff is the one thing that makes the rest
            # of that chart interpretable.
            "history": [
                {
                    "available_at": format_time(preview_sequence.available_times[position]),
                    "values": [
                        None if not observed else float(value)
                        for value, observed in zip(
                            preview_sequence.raw_values[position],
                            preview_sequence.mask[position],
                        )
                    ],
                }
                for position in range(preview_index + 1)
            ],
            "actual_after_cutoff": [
                {
                    "available_at": format_time(preview_sequence.available_times[position]),
                    "values": [
                        None if not observed else float(value)
                        for value, observed in zip(
                            preview_sequence.raw_values[position], preview_sequence.mask[position]
                        )
                    ],
                }
                for position in range(preview_index + 1, preview_sequence.length)
            ],
            "forecast": preview_forecast.as_dict(),
            "baseline_forecast": baseline.as_dict() if baseline is not None else None,
        }

    representative = per_model_bundles["memory_gru"][0][0] if per_model_bundles["memory_gru"] else None
    state_values = None
    if projection is not None and heldout:
        encoded_state = artifact.to_model().encode(
            heldout[0].values, heldout[0].mask, np.asarray(heldout[0].delta_days, dtype=float)
        )
        if len(encoded_state):
            state_values = projection.apply_one(encoded_state[-1]).tolist()

    explanation_bundle = build_explanation_bundle(
        run_id=run_id,
        forecast_id=representative.forecast_id if representative else f"{run_id}-{scenario}-none",
        projection=projection,
        explanation=explanation,
        fidelity=fidelity,
        state_values=state_values,
        capability_flags=models["memory_gru"].capability_flags(),
        source_refs=(f"generator-v0/{scenario}/seed-{seed}",),
    )

    recovered_edges = (
        [
            (tuple(term.source_axes), term.target_axis, coefficient)
            for term, coefficient, _ in explanation.selected_terms()
        ]
        if explanation is not None
        else []
    )
    true_edges = [
        (edge.source_names, edge.target_name, edge.coefficient) for edge in dataset.truth.true_edges
    ]

    checks = [
        leakage_checks.available_at_within_cutoff(
            forecasts, {row.event_id: row.available_at for row in bundle.observations}
        ),
        leakage_checks.future_row_is_refused(bundle),
        leakage_checks.split_groups_are_disjoint(split),
        leakage_checks.normalizer_was_fitted_on_train_only(
            normalizer, [row.event_id for row in train_rows]
        ),
        leakage_checks.online_evaluation_excludes_smoothing(forecasts),
    ]

    return {
        "scenario": scenario,
        "seed": seed,
        "dataset_hash": bundle.content_hash(),
        "split_hash": split.content_hash(),
        "encoder_id": artifact.encoder_id,
        "model_hashes": {model_id: model.model_hash() for model_id, model in models.items()},
        "predictions": predictions,
        "forecasts": forecasts,
        "explanation_bundle": explanation_bundle,
        "recovered_edges": recovered_edges,
        "true_edges": true_edges,
        "structure_defined": dataset.truth.structure_defined,
        "structure_undefined_reason_ja": dataset.truth.structure_undefined_reason_ja,
        "leakage_checks": checks,
        "forecast_preview": preview,
        "encoder_training_status": artifact.training_status,
        "n_comparable_participants": len(comparable),
    }



def _structure_across_seeds(scenario_passes: Sequence[Dict[str, Any]]) -> List[Metric]:
    """Structure recovery over every seed of one scenario, not just the first.

    Taking the first pass would have reported seed 11's precision under a report
    that advertises seeds 11, 12 and 13, letting the later seeds disagree without
    the number moving. Each seed is scored separately; the value is the mean
    across seeds and the interval is the range they actually spanned, so
    disagreement between seeds shows up as a wide interval rather than
    disappearing.
    """

    if not scenario_passes:
        return []

    per_seed: List[List[Metric]] = [
        structure_metrics(
            entry["recovered_edges"],
            entry["true_edges"],
            "sparse-projection-v0",
            structure_defined=entry["structure_defined"],
            undefined_reason_ja=entry["structure_undefined_reason_ja"],
        )
        for entry in scenario_passes
    ]

    combined: List[Metric] = []
    for position in range(len(per_seed[0])):
        candidates = [seed_metrics[position] for seed_metrics in per_seed]
        usable = [metric for metric in candidates if metric.status == "ok" and metric.value is not None]
        if not usable:
            # Every seed declined for the same reason; report it once.
            combined.append(candidates[0])
            continue

        values = [float(metric.value) for metric in usable]
        combined.append(
            dataclasses.replace(
                usable[0],
                value=float(np.mean(values)),
                n_predictions=sum(metric.n_predictions or 0 for metric in usable),
                uncertainty_method="across_seeds_range" if len(values) > 1 else None,
                interval=(min(values), max(values)) if len(values) > 1 else None,
            )
        )
    return combined


def run_pipeline(config: RunConfig, out_dir: Path, run_id: Optional[str] = None) -> RunResult:
    started = time.monotonic()
    run_dir = Path(out_dir)
    run_dir.mkdir(parents=True, exist_ok=True)
    run_id = run_id or f"run-{config.config_id}-{config.config_hash().split(':')[1][:8]}"

    ledger = PredictionLedger(run_dir / "predictions.jsonl", run_id=run_id)
    passes: List[Dict[str, Any]] = []
    for scenario in config.scenarios:
        for seed in config.seeds:
            passes.append(_scenario_seed_pass(config, scenario, seed, run_id, ledger, run_dir))

    all_predictions = [p for entry in passes for p in entry["predictions"]]
    all_forecasts = [f for entry in passes for f in entry["forecasts"]]

    metrics: List[Metric] = []
    unsupported: List[Metric] = []
    for model_id in MODEL_IDS:
        subset = [p for p in all_predictions if p.model_id == model_id]
        metrics.append(mae(subset, model_id))
        metrics.append(rmse(subset, model_id))
        for metric in (interval_coverage(subset, model_id), interval_width(subset, model_id)):
            (metrics if metric.status == "ok" else unsupported).append(metric)

    metrics_by_scenario: Dict[str, List[Metric]] = {}
    for scenario in config.scenarios:
        scenario_metrics: List[Metric] = []
        for model_id in MODEL_IDS:
            subset = [
                p for p in all_predictions if p.model_id == model_id and p.scenario == scenario
            ]
            scenario_metrics.append(mae(subset, model_id, target=scenario))
        structure = _structure_across_seeds(
            [item for item in passes if item["scenario"] == scenario]
        )
        for metric in structure:
            if metric.status == "ok":
                scenario_metrics.append(metric)
            else:
                unsupported.append(metric)
        metrics_by_scenario[scenario] = scenario_metrics

    checks: List[LeakageCheck] = []
    seen_names = set()
    for entry in passes:
        for check in entry["leakage_checks"]:
            key = (check.name, check.passed)
            if check.passed and check.name in seen_names:
                continue
            seen_names.add(check.name)
            checks.append(check)
    checks.append(leakage_checks.predictions_were_sealed(ledger, all_forecasts))

    artifact_hashes = {
        "dataset_hash": content_hash([entry["dataset_hash"] for entry in passes]),
        "split_hash": content_hash([entry["split_hash"] for entry in passes]),
        "config_hash": config.config_hash(),
        "model_hash": content_hash([entry["model_hashes"] for entry in passes]),
        "encoder_hash": content_hash([entry["encoder_id"] for entry in passes]),
    }

    report = EvaluationReport(
        run_id=run_id,
        dataset_id=",".join(sorted({entry["scenario"] for entry in passes})),
        split_id="participant-holdout-v0",
        artifact_hashes=artifact_hashes,
        seed_list=config.seeds,
        baselines=list(BASELINE_IDS),
        metrics=metrics,
        metrics_by_scenario=metrics_by_scenario,
        unsupported_metrics=unsupported,
        leakage_checks=checks,
        predictions_ref=str((run_dir / "predictions.jsonl").name),
        limitations=LIMITATIONS_JA,
        measured_usage=MeasuredUsage(
            # Measured, not assumed: this pipeline makes no provider call at
            # all, and 0 is the evidence for that. `null` would mean unmeasured.
            provider_calls=0,
            input_tokens=0,
            output_tokens=0,
            cached_tokens=0,
            elapsed_seconds=time.monotonic() - started,
            compute_environment=f"cpu-only, numpy {np.__version__}, python {platform.python_version()}",
        ),
        reproducibility_command=REPRODUCIBILITY_COMMAND,
        status="ok" if all(check.passed for check in checks) else "failed",
        generated_at=datetime.now(timezone.utc),
    )
    report.validate()

    explanations = [entry["explanation_bundle"].as_dict() for entry in passes]
    previews = [entry["forecast_preview"] for entry in passes if entry["forecast_preview"]]
    (run_dir / "report.json").write_text(
        json.dumps(report.as_dict(), indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    (run_dir / "explanations.json").write_text(
        json.dumps(explanations, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    (run_dir / "forecast_previews.json").write_text(
        json.dumps(previews, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    (run_dir / "run_config.json").write_text(
        json.dumps(config.as_dict(), indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )

    return RunResult(
        run_id=run_id,
        report=report,
        explanations=explanations,
        run_dir=run_dir,
        forecast_previews=previews,
        predictions=all_predictions,
    )
