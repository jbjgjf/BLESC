"""The required-observations judgement the #99 / #100 entry gates call.

What is pinned here is the arithmetic a reader would otherwise take on trust —
that 1,400 diary entries from 50 students are worth about 97 independent
observations, not 1,400 — and the direction every failure falls: closed, with
a code saying why.

The counts below are hypothetical numbers for unit tests. None of them describes
a real participant; this repository has no path that reads one.
"""

from __future__ import annotations

import pytest

from app.analytics.data_sufficiency import (
    COUNTS_INCONSISTENT_WITH_DESIGN,
    EFFECTIVE_SAMPLE_BELOW_REQUIREMENT,
    NO_OBSERVED_DATA,
    NOT_REAL_CONSENTED,
    PILOT_STUDY_DESIGN,
    PLANNING_ICC,
    REAL_CONSENTED,
    REQUIREMENT_EXCEEDS_DESIGN,
    REQUIREMENT_UNDECIDED,
    TOO_FEW_EDGES_PER_RELATION,
    TOO_FEW_PARTICIPANTS,
    ObservationRequirement,
    ObservedCounts,
    assess_observation_sufficiency,
    design_effective_sample_size,
    effective_sample_size,
)

_ALL_THRESHOLDS = ("min_participants", "min_days_per_participant", "min_effective_sample_size")


def _decided(**overrides):
    values = dict(
        stage="unit-test",
        must_decide=_ALL_THRESHOLDS,
        min_participants=40,
        min_days_per_participant=14,
        min_effective_sample_size=60.0,
        decided_in="unit-test",
    )
    values.update(overrides)
    return ObservationRequirement(**values)


def _real(days, **overrides):
    return ObservedCounts(
        data_classification=REAL_CONSENTED, days_observed=tuple(days), source="hypothetical", **overrides
    )


# ── the design and its effective size ────────────────────────────────────────


def test_the_design_is_the_28_day_pilot():
    """PR #328 / #315: 50 x 28, one period, one entry a day. Not yet on main."""
    assert PILOT_STUDY_DESIGN.participants == 50
    assert PILOT_STUDY_DESIGN.days_per_participant == 28
    assert PILOT_STUDY_DESIGN.entries_per_day == 1
    assert PILOT_STUDY_DESIGN.max_observations == 1400
    assert "#328" in PILOT_STUDY_DESIGN.source


def test_1400_entries_are_worth_about_97_at_icc_one_half():
    assert PLANNING_ICC == 0.5
    ceiling = design_effective_sample_size(PILOT_STUDY_DESIGN, PLANNING_ICC)
    assert ceiling == pytest.approx(1400 / 14.5)
    assert round(ceiling) == 97


def test_effective_size_spans_participants_to_entries():
    days = [28] * 50
    assert effective_sample_size(days, 0.0) == pytest.approx(1400)
    assert effective_sample_size(days, 1.0) == pytest.approx(50)


def test_unequal_counts_are_summed_per_participant():
    # 28 / (1 + 27 * 0.5) + 10 / (1 + 9 * 0.5) + 1 / 1 + nothing for 0 days
    expected = 28 / 14.5 + 10 / 5.5 + 1.0
    assert effective_sample_size([28, 10, 1, 0], 0.5) == pytest.approx(expected)


@pytest.mark.parametrize("icc", [-0.1, 1.5])
def test_an_impossible_icc_is_an_error(icc):
    with pytest.raises(ValueError):
        effective_sample_size([28], icc)


# ── closed, and why ──────────────────────────────────────────────────────────


def test_an_undecided_requirement_closes_even_on_complete_counts():
    requirement = ObservationRequirement(stage="unit-test", must_decide=_ALL_THRESHOLDS)
    result = assess_observation_sufficiency(requirement, _real([28] * 50))

    assert result.sufficient is False
    assert result.codes == (REQUIREMENT_UNDECIDED,)
    assert set(requirement.undecided()) == set(_ALL_THRESHOLDS)


