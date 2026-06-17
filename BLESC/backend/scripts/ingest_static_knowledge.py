from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.services.static_knowledge import default_static_knowledge_files, ingest_static_knowledge_files


def main() -> int:
    parser = argparse.ArgumentParser(description="Upload BLESC static policy and psychoeducation files to OpenAI Vector Store.")
    parser.add_argument("paths", nargs="*", help="Static knowledge files to ingest. Defaults to BLESC docs allowlist.")
    parser.add_argument("--no-create", action="store_true", help="Require BLESC_VECTOR_STORE_ID instead of creating a new vector store.")
    args = parser.parse_args()

    paths = [Path(path) for path in args.paths] if args.paths else default_static_knowledge_files()
    result = ingest_static_knowledge_files(paths, create_if_missing=not args.no_create)
    print(json.dumps(result, indent=2, ensure_ascii=False, default=str))
    if result.get("status") == "created":
        print("Set BLESC_VECTOR_STORE_ID to the returned vector_store_id before running the app.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
