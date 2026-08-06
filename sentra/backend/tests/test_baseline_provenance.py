"""D-04: POPULATION_BASELINE is guessed, so a reading taken against it during
the 14-day ramp-up carries no statistical meaning. The uncertainty has to
travel with the score rather than living only in a source comment.
"""

from app.analytics.baseline import RAMP_UP_DAYS, baseline_provenance


class TestBaselineProvenance:
    def test_population_reading_is_flagged_provisional(self):
        got = baseline_provenance("population", 0)
        assert got["is_provisional"] is True
        assert got["days_remaining"] == RAMP_UP_DAYS
        assert got["population_baseline_is_measured"] is False

    def test_blended_reading_is_still_provisional(self):
        # Half the window is still half a guess.
        got = baseline_provenance("blended", 7)
        assert got["is_provisional"] is True
        assert got["days_remaining"] == RAMP_UP_DAYS - 7

    def test_user_baseline_is_not_provisional(self):
        got = baseline_provenance("user", RAMP_UP_DAYS)
        assert got["is_provisional"] is False
        assert got["days_remaining"] == 0

    def test_days_remaining_never_goes_negative(self):
        assert baseline_provenance("user", RAMP_UP_DAYS + 30)["days_remaining"] == 0

    def test_population_baseline_is_never_claimed_as_measured(self):
        # Flipping this is a deliberate act with a documented procedure
        # (docs/baseline_reestimation.md), not something that drifts true.
        for baseline_type in ("population", "blended", "user"):
            assert baseline_provenance(baseline_type, 20)["population_baseline_is_measured"] is False