def test_no_counts_is_closed_and_says_so():
    result = assess_observation_sufficiency(_decided(), None)

    assert result.sufficient is False
    assert NO_OBSERVED_DATA in result.codes
    assert result.observed_effective_n is None


def test_synthetic_counts_are_refused_not_counted():
    synthetic = ObservedCounts(data_classification="synthetic", days_observed=(28,) * 50)
    result = assess_observation_sufficiency(_decided(), synthetic)

    assert result.sufficient is False
    assert result.codes == (NOT_REAL_CONSENTED,)
    # Not even reported: an effective size computed from generators we wrote
    # would be read as a property of students.
    assert result.observed_effective_n is None


def test_a_requirement_the_pilot_cannot_reach_is_named_as_such():
    """1,400 entries invite a requirement of a few hundred. The design tops out near 97."""
    requirement = _decided(min_effective_sample_size=200.0, min_participants=60)
    result = assess_observation_sufficiency(requirement, _real([28] * 50))

    assert REQUIREMENT_EXCEEDS_DESIGN in result.codes
    detail = next(r.detail for r in result.reasons if r.code == REQUIREMENT_EXCEEDS_DESIGN)
    assert "96.6" in detail and "1400 entries" in detail and "60 > 50" in detail


def test_counts_the_design_could_not_produce_are_refused():
    result = assess_observation_sufficiency(_decided(), _real([29] + [28] * 49))
    assert result.codes == (COUNTS_INCONSISTENT_WITH_DESIGN,)

    result = assess_observation_sufficiency(_decided(), _real([28] * 51))
    assert result.codes == (COUNTS_INCONSISTENT_WITH_DESIGN,)


def test_participants_below_the_day_minimum_do_not_count():
    # 30 complete participants and 20 who wrote on 5 days: only 30 meet 14 days.
    result = assess_observation_sufficiency(_decided(), _real([28] * 30 + [5] * 20))

    assert TOO_FEW_PARTICIPANTS in result.codes
    assert EFFECTIVE_SAMPLE_BELOW_REQUIREMENT in result.codes
    assert result.observed_effective_n == pytest.approx(30 * 28 / 14.5)


def test_the_upper_bound_of_a_measured_icc_replaces_the_assumption():
    counts = _real([28] * 50, icc_upper_bound=0.7)
    result = assess_observation_sufficiency(_decided(), counts)

    assert result.icc_source == "observed_upper_bound"
    assert result.icc_used == 0.7
    assert result.observed_effective_n == pytest.approx(1400 / (1 + 27 * 0.7))


def test_relation_types_short_of_edges_are_listed():
    requirement = _decided(
        must_decide=_ALL_THRESHOLDS + ("min_edges_per_relation_type",),
        min_edges_per_relation_type=30,
        relation_types=("causes", "buffers", "precedes"),
    )
    counts = _real([28] * 50, edges_per_relation_type={"causes": 120, "buffers": 12})
    result = assess_observation_sufficiency(requirement, counts)

    assert result.codes == (TOO_FEW_EDGES_PER_RELATION,)
    assert "buffers=12" in result.reasons[0].detail and "precedes=0" in result.reasons[0].detail


def test_the_calculator_is_not_a_constant():
    """Decided thresholds met by real counts read as sufficient. This is the
    calculator, not an entry gate: the gates in `learning_gates` also require a
    pre-registration and an approval, and both are absent."""
    result = assess_observation_sufficiency(_decided(), _real([28] * 45))

    assert result.sufficient is True
    assert result.codes == ()
    assert result.as_dict()["observed_effective_n"] == pytest.approx(45 * 28 / 14.5, abs=1e-3)


def test_the_assessment_is_machine_readable():
    payload = assess_observation_sufficiency(_decided(), None).as_dict()

    assert payload["sufficient"] is False
    assert {reason["code"] for reason in payload["reasons"]} == {NO_OBSERVED_DATA}
    assert payload["design"]["max_observations"] == 1400
    assert payload["design_ceiling_effective_n"] == pytest.approx(96.552, abs=1e-3)
