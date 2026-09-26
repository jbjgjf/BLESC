"""Every participant endpoint refuses an unidentified caller (#259).

Before this, `app/main.py` had thirty-seven routes and exactly one of them —
`POST /api/entries`, and only for its Supabase mirror — asked who was calling.
`GET /api/entries?user_id=…` handed over a participant's journals to whoever
typed the code, and `GET /api/entries/{entry_id}` did not even need the code,
because the ids are consecutive integers.

The rest of the suite runs with `BLESC_ALLOW_UNAUTHENTICATED_API=1`, set in
`conftest.py`, because there is no Supabase project behind these tests and there
must not be one. This module is the other side of that: it turns the hatch off
and asserts the refusals are real. Without it, "the tests pass" would only mean
"the escape hatch works".

No Supabase client is ever built here. Every case is decided before the network
would be reached — a missing token is refused on its own, and the ownership
check is driven through a stubbed `resolve_identity`.
"""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, SQLModel, create_engine

from app import authz
from app.database import get_session
from app.main import app
from app.schemas.entry import Entry
from app.schemas.structured import HybridExplanation
from app.services import supabase_writer

OWNER_CODE = "owned-participant"
OTHER_CODE = "somebody-elses-participant"
DATABASE = Path(__file__).resolve().parent / "test_endpoint_authorization.db"

engine = create_engine(f"sqlite:///{DATABASE}", connect_args={"check_same_thread": False})
client = TestClient(app)

#: One entry and one explanation, so the id-addressed routes have a real row to
#: refuse. The point of these cases is that the row exists and is still not
#: served — a 404 from "no such id" would prove nothing.
ENTRY_ID = 1
EXPLANATION_ID = 1


def _session_override():
    with Session(engine) as session:
        yield session


def setup_module():
    DATABASE.unlink(missing_ok=True)
    SQLModel.metadata.create_all(engine)
    app.dependency_overrides[get_session] = _session_override
    with Session(engine) as session:
        session.add(Entry(id=ENTRY_ID, user_id=OTHER_CODE, raw_text="他人の日記"))
        session.add(
            HybridExplanation(
                id=EXPLANATION_ID,
                user_id=OTHER_CODE,
                day=__import__("datetime").datetime(2026, 9, 1),
                triggered_rules_json=[],
                baseline_deviation_json={},
                changed_relations_json=[],
                protective_decline_json={},
                uncertainty_json={},
                evidence_summaries=[],
                graph_summary_json={},
                score_breakdown_json={},
            )
        )
        session.commit()


def teardown_module():
    app.dependency_overrides.pop(get_session, None)
    DATABASE.unlink(missing_ok=True)


@pytest.fixture
def closed(monkeypatch):
    """The deployed configuration: no escape hatch, no Supabase."""
    monkeypatch.delenv(authz.OPEN_ACCESS_ENV, raising=False)
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)


# Every route that reads, writes or spends on a participant's behalf, with a
# request that names one. Kept as data so that adding a route and forgetting the
# check shows up here as a missing line rather than as nothing at all.
PARTICIPANT_ROUTES = [
    ("GET", "/api/entries", {"user_id": OWNER_CODE}, None),
    ("GET", "/api/graph-snapshots", {"user_id": OWNER_CODE}, None),
    ("GET", "/api/timeline", {"user_id": OWNER_CODE}, None),
    ("GET", "/api/features", {"user_id": OWNER_CODE}, None),
    ("GET", "/api/baseline", {"user_id": OWNER_CODE}, None),
    ("GET", "/api/anomaly", {"user_id": OWNER_CODE}, None),
    ("GET", "/api/embeddings", {"user_id": OWNER_CODE}, None),
    ("GET", "/api/research/temporal-graph", {"user_id": OWNER_CODE}, None),
    ("GET", "/api/research/traversal", {"user_id": OWNER_CODE, "seeds": "sleep"}, None),
    ("GET", "/api/research/dynamics", {"user_id": OWNER_CODE}, None),
    ("GET", "/api/research/conversation-recall", {"user_id": OWNER_CODE}, None),
    ("GET", "/api/research/conversation-recall/memory-objects", {"user_id": OWNER_CODE}, None),
    ("GET", "/api/research/replay/1", {"user_id": OWNER_CODE}, None),
    ("GET", "/api/research/eval-examples", {"user_id": OWNER_CODE}, None),
    ("GET", "/api/research/evals/summary", {"user_id": OWNER_CODE}, None),
    ("GET", "/api/research/personalization", {"user_id": OWNER_CODE}, None),
    ("GET", "/api/research/patterns", {"user_id": OWNER_CODE}, None),
    (
        "GET",
        "/api/research/ontology-resolution",
        {"source_id": "a", "target_id": "b", "user_id": OWNER_CODE},
        None,
    ),
    ("POST", "/api/entries", {"user_id": OWNER_CODE}, {"journal_text": "今日のこと"}),
    ("POST", "/api/chat", None, {"user_id": OWNER_CODE, "message": "こんにちは"}),
    ("POST", "/api/research/similar", None, {"user_id": OWNER_CODE, "query": "sleep"}),
    # `export_format` is required by the schema, and FastAPI validates the body
    # before the handler runs — so an incomplete body would be answered 422 and
    # would prove nothing about the check underneath it.
    ("POST", "/api/research/exports", None, {"user_id": OWNER_CODE, "export_format": "jsonl"}),
    ("POST", "/api/research/fine-tuning-dataset", None, {"user_id": OWNER_CODE}),
    ("POST", "/api/research/eval-examples/1/review", None, {"user_id": OWNER_CODE, "review_status": "approved"}),
    ("POST", "/api/research/fine-tuning-jobs", None, {"user_id": OWNER_CODE, "export_job_id": 1}),
]

