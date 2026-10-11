"""The synthetic dry run of the whole transfer study, end to end.

Two synthetic cohorts play the two roles:

- the **selection cohort** — what the study will freeze and select models on
  (P13 decides which one; here it is whatever seed the caller passes);
- a **stand-in for the real pilot** — a second synthetic cohort, generated
  with a different seed and different missingness assumptions, so that the
  comparison has something that is not a copy to compare against. It is
  labelled `simulated_real_stand_in` everywhere. **It is not real data, it is
  not a forecast of the real data, and nothing computed on it is a result.**

The dry run does, in order: leakage probes; the synthetic ranking; the seal;
the stand-in ranking under each fit mode; the comparison against the *sealed*
ranking (read back from the seal file, not recomputed); the measurement audit
of both cohorts and their comparison; the missingness sensitivity analysis
(#216) over several seeds; and the report, rendered into the template's
headings.
"""

from __future__ import annotations

import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Mapping, Optional, Sequence

from . import CANDIDATE_STATUS, CANDIDATE_STATUS_JA, TRANSFER_STUDY_VERSION
from .audit import compare_audits, public_view, run_audit
from .consent_gate import consent_dry_run
from .forecasting import evaluate_dataset, leakage_probes
from .generator import GeneratedCohort, SyntheticCohortConfig, generate, manifest_hash, write_cohort
from .plan import DRY_RUN_PLAN, FIT_TARGET_SPLIT, AnalysisPlan
from .preregistration import Preregistration, load_preregistration
from .ranking import compare_rankings, rank_evaluations
from .report import render_report
from .seal import build_seal, verify_seal, write_seal
from .sensitivity import run_sensitivity

STAND_IN_LABEL = "simulated_real_stand_in"
STAND_IN_NOTE_JA = (
    "実パイロットの代わりに置いた2つ目の合成コホート。実データではなく、実データの予想でもない。"
    "比較の経路を最後まで通すためだけに使い、その数値を結果として読まない。"
)


def stand_in_config(seed: int) -> SyntheticCohortConfig:
    """A second synthetic cohort that differs from the selection cohort on purpose.

    Different seed, independent instead of state-dependent missingness, a lower
    submission rate and more skipped items. These are dry-run assumptions; they
    say nothing about how the pilot will differ.
    """

    return SyntheticCohortConfig(
        seed=seed + 100_000,
        missingness="independent",
        submit_rate_mean=0.65,
        item_skip_rate=0.12,
        dataset_label=f"{STAND_IN_LABEL}-seed{seed + 100_000}",
    )


def current_commit() -> Optional[str]:
    """The checked-out commit, if git is available. Read-only."""

    try:
        output = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=str(Path(__file__).resolve().parent),
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    commit = output.stdout.strip()
    return commit or None


