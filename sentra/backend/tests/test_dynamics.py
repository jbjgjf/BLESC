"""Exploratory time-series dynamics (#97).

Written against the acceptance criteria. The synthetic series the issue names —
stable, noisy, gradually destabilising, missing-data, irregularly spaced — are
built here rather than drawn from fixtures, because the property under test is
how the measures behave on a series of a known shape, and a fixture would put a
layer of parsing between the shape and the assertion.

The false-positive section is the reason `Calibration` exists. It is not a
formality: the bare Kendall tau it measures is unusable, and the numbers are
asserted so a future change that removes the calibration fails here rather than
in a report.
"""

from __future__ import annotations

import random
from datetime import date, timedelta
from typing import Sequence

import pytest

from app.analytics.dynamics import (
    DEFAULT_PARAMETERS,
    DYNAMICS_VERSION,
    EXCLUDED_FEATURES,
    NOT_VALIDATED_HERE,
    SELECTED_FEATURES,
    SURROGATE_SEED,
    DynamicsParameters,
    MeasureStatus,
    Observation,
    analyse_feature,
    analyse_participant,
    describe_spacing,
    false_positive_profile,
    kendall_tau_against_time,
    observations_from_vectors,
    pearson,
    sample_variance,
)

DAY0 = date(2026, 6, 1)


def series(values: Sequence[float], offsets: Sequence[int] | None = None) -> tuple:
    offsets = list(offsets) if offsets is not None else list(range(len(values)))
    return tuple(
        Observation(day=DAY0 + timedelta(days=offset), value=value)
        for offset, value in zip(offsets, values)
    )


def stable(seed: int, n: int = 30, sd: float = 0.01) -> tuple:
    rng = random.Random(seed)
    return series([0.5 + rng.gauss(0, sd) for _ in range(n)])


def destabilising(seed: int, n: int = 30) -> tuple:
    rng = random.Random(seed)
    return series([0.5 + rng.gauss(0, 0.01 + 0.02 * i) for i in range(n)])


# ---- AC: absence is never a number ----------------------------------------


def test_a_missing_day_produces_no_observation_rather_than_a_zero():
    """The defect this layer exists to not repeat.

    `research_pipeline.recompute_longitudinal_features` read
    `float(vector.get(name) or 0.0)`, so a feature absent on a day entered the
    mean and the variance as a measurement of zero.
    """
    rows = [
        (DAY0, {"protective_ratio": 0.8}),
        (DAY0 + timedelta(days=1), {}),                       # wrote, no such feature
        (DAY0 + timedelta(days=2), {"protective_ratio": None}),  # explicit null
        (DAY0 + timedelta(days=3), {"protective_ratio": 0.9}),
    ]
    observed = observations_from_vectors(rows, "protective_ratio")

    assert [point.value for point in observed] == [0.8, 0.9]
    assert [point.day for point in observed] == [DAY0, DAY0 + timedelta(days=3)]


def test_a_boolean_is_not_read_as_a_number():
    """`True` is `1.0` to `float()`, and a flag entering a variance is not data."""
    rows = [(DAY0, {"protective_ratio": True}), (DAY0 + timedelta(days=1), {"protective_ratio": 0.5})]
    assert [point.value for point in observations_from_vectors(rows, "protective_ratio")] == [0.5]


def test_one_observation_has_no_variance_rather_than_a_variance_of_zero():
    """Population variance over n=1 is 0, which reads as perfect stability."""
    assert sample_variance([0.5]) is None
    assert sample_variance([]) is None
    assert sample_variance([0.4, 0.6]) == pytest.approx(0.02)


def test_a_constant_series_has_no_correlation_rather_than_zero_or_one():
    """The denominator is zero. Both 0 and 1 would be inventions, and a student
    whose ratio sat at one value all fortnight is a case this will meet."""
    assert pearson([0.5] * 6, [0.5] * 6, DEFAULT_PARAMETERS.variance_floor) is None

    result = analyse_feature(series([0.5] * 30), "protective_ratio")
    assert result.lag1_autocorrelation.status is MeasureStatus.NOT_COMPUTABLE
    assert result.lag1_autocorrelation.value is None
    assert "undefined" in result.lag1_autocorrelation.reason


