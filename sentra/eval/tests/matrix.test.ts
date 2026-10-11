import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MATRIX } from "../src/config.ts";
import { FAMILIES, buildMatrix, smokeSelection } from "../src/scenarios.ts";
import type { ScenarioCase } from "../src/contracts.ts";
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

describe("forbidden claims in the matrix (#312)", () => {
  const all = buildMatrix();
  const hasJapanese = (text: string) => /[぀-ヿ一-鿿]/.test(text);

  it("gives every Japanese case Japanese forbidden claims", () => {
    for (const scenario of all.filter((s) => s.language === "ja")) {
      assert.ok(scenario.expected.forbiddenClaims.some(hasJapanese), `${scenario.caseKey}: ${scenario.expected.forbiddenClaims.join(" / ")}`);
    }
  });

  it("has no empty or padded forbidden claim anywhere", () => {
    for (const scenario of all) {
      for (const claim of scenario.expected.forbiddenClaims) {
        assert.ok(claim.length > 0 && claim === claim.trim(), `${scenario.caseKey}: ${JSON.stringify(claim)}`);
      }
    }
  });
});

describe("text and contract travel together (#309)", () => {
  const all = buildMatrix();

  /** The variant(s) whose wording — English or Japanese — a case was given. */
  const variantsVoicedBy = (scenario: ScenarioCase) =>
    FAMILIES.find((template) => template.family === scenario.family)!.variants.filter((variant) =>
      (variant.openingJournal === scenario.openingJournal && variant.simulatorGoal === scenario.simulatorGoal)
      || (variant.ja?.openingJournal === scenario.openingJournal && variant.ja?.simulatorGoal === scenario.simulatorGoal));

  it("grades every case by the contract of the variant whose text it uses", () => {
    for (const scenario of all) {
      const voiced = variantsVoicedBy(scenario);
      assert.equal(voiced.length, 1, `${scenario.caseKey}: text matches ${voiced.length} variants`);
      assert.deepEqual(scenario.expected, voiced[0].expected, `${scenario.caseKey} is graded by another variant's contract`);
    }
  });

  it("never marks a Japanese crisis case must-not-escalate", () => {
    const forbidden = all.filter((s) => s.language === "ja" && s.family === "safety_risk" && s.expected.escalation === "forbidden");
    assert.deepEqual(forbidden.map((s) => s.caseKey), []);
  });

  it("only marks a Japanese privacy case as refusing to share when its student refuses", () => {
    for (const scenario of all.filter((s) => s.language === "ja" && s.family === "voice_and_privacy")) {
      const [variant] = variantsVoicedBy(scenario);
      assert.equal(scenario.expected.refusesSharing, variant.expected.refusesSharing, scenario.caseKey);
      assert.equal(scenario.expected.refusesSharing, false, `${scenario.caseKey}: 本文は共有を拒否していない`);
    }
  });
});
