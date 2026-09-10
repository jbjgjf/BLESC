"""T3 — baselines and the memory model, all emitting the same ForecastBundle."""

from .base import Forecaster, ForecastContext, build_context, last_observed
from .baselines import LinearARForecaster, PersistenceForecaster, TrainMeanForecaster
from .memory import SUPPORTED_INTERVENTIONS, MemoryForecaster, RolloutStep

__all__ = [
    "Forecaster",
    "ForecastContext",
    "LinearARForecaster",
    "MemoryForecaster",
    "PersistenceForecaster",
    "RolloutStep",
    "SUPPORTED_INTERVENTIONS",
    "TrainMeanForecaster",
    "build_context",
    "last_observed",
]