#: Reached by an integer id rather than by a participant code. These are the
#: ones an enumerating caller walks, so they get their own assertions.
ID_ADDRESSED_ROUTES = [
    ("GET", f"/api/entries/{ENTRY_ID}"),
    ("GET", f"/api/entries/{ENTRY_ID}/structure"),
    ("GET", f"/api/explanations/{EXPLANATION_ID}"),
    ("GET", "/api/similar?entry_id=%d" % ENTRY_ID),
]


def _call(method, path, params, body, headers=None):
    if method == "GET":
        return client.get(path, params=params, headers=headers or {})
    return client.post(path, params=params, json=body, headers=headers or {})


class TestNoToken:
    @pytest.mark.parametrize("method,path,params,body", PARTICIPANT_ROUTES)
    def test_participant_routes_refuse(self, closed, method, path, params, body):
        response = _call(method, path, params, body)
        assert response.status_code == 401, f"{method} {path} answered {response.status_code}"
        assert response.headers.get("www-authenticate") == "Bearer"

    @pytest.mark.parametrize("method,path", ID_ADDRESSED_ROUTES)
    def test_id_addressed_routes_refuse_before_looking(self, closed, method, path):
        """401, not 404.

        These rows exist and belong to somebody else. Answering 404 here would
        be correct about the outcome and wrong about the reason — and answering
        anything that varies with whether the id exists is what makes counting
        upwards from 1 worth doing.
        """
        response = _call(method, path, None, None)
        assert response.status_code == 401, f"{method} {path} answered {response.status_code}"

    def test_a_malformed_authorization_header_is_not_a_token(self, closed):
        for header in ["", "Bearer", "Bearer    ", "Basic abc", "abc"]:
            response = client.get(
                "/api/entries", params={"user_id": OWNER_CODE}, headers={"Authorization": header}
            )
            assert response.status_code == 401, f"{header!r} was accepted"


class TestTokenPresent:
    def test_no_supabase_is_503_not_a_quiet_yes(self, closed):
        """A service that cannot verify anyone serves nobody.

        503 rather than 401: the caller did present a token, and the thing that
        is broken is the deployment. This is the one refusal that says what is
        wrong, because the person who needs to read it is the operator.
        """
        response = client.get(
            "/api/entries", params={"user_id": OWNER_CODE}, headers={"Authorization": "Bearer t"}
        )
        assert response.status_code == 503
        assert "SUPABASE_SERVICE_ROLE_KEY" in response.json()["detail"]

    def test_a_code_the_caller_does_not_own_is_404(self, closed, monkeypatch):
        """Not 403 — 403 would confirm that the code belongs to somebody."""
        monkeypatch.setattr(supabase_writer, "is_configured", lambda: True)

        def refuse(authorization, participant_code):
            raise supabase_writer.NotAuthorized("participant not found for this user")

        monkeypatch.setattr(supabase_writer, "resolve_identity", refuse)

        response = client.get(
            "/api/entries", params={"user_id": OTHER_CODE}, headers={"Authorization": "Bearer t"}
        )
        assert response.status_code == 404
        assert response.json()["detail"] == "Not found"

    def test_a_mismatched_pair_checks_both_halves(self, closed, monkeypatch):
        """`user_id` owned, `participant_code` somebody else's.

        The research routes take both, and every row is written with them equal,
        so a mismatched pair reads nothing today. That is the writer's doing,
        not a check — so the check is here, and it refuses.
        """
        monkeypatch.setattr(supabase_writer, "is_configured", lambda: True)
        checked = []

        def resolve(authorization, participant_code):
            checked.append(participant_code)
            if participant_code != OWNER_CODE:
                raise supabase_writer.NotAuthorized("participant not found for this user")
            return {"owner_user_id": "u", "participant_id": "p"}

        monkeypatch.setattr(supabase_writer, "resolve_identity", resolve)

        response = client.get(
            "/api/research/personalization",
            params={"user_id": OWNER_CODE, "participant_code": OTHER_CODE},
            headers={"Authorization": "Bearer t"},
        )
        assert response.status_code == 404
        assert checked == [OWNER_CODE, OTHER_CODE], "the second half was never checked"

    def test_an_owned_code_is_served(self, closed, monkeypatch):
        monkeypatch.setattr(supabase_writer, "is_configured", lambda: True)
        monkeypatch.setattr(
            supabase_writer,
            "resolve_identity",
            lambda authorization, participant_code: {"owner_user_id": "u", "participant_id": "p"},
        )

        response = client.get(
            "/api/entries", params={"user_id": OTHER_CODE}, headers={"Authorization": "Bearer t"}
        )
        assert response.status_code == 200
        assert [row["user_id"] for row in response.json()] == [OTHER_CODE]


