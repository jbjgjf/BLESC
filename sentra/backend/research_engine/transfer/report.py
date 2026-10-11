"""#216 — the report, rendered from the run's outputs into the template's headings.

The headings are those of `docs/transfer_study_report_template.md`, and the
fixed texts — the scope of the conclusion and the limitations — are the
constants below, which the template quotes word for word (a test checks
both). The rendered report is the same document a human will finish once
real data exists; today it is filled from the synthetic dry run and says so in
its first section.

What it never contains: diary text, research codes, participant-level values,
single-person extremes. Every number is a participant-level aggregate or a
count. All models, all items, all seeds and both split kinds are listed,
including the unfavourable rows — a table that shows only where the synthetic
winner held would be the selective report #216 rules out.
"""

from __future__ import annotations

from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence

from .forecasting import SPLIT_KINDS
from .plan import AnalysisPlan
from .preregistration import Preregistration, freeze_status

REPORT_HEADINGS: Sequence[str] = (
    "## 0. この報告の状態",
    "## 1. 研究の問いと、結論の範囲",
    "## 2. 事前登録と封印",
    "## 3. データ",
    "## 4. 主要結果",
    "## 5. 合成上の順位と実データ上の順位",
    "## 6. 欠測感度分析",
    "## 7. 測定・入力過程（副次）",
    "## 8. 探索的結果",
    "## 9. 限界",
    "## 10. 再現の方法",
    "## 11. 未決定の事項",
)

SCOPE_JA: Sequence[str] = (
    "結論は「このコホート（50名・1校）、この期間（28日・区分なし）、この3つのモデルの間での、合成評価の移転」に限る。",
    "臨床的なリスク、因果、他校・他の期間への一般化は主張しない（#210）。",
    "予測精度そのものを新しい成果と呼ばない。新規性は合成から実データへの**モデル選択の移転**に置く。",
)

LIMITATIONS_JA: Sequence[str] = (
    "50名・1校・28日（1区間）の研究である。他の学校・他の期間・臨床の場面へ一般化しない。",
    "自己評定はすべて任意回答で、答えなかった日は欠測になる。未観測日の真の状態は識別できない。",
    "参加は同意による選択であり、参加者は対象の生徒全体を代表しない。学習利用の別opt-inで、当てはめに入る参加者はさらに選ばれる。",
    "自己評定には測定誤差がある（0〜10の尺度の解釈の揺れ、睡眠時間の自己申告）。MAE はこの誤差を含む。",
    "合成データは動作確認のための仮定で作った。実測の母集団事前分布ではない（#62・#99）。",
    "比較したモデルは持続値・訓練平均・線形ARの3つで、順位の一致はこの3つの間の一致である。",
    "heldout の参加者は少数で、参加者単位の区間は広い。同点域に入る比較が多くなりうる。",
    "実／合成の判別器は使っていない。使う場合も参加者単位で分割し、判別精度を合成データの有用性の代用にしない。",
    "提出率・文字数の日数に伴う変化は副次の記述であり、介入効果と呼ばない（この研究は介入を加えない）。",
    "入力時間は data dictionary で未実装、書き止まり・書き直しは未採用で、この報告に含めない。",
)

CONSENT_DECISIONS_JA: Sequence[str] = (
    "G1 訓練平均・線形ARの係数推定を「モデルの学習」に含めるか",
    "G2 撤回して「残す」を選んだ参加者の撤回前データを使うか",
    "G3 実データの処理を承認する役割",
    "G4 承認記録の保存先と渡し方",
    "G5 v0 契約の実データ拒否を外す条件",
    "G6 文字数を数えるための本文の読み取りが原文保持の同意の範囲に入るか",
    "G7 公開報告の最小集計単位",
    "G8 保持期限・研究 export の権限の確認",
)


def _f(value: Optional[float], digits: int = 3) -> str:
    return "—" if value is None else f"{value:.{digits}f}"


def _interval(interval: Optional[Sequence[float]]) -> str:
    return "—" if not interval else f"[{interval[0]:.3f}, {interval[1]:.3f}]"


def _table(header: Sequence[str], rows: Iterable[Sequence[Any]]) -> List[str]:
    lines = ["| " + " | ".join(header) + " |", "|" + "---|" * len(header)]
    for row in rows:
        lines.append("| " + " | ".join(str(cell) for cell in row) + " |")
    return lines


def _order(order: Optional[Sequence[str]]) -> str:
    return " < ".join(order) if order else "—"


