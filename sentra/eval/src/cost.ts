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
// - The limit is per run, across resumes (#266). A resumed run's guard starts
//   from the run's recorded `actual_cost_usd`, and the runner records the spend
//   after every case, so neither a resume nor a crash hands out a fresh US$80.
// - OpenAI Evals registration is opt-in (`--register-eval`) and paid for
//   through the guard before it starts (see `registerOpenAiEval`).

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

/**
 * Token ceiling for one row graded by OpenAI Evals: the rubric, the contract,
 * and a transcript the runner caps at 20,000 characters — counted as one token
 * per character, which is about right for Japanese and generous for English.
 */
export const EVAL_ROW_MAX_INPUT_TOKENS = 22_000;
export const EVAL_ROW_OUTPUT_TOKENS = 300;

/**
 * Pre-run estimate shown to the operator before anything is spent.
 *
 * `MODELS.counselorSimulator` is not counted because nothing calls it: the
 * counselor pass logs in and reads /oversight through the browser, and no
 * model writes a counselor turn. If a counselor simulator is ever wired in,
 * it must be added here and charged to the guard (#266).
 */
export function estimateRunUsd(
  conversations: number,
  avgTurns: number,
  options: { pricing?: PriceTable; models?: ModelSet; registerEval?: boolean } = {},
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
  // OpenAI Evals grades every row again with the judge model, server-side.
  const evalUsage = options.registerEval
    ? { inputTokens: conversations * EVAL_ROW_MAX_INPUT_TOKENS, outputTokens: conversations * EVAL_ROW_OUTPUT_TOKENS }
    : { inputTokens: 0, outputTokens: 0 };
  const usd = usdFor(models.studentSimulator, simUsage, pricing)
    + usdFor(models.judge, judgeUsage, pricing)
    + usdFor(models.judge, evalUsage, pricing);
  const tokens = [simUsage, judgeUsage, evalUsage].reduce((sum, usage) => sum + usage.inputTokens + usage.outputTokens, 0);
  return { tokens, usd };
}

export class CostGuard {
  private spentUsd = 0;
  public warned = false;
  private readonly pricing: PriceTable;
  private readonly limits: CostLimits;

  /**
   * `alreadySpentUsd` is what the run spent before this process: a resumed
   * run's guard starts there, so the limit covers the run and not the attempt.
   */
  constructor(options: { pricing?: PriceTable; limits?: CostLimits; alreadySpentUsd?: number } = {}) {
    this.pricing = options.pricing ?? PRICING;
    this.limits = options.limits ?? COST_LIMITS;
    const already = options.alreadySpentUsd ?? 0;
    if (!Number.isFinite(already) || already < 0) throw new Error(`invalid prior spend ${already}`);
    this.spentUsd = already;
  }

  /** Stops before anything is spent when the run is already at the hard stop. */
  assertBudgetLeft(): void {
    if (this.spentUsd >= this.limits.hardStopUsd) {
      throw new CostHardStop(this.spentUsd,
        `hard cost stop: this run has already spent ~$${this.spentUsd.toFixed(2)}, at or over the US$${this.limits.hardStopUsd} limit`);
    }
  }

  /** Whether spending `usage` on `model` would stay under the hard stop. */
  wouldStayUnder(model: string, usage: UsageTotals): boolean {
    return this.spentUsd + usdFor(model, usage, this.pricing) < this.limits.hardStopUsd;
  }

  hardStopUsd(): number {
    return this.limits.hardStopUsd;
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
