"""Command line for the transfer study.

```bash
cd sentra/backend
python -m research_engine.transfer.cli prereg-status      # what still blocks the freeze
python -m research_engine.transfer.cli prereg-hash        # the hash a human copies into 凍結記録
```

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
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    return int(args.handler(args))


if __name__ == "__main__":  # pragma: no cover - entry point
    sys.exit(main())
