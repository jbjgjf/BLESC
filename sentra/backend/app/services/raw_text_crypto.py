"""Encryption for retained journal text on the FastAPI write path (#131).

The parallel implementation is `frontend/src/lib/server/rawTextCrypto.ts`. The
two must produce values the other can open, because which one wrote a given row
depends on which backend was deployed when: AES-256-GCM, a random 12-byte IV
prefixed to the ciphertext, the whole thing base64-encoded, under the 32-byte
key in ``RESEARCH_RAW_TEXT_KEY``.

Without the key — or without ``cryptography`` installed — ``encrypt_raw_text``
returns ``None`` and the writer stores nothing. A misconfigured deployment
retains no research text; it never retains it in the clear.
"""

from __future__ import annotations

import base64
import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Optional, Tuple

logger = logging.getLogger(__name__)

KEY_VERSION = "raw-text-aesgcm-v1"
_IV_BYTES = 12

# Broadly guarded on purpose. `cryptography` is an optional dependency, and a
# partially-installed one fails at import with something other than ImportError
# (a missing `_cffi_backend` surfaces as a pyo3 panic). Either way the answer is
# the same — retention is unavailable — and neither may take the whole writer
# down on import.
try:  # pragma: no cover - import guard
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    _AESGCM_AVAILABLE = True
except Exception:  # pragma: no cover - import guard
    AESGCM = None  # type: ignore[assignment]
    _AESGCM_AVAILABLE = False
    logger.warning("[raw-text] cryptography is unavailable; raw text will not be retained")


def _key_material() -> Optional[bytes]:
    configured = os.getenv("RESEARCH_RAW_TEXT_KEY")
    if not configured:
        return None
    try:
        material = base64.b64decode(configured, validate=True)
    except Exception:
        logger.warning("[raw-text] RESEARCH_RAW_TEXT_KEY is not valid base64; raw text will not be retained")
        return None
    if len(material) != 32:
        logger.warning("[raw-text] RESEARCH_RAW_TEXT_KEY must decode to 32 bytes; raw text will not be retained")
        return None
    return material


def retention_configured() -> bool:
    return _AESGCM_AVAILABLE and _key_material() is not None


def encrypt_raw_text(plaintext: str) -> Optional[Tuple[str, str]]:
    """Return ``(ciphertext, key_version)``, or ``None`` when unavailable.

    The IV is random per call, so two identical entries do not produce the same
    column value — otherwise the column tells anyone who can read it that two
    submissions were identical, without the key.
    """
    material = _key_material()
    if material is None or not _AESGCM_AVAILABLE:
        return None
    iv = os.urandom(_IV_BYTES)
    sealed = AESGCM(material).encrypt(iv, plaintext.encode("utf-8"), None)
    return base64.b64encode(iv + sealed).decode("ascii"), KEY_VERSION


def decrypt_raw_text(ciphertext: str) -> Optional[str]:
    """Open a stored value, or ``None`` when it will not open.

    Returns ``None`` rather than raising: one unreadable row — a rotated key, a
    truncated column — should not abort an export of the rest.
    """
    material = _key_material()
    if material is None or not _AESGCM_AVAILABLE:
        return None
    try:
        packed = base64.b64decode(ciphertext, validate=True)
        if len(packed) <= _IV_BYTES:
            return None
        opened = AESGCM(material).decrypt(packed[:_IV_BYTES], packed[_IV_BYTES:], None)
        return opened.decode("utf-8")
    except Exception:
        return None


def retention_days() -> int:
    try:
        return int(os.getenv("RESEARCH_RAW_TEXT_RETENTION_DAYS", "180"))
    except ValueError:
        return 180


def expiry_from(now: Optional[datetime] = None) -> str:
    moment = now or datetime.now(timezone.utc)
    return (moment + timedelta(days=retention_days())).isoformat()
