"""BLESC research engine — the v0 world-model prototype (#156).

This package is new and deliberately separate from `app/`. `app/temporal/`
holds a *data* model: it records what was observed and when, and says so in its
own docstring. Nothing in it is trained and nothing in it forecasts. The code
here is the opposite: small models that are actually fitted to data, evaluated
against baselines, and required to say when they have not been trained.

Keeping the two apart is the point. A learned state that leaked into the
temporal graph would make an inference indistinguishable from an observation,
and the whole provenance argument in `sentra/docs/participant_temporal_graph.md`
rests on that distinction holding.

Layout follows the team ownership in the delivery plan, so a reader can map a
directory to the contract it produces:

- `contracts/`   C1–C6 types, versions and the checks that reject bad handoffs
- `data/`        observations, splits, train-only normalisation           (C1)
- `representation/` the trained encoder and its checkpoint                (C2)
- `dynamics/`    baselines, the memory model, forecasts and rollouts      (C3)
- `abstraction/` the explanation projection, candidate edges, fidelity    (C4)
- `evaluation/`  synthetic generators, sealed truth, leakage checks, report (C5)
- `cli.py`       the one command that runs the whole path end to end

Scope, stated once so no downstream reader has to infer it: v0 runs on
**synthetic data only**. It needs no network, no API key and no GPU. It does not
model any real person, and none of its numbers are evidence about one.
"""

from .contracts import versions as _versions

__all__ = ["CONTRACT_VERSION"]

#: The one version string every artifact carries. Bumped by T0 only, and only
#: with a fixture diff, per the contract-change rule in the delivery plan.
CONTRACT_VERSION = _versions.CONTRACT_VERSION