# ---- AC: consecutive rows are not consecutive days ------------------------


def test_lag1_pairs_only_days_that_are_actually_adjacent():
    """The measure that makes the critical-slowing framing mean anything.

    Written on the 1st, 2nd, 9th and 10th: two adjacent pairs, not three.
    """
    spacing = describe_spacing(series([0.1, 0.2, 0.3, 0.4], offsets=[0, 1, 8, 9]))
    assert spacing.observation_count == 4
    assert spacing.consecutive_day_pairs == 2, "the 1st→2nd and 9th→10th, not the 2nd→9th"
    assert spacing.median_gap_days == 1.0, "gaps are 1, 7, 1"
    assert spacing.max_gap_days == 7
    assert spacing.consecutive_fraction == pytest.approx(2 / 3)


def test_an_irregular_series_refuses_the_lag1_autocorrelation():
    """AC: irregular-spacing case. Refusing is the correct answer here, and it
    happens often — that is information about the data, not a gap to fill."""
    result = analyse_feature(series([0.4, 0.5, 0.6, 0.5, 0.4, 0.5, 0.6, 0.5],
                                    offsets=[0, 3, 7, 12, 18, 21, 26, 30]), "protective_ratio")

    assert result.lag1_autocorrelation.status is MeasureStatus.NOT_ENOUGH_DATA
    assert result.lag1_autocorrelation.support == 0
    assert "not a lag-1 autocorrelation" in result.lag1_autocorrelation.reason
    assert "mostly_non_consecutive_observations" in result.quality_flags


def test_the_successive_correlation_is_named_so_it_cannot_be_mistaken_for_lag1():
    """The descriptive statistic travels with the spacing that produced it.

    A correlation over a median gap of 4 days is not a lag-1 anything, and the
    field name plus the spacing block are what stop it being read as one.
    """
    result = analyse_feature(
        series([0.4, 0.5, 0.6, 0.5, 0.4, 0.55, 0.62, 0.48], offsets=[0, 3, 7, 12, 18, 21, 26, 30]),
        "protective_ratio",
    )
    successive = result.successive_observation_correlation

    assert successive.status is MeasureStatus.COMPUTED
    assert "not consecutive days" in successive.reason
    assert result.spacing.median_gap_days == 4.0
    assert result.lag1_autocorrelation.status is MeasureStatus.NOT_ENOUGH_DATA, (
        "the two measures must be able to disagree, or one of them is redundant"
    )


# ---- AC: not_enough_data rather than a number ------------------------------


def test_a_short_series_reports_not_enough_data_everywhere():
    result = analyse_feature(series([0.5, 0.6, 0.55]), "protective_ratio")

    assert result.rolling_variance == ()
    assert result.lag1_autocorrelation.status is MeasureStatus.NOT_ENOUGH_DATA
    assert result.variance_trend.status is MeasureStatus.NOT_ENOUGH_DATA
    assert result.variance_trend.value is None
    assert "no_rolling_variance" in result.quality_flags


def test_an_empty_series_is_answered_rather_than_crashed():
    result = analyse_feature((), "protective_ratio")
    assert result.spacing.observation_count == 0
    assert "no_observations" in result.quality_flags
    assert result.as_dict()["observation_window"] == {"start": None, "end": None}


def test_the_minimums_are_declared_and_travel_with_the_result():
    """AC: window length, minimum observations, irregular-interval handling and
    missing-day handling are defined before results are evaluated."""
    payload = analyse_participant("p1", [(DAY0, {"protective_ratio": 0.5})]).as_dict()

    parameters = payload["parameters"]
    assert parameters["declared_before_results"] is True
    assert parameters["window_days"] == 14
    assert parameters["min_observations"] == 8
    assert parameters["min_lag_pairs"] == 5


# ---- AC: the documented feature selection ---------------------------------


