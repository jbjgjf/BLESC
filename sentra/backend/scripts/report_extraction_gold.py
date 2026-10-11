"""Print precision and recall of the no-model extractors on the gold set.

    USE_MOCK_LLM=true python scripts/report_extraction_gold.py [--json]

Reports and never fails. Drafted items are reported apart from human-labelled
ones and never enter the confirmatory block (#88); with no human labels that
block reads "not measured".
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

# Before the adapter is imported: it picks its provider at import time, and the
# mock path is the only one this script is allowed to score.
os.environ.setdefault("USE_MOCK_LLM", "true")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.evaluation.extraction_gold import EXTRACTORS, evaluate, format_report, load_gold  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--json", action="store_true", help="Emit the raw results instead of tables.")
    args = parser.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    gold = load_gold()
    results = {name: evaluate(gold, extractor) for name, extractor in EXTRACTORS.items()}
    if args.json:
        print(json.dumps(results, ensure_ascii=False, indent=2))
        return 0
    for name, result in results.items():
        print(format_report(name, result))
        print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
