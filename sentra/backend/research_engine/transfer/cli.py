"""Command line for the transfer study.

```bash
cd sentra/backend
python -m research_engine.transfer.cli prereg-status      # what still blocks the freeze
python -m research_engine.transfer.cli prereg-hash        # the hash a human copies into 凍結記録
python -m research_engine.transfer.cli generate --seed 1 --missingness state_dependent --out /tmp/cohort
```

`generate` needs `--seed` and `--missingness` spelled out: which seed and
scenario become the frozen synthetic set is P13 of the pre-registration, and a
default would quietly make that choice.

Nothing here writes to the pre-registration. `prereg-status` exits non-zero
while the draft is not frozen, so a script that gates on it cannot mistake an
open draft for a frozen one.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Optional, Sequence

from .generator import MISSINGNESS_SCENARIOS, SyntheticCohortConfig, generate, manifest_hash, write_cohort
from .preregistration import PREREGISTRATION_PATH, freeze_status, load_preregistration


def command_prereg_status(args: argparse.Namespace) -> int:
    prereg = load_preregistration(Path(args.path))
    status = freeze_status(prereg)
    print(json.dumps(status.as_dict(), ensure_ascii=False, indent=2))
    return 0 if status.frozen else 1


def command_prereg_hash(args: argparse.Namespace) -> int:
    prereg = load_preregistration(Path(args.path))
    print(prereg.content_hash())
    return 0


def command_generate(args: argparse.Namespace) -> int:
    config = SyntheticCohortConfig(seed=args.seed, missingness=args.missingness, mnar_strength=args.mnar_strength)
    cohort = generate(config)
    paths = write_cohort(cohort, Path(args.out))
    print(
        json.dumps(
            {
                "status": cohort.manifest["status"],
                "dataset_id": cohort.dataset.dataset_id,
                "dataset_hash": cohort.manifest["hashes"]["dataset_hash"],
                "manifest_hash": manifest_hash(cohort.manifest),
                "paths": {name: str(path) for name, path in paths.items()},
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="research_engine.transfer.cli", description="合成→実データ移転研究（#210）"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    status = subparsers.add_parser("prereg-status", help="事前登録の凍結を妨げている項目を表示する")
    status.add_argument("--path", default=str(PREREGISTRATION_PATH))
    status.set_defaults(handler=command_prereg_status)

    digest = subparsers.add_parser("prereg-hash", help="凍結記録に書く文書hashを表示する")
    digest.add_argument("--path", default=str(PREREGISTRATION_PATH))
    digest.set_defaults(handler=command_prereg_hash)

    gen = subparsers.add_parser("generate", help="合成参加者（候補・未凍結）を生成する")
    gen.add_argument("--seed", type=int, required=True)
    gen.add_argument("--missingness", choices=MISSINGNESS_SCENARIOS, required=True)
    gen.add_argument("--mnar-strength", type=float, default=1.0)
    gen.add_argument("--out", required=True)
    gen.set_defaults(handler=command_generate)
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    return int(args.handler(args))


if __name__ == "__main__":  # pragma: no cover - entry point
    sys.exit(main())