def render_report(
    run: Mapping[str, Any],
    sensitivity: Mapping[str, Any],
    *,
    plan: AnalysisPlan,
    preregistration: Preregistration,
    is_dry_run: bool = True,
) -> str:
    summary = run["summary"]
    status = freeze_status(preregistration)
    lines: List[str] = ["# 合成→実データのモデル選択移転：報告", ""]

    # 0 -------------------------------------------------------------------
    lines += [REPORT_HEADINGS[0], ""]
    if is_dry_run:
        lines += [
            "**合成データだけの dry run。** 実データは使っていない（`real_data_used: false`、外部AIの呼び出し0回）。",
            f"解析計画は `{plan.plan_id}`（状態 `{plan.status}`）。{plan.note_ja}",
            "「実データ上の順位」の欄にあるのは、実パイロットの代わりに置いた2つ目の合成コホート（`simulated_real_stand_in`）の数値で、**実データの結果でも予想でもない**。",
            f"生成物の状態：{summary['status_ja']}",
            "",
        ]

    # 1 -------------------------------------------------------------------
    lines += [REPORT_HEADINGS[1], "", "研究の問い：実参加者を見ずに凍結した合成データで選んだ予測モデルは、実パイロットでも同じ順位になるか。", ""]
    lines += [f"- {text}" for text in SCOPE_JA] + [""]

    # 2 -------------------------------------------------------------------
    seal = run["seal"]
    lines += [REPORT_HEADINGS[2], ""]
    lines += _table(
        ("項目", "値"),
        [
            ("事前登録の状態", "凍結" if status.frozen else f"未凍結（未解決 {len(status.blockers)} 件）"),
            ("事前登録の文書hash", f"`{status.content_hash}`"),
            ("解析計画", f"`{plan.plan_id}`（`{plan.status}`）"),
            ("解析計画のhash", f"`{plan.content_hash()}`"),
            ("封印の状態", f"`{seal['status']}`"),
            ("封印した順位のhash（ranking_hash）", f"`{seal['ranking_hash']}`"),
            ("封印の記録hash（seal_hash）", f"`{seal['seal_hash']}`"),
            ("封印日時", seal["sealed_at"]),
            ("コードのcommit", seal["code_commit"] or "—"),
        ],
    )
    lines += ["", "比較は封印ファイルから読み戻した順位に対して行った（その場で計算し直していない）。", ""]

    # 3 -------------------------------------------------------------------
    selection = run["selection"]
    manifest = selection.manifest
    lines += [REPORT_HEADINGS[3], ""]
    lines += _table(
        ("", "選択用の合成コホート", "実データの代わり（stand-in）"),
        [
            ("種類", f"`{manifest['generator']['kind']}`（`{manifest['generator']['version']}`）", f"`{run['stand_in'].manifest['generator']['kind']}`"),
            ("欠測シナリオ", f"`{manifest['missingness_scenario']}`", f"`{run['stand_in'].manifest['missingness_scenario']}`"),
            ("seed", manifest["seed"], run["stand_in"].manifest["seed"]),
            ("参加者 × 日", f"{manifest['shape']['n_participants']} × {manifest['shape']['study_days']}", f"{run['stand_in'].manifest['shape']['n_participants']} × {run['stand_in'].manifest['shape']['study_days']}"),
            ("記録数", manifest["shape"]["n_records"], run["stand_in"].manifest["shape"]["n_records"]),
            ("dataset hash", f"`{manifest['hashes']['dataset_hash']}`", f"`{run['stand_in'].manifest['hashes']['dataset_hash']}`"),
            ("状態", f"`{manifest['status']}`", f"`{run['stand_in'].manifest['status']}`"),
        ],
    )
    lines += ["", f"- {manifest['not_a_population_prior_ja']}", f"- {manifest['inputs']['note_ja']}", ""]

    # 4 -------------------------------------------------------------------
    lines += [REPORT_HEADINGS[4], ""]
    lines += [
        "**実データは採点していない。** 主結果の定義（順位一致／逆転の判定・同点域・参加者単位MAE差と区間）は事前登録 P3、失敗条件は P7 で決める（どちらも未決定）。",
        "そのため、この節に結論は書かない。次の節にすべての比較の分類を並べる。",
        "",
    ]

    # 5 -------------------------------------------------------------------
    lines += [REPORT_HEADINGS[5], ""]
    for mode, payload in run["stand_in_results"].items():
        comparison = payload["comparison"]
        lines += [f"### 当てはめ方 `{mode}`", ""]
        for kind in SPLIT_KINDS:
            rows = []
            for item, row in comparison["comparisons"][kind].items():
                if row["status"] != "ok":
                    rows.append((item, "—", "—", "比較不能", "", "", "", "", ""))
                    continue
                counts = row["pair_counts"]
                rows.append(
                    (
                        item,
                        _order(row["synthetic_order"]),
                        _order(row["real_order"]),
                        counts["agree"],
                        counts["reversal"],
                        counts["tie_both"] + counts["tie_synthetic_only"] + counts["tie_real_only"],
                        "はい" if row["winner_agrees"] else ("同点域" if row["synthetic_winner_in_real_tie_zone"] else "いいえ"),
                        ", ".join(row["synthetic_winner_beaten_on_real_by"]) or "—",
                        f"{row['n_participants_scored']['synthetic']} / {row['n_participants_scored']['real']}",
                    )
                )
            lines += [f"**{kind} 分割**", ""]
            lines += _table(
                ("目標", "合成の順位（MAE小→大）", "stand-in の順位", "一致", "逆転", "同点域", "勝者一致", "合成の勝者に勝った単純モデル", "採点した参加者（合成/stand-in）"),
                rows,
            )
            lines += [""]
            mae_rows = []
            for item, row in comparison["comparisons"][kind].items():
                if row["status"] != "ok":
                    continue
                for model, values in row["mae"].items():
                    mae_rows.append(
                        (
                            item,
                            model,
                            f"{_f(values['synthetic']['mae'])} {_interval(values['synthetic']['interval'])}",
                            f"{_f(values['real']['mae'])} {_interval(values['real']['interval'])}",
                        )
                    )
            lines += _table(("目標", "モデル", "合成 MAE [区間]", "stand-in MAE [区間]"), mae_rows)
            lines += [""]
            reduction_rows = []
            for item, row in comparison["comparisons"][kind].items():
                left = row["reduction"]["synthetic"]
                right = row["reduction"]["real"]
                reduction_rows.append(
                    (
                        item,
                        f"{left.get('scored', 0)} / {left.get('candidate_points', 0)}",
                        f"{right.get('scored', 0)} / {right.get('candidate_points', 0)}",
                        f"{left.get('target_missing', 0)} / {right.get('target_missing', 0)}",
                        f"{left.get('declined_by_a_model', 0)} / {right.get('declined_by_a_model', 0)}",
                    )
                )
            lines += _table(("目標", "採点点／候補（合成）", "採点点／候補（stand-in）", "翌日欠測（合成/stand-in）", "起点欠測などで予測なし（合成/stand-in）"), reduction_rows)
            lines += [""]

    # 6 -------------------------------------------------------------------
    lines += [REPORT_HEADINGS[6], "", sensitivity["not_identifiable_ja"], ""]
    scenarios = sensitivity["missingness_scenarios"]
    lines += [f"**欠測シナリオ（合成のみ、seed: {', '.join(str(s) for s in scenarios['seeds'])}）。** {scenarios['note_ja']}", ""]
    scenario_rows = []
    for seed, payload in scenarios["results"].items():
        for label, values in payload["scenarios"].items():
            shift = values["shift_from_reference"]
            for kind in SPLIT_KINDS:
                if shift is None:
                    scenario_rows.append((seed, label, kind, "基準", "", "", ""))
                    continue
                rows = [row for row in shift[kind].values() if row["status"] == "ok"]
                scenario_rows.append(
                    (
                        seed,
                        label,
                        kind,
                        sum(1 for row in rows if row["winner_changed"] and not row["winner_changed_within_tie_zone"]),
                        sum(1 for row in rows if row["winner_changed_within_tie_zone"]),
                        sum(row["pair_counts"]["reversal"] for row in rows),
                        sum(values["summary"][kind][item]["n_points_scored"] for item in values["summary"][kind]),
                    )
                )
    lines += _table(("seed", "シナリオ", "分割", "勝者が変わった目標（同点域の外）", "勝者が同点域の中で入れ替わった目標", "逆転した組", "採点点の合計"), scenario_rows)
    lines += [""]
    truth = sensitivity["observed_vs_truth"]
    lines += [f"**観測での採点と真値での採点（合成のみ）。** {truth['note_ja']}", ""]
    truth_rows = []
    for kind in SPLIT_KINDS:
        for item, observed in truth["observed_targets"][kind].items():
            against = truth["truth_targets"][kind][item]
            truth_rows.append((kind, item, _order(observed["order"]), _order(against["order"]), f"{observed['n_points_scored']} / {against['n_points_scored']}"))
    lines += _table(("分割", "目標", "観測で採点した順位", "真値で採点した順位", "採点点（観測/真値）"), truth_rows)
    lines += [""]

    # 7 -------------------------------------------------------------------
    lines += [REPORT_HEADINGS[7], "", "参加者単位の値の中央値と、平均の差（stand-in − 合成）と参加者 bootstrap の区間。記録を独立な標本として扱っていない。", ""]
    audit_rows = []
    for row in run["audits"]["comparison"]["rows"]:
        if row["status"] != "ok":
            audit_rows.append((row["metric_key"], "—", "—", "比較不能", "—"))
            continue
        audit_rows.append(
            (
                row["metric_key"],
                _f(row["synthetic_median"]),
                _f(row["real_median"]),
                f"{_f(row['mean_difference_real_minus_synthetic'])} {_interval(row['difference_interval'])}",
                f"{row['n_participants']['synthetic']} / {row['n_participants']['real']}",
            )
        )
    lines += _table(("指標", "合成の中央値", "stand-in の中央値", "平均の差 [区間]", "参加者数（合成/stand-in）"), audit_rows)
    lines += ["", f"分類：`{run['audits']['comparison']['classification']}`。{run['audits']['comparison']['role_ja']}", ""]

    # 8 -------------------------------------------------------------------
    lines += [REPORT_HEADINGS[8], "", "主要結果と混ぜない。どれを副次・探索とするかは P8（未決定）。", ""]
    for key, title, shift_key in (
        ("analysis_rules", "解析規則（P5・P6）を動かした場合", "shift_from_plan"),
        ("delta_adjustment", "欠測日の値を仮定して採点し直した場合（δ調整）", "shift_from_observed_only"),
    ):
        section = sensitivity[key]
        lines += [f"**{title}。** {section['note_ja']}", ""]
        rows = []
        for variant, payload in section["variants"].items():
            for kind in SPLIT_KINDS:
                shifted = [row for row in payload[shift_key][kind].values() if row["status"] == "ok"]
                rows.append(
                    (
                        variant,
                        kind,
                        sum(1 for row in shifted if row["winner_changed"] and not row["winner_changed_within_tie_zone"]),
                        sum(1 for row in shifted if row["winner_changed_within_tie_zone"]),
                        sum(row["pair_counts"]["reversal"] for row in shifted),
                    )
                )
        lines += _table(("変えたもの", "分割", "勝者が変わった目標（同点域の外）", "同点域の中で入れ替わった目標", "逆転した組"), rows)
        lines += [""]
    trend_rows = []
    for row in run["audits"]["comparison"]["rows"]:
        if row["metric_key"] in ("submission_trend_slope", "char_count_trend_slope") and row["status"] == "ok":
            trend_rows.append((row["metric_key"], _f(row["synthetic_median"], 4), _f(row["real_median"], 4)))
    lines += ["**日数に伴う変化（記述）。** 変化を介入効果と呼ばない。", ""]
    lines += _table(("指標", "合成の中央値（1日あたり）", "stand-in の中央値（1日あたり）"), trend_rows)
    lines += [""]

    # 9 -------------------------------------------------------------------
    lines += [REPORT_HEADINGS[9], ""] + [f"- {text}" for text in LIMITATIONS_JA] + [""]

    # 10 ------------------------------------------------------------------
    lines += [REPORT_HEADINGS[10], ""]
    lines += [
        "```bash",
        "cd sentra/backend",
        f"python -m research_engine.transfer.cli dry-run --seed {summary['seed']} --out <出力先>",
        "```",
        "",
        f"- 選択用コホートの dataset hash：`{summary['selection']['dataset_hash']}`",
        f"- stand-in の dataset hash：`{summary['stand_in']['dataset_hash']}`",
        f"- 欠測感度の seed：{', '.join(str(s) for s in scenarios['seeds'])}",
        "- 鍵・ネットワーク・実データを使わない。同じ seed・同じコードで同じ hash になる（封印日時を除く）。",
        "",
    ]

    # 11 ------------------------------------------------------------------
    lines += [REPORT_HEADINGS[11], "", "事前登録（`docs/transfer_study_preregistration.md`）："]
    lines += [f"- {item.item_id}（{item.status}）：{item.subject}" for item in preregistration.items]
    lines += ["", "同意・撤回の扱い（`docs/transfer_study_consent_matrix.md`）："]
    lines += [f"- {text}" for text in CONSENT_DECISIONS_JA]
    lines += ["", "凍結と承認は人が行う。この報告はどちらも行っていない。", ""]
    return "\n".join(lines)