#: Everything this service answers without asking who is calling. Three static
#: documents and a liveness check; none of them holds participant data, names a
#: participant, spends money, or describes the deployment.
#:
#: `/api/research/ontology-resolution` is not here. It is open for the curated
#: layer and closed the moment a request names a participant, which
#: `TestOpenSurface` asserts separately.
OPEN_ROUTES = {
    ("GET", "/api/health"),
    ("GET", "/api/research/graph-walk-policy"),
    ("GET", "/api/research/ontology-layers"),
    ("GET", "/api/research/ontology-resolution"),
}


class TestEveryRouteIsAccountedFor:
    def test_no_route_is_open_by_omission(self):
        """The list above is the whole open surface, checked against the app.

        This is the test that catches the thirty-eighth route. A handler added
        without a `require_…` call is how the first thirty-six came to be open —
        not by anyone deciding they should be, but by nobody deciding anything.
        Adding one now fails here until it is either guarded or written into
        `OPEN_ROUTES`, which is a line a reviewer sees.
        """
        import inspect

        from fastapi.routing import APIRoute

        from app import main

        unguarded = set()
        for route in main.app.routes:
            if not isinstance(route, APIRoute) or not route.path.startswith("/api/"):
                continue
            # The world-model router has its own `RESEARCH_API_TOKEN` gate.
            if route.path.startswith("/api/research/world-model"):
                continue
            source = inspect.getsource(route.endpoint)
            guarded = any(
                call in source
                for call in ("require_participant", "require_owner_of", "require_user")
            )
            for method in route.methods - {"HEAD", "OPTIONS"}:
                if not guarded and (method, route.path) not in OPEN_ROUTES:
                    unguarded.add((method, route.path))

        assert unguarded == set(), (
            "routes with no caller check and no entry in OPEN_ROUTES: "
            + ", ".join(f"{m} {p}" for m, p in sorted(unguarded))
        )

    def test_the_open_list_is_honest(self):
        """An entry that names no route is a claim about code that has moved."""
        from fastapi.routing import APIRoute

        from app import main

        live = {
            (method, route.path)
            for route in main.app.routes
            if isinstance(route, APIRoute)
            for method in route.methods - {"HEAD", "OPTIONS"}
        }
        assert OPEN_ROUTES - live == set()


class TestOpenSurface:
    """What stays open, listed so that widening it is a visible edit."""

    @pytest.mark.parametrize(
        "path",
        [
            "/api/health",
            "/api/research/graph-walk-policy",
            "/api/research/ontology-layers",
        ],
    )
    def test_still_open(self, closed, path):
        assert client.get(path).status_code == 200

    def test_the_curated_layer_is_open_but_a_participant_is_not(self, closed):
        """`/api/research/ontology-resolution` answers about people in general.

        Naming a participant turns the same route into a question about their
        entries, and that half is refused.
        """
        general = client.get(
            "/api/research/ontology-resolution", params={"source_id": "a", "target_id": "b"}
        )
        assert general.status_code == 200

        personal = client.get(
            "/api/research/ontology-resolution",
            params={"source_id": "a", "target_id": "b", "user_id": OWNER_CODE},
        )
        assert personal.status_code == 401


class TestTheEscapeHatchIsVisible:
    def test_health_reports_that_this_instance_is_open(self, monkeypatch):
        monkeypatch.setenv(authz.OPEN_ACCESS_ENV, "1")
        assert client.get("/api/health").json()["authentication"] == "disabled"

    def test_health_reports_that_this_instance_is_closed(self, closed):
        assert client.get("/api/health").json()["authentication"] == "required"

    @pytest.mark.parametrize("value", ["", "0", "true", "yes", "1 ", " 1"])
    def test_only_the_exact_string_opens_it(self, closed, monkeypatch, value):
        """`1`, and nothing that merely looks willing.

        `" 1"` and `"1 "` are accepted because the value is stripped — a
        trailing space in a dashboard field is a typo, not a decision. Anything
        else leaves the check on.
        """
        monkeypatch.setenv(authz.OPEN_ACCESS_ENV, value)
        expected = value.strip() == "1"
        assert authz.open_access() is expected