def test_the_selection_is_explicit_and_every_choice_carries_a_reason():
    """AC: 'explicitly selected, documented features' — not every key present."""
    assert SELECTED_FEATURES and EXCLUDED_FEATURES
    assert not set(SELECTED_FEATURES) & set(EXCLUDED_FEATURES)
    for reason in list(SELECTED_FEATURES.values()) + list(EXCLUDED_FEATURES.values()):
        assert len(reason) > 40, "a one-word reason is not a documented choice"


def test_no_count_feature_is_measured():
    """Counts scale with entry length, so their variance is confounded with
    verbosity — a rising variance would read as a destabilising student when it
    may be a student writing longer entries."""
    assert not any(name.endswith("_count") for name in SELECTED_FEATURES)
    assert all(name.endswith("_count") or name in EXCLUDED_FEATURES for name in EXCLUDED_FEATURES)


def test_the_exclusions_are_reported_not_just_omitted():
    payload = analyse_participant("p1", []).as_dict()
    selection = payload["feature_selection"]

    assert set(selection["selected"]) == set(SELECTED_FEATURES)
    assert "isolation_signal" in selection["excluded"]
    assert "Japanese" in selection["excluded"]["isolation_signal"], (
        "the language defect is the reason, and a reader should find it here"
    )


# ---- AC: no population prior ----------------------------------------------


def _executable_names(module_path) -> set:
    """Every identifier the module actually executes, docstrings excluded.

    A prose scan cannot do this job: this module's own docstring says the words
    `POPULATION_BASELINE` in order to say it does not use one, and a substring
    test would fail on the sentence that promises the thing it is checking.
    """
    import ast

    tree = ast.parse(module_path.read_text(encoding="utf-8"))
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Name):
            names.add(node.id.lower())
        elif isinstance(node, ast.Attribute):
            names.add(node.attr.lower())
        elif isinstance(node, ast.alias):
            names.add((node.asname or node.name).split(".")[-1].lower())
    return names


def test_nothing_here_consults_a_population():
    """#91 deleted `POPULATION_BASELINE`. This fails if it returns under any name.

    Checked against executed identifiers and against the payload's own keys —
    the two places a population prior could actually reach a reader.
    """
    from pathlib import Path

    module = Path(__file__).resolve().parents[1] / "app" / "analytics" / "dynamics.py"
    names = _executable_names(module)
    for forbidden in ("population_baseline", "cohort_mean", "peer_average", "norm_table", "baseline"):
        assert forbidden not in names, f"{forbidden!r} is executed by the dynamics layer"

    payload = analyse_participant("p1", [(DAY0, {"protective_ratio": 0.5})]).as_dict()
    assert "any comparison against a population distribution" in payload["not_validated_here"]

    calibration_nulls = str(payload).lower()
    assert "percentile of other participants" not in calibration_nulls


# ---- AC: the wording -------------------------------------------------------


def test_the_output_reports_variability_and_persistence_and_claims_nothing_else():
    """AC: 'no diagnosis, risk band, or predicted clinical transition'.

    An invariant test: it fails if someone later adds a field that classifies.
    """
    rows = [(DAY0 + timedelta(days=i), {"protective_ratio": 0.5 + i * 0.01}) for i in range(30)]
    payload = analyse_participant("p1", rows).as_dict()

    # The measured part only. `not_validated_here` and `interpretation` are the
    # disclaimers, and they legitimately contain the words a classifier would —
    # scanning them would fail on the sentence promising the thing being checked.
    measured = str(
        {"features": payload["features"], "parameters": payload["parameters"]}
    ).lower()
    for forbidden in ("risk_band", "risk_level", "diagnosis", "depressed", "at_risk", "severity", "alert"):
        assert forbidden not in measured, f"{forbidden!r} reached a measured field"

    # And no measured field is a verdict: every one is a number, a status, a
    # count, a day, or a named quality flag.
    for feature in payload["features"]:
        for measure_key in ("lag1_autocorrelation", "successive_observation_correlation"):
            assert set(feature[measure_key]) == {"status", "value", "support", "reason", "calibration"}

    assert "no threshold, no risk band, no predicted transition" in payload["interpretation"]
    assert "clinical early warning or transition prediction" in NOT_VALIDATED_HERE


