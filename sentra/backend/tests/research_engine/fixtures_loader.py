"""Load the shared contract fixtures.

A module rather than a pytest fixture so that non-test callers (a REPL, a
one-off script checking a handoff) read the same files by the same path.
Deliberately not a package: a directory named `research_engine` under `tests/`
would shadow the real one on `sys.path`.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

FIXTURE_DIR = Path(__file__).parent / "fixtures"


def load_fixture(name: str) -> Any:
    return json.loads((FIXTURE_DIR / name).read_text(encoding="utf-8"))
