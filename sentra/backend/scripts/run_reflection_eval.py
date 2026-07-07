from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.reflection_intelligence import run_reflection_eval


def main() -> int:
    case_ids = sys.argv[1:] or None
    result = run_reflection_eval(case_ids)
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0 if result["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
