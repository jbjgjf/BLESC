"""The analysis plan: every research choice the analyses need, in one object, labelled with its status.

The ranking and sensitivity code cannot run without answers to questions the
pre-registration still leaves open — which item to predict (P1), which models
(P2), what counts as a tie (P3), how to split time (P4), who is included (P5),
what to do with missing days (P6), how to split participants (P10), whether to
fit on real data (P14). Hiding those answers as defaults scattered through the
code would decide them without anyone noticing. So they all live here, each
next to the pre-registration item it belongs to, and a plan always says what
it is:

- `dry_run_placeholder` — the only plan in the code. Its values exist so the
  analysis can be exercised on synthetic data. **They are not proposals for
  P1–P14**, they were not chosen by looking at any result, and every output
  produced under this plan carries the label. Where an open item has a
  natural "do not choose" setting, the placeholder takes it: all five items
  are targets rather than one, and nobody is excluded by an inclusion minimum.
- `frozen_preregistration` — a plan built from a frozen pre-registration.
  This module does not build one: turning the human-written decisions into
  values is itself work to be reviewed once those decisions exist.
  `require_confirmatory()` is what the real-data path calls, and it refuses
  any other status.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Dict, Mapping, Optional, Tuple

from ..contracts.common import content_hash
from ..contracts.errors import Code, ContractViolation
from ..data.splits import DEFAULT_FRACTIONS
from .codes import TransferCode
from .schema import ITEM_IDS

PLAN_STATUS_PLACEHOLDER = "dry_run_placeholder"
PLAN_STATUS_FROZEN = "frozen_preregistration"
PLAN_STATUSES = (PLAN_STATUS_PLACEHOLDER, PLAN_STATUS_FROZEN)

MODEL_IDS: Tuple[str, ...] = ("persistence", "train_mean", "linear_ar")

ORIGIN_REQUIRE_OBSERVED = "require_observed_origin"
ORIGIN_LAST_OBSERVED = "last_observed"
ORIGIN_RULES = (ORIGIN_REQUIRE_OBSERVED, ORIGIN_LAST_OBSERVED)

TIE_INTERVAL = "interval_contains_zero"
TIE_MARGIN = "margin"
TIE_MARGIN_OR_INTERVAL = "margin_or_interval"
TIE_RULES = (TIE_INTERVAL, TIE_MARGIN, TIE_MARGIN_OR_INTERVAL)

#: How models reach the real data (#215, P14). `target_split` fits on the
#: target dataset's own train participants — on real data that is training on
#: real data and needs `model_training_use`. `synthetic_frozen` fits on the
#: synthetic selection cohort only and applies the frozen models to the target.
FIT_TARGET_SPLIT = "target_split"
FIT_SYNTHETIC_FROZEN = "synthetic_frozen"
FIT_MODES = (FIT_TARGET_SPLIT, FIT_SYNTHETIC_FROZEN)

#: Which pre-registration item owns each field. Printed with every plan, so a
#: reader of an output knows which open decision each number stands in for.
FIELD_ITEMS: Mapping[str, str] = {
    "target_items": "P1",
    "horizon_days": "P1",
    "model_ids": "P2",
    "tie_rule": "P3",
    "tie_margin": "P3",
    "bootstrap_rounds": "P3",
    "interval_level": "P3",
    "bootstrap_seed": "P2",
    "temporal_fit_last_day": "P4",
    "inclusion_min_submitted_days": "P5",
    "origin_rule": "P6",
    "participant_split_fractions": "P10",
    "participant_split_seed": "P10",
    "fit_modes": "P14",
}


@dataclass(frozen=True)
class AnalysisPlan:
    plan_id: str
    status: str
    target_items: Tuple[str, ...]
    horizon_days: int
    model_ids: Tuple[str, ...]
    tie_rule: str
    tie_margin: float
    bootstrap_rounds: int
    interval_level: float
    bootstrap_seed: int
    temporal_fit_last_day: int
    inclusion_min_submitted_days: int
    origin_rule: str
    participant_split_fractions: Tuple[float, float, float]
    participant_split_seed: int
    fit_modes: Tuple[str, ...]
    preregistration_hash: Optional[str] = None
    note_ja: str = ""

    def validate(self) -> None:
        if self.status not in PLAN_STATUSES:
            raise ContractViolation(Code.UNKNOWN_ENUM_VALUE, f"未知の計画の状態です: {self.status}", "plan.status")
        unknown_items = [item for item in self.target_items if item not in ITEM_IDS]
        if unknown_items or not self.target_items:
            raise ContractViolation(Code.UNKNOWN_ENUM_VALUE, f"予測目標が5項目の外です: {unknown_items}", "plan.target_items")
        if self.horizon_days != 1:
            raise ContractViolation(
                Code.UNKNOWN_ENUM_VALUE,
                "この実装は翌日（1日先）の予測だけを扱います。何日先までにするかは P1 で決めます。",
                "plan.horizon_days",
            )
        unknown_models = [model for model in self.model_ids if model not in MODEL_IDS]
        if unknown_models or len(self.model_ids) < 2:
            raise ContractViolation(
                Code.UNKNOWN_ENUM_VALUE,
                f"モデル集合が不正です: {unknown_models or self.model_ids}。順位には2つ以上が要ります。",
                "plan.model_ids",
            )
        for name, allowed in (("tie_rule", TIE_RULES), ("origin_rule", ORIGIN_RULES)):
            if getattr(self, name) not in allowed:
                raise ContractViolation(Code.UNKNOWN_ENUM_VALUE, f"{name} が不正です。", f"plan.{name}")
        if not self.fit_modes or any(mode not in FIT_MODES for mode in self.fit_modes):
            raise ContractViolation(Code.UNKNOWN_ENUM_VALUE, "fit_modes が不正です。", "plan.fit_modes")
        if not 0.0 < self.interval_level < 1.0 or self.bootstrap_rounds < 1:
            raise ContractViolation(Code.WRONG_TYPE, "区間の設定が不正です。", "plan.interval_level")

    def require_confirmatory(self) -> None:
        """The real-data path's check: a placeholder plan never scores real data."""

        if self.status != PLAN_STATUS_FROZEN or not self.preregistration_hash:
            raise ContractViolation(
                TransferCode.PLAN_NOT_CONFIRMATORY,
                "この解析計画は凍結した事前登録から作られていません（仮置きの dry run 計画）。実データの採点には使いません。",
                "plan.status",
                {"status": self.status},
            )

    def as_dict(self) -> Dict[str, Any]:
        payload = asdict(self)
        payload["target_items"] = list(self.target_items)
        payload["model_ids"] = list(self.model_ids)
        payload["participant_split_fractions"] = list(self.participant_split_fractions)
        payload["fit_modes"] = list(self.fit_modes)
        payload["field_items"] = dict(FIELD_ITEMS)
        return payload

    def content_hash(self) -> str:
        return content_hash(self.as_dict())


