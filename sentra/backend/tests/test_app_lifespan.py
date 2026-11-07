"""The startup path runs as a lifespan handler, not `on_event` (#460).

`@app.on_event("startup")` is deprecated and scheduled for removal, and the
`backend-minor-and-patch` Dependabot group raises fastapi/starlette minor and
patch versions weekly — so the day it is removed arrives as a routine
dependency PR, and what breaks is the only path that creates this service's
tables. These tests are what makes that reintroduction visible here instead.

## Why this asserts structure rather than capturing the warning

FastAPI emits the `on_event is deprecated` warning when the decorator *runs*,
which is at import time. By the time any test body executes, `app.main` is long
since imported and the warning — if there were one — has already been emitted
and cannot be caught. Reloading the module to catch it would re-run every
top-level statement in a 3,000-line module and hand the rest of the suite a
different `app` object than the one it imported.

So these assert the thing the warning is *about*: `on_event` registers its
callback by appending to `app.router.on_startup`, and a lifespan handler leaves
that list empty. If someone reintroduces the decorator, the list grows and the
first test fails, which is the same signal with none of the import-order
fragility.
"""

import ast
import inspect
import textwrap

from fastapi.testclient import TestClient

from app.main import app, lifespan


def test_no_deprecated_event_handlers_are_registered():
    """`on_event("startup"/"shutdown")` appends here; a lifespan does not."""
    assert app.router.on_startup == []
    assert app.router.on_shutdown == []


def test_app_was_built_with_a_lifespan_handler():
    """Not Starlette's placeholder, which is what an app with none would hold."""
    assert type(app.router.lifespan_context).__name__ != "_DefaultLifespan"


def test_lifespan_creates_tables_then_seeds(monkeypatch):
    """The order is load-bearing: `seed_data()` writes into those tables."""
    calls = []
    monkeypatch.setattr("app.main.create_db_and_tables", lambda: calls.append("create"))
    monkeypatch.setattr("app.main.seed_data", lambda: calls.append("seed"))

    with TestClient(app):
        pass

    assert calls == ["create", "seed"]


def test_lifespan_adds_no_shutdown_work():
    """The `yield` is the last statement in the handler — nothing runs on exit.

    Adding a shutdown half is the one change this migration could smuggle in:
    `on_event("shutdown")` never existed here, so no other test in the suite
    would notice an ordering promise appearing. Read off the source rather than
    by running it, because work added after the `yield` would most likely call
    something these tests do not stub and so would pass unnoticed.
    """
    source = textwrap.dedent(inspect.getsource(lifespan.__wrapped__))
    body = ast.parse(source).body[0].body

    last = body[-1]
    assert isinstance(last, ast.Expr) and isinstance(last.value, ast.Yield), (
        "the lifespan handler must end at its yield; work after it is shutdown "
        "ordering this service has not promised"
    )
    assert last.value.value is None, "the lifespan yields no state"
    assert sum(isinstance(n, ast.Expr) and isinstance(n.value, ast.Yield) for n in body) == 1
