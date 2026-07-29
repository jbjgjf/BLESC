import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MATRIX } from "../src/config.ts";
import { buildMatrix, smokeSelection } from "../src/scenarios.ts";
import { CostGuard, CostHardStop, estimateRunUsd } from "../src/cost.ts";

describe("scenario matrix", () => {
  const all = buildMatrix();

  it("yields exactly 100 scenarios and 300 conversations across 20 personas", () => {
    assert.equal(all.length, MATRIX.conversations);
    const scenarioKeys = new Set(all.map((scenario) => `${scenario.personaId}:${scenario.family}`));
    assert.equal(scenarioKeys.size, MATRIX.scenarios);
    const personas = new Set(all.map((scenario) => scenario.personaId));
    assert.equal(personas.size, MATRIX.personas);
  });

  it("is deterministic per seed", () => {
    const again = buildMatrix();
    assert.deepEqual(
      all.map((scenario) => [scenario.caseKey, scenario.turnTarget]),
      again.map((scenario) => [scenario.caseKey, scenario.turnTarget]),
    );
  });

  it("keeps turn targets within 10-30", () => {
    for (const scenario of all) {
      assert.ok(scenario.turnTarget >= MATRIX.minTurns && scenario.turnTarget <= MATRIX.maxTurns, scenario.caseKey);
    }
  });

  it("selects 12 stratified smoke cases covering all families and crisis paths", () => {
    const smoke = smokeSelection(all);
    assert.equal(smoke.length, MATRIX.smokeCases);
    const families = new Set(smoke.map((scenario) => scenario.family));
    assert.equal(families.size, 5);
    assert.ok(smoke.some((scenario) => scenario.expected.escalation === "required" && !scenario.expected.reflectionAllowed));
    assert.ok(smoke.some((scenario) => scenario.expected.refusesSharing));
    assert.ok(smoke.some((scenario) => scenario.expected.escalation === "forbidden"));
  });
});

describe("cost controls", () => {
  it("estimates the full run under the hard stop", () => {
    const estimate = estimateRunUsd(300, 20);
    assert.ok(estimate.usd > 0);
    assert.ok(estimate.usd < 80, `estimate ${estimate.usd}`);
  });

  it("hard-stops at the US$80 ceiling", () => {
    const guard = new CostGuard();
    assert.throws(
      () => guard.add("gpt-5.4", { inputTokens: 60_000_000, outputTokens: 0 }),
      CostHardStop,
    );
  });
});
