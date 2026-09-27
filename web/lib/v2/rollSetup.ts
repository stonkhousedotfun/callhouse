import { MAX_ASK_BPS, MIN_ASK_BPS, smartPricingPrices } from "./smartPricing";

export type RollStep = "payout" | "operator" | "bookOperator" | "delegate" | "strategy";
export const ROLL_STEPS: readonly { key: RollStep; label: string }[] = [
  { key: "payout", label: "Keep payouts in your Stonkhouse balance" },
  { key: "operator", label: "Allow AutoRoller to use your free collateral" },
  // AutoRoller.roll checks BOTH Clearinghouse operator flags (the roller's and the OrderBook's) and reverts
  // NotAuthorized without either. Only a manual ask used to grant the OrderBook's, so a page-only setup never rolled.
  { key: "bookOperator", label: "Allow the order book to use your free collateral when an ask fills" },
  { key: "delegate", label: "Allow AutoRoller to place your asks" },
  { key: "strategy", label: "Save your strategy" },
];

export type RollProgress = { payout: boolean; operator: boolean; bookOperator: boolean; delegate: boolean; strategy: boolean };

/** Start each setup attempt from the connected account's fresh on-chain permissions. */
export function rollProgressFromChain(reads: {
  payoutToLedger: boolean; rollerOperator: boolean; orderBookOperator: boolean; delegate: boolean;
}): RollProgress {
  return { payout: reads.payoutToLedger, operator: reads.rollerOperator, bookOperator: reads.orderBookOperator,
    delegate: reads.delegate,
    // An active writer pressing Update must still save the edited strategy.
    strategy: false };
}

/** Each confirmed step can be resumed after a rejected wallet prompt or page reload. */
export function nextRollStep(progress: RollProgress): RollStep | null {
  return ROLL_STEPS.find((step) => !progress[step.key])?.key ?? null;
}

/**
 * auto-roll is ACTIVE only when the keeper's roll can succeed: a saved strategy plus every permission
 * AutoRoller.roll checks (both Clearinghouse operator flags and the delegate). A saved strategy alone is "incomplete":
 * the keeper's roll reverts NotAuthorized and it skips the writer without telling them.
 */
export function rollStatusFromChain(reads: {
  strategyActive: boolean; rollerOperator: boolean; orderBookOperator: boolean; delegate: boolean;
}): "active" | "incomplete" | "off" {
  if (!reads.strategyActive) return "off";
  return reads.rollerOperator && reads.orderBookOperator && reads.delegate ? "active" : "incomplete";
}

export function validateRollStrategy(strategy: {
  smartPricing?: boolean; otmBps: number; askBps: number; minAskBps: number; maxAskBps: number; maxUnits: string;
}, spot?: bigint | null): string | null {
  if (!Number.isInteger(strategy.otmBps) || strategy.otmBps < 100 || strategy.otmBps > 2_500)
    return "Strike distance must be between 1% and 25%.";
  if (!Number.isInteger(strategy.askBps) || strategy.askBps < MIN_ASK_BPS || strategy.askBps > MAX_ASK_BPS)
    return "Starting ask must be between 0.5% and 10% of spot.";
  if (strategy.smartPricing && (![strategy.minAskBps, strategy.maxAskBps].every(Number.isInteger) ||
      strategy.minAskBps < MIN_ASK_BPS || strategy.maxAskBps > MAX_ASK_BPS ||
      strategy.minAskBps > strategy.askBps || strategy.askBps > strategy.maxAskBps))
    return "Smart-price bounds must be 0.5%–10%, with minimum ≤ starting ask ≤ maximum.";
  if (strategy.smartPricing && spot && smartPricingPrices(spot, strategy) === null)
    return "No 0.0001 USDG price fits inside these smart-price bounds at the current spot.";
  if (!/^\d+$/.test(strategy.maxUnits) || BigInt(strategy.maxUnits) > (1n << 64n) - 1n)
    return "Choose a valid maximum size.";
  return null;
}
