"""Print the backend detectors' per-category rates on the safety corpus.

    python scripts/report_safety_corpus.py           # Markdown tables + drift
    python scripts/report_safety_corpus.py --json    # the raw summaries
    python scripts/report_safety_corpus.py --prune   # apply notices to baseline.json

Like `report_provenance_coverage.py`, this **reports and never fails**; the
gate is `tests/test_safety_corpus.py`. `--prune` only removes entries that the
test reported as improvements (a known gap now caught, a false positive now
clean). It never adds one: accepting a regression is a decision a person makes
by editing `baseline.json` by hand.

The frontend detector is measured by `sentra/frontend/tests/safety-corpus.test.mjs`,
which prints the same table in its output.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.evaluation.safety_corpus import (  # noqa: E402
    BASELINE_PATH,
    compare,
    dump_baseline,
    evaluate_backend,
    format_table,
    load_baseline,
    load_corpus,
    pruned_entry,
)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--json", action="store_true", help="Emit the raw summaries instead of tables.")
    group.add_argument("--prune", action="store_true", help="Remove improved entries from baseline.json.")
    args = parser.parse_args()

    # Category labels and corpus text are Japanese; a console defaulting to
    # cp932 or ascii would turn the report into an encoding error.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    corpus = load_corpus()
    baseline = load_baseline()
    results = evaluate_backend(corpus)

    if args.json:
        print(json.dumps({name: r["summary"] for name, r in results.items()}, ensure_ascii=False, indent=2))
        return 0

    for name, result in results.items():
        entry = baseline["detectors"][name]
        drift = compare(corpus, result["observations"], entry)
        if args.prune:
            baseline["detectors"][name] = pruned_entry(corpus, entry, drift, result["observations"])
            continue
        print(f"## {name}  ({result['detector'].source})\n")
        print(format_table(corpus, result["summary"]))
        print()
        print(f"failures: {drift.failures or 'none'}")
        print(f"notices:  {drift.notices or 'none'}\n")

    if args.prune:
        BASELINE_PATH.write_text(dump_baseline(baseline), encoding="utf-8")
        print(f"pruned backend entries in {BASELINE_PATH}")
    print(
        "Expected verdicts are an unreviewed model draft (reviewed: false). "
        "These rates are agreement with that draft, not coverage."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
