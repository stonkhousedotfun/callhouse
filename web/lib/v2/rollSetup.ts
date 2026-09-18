export type RollStep = "payout" | "operator" | "delegate" | "strategy";
export const ROLL_STEPS: readonly { key: RollStep; label: string }[] = [
  { key: "payout", label: "Keep payouts in your Stonkhouse balance" },
  { key: "operator", label: "Allow AutoRoller to use your free collateral" },
  { key: "delegate", label: "Allow AutoRoller to place your asks" },
  { key: "strategy", label: "Save your strategy" },
];

export type RollProgress = { payout: boolean; operator: boolean; delegate: boolean; strategy: boolean };

/** Start each setup attempt from the connected account's fresh on-chain permissions. */
export function rollProgressFromChain(reads: { payoutToLedger: boolean; rollerOperator: boolean; delegate: boolean }): RollProgress {
  return { payout: reads.payoutToLedger, operator: reads.rollerOperator, delegate: reads.delegate,
    // An active writer pressing Update must still save the edited strategy.
    strategy: false };
}

/** Each confirmed step can be resumed after a rejected wallet prompt or page reload. */
export function nextRollStep(progress: RollProgress): RollStep | null {
  return ROLL_STEPS.find((step) => !progress[step.key])?.key ?? null;
}

export function validateRollStrategy(strategy: {
  otmBps: number; askBps: number; minAskBps: number; maxAskBps: number; maxUnits: string;
}): string | null {
  if (!Number.isInteger(strategy.otmBps) || strategy.otmBps < 100 || strategy.otmBps > 2_500)
    return "Strike distance must be between 1% and 25%.";
  if (![strategy.askBps, strategy.minAskBps, strategy.maxAskBps].every(Number.isInteger) ||
      strategy.askBps < 5 || strategy.askBps > 1_000 || strategy.minAskBps < 5 ||
      strategy.maxAskBps > 1_000 || strategy.minAskBps > strategy.askBps || strategy.askBps > strategy.maxAskBps)
    return "Ask and smart-price bounds must be 0.05%–10%, with minimum ≤ ask ≤ maximum.";
  if (!/^\d+$/.test(strategy.maxUnits) || BigInt(strategy.maxUnits) > (1n << 64n) - 1n)
    return "Choose a valid maximum size.";
  return null;
}
