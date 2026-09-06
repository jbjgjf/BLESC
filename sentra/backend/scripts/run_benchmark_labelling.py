"""Run the human labelling protocol for the #88 benchmark (#126).

Everything the protocol needs already existed in `benchmark_labelling` — what
a rater is shown, how two raters are compared, how a drafted key becomes an
answer key — and none of it had a way in or out of a file. This is that way.

    # what state the labels are in
    python scripts/run_benchmark_labelling.py status

    # hand one rater the set, and a second rater the 20-case agreement sample
    python scripts/run_benchmark_labelling.py export --rater ayaka --out ./out
    python scripts/run_benchmark_labelling.py export --rater kenji --sample --out ./out

    # take the filled-in files back
    python scripts/run_benchmark_labelling.py import ./out/ayaka.json
    python scripts/run_benchmark_labelling.py import ./out/kenji.json

    # what the two raters disagreed about, and the coefficient over the sample
    python scripts/run_benchmark_labelling.py agreement
    python scripts/run_benchmark_labelling.py adjudicate
    python scripts/run_benchmark_labelling.py adjudicate --resolve sleep_chain_ja=c1,c2

    # sign the labels off; the benchmark picks them up from the store
    python scripts/run_benchmark_labelling.py apply --reviewer "Name"

Read `docs/benchmark_preregistration.md` before labelling. The exclusion
criteria were written before any case was excluded, and this tool follows them
rather than restating them.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Dict, List, Sequence, Set

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.benchmark_cases import BENCHMARK_CASES, BenchmarkCase
from app.services.benchmark_label_store import (
    DEFAULT_STORE,
    LabelStoreError,
    dispute_report,
    export_path,
    load_adjudication_record,
    resolve_dataset,
    store_rater_file,
    write_adjudication_record,
    write_labelling_file,
)
from app.services.benchmark_labelling import agreement_sample, assign_splits, labelling_status


def _selected_cases(args: argparse.Namespace) -> List[BenchmarkCase]:
    """Which cases go into one rater's file.

    `--sample` is the pre-drawn agreement set and is meant for the second
    rater; `--split` narrows to one partition, which is how a team keeps the
    test split for last.
    """
    if args.sample:
        return list(agreement_sample())
    if args.split and args.split != "all":
        wanted = set(assign_splits().cases_in(args.split))
        return [case for case in BENCHMARK_CASES if case.case_id in wanted]
    return list(BENCHMARK_CASES)


def _print(payload: object) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True, default=list))


def cmd_status(args: argparse.Namespace) -> int:
    dataset = resolve_dataset(args.store)
    status = labelling_status(
        agreement=dataset.agreement,
        cases=dataset.cases,
        reviewer=dataset.reviewer,
    )
    _print(
        {
            "store": str(args.store),
            "label_source": dataset.source,
            "raters": dataset.raters,
            "unresolved_disputes": dataset.disputed,
            "human_labelled_count": status["human_labelled_count"],
            "drafted_not_labelled_count": status["drafted_not_labelled_count"],
            "inter_rater_agreement": status["inter_rater_agreement"],
            "inter_rater_agreement_measured": status["inter_rater_agreement_measured"],
            "dataset": status["dataset"],
            "independent_group_count": status["independent_group_count"],
            "warnings": status["warnings"],
        }
    )
    return 0


def cmd_export(args: argparse.Namespace) -> int:
    cases = _selected_cases(args)
    destination = (args.out or args.store / "outbox") / f"{args.rater}.json"
    write_labelling_file(args.rater, destination, cases)
    print(f"wrote {destination}")
    print(f"  rater      {args.rater}")
    print(f"  cases      {len(cases)}")
    print(f"  candidates {sum(len(case.evidence) for case in cases)} judgements")
    print("  the file carries no answer key; fill in selected_evidence_ids, or [\"none\"]")
    return 0


def cmd_import(args: argparse.Namespace) -> int:
    try:
        stored = store_rater_file(args.file, args.store)
    except LabelStoreError as error:
        print(str(error), file=sys.stderr)
        return 1
    dataset = resolve_dataset(args.store)
    print(f"stored {stored}")
    print(f"  raters now      {', '.join(dataset.raters)}")
    print(f"  human-labelled  {sum(1 for case in dataset.cases if case.labelled_by == 'human')}/{len(dataset.cases)}")
    if dataset.disputed:
        print(f"  unresolved      {len(dataset.disputed)} case(s) — run `adjudicate`")
    return 0


def cmd_agreement(args: argparse.Namespace) -> int:
    dataset = resolve_dataset(args.store)
    if dataset.agreement is None:
        print(
            "agreement is not measured: it needs two rater files that overlap on the "
            "pre-drawn sample. This is 'not measured', which is not the same as "
            "'the raters disagreed' — do not report it as 0.",
            file=sys.stderr,
        )
        return 1
    result = dataset.agreement
    _print(
        {
            "kappa": result.kappa,
            "is_defined": result.is_defined,
            "meets_threshold": result.meets_threshold,
            "observed_agreement": result.observed_agreement,
            "expected_agreement": result.expected_agreement,
            "judgements": result.judgements,
            "note": result.note,
        }
    )
    return 0


def _parse_resolutions(pairs: Sequence[str]) -> Dict[str, Set[str]]:
    resolutions: Dict[str, Set[str]] = {}
    for pair in pairs:
        case_id, _, picks = pair.partition("=")
        if not case_id or not _:
            raise SystemExit(f"--resolve expects CASE_ID=id,id (got {pair!r})")
        chosen = [pick.strip() for pick in picks.split(",") if pick.strip()]
        resolutions[case_id] = set() if chosen == ["none"] else set(chosen)
    return resolutions


def cmd_adjudicate(args: argparse.Namespace) -> int:
    if args.resolve:
        record = load_adjudication_record(args.store)
        resolutions = dict(record.get("resolutions") or {})
        for case_id, picks in _parse_resolutions(args.resolve).items():
            resolutions[case_id] = sorted(picks)
        record["resolutions"] = resolutions
        path = write_adjudication_record(record, args.store)
        print(f"recorded {len(args.resolve)} resolution(s) in {path}")

    disputes = dispute_report(args.store)
    if not disputes:
        print("no unresolved disagreement")
        return 0
    print(f"{len(disputes)} unresolved disagreement(s). Until resolved these keep their")
    print("drafted keys and stay out of the confirmatory analysis.\n")
    _print(disputes)
    return 0


def cmd_apply(args: argparse.Namespace) -> int:
    dataset = resolve_dataset(args.store)
    if dataset.source != "store":
        print("no rater file in the store — nothing to apply", file=sys.stderr)
        return 1

    human = [case for case in dataset.cases if case.labelled_by == "human"]
    if args.reviewer:
        record = load_adjudication_record(args.store)
        record["reviewer"] = args.reviewer
        write_adjudication_record(record, args.store)
        print(f"reviewer recorded: {args.reviewer}")
    elif dataset.reviewer is None:
        print(
            "no reviewer recorded. Pass --reviewer NAME: a labelled dataset with "
            "nobody's name on it cannot be cited.",
            file=sys.stderr,
        )
        return 1

    print(f"human-labelled {len(human)}/{len(dataset.cases)} cases")
    if dataset.disputed:
        print(f"still unresolved: {', '.join(dataset.disputed)}")
    if len(human) < len(dataset.cases):
        print("retrieval numbers stay PRELIMINARY until every case carries a human label")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--store", type=Path, default=DEFAULT_STORE, help="Label store directory.")
    sub = parser.add_subparsers(dest="command", required=True)

    status = sub.add_parser("status", help="What state the labels are in.")
    status.set_defaults(func=cmd_status)

    export = sub.add_parser("export", help="Write one rater's file.")
    export.add_argument("--rater", required=True, help="Rater id. Becomes the file name.")
    export.add_argument("--split", choices=("all", "train", "validation", "test"), default="all")
    export.add_argument("--sample", action="store_true", help="The pre-drawn 20-case agreement sample.")
    export.add_argument("--out", type=Path, default=None, help="Directory to write into.")
    export.set_defaults(func=cmd_export)

    incoming = sub.add_parser("import", help="Validate a returned file and store it.")
    incoming.add_argument("file", type=Path)
    incoming.set_defaults(func=cmd_import)

    agreement = sub.add_parser("agreement", help="Cohen's kappa over the agreement sample.")
    agreement.set_defaults(func=cmd_agreement)

    adjudication = sub.add_parser("adjudicate", help="List disagreements; record resolutions.")
    adjudication.add_argument("--resolve", action="append", default=[], metavar="CASE_ID=id,id")
    adjudication.set_defaults(func=cmd_adjudicate)

    apply_cmd = sub.add_parser("apply", help="Sign the labels off.")
    apply_cmd.add_argument("--reviewer", default=None, help="Who signed off on the labels.")
    apply_cmd.set_defaults(func=cmd_apply)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
