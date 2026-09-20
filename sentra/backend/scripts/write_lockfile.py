"""Regenerate `requirements.lock.txt` from a pip resolution report (#184).

Usage:

    cd sentra/backend
    python -m pip install -r requirements.txt --dry-run --ignore-installed \
      --report /tmp/resolve.json
    python scripts/write_lockfile.py /tmp/resolve.json

`--ignore-installed` matters. Without it, pip's report lists only what it
*would newly install*, so running this inside a virtualenv that already has the
dependencies produces a lock file with a handful of entries and no error — a
failure that looks like success, which is the kind this file exists to prevent.

Deliberately not a lockfile tool. `pip-tools`, `uv` and `poetry` all do this
better, and adopting one is a change to how everybody works. This is the
smallest thing that makes a CI run reproducible from the commit, and it should
be replaced the day the project picks a real one.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

HEADER = """# Fully pinned dependency set, including transitive packages (#184).
#
# Generated, not hand-edited. This is what CI installs, so that a run can be
# rebuilt later from the commit alone — the direct pins in `requirements.txt`
# are not enough on their own, because a transitive release can change a
# numerical result just as easily as a direct one.
#
# Regenerate after changing `requirements.txt`:
#   cd sentra/backend
#   python -m pip install -r requirements.txt --dry-run --ignore-installed \\
#     --report /tmp/resolve.json
#   python scripts/write_lockfile.py /tmp/resolve.json
"""


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2

    report = json.loads(Path(argv[1]).read_text(encoding="utf-8"))
    installs = report.get("install", [])

    # A report with almost nothing in it is the `--ignore-installed` mistake
    # above. Refuse rather than write a lock file that silently pins a fraction
    # of the tree.
    if len(installs) < 20:
        print(
            f"Only {len(installs)} package(s) in the report. Re-run the resolve with "
            "--ignore-installed; a report produced inside a populated virtualenv "
            "lists only what is missing from it.",
            file=sys.stderr,
        )
        return 1

    pins = {item["metadata"]["name"].lower(): item["metadata"]["version"] for item in installs}
    body = "\n".join(f"{name}=={version}" for name, version in sorted(pins.items()))

    out = Path(__file__).resolve().parent.parent / "requirements.lock.txt"
    out.write_text(f"{HEADER}\n{body}\n", encoding="utf-8")
    print(f"wrote {out} ({len(pins)} packages)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
