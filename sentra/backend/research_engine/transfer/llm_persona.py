"""#213 — the LLM persona text generator: an interface and a record, and no provider.

#213 asks for the statistical generator and an LLM persona generator to be kept
clearly apart, and for the LLM one to save its prompt, model version, seed and
cost. Calling a paid model is out of scope for this work, so what is here is
the part that has to exist *before* anyone does:

- `PersonaTextProvider` — the one method a provider must implement. No
  concrete provider ships in this package. The default is `DisabledProvider`,
  which refuses every call, so constructing the generator without explicitly
  injecting a provider cannot spend anything.
- `LLMPersonaConfig` — what decides a run. `model` has no default: choosing a
  model is choosing a cost and a provider, and that is a human decision.
- `LLMGenerationRecord` — what a run must leave behind: the requested model,
  the versions the provider actually reported, the prompt template hash, a
  hash over every prompt sent, token counts, cost, and the call count.

**Cost is measured, not assumed.** If any response does not report its cost,
the total is `None` with `cost_measured=false`, never 0 — the same distinction
the evaluation contract makes for `provider_calls` (C5): 0 is a measurement,
`null` is the absence of one.

**Prompts are built from synthetic personas only.** `build_prompt` takes a
synthetic record and refuses anything whose dataset is not `synthetic` or
whose research code is not a `SYN-` code. A prompt built from a real diary
would send that diary to an external provider, which protocol §6 forbids.

**Budget is a hard stop.** A run refuses to start with `budget_usd <= 0`, stops
before exceeding `max_calls`, and stops as soon as the reported spend passes
the budget. It cannot pre-empt the call that crosses the line — no price table
lives here — which is why `max_calls` exists as the bound that does not depend
on the provider being honest about cost.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Protocol, Sequence, Tuple

from ..contracts.common import content_hash
from ..contracts.errors import ContractViolation
from . import CANDIDATE_STATUS, CANDIDATE_STATUS_JA
from .codes import TransferCode
from .schema import ITEM_IDS, SOURCE_SYNTHETIC, DailyRecord, TransferDataset

GENERATOR_KIND = "llm_persona_text"


@dataclass(frozen=True)
class ProviderResponse:
    text: str
    model_version: str
    input_tokens: Optional[int] = None
    output_tokens: Optional[int] = None
    cost_usd: Optional[float] = None


class PersonaTextProvider(Protocol):
    provider_id: str

    def complete(
        self, prompt: str, *, model: str, temperature: float, max_output_tokens: int, seed: int
    ) -> ProviderResponse:  # pragma: no cover - protocol
        ...


class DisabledProvider:
    """The default. Refuses every call, so nothing is spent by accident."""

    provider_id = "disabled"

    def complete(self, prompt: str, *, model: str, temperature: float, max_output_tokens: int, seed: int) -> ProviderResponse:
        raise ContractViolation(
            TransferCode.PROVIDER_CALLS_DISABLED,
            "LLMの呼び出しは無効です。有料APIを呼ぶには、人が承認したproviderを明示的に渡してください。",
            "provider",
        )


@dataclass(frozen=True)
class LLMPersonaConfig:
    model: str
    prompt_template_id: str
    prompt_template: str
    seed: int
    budget_usd: float
    max_calls: int
    temperature: float = 0.0
    max_output_tokens: int = 200

    def validate(self) -> None:
        for name in ("model", "prompt_template_id", "prompt_template"):
            if not getattr(self, name):
                raise ContractViolation(TransferCode.PROVIDER_CALLS_DISABLED, f"{name}が空です。", f"config.{name}")
        if self.budget_usd <= 0:
            raise ContractViolation(
                TransferCode.BUDGET_EXCEEDED,
                "budget_usdが0以下です。予算を決めずに有料APIを呼びません。",
                "config.budget_usd",
            )
        if self.max_calls <= 0:
            raise ContractViolation(TransferCode.BUDGET_EXCEEDED, "max_callsが0以下です。", "config.max_calls")

    @property
    def template_hash(self) -> str:
        return content_hash({"id": self.prompt_template_id, "template": self.prompt_template})


@dataclass(frozen=True)
class LLMGenerationRecord:
    generator_kind: str
    provider_id: str
    model_requested: str
    model_versions_returned: Tuple[str, ...]
    prompt_template_id: str
    prompt_template_hash: str
    prompts_hash: str
    seed: int
    temperature: float
    max_output_tokens: int
    provider_calls: int
    input_tokens: Optional[int]
    output_tokens: Optional[int]
    cost_usd: Optional[float]
    cost_measured: bool
    budget_usd: float
    base_dataset_hash: str
    dataset_hash: str

    def as_dict(self) -> Dict[str, Any]:
        return {
            "generator_kind": self.generator_kind,
            "provider_id": self.provider_id,
            "model_requested": self.model_requested,
            "model_versions_returned": list(self.model_versions_returned),
            "prompt_template_id": self.prompt_template_id,
            "prompt_template_hash": self.prompt_template_hash,
            "prompts_hash": self.prompts_hash,
            "seed": self.seed,
            "temperature": self.temperature,
            "max_output_tokens": self.max_output_tokens,
            "provider_calls": self.provider_calls,
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "cost_usd": self.cost_usd,
            "cost_measured": self.cost_measured,
            "budget_usd": self.budget_usd,
            "base_dataset_hash": self.base_dataset_hash,
            "dataset_hash": self.dataset_hash,
        }


def build_prompt(config: LLMPersonaConfig, dataset: TransferDataset, record: DailyRecord) -> str:
    """Fill the template from one *synthetic* record's day state."""

    if dataset.source_kind != SOURCE_SYNTHETIC or not record.research_code.startswith("SYN-"):
        raise ContractViolation(
            TransferCode.NON_SYNTHETIC_PROMPT_INPUT,
            "プロンプトは合成参加者からだけ作ります。実データを外部のAIへ送りません（protocol §6）。",
            "record",
            {"source_kind": dataset.source_kind},
        )
    fields: Dict[str, Any] = {"day_index": record.day_index}
    for item_id in ITEM_IDS:
        value = record.value(item_id)
        fields[item_id] = "未回答" if value is None else f"{value:g}"
    try:
        return config.prompt_template.format(**fields)
    except KeyError as exc:
        raise ContractViolation(
            TransferCode.NON_SYNTHETIC_PROMPT_INPUT,
            f"テンプレートが未知の欄を参照しています: {exc}",
            "config.prompt_template",
        ) from exc


