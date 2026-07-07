from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.reflection_intelligence import CANONICAL_EVAL_CASES, analyze_reflection


def main() -> int:
    output = [
        {
            "case_id": case.case_id,
            "text": case.text,
            **analyze_reflection(case.case_id, case.text),
        }
        for case in CANONICAL_EVAL_CASES
    ]
    output_path = Path("reflection_demo_scenarios.json")
    output_path.write_text(json.dumps(output, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Wrote {len(output)} deterministic scenarios to {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