def test_the_version_travels_with_the_result():
    payload = analyse_participant("p1", []).as_dict()
    assert payload["dynamics_version"] == DYNAMICS_VERSION


# ---- AC: the synthetic series the issue names -----------------------------


def test_a_stable_series_computes_and_a_destabilising_one_computes_higher():
    stable_result = analyse_feature(stable(7), "protective_ratio")
    rising_result = analyse_feature(destabilising(7), "protective_ratio")

    assert stable_result.variance_trend.status is MeasureStatus.COMPUTED
    assert rising_result.variance_trend.status is MeasureStatus.COMPUTED
    assert rising_result.variance_trend.value > stable_result.variance_trend.value

    last_stable = stable_result.rolling_variance[-1].value
    last_rising = rising_result.rolling_variance[-1].value
    assert last_rising > last_stable * 5, "the destabilising fixture must actually destabilise"


def test_a_missing_data_series_still_reports_what_it_could_measure():
    """AC: missing-data case. Gaps do not void the whole analysis; they void the
    measures that need adjacency, and the flags say which."""
    values = [0.5 + (i % 3) * 0.05 for i in range(20)]
    offsets = [i for i in range(20) if i % 5 != 0]
    result = analyse_feature(series(values[: len(offsets)], offsets), "protective_ratio")

    assert result.spacing.observation_count == len(offsets)
    assert result.spacing.consecutive_day_pairs > 0
    assert result.lag1_autocorrelation.status is MeasureStatus.COMPUTED
    assert result.spacing.consecutive_fraction < 1.0


# ---- AC: false-positive behaviour on stable series ------------------------


#: 80 series, computed once. Each one runs 200 surrogates through the full
#: rolling pipeline, so this is the expensive fixture in the suite and sharing it
#: is the difference between ~10s and ~25s. 80 is enough for the margins the
#: assertions below use; it is not enough to quote a rate to three decimals, and
#: none of them do.
STABLE_SAMPLE = 80


@pytest.fixture(scope="module")
def stable_profile():
    return false_positive_profile([stable(seed) for seed in range(STABLE_SAMPLE)])


def test_the_bare_tau_is_unusable_and_this_is_the_measurement_that_says_so(stable_profile):
    """The finding that produced `Calibration`.

    Kendall's tau over a rolling series computed from OVERLAPPING windows is not
    a trend test — consecutive values share most of their observations, so long
    runs appear by construction. This asserts the failure rather than describing
    it, so removing the calibration cannot quietly restore a bare direction.
    """
    assert stable_profile["series_with_a_trend"] == STABLE_SAMPLE
    assert stable_profile["bare_tau_false_positive_rate"] > 0.15, (
        "if this drops, the bare tau may have become usable and the calibration's "
        "justification needs rewriting rather than deleting"
    )
    assert abs(stable_profile["mean_tau"]) < 0.15, "tau is not biased — its spread is the problem"


def test_the_calibration_cuts_the_false_positive_rate_on_stable_input(stable_profile):
    assert (
        stable_profile["calibrated_false_positive_rate"]
        < stable_profile["bare_tau_false_positive_rate"]
    )
    assert stable_profile["calibrated_false_positive_rate"] <= 0.15, (
        "a nominal 95th-percentile cut should be near 5%; well above it means the "
        "surrogate null does not describe this statistic"
    )


def test_the_calibration_still_detects_a_genuinely_destabilising_series():
    """A false-positive rate is only meaningful next to a detection rate. A cut
    that flags nothing has a perfect false-positive rate and no use."""
    detected = 0
    considered = 0
    for seed in range(40):
        trend = analyse_feature(destabilising(1000 + seed), "protective_ratio").variance_trend
        if trend.calibration is None:
            continue
        considered += 1
        detected += trend.calibration.exceeds_p95

    assert considered == 40
    assert detected / considered > 0.80


