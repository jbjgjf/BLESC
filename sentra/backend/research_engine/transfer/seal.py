"""#215 — sealing the synthetic ranking before any real data is scored.

"The synthetic ranking was fixed before we looked at the real data" has to be
checkable, not promised. The seal is a JSON file holding the full synthetic
ranking result, the plan, the hashes of the dataset, manifest and
pre-registration it came from, and the commit of the code. Two hashes:

- `ranking_hash` — of the ranking result alone. Deterministic: rerunning the
  same code on the same cohort and plan gives the same value, which is how a
  reviewer re-derives the seal without trusting the file.
- `seal_hash` — of the whole record, including when it was sealed.

**Write once.** `write_seal` refuses to overwrite an existing seal. A second
synthetic run after the seal is a different result, and replacing the file
would erase the evidence of the first — exactly the "re-tune until it matches"
path the seal exists to close.

**Candidate or confirmatory.** A seal is valid for the confirmatory real-data
comparison only if the pre-registration was frozen when it was made and the
plan was built from that frozen pre-registration. Anything else — every seal
this code can produce today — is `sealed_candidate_not_confirmatory`, and the
real-data path refuses it (`seal_not_confirmatory`).

As with the pre-registration, the hash proves sameness of content, not who
wrote the file or when; where the file is kept and who can write it is what
makes the seal mean something, and the record says so.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, Mapping, Optional

from ..contracts.common import content_hash
from ..contracts.errors import ContractViolation
from .codes import TransferCode
from .plan import PLAN_STATUS_FROZEN, AnalysisPlan
from .preregistration import Preregistration, freeze_status

SEAL_VERSION = "transfer-seal-v0"
SEAL_CONFIRMATORY = "sealed_confirmatory"
SEAL_CANDIDATE = "sealed_candidate_not_confirmatory"


def build_seal(
    ranking: Mapping[str, Any],
    *,
    plan: AnalysisPlan,
    manifest: Mapping[str, Any],
    preregistration: Preregistration,
    sealed_at: str,
    code_commit: Optional[str],
) -> Dict[str, Any]:
    status = freeze_status(preregistration)
    confirmatory = (
        status.frozen
        and plan.status == PLAN_STATUS_FROZEN
        and plan.preregistration_hash == status.content_hash
        and ranking.get("source_kind") == "synthetic"
    )
    record = {
        "seal_version": SEAL_VERSION,
        "sealed_object": "synthetic_ranking",
        "status": SEAL_CONFIRMATORY if confirmatory else SEAL_CANDIDATE,
        "valid_for_confirmatory": confirmatory,
        "status_reasons_ja": [] if confirmatory else _candidate_reasons(status.frozen, plan, ranking),
        "sealed_at": sealed_at,
        "code_commit": code_commit,
        "plan": plan.as_dict(),
        "plan_hash": plan.content_hash(),
        "dataset_hash": ranking.get("dataset_hash"),
        "manifest_hash": content_hash(dict(manifest)),
        "preregistration_hash": status.content_hash,
        "preregistration_frozen": status.frozen,
        "ranking": dict(ranking),
        "ranking_hash": content_hash(dict(ranking)),
        "limitations_ja": (
            "hash は内容が同じことを確かめるだけで、改ざん防止ではない。封印の意味は、"
            "このファイルの置き場所と書き込み権限、git の履歴で支える。"
        ),
    }
    record["seal_hash"] = content_hash({key: value for key, value in record.items() if key != "seal_hash"})
    return record


def _candidate_reasons(frozen: bool, plan: AnalysisPlan, ranking: Mapping[str, Any]) -> list:
    reasons = []
    if not frozen:
        reasons.append("事前登録が凍結されていない。")
    if plan.status != PLAN_STATUS_FROZEN:
        reasons.append(f"解析計画が凍結した事前登録から作られていない（{plan.status}）。")
    if ranking.get("source_kind") != "synthetic":
        reasons.append("封印する順位が合成データのものではない。")
    return reasons


def write_seal(record: Mapping[str, Any], path: Path) -> Path:
    target = Path(path)
    if target.exists():
        raise ContractViolation(
            TransferCode.SEAL_EXISTS,
            "封印ファイルが既にあります。上書きすると先の封印の証跡が消えます。別の出力先を指定してください。",
            str(target),
        )
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(record, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    return target


def verify_seal(path_or_record: Any) -> Dict[str, Any]:
    """Recompute both hashes; refuse a seal whose content no longer matches."""

    record = (
        json.loads(Path(path_or_record).read_text(encoding="utf-8"))
        if not isinstance(path_or_record, Mapping)
        else dict(path_or_record)
    )
    ranking_hash = content_hash(record["ranking"])
    seal_hash = content_hash({key: value for key, value in record.items() if key != "seal_hash"})
    if ranking_hash != record.get("ranking_hash") or seal_hash != record.get("seal_hash"):
        raise ContractViolation(
            TransferCode.SEAL_MISMATCH,
            "封印の内容が記録された hash と一致しません。封印の後に順位か記録が変わっています。",
            "seal",
            {"ranking_hash_matches": ranking_hash == record.get("ranking_hash"), "seal_hash_matches": seal_hash == record.get("seal_hash")},
        )
    return record


def require_confirmatory_seal(record: Mapping[str, Any]) -> None:
    if not record.get("valid_for_confirmatory"):
        raise ContractViolation(
            TransferCode.SEAL_NOT_CONFIRMATORY,
            "この封印は候補（確証解析には使えない）です。凍結した事前登録の下で作り直した封印が要ります。",
            "seal.status",
            {"status": record.get("status"), "reasons": record.get("status_reasons_ja")},
        )
