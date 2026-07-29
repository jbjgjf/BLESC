import { COST_LIMITS, MODELS, PRICING } from "./config.ts";

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
}

export function usdFor(model: string, usage: UsageTotals): number {
  const price = PRICING[model];
  if (!price) return 0;
  return (usage.inputTokens / 1_000_000) * price.input + (usage.outputTokens / 1_000_000) * price.output;
}

/** Pre-run estimate shown to the operator before anything is spent. */
export function estimateRunUsd(conversations: number, avgTurns: number): {
  tokens: number;
  usd: number;
} {
  // Empirical shape: each student turn ≈ 700 in / 160 out on the simulator;
  // judge ≈ one 6k-in / 700-out call per conversation.
  const simUsage = {
    inputTokens: conversations * avgTurns * 700,
    outputTokens: conversations * avgTurns * 160,
  };
  const judgeUsage = { inputTokens: conversations * 6000, outputTokens: conversations * 700 };
  const usd = usdFor(MODELS.studentSimulator, simUsage) + usdFor(MODELS.judge, judgeUsage);
  return { tokens: simUsage.inputTokens + simUsage.outputTokens + judgeUsage.inputTokens + judgeUsage.outputTokens, usd };
}

export class CostGuard {
  private spentUsd = 0;
  public warned = false;

  add(model: string, usage: UsageTotals): void {
    this.spentUsd += usdFor(model, usage);
    if (!this.warned && this.spentUsd >= COST_LIMITS.warnUsd) {
      this.warned = true;
      console.warn(`[cost] WARNING: estimated spend passed US$${COST_LIMITS.warnUsd} (now ~$${this.spentUsd.toFixed(2)})`);
    }
    if (this.spentUsd >= COST_LIMITS.hardStopUsd) {
      throw new CostHardStop(this.spentUsd);
    }
  }

  total(): number {
    return this.spentUsd;
  }
}

export class CostHardStop extends Error {
  readonly spentUsd: number;

  constructor(spentUsd: number) {
    super(`hard cost stop: estimated spend ~$${spentUsd.toFixed(2)} reached the US$${COST_LIMITS.hardStopUsd} limit`);
    this.spentUsd = spentUsd;
  }
}