def test_a_trend_is_never_reported_without_its_calibration():
    """The invariant. A bare tau is not a result, given the measurement above."""
    for fixture in (stable(3), destabilising(3)):
        for trend in (
            analyse_feature(fixture, "protective_ratio").variance_trend,
            analyse_feature(fixture, "protective_ratio").autocorrelation_trend,
        ):
            if trend.status is MeasureStatus.COMPUTED:
                assert trend.calibration is not None
                assert trend.calibration.trials > 0
                assert "never bare" in trend.reason


def test_the_null_is_this_participants_own_values_and_says_so():
    """Not a population distribution. Permuting the participant's own values
    across their own days keeps this personal-only, which #91 requires."""
    calibration = analyse_feature(stable(11), "protective_ratio").variance_trend.calibration
    assert calibration is not None
    assert "this participant's own values" in calibration.as_dict()["null"]
    assert calibration.seed == SURROGATE_SEED


# ---- determinism -----------------------------------------------------------


def test_the_same_series_produces_the_same_numbers():
    """The surrogate null is seeded. An unseeded one would make every stored
    calibration unreproducible, which is worse than not having one."""
    first = analyse_feature(stable(5), "protective_ratio").as_dict()
    second = analyse_feature(stable(5), "protective_ratio").as_dict()
    assert first == second


def test_analysis_does_not_read_the_wall_clock():
    """Nothing here takes `date.today()`. A result computed in December from an
    August series must match the one computed in August."""
    from pathlib import Path

    source = (Path(__file__).resolve().parents[1] / "app" / "analytics" / "dynamics.py").read_text(
        encoding="utf-8"
    )
    assert "date.today()" not in source
    assert "datetime.now" not in source


def test_kendall_tau_is_conservative_about_ties():
    """Tau-a: ties contribute to neither side, so a flat series reports 0 rather
    than a direction. That is the direction to be wrong in."""
    assert kendall_tau_against_time([1.0, 2.0, 3.0, 4.0]) == pytest.approx(1.0)
    assert kendall_tau_against_time([4.0, 3.0, 2.0, 1.0]) == pytest.approx(-1.0)
    assert kendall_tau_against_time([2.0, 2.0, 2.0, 2.0]) == pytest.approx(0.0)
    assert kendall_tau_against_time([1.0, 2.0]) is None


# ---- the participant-level roll-up ----------------------------------------


def test_every_selected_feature_is_analysed_even_when_absent_from_the_data():
    """A feature the participant's extractions never produced must appear with
    `no_observations`, not be missing from the payload. A reader cannot tell a
    feature that was not measured from one that was measured and found nothing."""
    rows = [(DAY0 + timedelta(days=i), {"protective_ratio": 0.5}) for i in range(10)]
    payload = analyse_participant("p1", rows).as_dict()

    analysed = {feature["feature"] for feature in payload["features"]}
    assert analysed == set(SELECTED_FEATURES)

    absent = next(f for f in payload["features"] if f["feature"] == "relation_density")
    assert "no_observations" in absent["quality_flags"]


def test_days_observed_counts_days_not_rows():
    rows = [
        (DAY0, {"protective_ratio": 0.5}),
        (DAY0, {"protective_ratio": 0.6}),
        (DAY0 + timedelta(days=1), {"protective_ratio": 0.7}),
    ]
    assert analyse_participant("p1", rows).days_observed == 2


def test_parameters_can_be_overridden_for_an_analysis_that_says_it_did():
    """Not a tuning knob for making a result appear. The parameters are echoed
    into the payload, so an analysis run with looser minimums is visibly one."""
    loose = DynamicsParameters(window_days=7, min_observations=3, min_lag_pairs=2, min_trend_points=3)
    result = analyse_feature(series([0.5, 0.6, 0.55, 0.7, 0.4, 0.65]), "protective_ratio", loose)

    assert result.rolling_variance
    assert analyse_participant("p1", [], loose).as_dict()["parameters"]["min_observations"] == 3
