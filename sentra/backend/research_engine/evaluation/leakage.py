"""Leakage checks that actually run, including the ones that must fail.

A check recorded as "passed" without having executed is worse than no check: it
appears in the report as evidence. So each function here returns a `LeakageCheck`
that says what it examined and how many items it looked at, and the negative
check — a deliberately future row — is *performed*, not asserted about.

The evaluation plan asks specifically for "a test with one future row mixed in
must fail". `future_row_is_refused` builds that row, feeds it to the real loader
and reports whether the refusal happened. If the guard is ever removed, this
check goes red in the report rather than staying silently green.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any, Dict, List, Mapping, Optional, Sequence

from ..contracts.errors import Code, ContractViolation
from ..contracts.evaluation import LeakageCheck
from ..contracts.forecast import ForecastBundle
from ..contracts.observation import ObservationBundle
from ..data.normalizer import Normalizer
from ..data.sequences import load_observations
from ..data.splits import SPLIT_NAMES, SplitAssignment
from .ledger import PredictionLedger


def available_at_within_cutoff(
    forecasts: Sequence[ForecastBundle], event_times: Mapping[str, Any]
) -> LeakageCheck:
    """Every event a forecast cites was available at or before its cutoff."""

    checked = 0
    offenders: List[str] = []
    for forecast in forecasts:
        for event_id in forecast.source_event_ids:
            available_at = event_times.get(event_id)
            checked += 1
            if available_at is not None and available_at > forecast.cutoff_at:
                offenders.append(f"{forecast.forecast_id}:{event_id}")

    return LeakageCheck(
        name="available_at_le_cutoff",
        passed=not offenders,
        detail_ja=(
            f"{checked}件の入力eventがすべてcutoff以前だった。"
            if not offenders
            else f"cutoffより後のeventが混入している: {offenders[:5]}"
        ),
        checked_items=checked,
    )


def future_row_is_refused(bundle: ObservationBundle) -> LeakageCheck:
    """Mix in one row from after the cutoff and require the loader to drop it.

    Executed rather than asserted: this is the check that goes red if someone
    removes the availability filter, which is the failure mode nothing else in
    the suite would notice.
    """

    if not bundle.observations:
        return LeakageCheck(
            name="future_row_must_fail",
            passed=False,
            detail_ja="観測が空のため、未来混入テストを実行できなかった。",
            checked_items=0,
        )

    latest = max(row.available_at for row in bundle.observations)
    cutoff = latest
    future_payload = bundle.observations[0].as_dict()
    future_payload["event_id"] = future_payload["event_id"] + "-future-probe"
    future_payload["recorded_at"] = (latest + timedelta(days=7)).isoformat().replace("+00:00", "Z")
    future_payload["available_at"] = (
        (latest + timedelta(days=7, seconds=1)).isoformat().replace("+00:00", "Z")
    )
    future_payload["occurred_at"] = None

    payload = bundle.as_dict()
    payload["observations"] = payload["observations"] + [future_payload]
    poisoned = ObservationBundle.from_dict(payload)

    visible = load_observations(poisoned, cutoff_at=cutoff)
    survived = [
        row.event_id for row in visible.observations if row.event_id.endswith("-future-probe")
    ]
    return LeakageCheck(
        name="future_row_must_fail",
        passed=not survived,
        detail_ja=(
            "未来の1行を混ぜたテストが期待どおり除外された。"
            if not survived
            else "未来の行がcutoff後も入力に残った。"
        ),
        checked_items=1,
    )


def split_groups_are_disjoint(split: SplitAssignment) -> LeakageCheck:
    try:
        split.validate()
    except ContractViolation as violation:
        return LeakageCheck(
            name="split_group_disjoint",
            passed=False,
            detail_ja=violation.message_ja,
            checked_items=len(split.assignment),
        )
    groups = len({split.split_groups.get(key, key) for key in split.assignment})
    return LeakageCheck(
        name="split_group_disjoint",
        passed=True,
        detail_ja=f"{groups}個のsplit_groupがtrain/validation/heldoutで重複していない。",
        checked_items=groups,
    )


def normalizer_was_fitted_on_train_only(
    normalizer: Normalizer, train_event_ids: Sequence[str]
) -> LeakageCheck:
    """The fit hash must be the hash of the train rows and nothing else."""

    from ..contracts.common import content_hash

    expected = content_hash(
        {
            "feature_schema_id": normalizer.feature_schema_id,
            "feature_names": list(normalizer.feature_names),
            "event_ids": sorted(train_event_ids),
        }
    )
    matches = expected == normalizer.fit_input_hash
    return LeakageCheck(
        name="normalizer_fit_on_train_only",
        passed=matches and normalizer.fit_split == "train",
        detail_ja=(
            f"normalizerはtrainの{normalizer.n_rows_fitted}行だけでfitされている。"
            if matches
            else "normalizerのfit入力hashがtrain行と一致しない。heldoutが混ざった可能性がある。"
        ),
        checked_items=normalizer.n_rows_fitted,
    )


def predictions_were_sealed(
    ledger: PredictionLedger, forecasts: Sequence[ForecastBundle]
) -> LeakageCheck:
    drifted = ledger.verify_unchanged(forecasts)
    entries = ledger.entries()
    return LeakageCheck(
        name="sealed_predictions_unchanged",
        passed=not drifted and len(entries) >= len(forecasts),
        detail_ja=(
            f"{len(entries)}件の予測が採点前に台帳へ記録され、payload hashが変わっていない。"
            if not drifted
            else f"採点後に内容が変わった予測がある: {drifted[:5]}"
        ),
        checked_items=len(entries),
    )


def online_evaluation_excludes_smoothing(forecasts: Sequence[ForecastBundle]) -> LeakageCheck:
    offenders = [
        forecast.forecast_id for forecast in forecasts if forecast.inference_mode != "forecast"
    ]
    return LeakageCheck(
        name="no_smoothing_in_online_evaluation",
        passed=not offenders,
        detail_ja=(
            f"{len(forecasts)}件すべてがinference_mode=forecastだった。"
            if not offenders
            else f"smoothing結果がオンライン評価に混ざっている: {offenders[:5]}"
        ),
        checked_items=len(forecasts),
    )
