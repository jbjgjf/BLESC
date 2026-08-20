from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.benchmark_model_labelling import (
    DEFAULT_ARTIFACT,
    DEFAULT_CHECKPOINT,
    DEFAULT_LEDGER,
    CostLedger,
    adjudicate,
    build_artifact,
    build_client,
    generate_cases,
    judge_cases,
    save_artifact,
)


def main() -> int:
    parser = argparse.ArgumentParser(description="Draft and model-adjudicate the #88 synthetic benchmark.")
    parser.add_argument("--env-file", type=Path, default=Path(__file__).resolve().parents[1] / ".env.benchmark.local")
    parser.add_argument("--artifact", type=Path, default=DEFAULT_ARTIFACT)
    parser.add_argument("--ledger", type=Path, default=DEFAULT_LEDGER)
    parser.add_argument("--checkpoint", type=Path, default=DEFAULT_CHECKPOINT)
    parser.add_argument("--pair-limit", type=int, choices=(2, 40), default=2)
    parser.add_argument("--batch-size", type=int, default=5)
    args = parser.parse_args()

    load_dotenv(args.env_file, override=True)
    client = build_client()
    ledger = CostLedger(args.ledger)
    checkpoint = {"cases": [], "runs": []}
    if args.checkpoint.exists():
        checkpoint = json.loads(args.checkpoint.read_text())

    def save_checkpoint() -> None:
        args.checkpoint.parent.mkdir(parents=True, exist_ok=True)
        temporary = args.checkpoint.with_suffix(".tmp")
        temporary.write_text(json.dumps(checkpoint, ensure_ascii=False, indent=2) + "\n")
        temporary.replace(args.checkpoint)

    def cases_progress(rows):
        checkpoint["cases"] = rows
        save_checkpoint()

    def runs_progress(rows):
        checkpoint["runs"] = rows
        save_checkpoint()

    cases = generate_cases(
        client,
        ledger,
        pair_limit=args.pair_limit,
        initial_cases=checkpoint.get("cases", []),
        on_progress=cases_progress,
    )
    checkpoint["cases"] = cases
    save_checkpoint()
    runs = judge_cases(
        client,
        ledger,
        cases,
        batch_size=args.batch_size,
        initial_runs=checkpoint.get("runs", []),
        on_progress=runs_progress,
    )
    checkpoint["runs"] = runs
    save_checkpoint()
    final, report = adjudicate(client, ledger, cases, runs)

    if args.pair_limit == 40:
        payload = build_artifact(cases, runs, final, report, ledger)
        save_artifact(payload, args.artifact)
    else:
        payload = {
            "trial": True,
            "case_count": len(cases),
            "agreement": report,
            "cost_usd": round(ledger.total_usd, 6),
            "nonempty_final_labels": sum(bool(row["selected_evidence_ids"]) for row in final.values()),
        }
    print(json.dumps(payload if args.pair_limit == 2 else payload["metadata"] | {"agreement": report}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
