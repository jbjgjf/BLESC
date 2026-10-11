// Spend control for the evaluation runner's own OpenAI key: the student
// simulator and the judge. (The product's traffic runs on the deployment's key
// and is not counted here.)
//
// Decisions recorded here, because each one is a way for the US$80 hard stop to
// stop meaning anything:
//
// - A model with no price is an error, not $0 (#286). Not knowing the price is
//   not evidence that it was free, and every way into that state is ordinary:
//   changing MODELS without PRICING, or pinning a dated snapshot for
//   reproducibility. `usdFor` throws `UnpricedModel`; the guard therefore stops
//   the run rather than warning once and carrying on — a guard that keeps
//   spending without a price is no longer enforcing a limit. The runner and
//   the CLI check every configured model up front (`assertPriced`), so in
//   practice this is a refusal before anything is spent, not a mid-run stop.
// - Snapshot names are not resolved to their alias. PRICING is matched
//   exactly, and a snapshot must be listed under its own name. Prefix matching
//   is the alternative and it is wrong in both directions here: "gpt-5.4" is a
//   prefix of "gpt-5.4-mini", and a snapshot's price is the vendor's to set.

import { COST_LIMITS, MODELS, PRICING } from "./config.ts";

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
}

export type PriceTable = Readonly<Record<string, { input: number; output: number }>>;
export type CostLimits = Readonly<{ warnUsd: number; hardStopUsd: number }>;
export type ModelSet = Readonly<{ studentSimulator: string; counselorSimulator: string; judge: string }>;

/**
 * The guard stopped the run. Subclasses say why; the runner treats every one
 * the same way (mark the run aborted with what was spent, then stop).
 */
export class CostHardStop extends Error {
  readonly spentUsd: number;

  constructor(spentUsd: number, message?: string) {
    super(message ?? `hard cost stop: estimated spend ~$${spentUsd.toFixed(2)} reached the US$${COST_LIMITS.hardStopUsd} limit`);
    this.spentUsd = spentUsd;
  }
}

/** Asked to price a model the table does not list. */
export class UnpricedModel extends CostHardStop {
  readonly model: string;

  constructor(model: string, spentUsd: number) {
    super(spentUsd, `no price for model "${model}" in PRICING (sentra/eval/src/config.ts): the cost guard cannot enforce its limit without one. `
      + "Add the model — a dated snapshot under its own name — before running.");
    this.model = model;
  }
}

export function usdFor(model: string, usage: UsageTotals, pricing: PriceTable = PRICING): number {
  if (!Object.hasOwn(pricing, model)) throw new UnpricedModel(model, 0);
  const price = pricing[model];
  return (usage.inputTokens / 1_000_000) * price.input + (usage.outputTokens / 1_000_000) * price.output;
}

/** Throws `UnpricedModel` for the first of `models` without a price. */
export function assertPriced(models: Iterable<string>, pricing: PriceTable = PRICING): void {
  for (const model of models) {
    if (!Object.hasOwn(pricing, model)) throw new UnpricedModel(model, 0);
  }
}

/** Pre-run estimate shown to the operator before anything is spent. */
export function estimateRunUsd(
  conversations: number,
  avgTurns: number,
  options: { pricing?: PriceTable; models?: ModelSet } = {},
): {
  tokens: number;
  usd: number;
} {
  const pricing = options.pricing ?? PRICING;
  const models = options.models ?? MODELS;
  // Empirical shape: each student turn ≈ 700 in / 160 out on the simulator;
  // judge ≈ one 6k-in / 700-out call per conversation.
  const simUsage = {
    inputTokens: conversations * avgTurns * 700,
    outputTokens: conversations * avgTurns * 160,
  };
  const judgeUsage = { inputTokens: conversations * 6000, outputTokens: conversations * 700 };
  const usd = usdFor(models.studentSimulator, simUsage, pricing) + usdFor(models.judge, judgeUsage, pricing);
  return { tokens: simUsage.inputTokens + simUsage.outputTokens + judgeUsage.inputTokens + judgeUsage.outputTokens, usd };
}

export class CostGuard {
  private spentUsd = 0;
  public warned = false;
  private readonly pricing: PriceTable;
  private readonly limits: CostLimits;

  constructor(options: { pricing?: PriceTable; limits?: CostLimits } = {}) {
    this.pricing = options.pricing ?? PRICING;
    this.limits = options.limits ?? COST_LIMITS;
  }

  add(model: string, usage: UsageTotals): void {
    if (!Object.hasOwn(this.pricing, model)) throw new UnpricedModel(model, this.spentUsd);
    this.spentUsd += usdFor(model, usage, this.pricing);
    if (!this.warned && this.spentUsd >= this.limits.warnUsd) {
      this.warned = true;
      console.warn(`[cost] WARNING: estimated spend passed US$${this.limits.warnUsd} (now ~$${this.spentUsd.toFixed(2)})`);
    }
    if (this.spentUsd >= this.limits.hardStopUsd) {
      throw new CostHardStop(this.spentUsd,
        `hard cost stop: estimated spend ~$${this.spentUsd.toFixed(2)} reached the US$${this.limits.hardStopUsd} limit`);
    }
  }

  total(): number {
    return this.spentUsd;
  }
}
