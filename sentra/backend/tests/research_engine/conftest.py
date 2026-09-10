"""Research-engine test configuration.

`sentra/backend` has to be importable for `research_engine` to resolve when the
suite is collected from a different working directory than the CI one.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

BACKEND_ROOT = Path(__file__).resolve().parents[2]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from fixtures_loader import FIXTURE_DIR  # noqa: E402  (after the path fix above)


@pytest.fixture
def fixture_dir() -> Path:
    return FIXTURE_DIR
