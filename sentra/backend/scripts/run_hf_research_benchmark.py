from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.hf_research_benchmark import hf_dataset_rows, run_hf_research_benchmark


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the BLESC/Sentra Hugging Face ISEF research benchmark.")
    parser.add_argument("--method", action="append", dest="methods", help="Benchmark method to include. Repeatable.")
    parser.add_argument("--k", type=int, default=2, help="Retrieval cutoff for recall/nDCG.")
    parser.add_argument("--dataset-rows", action="store_true", help="Print HF Dataset-style JSONL rows instead of metrics.")
    args = parser.parse_args()

    if args.dataset_rows:
        for row in hf_dataset_rows():
            print(json.dumps(row, ensure_ascii=False, sort_keys=True))
        return 0

    result = run_hf_research_benchmark(methods=args.methods, k=args.k)
    print(json.dumps(result, indent=2, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
