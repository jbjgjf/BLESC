import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MODELS, PRICING } from "../src/config.ts";
import { CostGuard, CostHardStop, UnpricedModel, estimateRunUsd, usdFor } from "../src/cost.ts";

// A price table and limits of our own, so these tests say what the guard does
// rather than what today's prices happen to be.
const FAKE_PRICING = { "model-a": { input: 1, output: 2 } };
const FAKE_LIMITS = { warnUsd: 6, hardStopUsd: 8 };
const MILLION = { inputTokens: 1_000_000, outputTokens: 0 };

describe("models without a price (#286)", () => {
  it("usdFor refuses a model it has no price for instead of calling it free", () => {
    assert.equal(usdFor("model-a", MILLION, FAKE_PRICING), 1);
    assert.throws(() => usdFor("model-b", MILLION, FAKE_PRICING), UnpricedModel);
  });

  it("does not resolve a dated snapshot to its alias: snapshots must be priced explicitly", () => {
    assert.throws(() => usdFor("model-a-2026-08-01", MILLION, FAKE_PRICING), UnpricedModel);
    assert.equal(usdFor("model-a-2026-08-01", MILLION, { ...FAKE_PRICING, "model-a-2026-08-01": { input: 3, output: 3 } }), 3);
  });

  it("the cost guard stops instead of letting an unpriced model spend without limit", () => {
    const guard = new CostGuard({ pricing: FAKE_PRICING, limits: FAKE_LIMITS });
    assert.throws(() => guard.add("model-b", MILLION), UnpricedModel);
    assert.ok(new UnpricedModel("model-b", 0) instanceof CostHardStop, "the runner aborts on it like the hard stop");
  });

  it("the pre-run estimate refuses rather than showing US$0.00", () => {
    assert.throws(
      () => estimateRunUsd(10, 20, { pricing: FAKE_PRICING, models: { studentSimulator: "model-a", counselorSimulator: "model-a", judge: "model-b" } }),
      UnpricedModel,
    );
  });

  it("every model the harness is configured with has a price", () => {
    // Fails in CI the moment someone changes MODELS without PRICING.
    for (const [role, model] of Object.entries(MODELS)) {
      assert.ok(Object.hasOwn(PRICING, model), `MODELS.${role} = ${model} has no entry in PRICING`);
    }
  });
});

describe("the hard stop with a fake price table", () => {
  it("warns at the warn line and stops at the hard stop", () => {
    const guard = new CostGuard({ pricing: FAKE_PRICING, limits: FAKE_LIMITS });
    for (let i = 0; i < 6; i += 1) guard.add("model-a", MILLION);
    assert.equal(guard.warned, true);
    guard.add("model-a", MILLION); // $7
    assert.throws(() => guard.add("model-a", MILLION), CostHardStop); // $8
  });
});
