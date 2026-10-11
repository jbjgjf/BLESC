"""#216 — the report follows the template, reports everything, and leaks nothing.

Rendered from a synthetic dry run. The template in `docs/` and the renderer in
`report.py` share their headings and their fixed texts (scope, limitations);
these tests are what keeps the two from drifting apart.
"""

from __future__ import annotations

import dataclasses
import re
from pathlib import Path

import pytest

from research_engine.transfer.forecasting import SPLIT_KINDS
from research_engine.transfer.pipeline import run_transfer_dry_run
from research_engine.transfer.plan import DRY_RUN_PLAN, FIT_MODES
from research_engine.transfer.preregistration import REPO_ROOT, REQUIRED_ITEM_IDS
from research_engine.transfer.report import LIMITATIONS_JA, REPORT_HEADINGS, SCOPE_JA

TEMPLATE = REPO_ROOT / "docs" / "transfer_study_report_template.md"
PLAN = dataclasses.replace(DRY_RUN_PLAN, target_items=("mood", "sleep_hours"), bootstrap_rounds=200)
SEEDS = [61, 62]


@pytest.fixture(scope="module")
def run(tmp_path_factory):
    out = tmp_path_factory.mktemp("transfer-report")
    result = run_transfer_dry_run(61, out, plan=PLAN, sealed_at="2030-01-01T00:00:00Z", code_commit="test", sensitivity_seeds=SEEDS)
    return result, out


def _headings(text: str):
    return [line for line in text.splitlines() if re.match(r"^## \d+\. ", line)]


def test_the_template_and_the_renderer_have_the_same_headings(run) -> None:
    result, _ = run
    assert _headings(TEMPLATE.read_text(encoding="utf-8")) == list(REPORT_HEADINGS)
    assert _headings(result["report"]) == list(REPORT_HEADINGS)


def test_the_template_quotes_the_fixed_scope_and_limitations_verbatim() -> None:
    template = TEMPLATE.read_text(encoding="utf-8")
    for text in list(SCOPE_JA) + list(LIMITATIONS_JA):
        assert f"- {text}" in template


def test_the_limitations_issue_216_names_are_all_there() -> None:
    joined = "\n".join(LIMITATIONS_JA)
    for phrase in ("50名", "1校", "28日", "任意回答", "同意による選択", "測定誤差"):
        assert phrase in joined


def test_the_report_states_it_is_a_dry_run_and_draws_no_conclusion(run) -> None:
    result, _ = run
    report = result["report"]
    section0 = report.split(REPORT_HEADINGS[0], 1)[1].split(REPORT_HEADINGS[1], 1)[0]
    assert "dry run" in section0 and "実データは使っていない" in section0
    assert "実データの結果でも予想でもない" in section0
    section4 = report.split(REPORT_HEADINGS[4], 1)[1].split(REPORT_HEADINGS[5], 1)[0]
    assert "実データは採点していない" in section4
    assert "P3" in section4 and "P7" in section4


def test_the_report_lists_every_model_item_split_fit_mode_and_seed(run) -> None:
    result, _ = run
    report = result["report"]
    for model in PLAN.model_ids:
        assert model in report
    for item in PLAN.target_items:
        assert item in report
    for kind in SPLIT_KINDS:
        assert f"**{kind} 分割**" in report
    for mode in FIT_MODES:
        assert f"当てはめ方 `{mode}`" in report
    section6 = report.split(REPORT_HEADINGS[6], 1)[1].split(REPORT_HEADINGS[7], 1)[0]
    for seed in SEEDS:
        assert f"| {seed} | none |" in section6


def test_the_report_lists_every_open_decision(run) -> None:
    result, _ = run
    section11 = result["report"].split(REPORT_HEADINGS[11], 1)[1]
    for item_id in REQUIRED_ITEM_IDS:
        assert f"- {item_id}（" in section11
    for gate in ("G1", "G7", "G8"):
        assert gate in section11


def test_the_report_has_no_text_codes_or_participant_values(run) -> None:
    result, out = run
    report = (out / "report.md").read_text(encoding="utf-8")
    assert report == result["report"]
    assert "SYN-" not in report
    texts = {record.text for record in result["selection"].dataset.records if record.text}
    texts |= {record.text for record in result["stand_in"].dataset.records if record.text}
    assert texts
    assert not any(text in report for text in texts)
    assert "participant_level" not in report
