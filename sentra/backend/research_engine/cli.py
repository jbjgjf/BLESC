"""The command line: one command that runs everything, and one that re-reads it.

    python -m research_engine.cli smoke --config research_engine/configs/smoke.json \
        --out /tmp/blesc-research-smoke
    python -m research_engine.cli evaluate --run /tmp/blesc-research-smoke --split heldout

`smoke` does the whole path: generate the synthetic scenarios, split, fit the
encoder, save and reload the checkpoint, forecast, explain, score, and write the
report. No network, no API key, no GPU. That is the acceptance condition, so it
is what the default configuration does.

`evaluate` re-reads a finished run directory and prints its report. It exists so
that "look at the numbers" and "produce the numbers" are separate actions: a
reviewer reading a run does not re-run it, and cannot accidentally overwrite it.

The exit code is the result. A run whose leakage checks failed exits non-zero,
so CI cannot go green on a report that says it leaked.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

from .contracts.evaluation import EvaluationReport
from .pipeline import RunConfig, run_pipeline


def _load_config(path: Optional[str]) -> RunConfig:
    if not path:
        return RunConfig()
    return RunConfig.from_dict(json.loads(Path(path).read_text(encoding="utf-8")))


def _print_report(report: EvaluationReport, verbose: bool = True) -> None:
    print(f"run_id: {report.run_id}")
    print(f"status: {report.status}")
    print(f"seeds: {list(report.seed_list)}")
    print(f"再現コマンド: {report.reproducibility_command}")
    print("")
    print("== 全体 ==")
    for metric in report.metrics:
        value = "null" if metric.value is None else f"{metric.value:.4f}"
        interval = (
            f" [{metric.interval[0]:.4f}, {metric.interval[1]:.4f}]" if metric.interval else ""
        )
        print(f"  {metric.name:<24} {metric.model_id:<18} {value}{interval}  ({metric.status})")

    print("")
    print("== シナリオ別 ==")
    for scenario, metrics in report.metrics_by_scenario.items():
        print(f"  [{scenario}]")
        for metric in metrics:
            value = "null" if metric.value is None else f"{metric.value:.4f}"
            print(f"    {metric.name:<22} {metric.model_id:<18} {value} ({metric.status})")

    if report.unsupported_metrics and verbose:
        print("")
        print("== 算出しなかったmetric ==")
        for metric in report.unsupported_metrics:
            print(f"  {metric.name:<22} {metric.model_id:<18} {metric.reason_ja}")

    print("")
    print("== 漏洩・健全性の検査 ==")
    for check in report.leakage_checks:
        mark = "OK  " if check.passed else "NG  "
        print(f"  {mark}{check.name}: {check.detail_ja}")

    usage = report.measured_usage
    print("")
    print("== 実測 ==")
    print(
        f"  provider_calls={usage.provider_calls} input_tokens={usage.input_tokens} "
        f"elapsed={usage.elapsed_seconds:.1f}s env={usage.compute_environment}"
    )
    print("")
    print("== 制約 ==")
    for limitation in report.limitations:
        print(f"  - {limitation}")


def command_smoke(args: argparse.Namespace) -> int:
    config = _load_config(args.config)
    result = run_pipeline(config, Path(args.out))
    _print_report(result.report)
    print("")
    print(f"成果物: {result.run_dir}")
    return 0 if result.report.status == "ok" else 1


def command_evaluate(args: argparse.Namespace) -> int:
    run_dir = Path(args.run)
    report_path = run_dir / "report.json"
    if not report_path.exists():
        print(f"reportがありません: {report_path}", file=sys.stderr)
        return 2

    report = EvaluationReport.from_dict(json.loads(report_path.read_text(encoding="utf-8")))
    if args.split and args.split != "heldout":
        # v0 scores heldout only. Saying so beats printing the heldout numbers
        # under another split's name.
        print(
            f"v0の採点対象はheldoutのみです（要求: {args.split}）。"
            "他のsplitの成績は再現コマンドで別runとして作成してください。",
            file=sys.stderr,
        )
        return 2

    _print_report(report)
    return 0 if report.status == "ok" else 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="research_engine.cli", description="BLESC研究エンジン v0")
    subparsers = parser.add_subparsers(dest="command", required=True)

    smoke = subparsers.add_parser("smoke", help="合成生成から評価JSONまでを1コマンドで実行する")
    smoke.add_argument("--config", default="research_engine/configs/smoke.json")
    smoke.add_argument("--out", default="/tmp/blesc-research-smoke")
    smoke.set_defaults(func=command_smoke)

    evaluate = subparsers.add_parser("evaluate", help="完了したrunのreportを読む")
    evaluate.add_argument("--run", required=True)
    evaluate.add_argument("--split", default="heldout")
    evaluate.set_defaults(func=command_evaluate)

    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":  # pragma: no cover - entry point
    raise SystemExit(main())
