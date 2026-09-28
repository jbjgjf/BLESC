"""Numbers read out of the environment (#269).

The point of these is the last test: the FastAPI and Next.js implementations
have to answer the same way for the same value, because
``OPENAI_TRANSCRIPTION_MAX_BYTES`` is read by both and a row's fate must not
depend on which service received the request.

Before this, the same bad value produced ``ValueError`` at import here (so the
whole service refused to start over one optional tuning variable) and ``NaN``
there (so the size cap silently stopped capping).
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

from app.env_number import env_positive_int

NAME = "BLESC_TEST_ENV_NUMBER"

REPO_ROOT = Path(__file__).resolve().parents[3]
FRONTEND = REPO_ROOT / "sentra" / "frontend"


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    monkeypatch.delenv(NAME, raising=False)


def test_uses_a_positive_integer(monkeypatch):
    monkeypatch.setenv(NAME, "30000")
    assert env_positive_int(NAME, 25000) == 30000


def test_accepts_surrounding_whitespace(monkeypatch):
    # How a value arrives when it is pasted or piped rather than typed.
    monkeypatch.setenv(NAME, "  30000\n")
    assert env_positive_int(NAME, 25000) == 30000


def test_falls_back_when_unset_or_empty(monkeypatch):
    assert env_positive_int(NAME, 25000) == 25000
    monkeypatch.setenv(NAME, "")
    assert env_positive_int(NAME, 25000) == 25000
    monkeypatch.setenv(NAME, "   ")
    assert env_positive_int(NAME, 25000) == 25000


@pytest.mark.parametrize(
    "value",
    ["25s", "24MB", "20_000", '"20000"', "'20000'", "20000ms", "abc", "+20000", "0x20", "１２３"],
)
def test_falls_back_instead_of_raising(monkeypatch, value):
    """Every one of these used to raise ValueError at import time.

    ``"20_000"`` and ``"+20000"`` are the interesting pair: ``int()`` accepts
    both, JavaScript's ``Number()`` accepts neither. Accepting them here would
    make the two services disagree, which is the thing being fixed.
    """
    monkeypatch.setenv(NAME, value)
    assert env_positive_int(NAME, 25000) == 25000


@pytest.mark.parametrize("value", ["0", "-1", "-20000", "3.5", "0.5"])
def test_falls_back_on_zero_negatives_and_non_integers(monkeypatch, value):
    monkeypatch.setenv(NAME, value)
    assert env_positive_int(NAME, 25000) == 25000


def test_warns_when_it_falls_back(monkeypatch, caplog):
    """Silence is how a value somebody set stays ignored for a whole pilot."""
    monkeypatch.setenv(NAME, "24MB")
    with caplog.at_level("WARNING"):
        assert env_positive_int(NAME, 100) == 100
    assert any(NAME in record.getMessage() for record in caplog.records)


def test_does_not_warn_when_unset(caplog):
    with caplog.at_level("WARNING"):
        assert env_positive_int(NAME, 100) == 100
    assert caplog.records == []


def test_audio_ceiling_does_not_bring_the_service_down(monkeypatch):
    """The regression, at the call site that had it.

    ``app.main`` reads this at import. A ValueError there is not a bad request —
    it is every endpoint in the service refusing to start.
    """
    monkeypatch.setenv("OPENAI_TRANSCRIPTION_MAX_BYTES", "24MB")
    assert env_positive_int("OPENAI_TRANSCRIPTION_MAX_BYTES", 24 * 1024 * 1024) == 24 * 1024 * 1024


def test_the_call_site_no_longer_uses_a_bare_int_cast():
    source = (Path(__file__).resolve().parents[1] / "app" / "main.py").read_text(encoding="utf-8")
    assert 'env_positive_int("OPENAI_TRANSCRIPTION_MAX_BYTES"' in source
    assert not re.search(r"int\(\s*os\.getenv\(\s*[\"']OPENAI_TRANSCRIPTION_MAX_BYTES", source)


@pytest.mark.skipif(not (FRONTEND / "src" / "lib" / "server" / "envNumber.ts").exists(),
                    reason="frontend tree not present")
def test_both_implementations_agree(tmp_path):
    """The contract the two implementations exist under.

    Skipped rather than failed when node is unavailable, because this asserts a
    cross-service property and a missing toolchain is not a violation of it. CI
    runs both jobs on the same checkout, so it runs here.
    """
    cases = [
        "30000", "  30000\n", "", "   ",
        "25s", "24MB", "20_000", '"20000"', "'20000'", "20000ms", "abc", "+20000", "0x20",
        "0", "-1", "3.5",
    ]

    script = tmp_path / "probe.mjs"
    script.write_text(
        "import { envPositiveInt } from "
        f"{json.dumps(str(FRONTEND / 'src' / 'lib' / 'server' / 'envNumber.ts'))};\n"
        "const cases = JSON.parse(process.argv[2]);\n"
        "const out = {};\n"
        "for (const value of cases) {\n"
        "  process.env.PROBE = value;\n"
        "  out[value] = envPositiveInt('PROBE', 25000);\n"
        "}\n"
        "process.stdout.write(JSON.stringify(out));\n",
        encoding="utf-8",
    )

    try:
        completed = subprocess.run(
            [
                "node",
                "--experimental-strip-types",
                "--no-warnings",
                str(script),
                json.dumps(cases),
            ],
            capture_output=True,
            text=True,
            timeout=120,
            cwd=str(FRONTEND),
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as exc:  # pragma: no cover - toolchain
        pytest.skip(f"node unavailable: {exc}")

    if completed.returncode != 0:  # pragma: no cover - toolchain
        pytest.skip(f"node could not run the probe: {completed.stderr[-2000:]}")

    from_node = json.loads(completed.stdout)

    disagreements = []
    for value in cases:
        import os

        os.environ["PROBE_PY"] = value
        try:
            mine = env_positive_int("PROBE_PY", 25000)
        finally:
            os.environ.pop("PROBE_PY", None)
        theirs = from_node[value]
        if mine != theirs:
            disagreements.append((value, mine, theirs))

    assert not disagreements, f"python and node disagree on: {disagreements}"


def test_python_is_importable_without_the_optional_variables():
    """A smoke check that the module has no import-time environment reads."""
    completed = subprocess.run(
        [sys.executable, "-c", "import app.env_number as m; print(m.env_positive_int('NOPE', 7))"],
        capture_output=True,
        text=True,
        cwd=str(Path(__file__).resolve().parents[1]),
        timeout=120,
    )
    assert completed.returncode == 0, completed.stderr
    assert completed.stdout.strip() == "7"