#: The dry-run placeholder. See the module docstring: not a proposal.
DRY_RUN_PLAN = AnalysisPlan(
    plan_id="transfer-dry-run-placeholder-v0",
    status=PLAN_STATUS_PLACEHOLDER,
    # P1 open: every item is a target, so no item is singled out.
    target_items=ITEM_IDS,
    horizon_days=1,
    # The three comparators #215 and protocol §7.2 already require; P2 adds
    # any history/text model on top of these.
    model_ids=MODEL_IDS,
    tie_rule=TIE_INTERVAL,
    tie_margin=0.0,
    bootstrap_rounds=1000,
    interval_level=0.90,
    bootstrap_seed=0,
    # P4 open: half the period, chosen only because it is the midpoint.
    temporal_fit_last_day=14,
    # P5 open: protocol §5.1 says not to exclude anyone on this basis until
    # the pre-registration settles it.
    inclusion_min_submitted_days=0,
    origin_rule=ORIGIN_REQUIRE_OBSERVED,
    # P10 open: the v0 engine's existing split shape, reused, not re-decided.
    participant_split_fractions=DEFAULT_FRACTIONS,
    participant_split_seed=0,
    fit_modes=FIT_MODES,
    preregistration_hash=None,
    note_ja=(
        "dry run 用の仮置き。P1〜P14 の提案ではなく、結果を見て選んだ値でもない。"
        "この計画で出した数値は、事前登録の結果として読まない。"
    ),
)
