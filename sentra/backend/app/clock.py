"""The current time, in the form the rest of this service already uses (#207).

`datetime.utcnow()` is deprecated in Python 3.12 and scheduled for removal.
Eighteen calls to it produced most of the 8087 warnings a single `pytest` run
emitted, which is enough noise to hide a warning worth reading — the same run
also had six `anyio` deprecations in it that nobody had seen.

## Why this returns a naive datetime

The obvious replacement, `datetime.now(timezone.utc)`, returns an *aware*
datetime, and that is not a drop-in here. This service's convention is naive
UTC, and it is deliberate rather than accidental: `_parse_datetime` in
`services/research_pipeline.py` ends with `.replace(tzinfo=None)`, so every
timestamp read from input is stripped before it is used, and its fallback on
the very next line was `datetime.utcnow()`. Returning an aware value from that
fallback would put both kinds in one function's return type, and from there
into comparisons and subtractions that raise `TypeError` — or, where one side
is a stored column, quietly compare values that are not the same instant.

So this changes the deprecation and nothing else. Every call site keeps the
value it had.

## Moving to aware datetimes

Worth doing, and not here. It is one change: parse, store and compare aware
throughout, with the columns migrated to `timestamptz`. Doing it a call site at
a time is what produces the mixed comparisons above. Until then, `utcnow()`
being one function rather than eighteen inlined calls is what makes that change
a single edit — and `grep -rn "utcnow()"` now finds the convention rather than
the deprecation.
"""

from __future__ import annotations

from datetime import datetime, timezone

__all__ = ["utcnow"]


def utcnow() -> datetime:
    """Now, in UTC, without a timezone attached.

    The same value `datetime.datetime.utcnow()` returned, by a call that is not
    deprecated.
    """
    return datetime.now(timezone.utc).replace(tzinfo=None)
