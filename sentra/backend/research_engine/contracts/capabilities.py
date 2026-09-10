"""Capability flags: what this run actually did, declared before anyone asks.

The flags exist because the honest answer to "does the system model causal
effects?" changes per run, and a UI that decides by reading a model name will
get it wrong. Every artifact carries the full set, all six keys present, so a
missing key can never be read as an implicit yes.

Two flags are pinned false and cannot be set by configuration:
`real_world_causal_effects`, because nothing in v0 estimates an effect on a
person, and `active_questioning`, because no question-selection policy exists.
Pinning them here rather than trusting review means a config that asks for them
fails loudly at construction time.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Mapping

from .common import require
from .errors import Code
from .versions import CAPABILITY_FLAGS, FORBIDDEN_IN_V0


@dataclass(frozen=True)
class CapabilityFlags:
    trained_encoder: bool = False
    trained_dynamics: bool = False
    calibrated_uncertainty: bool = False
    model_interventions: bool = False
    real_world_causal_effects: bool = False
    active_questioning: bool = False

    def validate(self, path: str = "capability_flags") -> None:
        for name in FORBIDDEN_IN_V0:
            require(
                getattr(self, name) is False,
                Code.FORBIDDEN_CAPABILITY,
                f"v0では {name} をtrueにできません。根拠となる実装も検証もありません。",
                f"{path}.{name}",
            )

    def as_dict(self) -> Dict[str, bool]:
        return {name: bool(getattr(self, name)) for name in CAPABILITY_FLAGS}

    @staticmethod
    def from_dict(payload: Mapping[str, Any], path: str = "capability_flags") -> "CapabilityFlags":
        unknown = sorted(set(payload) - set(CAPABILITY_FLAGS))
        require(
            not unknown,
            Code.UNKNOWN_FIELD,
            f"未知のcapability flagです: {', '.join(unknown)}",
            path,
            unknown=unknown,
        )
        flags = CapabilityFlags(**{name: bool(payload.get(name, False)) for name in CAPABILITY_FLAGS})
        flags.validate(path)
        return flags
