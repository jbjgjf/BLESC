"""Reading a positive integer out of the environment (#269).

The parallel implementation is
``frontend/src/lib/server/envNumber.ts``, and the two must agree, because
``OPENAI_TRANSCRIPTION_MAX_BYTES`` is read by both services and the answer must
not depend on which one received the request.

## What each side used to do with the same bad value

``OPENAI_TRANSCRIPTION_MAX_BYTES=24MB`` — a value with a unit, which is the
obvious way to write it wrong — produced three different outcomes:

* Next.js ``Number(...)`` → ``NaN`` → ``file.size > NaN`` is ``false`` → **the
  size cap silently stopped capping.**
* Next.js timeouts (the same pattern on two other variables) → ``NaN`` →
  ``setTimeout(fn, NaN)`` fires on the next tick → **every model call aborted
  before it was sent.**
* FastAPI ``int(os.getenv(...))`` → ``ValueError`` at module import → **the
  service did not start at all.**

Raising was the least harmful of the three, and it is still the wrong answer:
it takes down every unrelated endpoint over one optional tuning variable, and
it does it at import, where the traceback points at a constant rather than at
the configuration. So both sides now fall back to the documented default and
say so in the log.

**A warning, not silence.** Substituting the default without a word is how a
value somebody set stays ignored for a whole pilot.
"""

from __future__ import annotations

import logging
import os
from typing import Optional

logger = logging.getLogger(__name__)

__all__ = ["env_positive_int"]


def env_positive_int(name: str, fallback: int) -> int:
    """A positive integer from ``name``, or ``fallback``.

    Rejects, with a warning: anything that is not a plain integer (``"24MB"``,
    ``"20_000"`` — which ``int()`` accepts and JavaScript does not — ``"3.5"``),
    zero, and negatives. Surrounding whitespace is accepted, because that is
    how a value arrives when it is pasted or piped rather than typed.

    Zero is refused rather than honoured: every variable read this way is a
    timeout or a ceiling, and a ``0`` in one of those is a truncated value, not
    a request to disable it.
    """
    raw: Optional[str] = os.getenv(name)
    if raw is None or not raw.strip():
        return fallback

    candidate = raw.strip()
    # `int()` accepts underscores as digit separators and a leading `+`, neither
    # of which `Number()` accepts on the TypeScript side. Checking the shape
    # first is what keeps the two implementations answering the same way.
    if not (candidate.isascii() and candidate.isdecimal()):
        return _rejected(name, fallback)

    value = int(candidate)
    if value <= 0:
        return _rejected(name, fallback)
    return value


def _rejected(name: str, fallback: int) -> int:
    # The value is not logged. These variables hold limits rather than secrets,
    # but printing environment values into logs is not a habit to keep
    # per-variable exceptions for.
    logger.warning(
        "[env] %s is not a positive integer, so it is being ignored and %d used instead. "
        "Set it to a plain integer with no units, separators or quotes.",
        name,
        fallback,
    )
    return fallback
