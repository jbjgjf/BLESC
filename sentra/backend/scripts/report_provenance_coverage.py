"""Print provenance coverage for every benchmark case. #79.

Runs in CI on every push so a regression is visible in the build log rather
than only when someone thinks to look. It **reports and never fails**: there is
no threshold to fail against yet, and inventing one before the distribution has
been looked at would be choosing a number to be passed rather than measuring
one. When there is a distribution, a gate belongs in a test, not here.

    python scripts/report_provenance_coverage.py [--json]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.hf_research_benchmark import run_hf_research_benchmark


def _row(name: str, coverage: Dict[str, Any]) -> str:
    return (
        f"  {name:<24}"
        f"  nodes {coverage['nodes_with_source']:>8.1%}"
        f"  edges {coverage['edges_with_source']:>8.1%}"
        f"  unsourced {coverage['unsourced_rate']:>8.1%}"
        f"  ({coverage['node_count']}n/{coverage['edge_count']}e)"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true", help="Emit the raw block instead of the table.")
    args = parser.parse_args()

    # The seed labels and case ids are bilingual; a console defaulting to cp932
    # would fail on them rather than print a worse table.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    report = run_hf_research_benchmark()["provenance_coverage"]

    if args.json:
        print(json.dumps(report, indent=2, ensure_ascii=False, sort_keys=True))
        return 0

    print("Provenance coverage — share of each benchmark graph tied to a published source")
    print(f"match rules: {', '.join(report['match_rules'])}")
    print()

    print("per case:")
    for case_id, coverage in sorted(report["cases"].items()):
        print(_row(f"{case_id} [{coverage['lang']}]", coverage))

    print()
    print("by language:")
    for lang, coverage in sorted(report["by_language"].items()):
        print(_row(lang, coverage))
    if not report["by_language_validity"]["per_language_comparison_valid"]:
        print(f"  ! {report['by_language_validity']['note']}")

    print()
    print("overall:")
    print(_row("all cases", report["overall"]))
    print(f"  matched edges by evidence strength: {report['overall']['edges_by_strength']}")
    print(f"  seed subgraphs touched: {', '.join(report['overall']['matched_seed_subgraphs']) or 'none'}")

    print()
    print(f"NOTE: {report['note']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