def _write(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def run_transfer_dry_run(
    seed: int,
    out_dir: Path,
    *,
    plan: AnalysisPlan = DRY_RUN_PLAN,
    preregistration: Optional[Preregistration] = None,
    sealed_at: Optional[str] = None,
    code_commit: Optional[str] = None,
    sensitivity_seeds: Optional[Sequence[int]] = None,
) -> Dict[str, Any]:
    """Run everything; write every artifact under `out_dir`.

    `sensitivity_seeds` defaults to three consecutive seeds. Three is a
    reproducibility check, not a statement of statistical power, and which
    seeds the study reports is part of P2/P13.
    """

    out = Path(out_dir)
    plan.validate()
    prereg = preregistration if preregistration is not None else load_preregistration()

    selection: GeneratedCohort = generate(SyntheticCohortConfig(seed=seed, missingness="state_dependent"))
    stand_in: GeneratedCohort = generate(stand_in_config(seed))
    write_cohort(selection, out / "selection_cohort")
    write_cohort(stand_in, out / "stand_in_cohort")

    probes = leakage_probes(selection.dataset, plan, truth_bearing=selection)
    gate = consent_dry_run(seed)

    synthetic_ranking = rank_evaluations(evaluate_dataset(selection.dataset, plan, fit_mode=FIT_TARGET_SPLIT), plan)
    seal_record = build_seal(
        synthetic_ranking,
        plan=plan,
        manifest=selection.manifest,
        preregistration=prereg,
        sealed_at=sealed_at or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        code_commit=code_commit if code_commit is not None else current_commit(),
    )
    seal_path = write_seal(seal_record, out / "synthetic_ranking.seal.json")

    # The comparison reads the ranking back from the seal file, so what is
    # compared is what was sealed, not a fresh recomputation.
    sealed = verify_seal(seal_path)
    stand_in_results: Dict[str, Any] = {}
    for fit_mode in plan.fit_modes:
        ranking = rank_evaluations(
            evaluate_dataset(stand_in.dataset, plan, fit_mode=fit_mode, selection=selection.dataset), plan
        )
        stand_in_results[fit_mode] = {
            "ranking": ranking,
            "comparison": compare_rankings(sealed["ranking"], ranking),
        }

    selection_audit = run_audit(selection.dataset, manifest=selection.manifest, seed=plan.bootstrap_seed)
    stand_in_audit = run_audit(stand_in.dataset, manifest=stand_in.manifest, seed=plan.bootstrap_seed)
    audit_comparison = compare_audits(selection_audit, stand_in_audit, seed=plan.bootstrap_seed)

    _write(out / "leakage_checks.json", [check.as_dict() for check in probes])
    _write(out / "consent_dry_run.json", gate)
    _write(out / "stand_in_rankings.json", {mode: result["ranking"] for mode, result in stand_in_results.items()})
    _write(out / "ranking_comparison.json", {mode: result["comparison"] for mode, result in stand_in_results.items()})
    _write(out / "audit_selection.json", selection_audit)
    _write(out / "audit_stand_in.json", stand_in_audit)
    _write(out / "audit_selection_public.json", public_view(selection_audit))
    _write(out / "audit_comparison.json", audit_comparison)

    seeds = list(sensitivity_seeds) if sensitivity_seeds is not None else [seed, seed + 1, seed + 2]
    sensitivity = run_sensitivity(selection, plan, seeds=seeds)
    _write(out / "sensitivity.json", sensitivity)

    summary = {
        "dry_run": "transfer_study",
        "transfer_study_version": TRANSFER_STUDY_VERSION,
        "status": CANDIDATE_STATUS,
        "status_ja": CANDIDATE_STATUS_JA,
        "plan_id": plan.plan_id,
        "plan_status": plan.status,
        "plan_note_ja": plan.note_ja,
        "seed": seed,
        "selection": {"dataset_hash": selection.dataset.content_hash(), "manifest_hash": manifest_hash(selection.manifest)},
        "stand_in": {
            "label": STAND_IN_LABEL,
            "note_ja": STAND_IN_NOTE_JA,
            "dataset_hash": stand_in.dataset.content_hash(),
            "manifest_hash": manifest_hash(stand_in.manifest),
        },
        "seal": {
            "path": str(seal_path),
            "status": seal_record["status"],
            "valid_for_confirmatory": seal_record["valid_for_confirmatory"],
            "ranking_hash": seal_record["ranking_hash"],
            "seal_hash": seal_record["seal_hash"],
        },
        "leakage_checks_passed": all(check.passed for check in probes),
        "consent_dry_run_passed": gate["passed"],
        "real_data_used": False,
        "provider_calls": 0,
        "sensitivity_seeds": seeds,
        "outputs": sorted(
            {str(path.relative_to(out)) for path in out.rglob("*") if path.is_file()} | {"report.md", "summary.json"}
        ),
    }
    _write(out / "summary.json", summary)
    run = {
        "summary": summary,
        "selection": selection,
        "stand_in": stand_in,
        "synthetic_ranking": synthetic_ranking,
        "seal": seal_record,
        "stand_in_results": stand_in_results,
        "leakage_checks": probes,
        "consent_dry_run": gate,
        "audits": {"selection": selection_audit, "stand_in": stand_in_audit, "comparison": audit_comparison},
        "sensitivity": sensitivity,
    }
    report = render_report(run, sensitivity, plan=plan, preregistration=prereg, is_dry_run=True)
    (out / "report.md").write_text(report, encoding="utf-8")
    run["report"] = report
    return run
