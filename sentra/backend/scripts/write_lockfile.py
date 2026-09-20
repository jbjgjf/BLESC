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
import platform as platform_module
import sys
from datetime import date
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
#
# A resolution is only valid for the interpreter and platform it was made on,
# and this file records both below. `numpy==2.5.3` requires >=3.12, so these
# pins do not install at all on 3.11; and `torch` declares its CUDA wheels as
# dependencies on linux-x86_64 and on no other platform, so a set resolved on
# macOS is missing twenty-one packages that CI will then install unpinned.
# Match what `.github/workflows/research-contracts.yml` runs.
#
# Resolved {resolved_on}, Python {python_version}, {platform}.
"""

# What CI installs on. A lock resolved anywhere else is not the set CI gets,
# which is the whole point of having one.
TARGET_PLATFORM = ("linux", "x86_64")


def provenance(report: dict) -> tuple[str, str, str]:
    """When this was resolved, on which Python, and on which platform.

    Read from pip's own report rather than from the interpreter running this
    script, because they can differ: the documented regenerate command resolves
    in one environment and this script may be run from another. The values that
    belong in the file are the ones the pins were resolved under.

    #206: the `Resolved …` line existed in the committed lock file and not in
    `HEADER`, so the first regeneration by the documented procedure would have
    silently dropped the only record of what the pins are valid for — from a
    file that tells its reader it is generated and must not be hand-edited.
    """
    environment = report.get("environment") or {}
    version = environment.get("python_version")
    if not version:
        # A report from a pip too old to include `environment`. The interpreter
        # running this script is the next best evidence, and saying so is still
        # better than saying nothing.
        version = f"{sys.version_info.major}.{sys.version_info.minor}"
    system = environment.get("sys_platform") or sys.platform
    machine = environment.get("platform_machine") or platform_module.machine()
    return date.today().isoformat(), str(version), f"{system}-{machine}"


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

    resolved_on, python_version, resolved_platform = provenance(report)

    # A resolution from the wrong platform is the other way to write a lock file
    # that looks complete and is not, and it is the one that actually happened:
    # the set this replaces held `torch==2.14.0` and none of the twenty-one CUDA
    # wheels torch depends on under linux-x86_64, so CI installed those unpinned
    # every run. Refused rather than warned, for the same reason as above — a
    # lock file nobody trusts to be complete is not doing the job #184 gave it.
    if resolved_platform != "-".join(TARGET_PLATFORM):
        print(
            f"Resolved on {resolved_platform}, but CI installs on "
            f"{'-'.join(TARGET_PLATFORM)}. Dependency sets differ by platform — "
            "torch alone pulls twenty-one CUDA packages on Linux and none "
            "elsewhere — so this resolve would pin a set CI never installs. "
            "Re-run the resolve on Linux (a container is enough; nothing is "
            "installed, `--dry-run` only asks the index).",
            file=sys.stderr,
        )
        return 1

    pins = {item["metadata"]["name"].lower(): item["metadata"]["version"] for item in installs}
    body = "\n".join(f"{name}=={version}" for name, version in sorted(pins.items()))

    header = HEADER.format(
        resolved_on=resolved_on,
        python_version=python_version,
        platform=resolved_platform,
    )

    out = Path(__file__).resolve().parent.parent / "requirements.lock.txt"
    out.write_text(f"{header}\n{body}\n", encoding="utf-8")
    print(f"wrote {out} ({len(pins)} packages, Python {python_version}, {resolved_platform})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
