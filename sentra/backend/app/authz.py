"""Who is asking, for the FastAPI product endpoints (#259).

`supabase_writer.resolve_identity()` already wrote down why identity cannot come
from a request:

    An earlier version of this took `owner_user_id` and `participant_id` from
    the request body and wrote them straight through. Any caller could name any
    participant and have rows created under it.

That was fixed for one endpoint — `POST /api/entries`, and only for the Supabase
mirror inside it. The other thirty-six routes in `app/main.py` never asked who
was calling. `GET /api/entries?user_id=…` returned a participant's journals to
anyone who typed the code; `GET /api/entries/{entry_id}` did not even need the
code, because the ids are consecutive integers. `sentra/docs/deployment_vercel.md`
recommends running this service on Render or Railway, so that is a public URL.

This module is the missing half. It is deliberately small: the verification
itself is `resolve_identity`, unchanged. What is added here is the decision to
*require* it, and the shape of the refusal.

## Fail closed

No token, no data — including when Supabase is not configured, because a service
that cannot verify anyone must not serve everyone. That is the same direction
`cronAuth.ts` and `research_world_model.py` fail in, and the opposite of
`rateLimit.ts`, which fails open on purpose. The asymmetry is the usual one:
a limiter that stops limiting inconveniences an attacker, and an authorisation
check that stops checking publishes a minor's diary.

## The one way out, and why it is visible

`BLESC_ALLOW_UNAUTHENTICATED_API=1` serves participant data with no token. It
exists because this service is also a local SQLite development target and the
test suite drives it with no Supabase project at all — without it, the escape
hatch would be "comment the check out", which is the kind that ships.

It is not quiet. It is logged at import, and `GET /api/health` reports it, so a
deployment that is running open says so to anyone who asks rather than only to
whoever reads the startup log. It must be exactly `"1"`: `true`, `yes` and an
accidental empty string do not turn it on.

## 401 or 404

A missing or rejected token is 401 — the caller has not said who they are, and
telling them so costs nothing. A valid token naming a participant it does not
own is 404, not 403: 403 would confirm the code belongs to somebody, which is
the one bit an enumerating caller wants. This matches `requireOperator` in the
Next.js app, which answers 404 for the same reason.
"""

from __future__ import annotations

import logging
import os
from typing import Optional

from fastapi import HTTPException, status

from .services import supabase_writer

logger = logging.getLogger(__name__)

#: The environment variable that turns the check off. Read through a function
#: rather than captured at import so the test suite can set it per module.
OPEN_ACCESS_ENV = "BLESC_ALLOW_UNAUTHENTICATED_API"


def open_access() -> bool:
    """Whether this process serves participant data without a verified token."""
    return (os.getenv(OPEN_ACCESS_ENV) or "").strip() == "1"


if open_access():  # pragma: no cover - startup announcement
    logger.warning(
        "[authz] %s=1: participant endpoints are being served without authentication. "
        "This is for local development and tests. Never set it on a deployment that "
        "holds real entries.",
        OPEN_ACCESS_ENV,
    )


def _unauthenticated() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Authorization: Bearer <Supabase access token> is required.",
        headers={"WWW-Authenticate": "Bearer"},
    )


def _not_found() -> HTTPException:
    # Deliberately indistinguishable from "no such participant". See the header.
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")


def _unavailable() -> HTTPException:
    # An operator error, not an attacker signal, so this one says what is wrong.
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail=(
            "This service cannot verify callers: SUPABASE_URL and "
            "SUPABASE_SERVICE_ROLE_KEY are not configured. It therefore serves "
            "no participant data. See sentra/docs/deployment_vercel.md."
        ),
    )


def require_user(authorization: Optional[str]) -> Optional[str]:
    """A verified Supabase user id, for routes that hold no participant data.

    Used by the endpoints that accept free text and spend money on it —
    transcription and reflection analysis. They name no participant, so there is
    nothing to own; what they need is that the caller is somebody at all.

    Returns None when `open_access()` is on.
    """
    if open_access():
        return None

    token = supabase_writer._bearer_token(authorization)
    if not token:
        raise _unauthenticated()

    client = supabase_writer.get_client()
    if client is None:
        raise _unavailable()

    # Verified with Supabase rather than decoded here, for the reason
    # `resolve_identity` gives: a locally decoded JWT cannot see revocation.
    try:
        user_response = client.auth.get_user(token)
    except Exception as exc:
        logger.info("[authz] access token rejected: %s", exc)
        raise _unauthenticated() from exc

    user_id = getattr(getattr(user_response, "user", None), "id", None)
    if not user_id:
        raise _unauthenticated()
    return str(user_id)


def require_participant(authorization: Optional[str], participant_code: Optional[str]) -> str:
    """The caller owns `participant_code`, or this raises.

    `participant_code` is what the rest of `main.py` calls `user_id`: the
    pseudonym the frontend holds, not a Supabase user id. `resolve_identity`
    constrains the lookup to the token's owner, so a code belonging to another
    student resolves to nothing rather than to their row.

    Returns the code, so call sites read as an assignment rather than as a bare
    statement that is easy to delete by accident.
    """
    code = (participant_code or "").strip()

    if open_access():
        return code

    if not supabase_writer._bearer_token(authorization):
        raise _unauthenticated()

    if not supabase_writer.is_configured():
        raise _unavailable()

    if not code:
        raise _not_found()

    try:
        supabase_writer.resolve_identity(authorization, code)
    except supabase_writer.NotAuthorized as exc:
        logger.info("[authz] refused: %s", exc)
        raise _not_found() from exc

    return code


def require_participant_pair(
    authorization: Optional[str],
    user_id: Optional[str],
    participant_code: Optional[str] = None,
) -> str:
    """Both halves of the `(user_id, participant_code)` pair the research routes take.

    Every request the frontend makes sets them to the same string, and every row
    is written with them equal, so a mismatched pair reads nothing today. That
    is a property of the writer, not a check: verifying only one half would let
    a caller pin the checked half to a code they own and leave the other one
    pointing at somebody else, and it would start returning rows the first time
    a query filtered on one column instead of two.

    Returns the effective participant code, as the routes' `participant = …`
    line already did.
    """
    owned = require_participant(authorization, user_id)
    code = (participant_code or "").strip() or owned
    if code != owned:
        require_participant(authorization, code)
    return code


def require_owner_of(authorization: Optional[str], owner_code: Optional[str]) -> str:
    """The same check, for a row reached by its own id rather than by a code.

    `GET /api/entries/{entry_id}` and friends are handed an integer. The row is
    read first, its `user_id` is the participant code that owns it, and that is
    what the caller has to own. A caller who owns nothing gets the same 404 as
    one who named an id that does not exist, so counting upwards from 1 tells
    them nothing.
    """
    return require_participant(authorization, owner_code)
