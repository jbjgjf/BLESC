"""The sealed prediction ledger: append a forecast before its outcome is known.

The point of the ledger is that "the prediction did not change after we saw the
answer" becomes checkable rather than promised. Each entry records the forecast
id, the hash of what the model was given, the hash of what it produced, and the
model hash — appended at issue time, read at scoring time.

Two honesties are built in.

`evaluation_mode` distinguishes `historical_simulation` from `prospective`.
Everything in v0 is the former: replaying synthetic data that already exists is
not a sealed forecast about a person, and the report must not read as if it
were.

A hash confirms content identity. It does not make the file tamper-proof —
anyone who can rewrite the ledger can rewrite the hashes with it. What makes the
seal mean something is where the file lives and who can append to it, and the
report says so in its own `limitations` rather than leaving the reader to infer
the strength of the guarantee from the presence of the word "hash".
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence

from ..contracts.common import content_hash
from ..contracts.errors import Code, ContractViolation
from ..contracts.evaluation import LedgerEntry
from ..contracts.forecast import ForecastBundle


@dataclass
class PredictionLedger:
    """Append-only JSON Lines. One file per run.

    Append-only describes ordering *within* a run: an entry is written when the
    forecast is issued and never rewritten. It does not mean a file accumulates
    across runs. The documented smoke command has a fixed `--out`, so without
    the reset below a second invocation would leave two runs' predictions in one
    file, the sealing check would still pass on the length comparison, and the
    artifact the report points at would no longer be the evidence for that
    report.

    A ledger already holding another run's entries is refused rather than
    overwritten: that file is someone's evidence, and the caller wants a
    different `--out`, not a silent replacement.
    """

    path: Path
    evaluation_mode: str = "historical_simulation"
    run_id: Optional[str] = None

    def __post_init__(self) -> None:
        self.path = Path(self.path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._reset_for_run()

    def _reset_for_run(self) -> None:
        if self.run_id is None or not self.path.exists():
            return

        existing = {entry.run_id for entry in self.entries()}
        foreign = existing - {self.run_id}
        if foreign:
            raise ContractViolation(
                Code.STATUS_PAYLOAD_MISMATCH,
                f"別のrunの予測台帳が既にあります: {sorted(foreign)}。"
                "別の出力先を指定してください。上書きすると、そのrunの証跡が消えます。",
                str(self.path),
                {"existing_run_ids": sorted(foreign), "requested_run_id": self.run_id},
            )
        # Same run, run again: the pipeline is deterministic, so regenerate
        # rather than double every entry.
        self.path.unlink()

    def append(
        self,
        forecast: ForecastBundle,
        *,
        input_hash: str,
        model_hash: str,
        issued_at: Optional[datetime] = None,
    ) -> LedgerEntry:
        entry = LedgerEntry(
            forecast_id=forecast.forecast_id,
            run_id=forecast.run_id,
            cutoff_at=forecast.cutoff_at,
            issued_at=issued_at or datetime.now(timezone.utc),
            target_times=tuple(forecast.target_times),
            model_hash=model_hash,
            input_hash=input_hash,
            payload_hash=forecast.content_hash(),
            evaluation_mode=self.evaluation_mode,
        )
        entry.validate()
        with self.path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry.as_dict(), ensure_ascii=False, sort_keys=True) + "\n")
        return entry

    def entries(self) -> List[LedgerEntry]:
        if not self.path.exists():
            return []
        return [
            LedgerEntry.from_dict(json.loads(line))
            for line in self.path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]

    def verify_unchanged(self, forecasts: Sequence[ForecastBundle]) -> List[str]:
        """Forecast ids whose payload no longer matches what was sealed."""

        sealed = {entry.forecast_id: entry.payload_hash for entry in self.entries()}
        drifted: List[str] = []
        for forecast in forecasts:
            expected = sealed.get(forecast.forecast_id)
            if expected is not None and expected != forecast.content_hash():
                drifted.append(forecast.forecast_id)
        return drifted


def input_hash_for(event_ids: Sequence[str], cutoff_at: datetime) -> str:
    from ..contracts.common import format_time

    return content_hash({"event_ids": list(event_ids), "cutoff_at": format_time(cutoff_at)})
