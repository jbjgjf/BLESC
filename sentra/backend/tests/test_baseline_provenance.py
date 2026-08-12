"""D-04: a reading is only as good as the history behind it. There is no
population baseline to stand in for missing days any more, so the provenance
has to say plainly whether a personal baseline exists at all — travelling with
the score rather than living only in a source comment.
"""

from app.analytics.baseline import RAMP_UP_DAYS, baseline_provenance


class TestBaselineProvenance:
    def test_absent_baseline_is_flagged_provisional(self):
        got = baseline_provenance("none", 0)
        assert got["is_provisional"] is True
        assert got["days_remaining"] == RAMP_UP_DAYS

    def test_partial_history_is_still_provisional(self):
        # Half the window is not yet a baseline.
        got = baseline_provenance("none", 7)
        assert got["is_provisional"] is True
        assert got["days_remaining"] == RAMP_UP_DAYS - 7

    def test_user_baseline_is_not_provisional(self):
        got = baseline_provenance("user", RAMP_UP_DAYS)
        assert got["is_provisional"] is False
        assert got["days_remaining"] == 0

    def test_days_remaining_never_goes_negative(self):
        assert baseline_provenance("user", RAMP_UP_DAYS + 30)["days_remaining"] == 0

    def test_only_a_user_baseline_is_ever_non_provisional(self):
        # Anything that is not the user's own measured history is provisional,
        # regardless of how many days have gone by.
        for baseline_type in ("none", "population", "blended"):
            assert baseline_provenance(baseline_type, 20)["is_provisional"] is True
