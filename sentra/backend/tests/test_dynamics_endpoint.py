"""The read-only dynamics endpoint (#97).

The measures are tested against synthetic series in `test_dynamics.py`. This
covers the seam those cannot: that stored `DailyFeatureAggregation` rows reach
the analysis intact, that a day whose vector omits a feature does not become a
zero on the way through, and that the response says what it is not.

Owns its database through `dependency_overrides` rather than `DATABASE_URL`, for
the reason set out at the top of `test_temporal_graph_endpoint.py`: the env var
is read once at import, so which test module wins depends on collection order.
"""

from datetime import date, timedelta
from pathlib import Path

from fastapi.testclient import TestClient
from sqlmodel import Session, SQLModel, create_engine

from app.database import get_session
from app.main import app
from app.schemas.analytics import DailyFeatureAggregation

USER = "dynamics-user"
SPARSE_USER = "dynamics-sparse-user"
DATABASE = Path(__file__).resolve().parent / "test_dynamics_endpoint.db"

engine = create_engine(f"sqlite:///{DATABASE}", connect_args={"check_same_thread": False})
client = TestClient(app)


def _session_override():
    with Session(engine) as session:
        yield session


def setup_module():
    DATABASE.unlink(missing_ok=True)
    SQLModel.metadata.create_all(engine)
    app.dependency_overrides[get_session] = _session_override
    _seed()


def teardown_module():
    app.dependency_overrides.pop(get_session, None)
    engine.dispose()
    DATABASE.unlink(missing_ok=True)


def _seed() -> None:
    """Thirty consecutive days for one participant, three scattered for another.

    Anchored on today, because the endpoint's window is relative to it. The
    ANALYSIS never reads the clock — see `test_analysis_does_not_read_the_wall_clock`
    — but the query that feeds it does, and this is the seam where that matters.

    Day 10's vector deliberately omits `protective_ratio`: the participant wrote,
    and that feature was not extracted. It must produce no observation rather
    than an observation of zero.
    """
    today = date.today()
    with Session(engine) as session:
        for offset in range(30):
            day = today - timedelta(days=29 - offset)
            vector = {
                "protective_ratio": round(0.4 + (offset % 5) * 0.03, 4),
                "relation_density": round(1.0 + (offset % 3) * 0.1, 4),
            }
            if offset == 10:
                vector.pop("protective_ratio")
            session.add(
                DailyFeatureAggregation(user_id=USER, day=day, feature_vector_json=vector)
            )

        for offset in (0, 9, 20):
            session.add(
                DailyFeatureAggregation(
                    user_id=SPARSE_USER,
                    day=today - timedelta(days=offset),
                    feature_vector_json={"protective_ratio": 0.5},
                )
            )
        session.commit()


def test_stored_aggregations_reach_the_analysis():
    response = client.get("/api/research/dynamics", params={"user_id": USER})
    assert response.status_code == 200
    payload = response.json()

    assert payload["days_observed"] == 30
    assert payload["requested_days"] == 90

    features = {feature["feature"]: feature for feature in payload["features"]}
    protective = features["protective_ratio"]

    assert protective["spacing"]["observation_count"] == 29, (
        "one of the thirty days did not carry the feature, and absence is not a zero"
    )
    assert protective["lag1_autocorrelation"]["status"] == "computed"
    assert protective["rolling_variance"], "a dense month supports a rolling variance"


def test_a_gap_in_one_feature_does_not_affect_another():
    payload = client.get("/api/research/dynamics", params={"user_id": USER}).json()
    features = {feature["feature"]: feature for feature in payload["features"]}

    assert features["relation_density"]["spacing"]["observation_count"] == 30
    assert features["protective_ratio"]["spacing"]["observation_count"] == 29


def test_a_sparse_participant_gets_not_enough_data_rather_than_numbers():
    payload = client.get("/api/research/dynamics", params={"user_id": SPARSE_USER}).json()
    protective = next(f for f in payload["features"] if f["feature"] == "protective_ratio")

    assert payload["days_observed"] == 3
    assert protective["lag1_autocorrelation"]["status"] == "not_enough_data"
    assert protective["lag1_autocorrelation"]["value"] is None
    assert protective["variance_trend_kendall_tau"]["value"] is None
    assert "no_rolling_variance" in protective["quality_flags"]


def test_a_participant_with_no_rows_is_answered_rather_than_erroring():
    payload = client.get("/api/research/dynamics", params={"user_id": "nobody"}).json()

    assert payload["days_observed"] == 0
    assert len(payload["features"]) == 4, "every selected feature is still reported"
    assert all("no_observations" in f["quality_flags"] for f in payload["features"])


def test_the_response_says_what_it_is_not():
    payload = client.get("/api/research/dynamics", params={"user_id": USER}).json()

    assert "clinical early warning or transition prediction" in payload["not_validated_here"]
    assert "any comparison against a population distribution" in payload["not_validated_here"]
    assert "no threshold, no risk band, no predicted transition" in payload["interpretation"]
    assert payload["dynamics_version"]


def test_the_parameters_and_the_feature_selection_come_back_with_the_numbers():
    """A reader cannot judge a variance without the window it was measured over,
    or a selection without the exclusions it implies."""
    payload = client.get("/api/research/dynamics", params={"user_id": USER}).json()

    assert payload["parameters"]["declared_before_results"] is True
    assert payload["parameters"]["window_days"] == 14
    assert "isolation_signal" in payload["feature_selection"]["excluded"]
    assert set(payload["feature_selection"]["selected"]) == {
        feature["feature"] for feature in payload["features"]
    }


def test_a_trend_carries_its_calibration_over_the_wire():
    """The invariant that matters most for this endpoint: a bare tau has a ~25%
    false-positive rate on flat input, so it must never travel alone."""
    payload = client.get("/api/research/dynamics", params={"user_id": USER}).json()

    for feature in payload["features"]:
        trend = feature["variance_trend_kendall_tau"]
        if trend["status"] != "computed":
            continue
        assert trend["calibration"] is not None
        assert trend["calibration"]["trials"] > 0
        assert "this participant's own values" in trend["calibration"]["null"]


def test_a_nonsensical_window_is_rejected():
    assert client.get("/api/research/dynamics", params={"user_id": USER, "days": 0}).status_code == 400
