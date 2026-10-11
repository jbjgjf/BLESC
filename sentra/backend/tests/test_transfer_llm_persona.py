"""#213 — the LLM persona generator is an interface with a record, tested only against fakes.

No test here, and no code in the package, calls a real provider. The fake
returns canned text and reports a token count and a cost so the record's
arithmetic can be checked; the disabled default is what runs when nobody
injects a provider.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional

import pytest

from research_engine.contracts.errors import ContractViolation
from research_engine.transfer.codes import TransferCode
from research_engine.transfer.generator import SyntheticCohortConfig, generate
from research_engine.transfer.llm_persona import (
    DisabledProvider,
    LLMPersonaConfig,
    LLMPersonaGenerator,
    ProviderResponse,
    build_prompt,
    llm_manifest,
)
from research_engine.transfer.schema import SOURCE_PARTICIPANT

TEMPLATE = "合成の高校生の{day_index}日目の日記を短く書く。気分{mood}、ストレス{stress}、出来事の大きさ{event_intensity}。"


@dataclass
class FakeProvider:
    provider_id: str = "fake"
    cost_per_call: Optional[float] = 0.001
    prompts: List[str] = field(default_factory=list)

    def complete(self, prompt: str, *, model: str, temperature: float, max_output_tokens: int, seed: int) -> ProviderResponse:
        self.prompts.append(prompt)
        return ProviderResponse(
            text=f"架空の応答{len(self.prompts)}。",
            model_version=f"{model}-fake-2030-01-01",
            input_tokens=len(prompt),
            output_tokens=8,
            cost_usd=self.cost_per_call,
        )


def _dataset(n: int = 3):
    cohort = generate(
        SyntheticCohortConfig(
            seed=9,
            missingness="independent",
            n_participants=n,
            withdrawals_keep=0,
            withdrawals_delete=0,
            raw_text_retention_rate=1.0,
        )
    )
    return cohort


def _config(**overrides) -> LLMPersonaConfig:
    base = dict(
        model="fake-model",
        prompt_template_id="persona-diary-v0",
        prompt_template=TEMPLATE,
        seed=4,
        budget_usd=1.0,
        max_calls=500,
    )
    base.update(overrides)
    return LLMPersonaConfig(**base)


def test_the_default_provider_refuses_every_call() -> None:
    cohort = _dataset()
    generator = LLMPersonaGenerator(_config())
    assert isinstance(generator.provider, DisabledProvider)
    with pytest.raises(ContractViolation) as caught:
        generator.generate_texts(cohort.dataset)
    assert caught.value.code == TransferCode.PROVIDER_CALLS_DISABLED


def test_no_budget_means_no_run() -> None:
    provider = FakeProvider()
    with pytest.raises(ContractViolation) as caught:
        LLMPersonaGenerator(_config(budget_usd=0.0), provider).generate_texts(_dataset().dataset)
    assert caught.value.code == TransferCode.BUDGET_EXCEEDED
    assert provider.prompts == []


def test_a_run_needing_more_calls_than_allowed_does_not_start() -> None:
    provider = FakeProvider()
    with pytest.raises(ContractViolation) as caught:
        LLMPersonaGenerator(_config(max_calls=2), provider).generate_texts(_dataset().dataset)
    assert caught.value.code == TransferCode.BUDGET_EXCEEDED
    assert provider.prompts == []


def test_reported_spend_past_the_budget_stops_the_run() -> None:
    provider = FakeProvider(cost_per_call=0.4)
    with pytest.raises(ContractViolation) as caught:
        LLMPersonaGenerator(_config(budget_usd=1.0), provider).generate_texts(_dataset().dataset)
    assert caught.value.code == TransferCode.BUDGET_EXCEEDED
    assert len(provider.prompts) == 3


def test_the_record_keeps_prompt_model_version_seed_and_cost() -> None:
    cohort = _dataset()
    provider = FakeProvider()
    rewritten, record = LLMPersonaGenerator(_config(), provider).generate_texts(cohort.dataset)
    with_text = [r for r in cohort.dataset.records if r.text is not None]
    assert record.provider_calls == len(with_text) == len(provider.prompts)
    assert record.model_requested == "fake-model"
    assert record.model_versions_returned == ("fake-model-fake-2030-01-01",)
    assert record.seed == 4
    assert record.prompt_template_hash.startswith("sha256:")
    assert record.prompts_hash.startswith("sha256:")
    assert record.cost_measured is True
    assert record.cost_usd == pytest.approx(0.001 * len(with_text))
    assert record.output_tokens == 8 * len(with_text)
    assert record.base_dataset_hash == cohort.dataset.content_hash()
    assert record.dataset_hash == rewritten.content_hash() != cohort.dataset.content_hash()

    # Only the text layer changed; the shape and the self-reports did not.
    assert [(r.research_code, r.day_index, r.self_report, r.text is None) for r in rewritten.records] == [
        (r.research_code, r.day_index, r.self_report, r.text is None) for r in cohort.dataset.records
    ]

    manifest = llm_manifest(cohort.manifest, record)
    assert manifest["llm"]["used"] is True
    assert manifest["llm"]["provider_calls"] == record.provider_calls
    assert manifest["generator"]["kind"] == "statistical+llm_persona_text"
    assert manifest["status"] == "candidate_not_frozen"


def test_an_unreported_cost_is_unmeasured_not_zero() -> None:
    provider = FakeProvider(cost_per_call=None)
    _, record = LLMPersonaGenerator(_config(), provider).generate_texts(_dataset().dataset)
    assert record.cost_measured is False
    assert record.cost_usd is None


def test_prompts_come_only_from_synthetic_records() -> None:
    cohort = _dataset()
    record = next(r for r in cohort.dataset.records if r.text is not None)
    prompt = build_prompt(_config(), cohort.dataset, record)
    assert f"{record.day_index}日目" in prompt

    relabelled = cohort.dataset.replace()
    object.__setattr__(relabelled, "source_kind", SOURCE_PARTICIPANT)
    with pytest.raises(ContractViolation) as caught:
        build_prompt(_config(), relabelled, record)
    assert caught.value.code == TransferCode.NON_SYNTHETIC_PROMPT_INPUT


def test_the_package_ships_no_concrete_provider() -> None:
    import research_engine.transfer.llm_persona as module

    source = open(module.__file__, encoding="utf-8").read()
    for marker in ("import openai", "import anthropic", "from openai", "from anthropic", "requests.", "httpx", "urllib.request"):
        assert marker not in source