@dataclass
class LLMPersonaGenerator:
    config: LLMPersonaConfig
    provider: PersonaTextProvider = field(default_factory=DisabledProvider)

    def generate_texts(self, dataset: TransferDataset) -> Tuple[TransferDataset, LLMGenerationRecord]:
        """Replace each available synthetic text with a provider-written one.

        Only records that already carry text are rewritten: a participant
        without retention consent has no text in the export, and giving them
        an LLM text would change the dataset's shape, not just its wording.
        """

        self.config.validate()
        targets = [record for record in dataset.records if record.text is not None]
        prompts: List[str] = [build_prompt(self.config, dataset, record) for record in targets]
        if len(prompts) > self.config.max_calls:
            raise ContractViolation(
                TransferCode.BUDGET_EXCEEDED,
                f"必要な呼び出し {len(prompts)} 回が max_calls={self.config.max_calls} を超えます。開始しません。",
                "config.max_calls",
            )

        texts: Dict[Tuple[str, int], str] = {}
        versions: List[str] = []
        input_tokens: Optional[int] = 0
        output_tokens: Optional[int] = 0
        cost: Optional[float] = 0.0
        cost_measured = True
        spent = 0.0
        calls = 0
        for record, prompt in zip(targets, prompts):
            response = self.provider.complete(
                prompt,
                model=self.config.model,
                temperature=self.config.temperature,
                max_output_tokens=self.config.max_output_tokens,
                seed=self.config.seed,
            )
            calls += 1
            texts[(record.research_code, record.day_index)] = response.text
            if response.model_version not in versions:
                versions.append(response.model_version)
            input_tokens = None if input_tokens is None or response.input_tokens is None else input_tokens + response.input_tokens
            output_tokens = (
                None if output_tokens is None or response.output_tokens is None else output_tokens + response.output_tokens
            )
            if response.cost_usd is None:
                cost_measured = False
                cost = None
            else:
                spent += response.cost_usd
                if cost is not None:
                    cost = cost + response.cost_usd
            if spent > self.config.budget_usd:
                raise ContractViolation(
                    TransferCode.BUDGET_EXCEEDED,
                    f"報告された費用 {spent:.4f} USD が予算 {self.config.budget_usd:.4f} USD を超えたため停止しました。",
                    "config.budget_usd",
                    {"provider_calls": calls, "spent_usd": spent},
                )

        records = [
            DailyRecord(
                research_code=record.research_code,
                day_index=record.day_index,
                self_report=record.self_report,
                text=texts.get((record.research_code, record.day_index), record.text),
                model_training_use=record.model_training_use,
                submitted_at=record.submitted_at,
            )
            for record in dataset.records
        ]
        rewritten = dataset.replace(records=records, dataset_id=f"{dataset.dataset_id}+llm-text")
        rewritten.validate()
        record = LLMGenerationRecord(
            generator_kind=GENERATOR_KIND,
            provider_id=getattr(self.provider, "provider_id", type(self.provider).__name__),
            model_requested=self.config.model,
            model_versions_returned=tuple(versions),
            prompt_template_id=self.config.prompt_template_id,
            prompt_template_hash=self.config.template_hash,
            prompts_hash=content_hash(prompts),
            seed=self.config.seed,
            temperature=self.config.temperature,
            max_output_tokens=self.config.max_output_tokens,
            provider_calls=calls,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cost_usd=None if not cost_measured else round(float(cost or 0.0), 9),
            cost_measured=cost_measured,
            budget_usd=self.config.budget_usd,
            base_dataset_hash=dataset.content_hash(),
            dataset_hash=rewritten.content_hash(),
        )
        return rewritten, record


def llm_manifest(base_manifest: Mapping[str, Any], record: LLMGenerationRecord) -> Dict[str, Any]:
    """The statistical manifest, amended: the text layer now has an LLM origin."""

    manifest = dict(base_manifest)
    manifest["status"] = CANDIDATE_STATUS
    manifest["status_ja"] = CANDIDATE_STATUS_JA
    manifest["dataset_id"] = f"{base_manifest['dataset_id']}+llm-text"
    manifest["generator"] = {
        **dict(base_manifest["generator"]),
        "kind": f"{base_manifest['generator']['kind']}+{GENERATOR_KIND}",
        "text_layer": GENERATOR_KIND,
    }
    manifest["llm"] = {
        "used": True,
        "provider_calls": record.provider_calls,
        "model_version": list(record.model_versions_returned),
        "prompt_template_hash": record.prompt_template_hash,
        "cost_usd": record.cost_usd,
        "record": record.as_dict(),
    }
    manifest["hashes"] = {**dict(base_manifest["hashes"]), "dataset_hash": record.dataset_hash}
    return manifest
