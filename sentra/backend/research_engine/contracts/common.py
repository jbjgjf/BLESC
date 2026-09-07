"""Primitives every contract shares: time, finiteness, canonical hashing.

Three rules from the contract document turn into code here, because each was
cheap to get subtly wrong in six places independently.

**Time is timezone-aware UTC.** A naive timestamp is rejected rather than
assumed to be UTC. The engine compares `available_at` against a cutoff to decide
what a model was allowed to see; a nine-hour guess about a Japanese local time
would be the difference between an honest forecast and a leak.

**No NaN, no Infinity.** JSON has no spelling for either, and every serialiser
that invents one produces a file that some readers accept and others reject.
A missing number is `null` with `observed_mask=false`; an unrepresentable number
is a bug to raise on, not a value to write.

**Hashes are of canonical JSON.** Two runs that used the same split must produce
the same `split_hash`, so the hashed bytes cannot depend on dict ordering or
float repr. A hash here confirms *sameness of content*; it is not a tamper
proof, and C5 says so in the report itself.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from datetime import datetime, timezone
from typing import Any, Iterable, List, Mapping, Optional, Sequence

from .errors import Code, ContractViolation
from .versions import SECONDS_PER_DAY

_ISO_Z = re.compile(r"Z$", re.IGNORECASE)


def parse_time(value: Any, path: str) -> datetime:
    """Parse an ISO 8601 timestamp, requiring an explicit offset."""

    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(_ISO_Z.sub("+00:00", value))
        except ValueError as exc:
            raise ContractViolation(
                Code.BAD_TIMESTAMP,
                f"ISO 8601として解釈できない時刻です: {value!r}",
                path,
                {"error": str(exc)},
            ) from exc
    else:
        raise ContractViolation(
            Code.WRONG_TYPE, "時刻は文字列かdatetimeで表します。", path, {"got": type(value).__name__}
        )

    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ContractViolation(
            Code.NAIVE_TIMESTAMP,
            "timezoneのない時刻は受け取りません。UTCと仮定すると9時間ずれた漏洩を見逃します。",
            path,
        )
    return parsed.astimezone(timezone.utc)


def parse_optional_time(value: Any, path: str) -> Optional[datetime]:
    """`None` stays `None` — an unknown event time is not a zero time."""

    if value is None:
        return None
    return parse_time(value, path)


def format_time(value: Optional[datetime]) -> Optional[str]:
    """Serialise back to the `...Z` form the contract examples use."""

    if value is None:
        return None
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def elapsed_days(later: datetime, earlier: datetime) -> float:
    """Elapsed time in days, with one day fixed at 86,400 seconds."""

    return (later - earlier).total_seconds() / SECONDS_PER_DAY


def check_finite(value: Any, path: str) -> float:
    """Reject NaN, ±Infinity and bools-posing-as-numbers."""

    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ContractViolation(
            Code.WRONG_TYPE, "数値が必要です。", path, {"got": type(value).__name__}
        )
    number = float(value)
    if math.isnan(number) or math.isinf(number):
        raise ContractViolation(
            Code.NON_FINITE_NUMBER,
            "NaN・Infinityは契約で禁止です。欠測はnullとmaskで表します。",
            path,
        )
    return number


def check_optional_finite(value: Any, path: str) -> Optional[float]:
    if value is None:
        return None
    return check_finite(value, path)


def require(condition: bool, code: str, message_ja: str, path: str = "", **detail: Any) -> None:
    if not condition:
        raise ContractViolation(code, message_ja, path, detail)


def require_fields(payload: Mapping[str, Any], fields: Sequence[str], path: str = "") -> None:
    missing = [name for name in fields if name not in payload]
    if missing:
        raise ContractViolation(
            Code.MISSING_FIELD,
            f"必須フィールドが欠けています: {', '.join(missing)}",
            path,
            {"missing": missing},
        )


def require_enum(value: Any, allowed: Sequence[str], path: str) -> str:
    if value not in allowed:
        raise ContractViolation(
            Code.UNKNOWN_ENUM_VALUE,
            f"未知の値です: {value!r}。許可: {', '.join(allowed)}",
            path,
            {"allowed": list(allowed), "got": value},
        )
    return str(value)


def require_same_length(left: Sequence[Any], right: Sequence[Any], left_path: str, right_path: str) -> None:
    if len(left) != len(right):
        raise ContractViolation(
            Code.LENGTH_MISMATCH,
            f"長さが一致しません: {left_path}={len(left)}, {right_path}={len(right)}",
            right_path,
            {"expected": len(left), "got": len(right)},
        )


def require_non_decreasing(times: Sequence[datetime], path: str) -> None:
    for index in range(1, len(times)):
        if times[index] < times[index - 1]:
            raise ContractViolation(
                Code.BAD_TIMESTAMP,
                "時刻が昇順ではありません。系列は観測順に並べます。",
                f"{path}[{index}]",
                {"previous": format_time(times[index - 1]), "current": format_time(times[index])},
            )


def canonical_json(payload: Any) -> str:
    """Deterministic JSON: sorted keys, no spaces, no NaN."""

    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def content_hash(payload: Any) -> str:
    """`sha256:<hex>` over canonical JSON — content identity, not tamper proof."""

    return "sha256:" + hashlib.sha256(canonical_json(payload).encode("utf-8")).hexdigest()


def file_hash(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(65_536), b""):
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def round_floats(values: Iterable[Optional[float]], places: int = 9) -> List[Optional[float]]:
    """Round for stable hashing across platforms with different float repr."""

    return [None if value is None else round(float(value), places) for value in values]
