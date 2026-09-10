"""Version strings and capability flags, in one place so they cannot drift.

Every artifact in the engine carries the schema version it was written under.
Two artifacts whose dimensions happen to match are *not* compatible: the
contract requires a version match as well, because a feature vector of the same
width can mean entirely different things after a schema change, and silently
accepting it is how a run produces confident numbers about the wrong quantity.
"""

from __future__ import annotations

#: Umbrella version for the whole v0 handoff. Referenced by the Wiki as
#: `research-plan-v1`; the artifacts use the per-contract strings below.
CONTRACT_VERSION = "research-engine-v0"

OBSERVATION_SCHEMA_VERSION = "observation-v0"
ENCODED_SCHEMA_VERSION = "encoded-sequence-v0"
FORECAST_SCHEMA_VERSION = "forecast-v0"
EXPLANATION_SCHEMA_VERSION = "explanation-v0"
EVALUATION_REPORT_VERSION = "evaluation-report-v0"
LEDGER_SCHEMA_VERSION = "prediction-ledger-v0"

#: Seconds in a day. The contract fixes elapsed time in days and one day as
#: exactly 86,400 seconds, so no part of the engine has to decide what a leap
#: second or a DST transition does to a "day".
SECONDS_PER_DAY = 86_400.0

#: Source of an observation row. `derived_extraction` additionally requires an
#: extractor version and a reference back to the observation it came from —
#: without those, a model output could re-enter as if it were a measurement.
SOURCE_KINDS = ("synthetic", "participant_observation", "derived_extraction")

#: How a forecast expresses uncertainty. `deterministic` must not invent one:
#: a point model that reports a standard deviation is claiming a calibration it
#: never estimated.
DISTRIBUTION_METHODS = ("deterministic", "gaussian_diag", "empirical_samples")

#: `forecast` is the online case and requires every target strictly after the
#: cutoff. `smoothing` uses data after the target time and is excluded from
#: online scoring — the distinction is the whole reason both names exist.
INFERENCE_MODES = ("forecast", "smoothing")

#: Terminal states a producer may report. Anything other than `ok` must leave
#: the numeric payload empty rather than filling it with a plausible default.
BUNDLE_STATUSES = ("ok", "not_enough_data", "unsupported", "incompatible_artifact", "failed")

#: What a node in the explanation graph is allowed to claim about itself.
#: `unvalidated_latent` is the default: an axis learned from synthetic data has
#: no measured meaning, and naming it after a clinical scale would manufacture
#: one.
SEMANTIC_STATUSES = ("synthetic_axis", "anchored_measure", "unvalidated_latent")

#: Where an edge's support comes from. v0 only ever produces `model_candidate`.
EVIDENCE_SCOPES = ("model_candidate", "observed_report", "curated_literature")

#: Historical replay is not prospective prediction. Keeping them as separate
#: values stops a report of a rerun from being read as a sealed forecast.
EVALUATION_MODES = ("historical_simulation", "prospective")

#: Capability flags, all of them declared on every run. A flag that is false
#: must not be enabled in the UI. `real_world_causal_effects` and
#: `active_questioning` are false in v0 and there is no configuration that
#: turns them on — the code to justify either does not exist.
CAPABILITY_FLAGS = (
    "trained_encoder",
    "trained_dynamics",
    "calibrated_uncertainty",
    "model_interventions",
    "real_world_causal_effects",
    "active_questioning",
)

#: Capabilities v0 can never claim, whatever a config says. Enforced in
#: `capabilities.py` rather than left to reviewer discipline.
FORBIDDEN_IN_V0 = ("real_world_causal_effects", "active_questioning")

#: Uses a dataset may declare. v0 accepts synthetic uses only; anything else is
#: refused at the permission boundary until a server-side consent check exists.
PERMITTED_USES_V0 = ("synthetic_training", "synthetic_evaluation")

#: How an encoded sequence was produced. `filtering` uses only history up to
#: each time point and is the only mode online forecasting may consume;
#: `smoothing` uses later data to improve earlier states and is kept as a
#: separate, clearly-labelled output so it can never be scored as if it were a
#: prediction.
ENCODING_MODES = ("filtering", "smoothing")

#: Whether a checkpoint holds fitted weights. An `untrained` artifact is not an
#: error — it is what a run that ran out of time honestly produces — but it must
#: never be reported as a trained encoder.
TRAINING_STATUSES = ("trained", "untrained", "failed")
