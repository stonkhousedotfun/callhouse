/**
 * Fee and conversion bounds shared with the site (callhouse-site lib/fees.ts).
 *
 * `conversionFloorBps` is Clearinghouse._conversionFloor expressed as the share of value a successful routed call
 * conversion is guaranteed to keep: the route fee clamps to MAX_ROUTE_FEE_BPS, then slippage plus route fee clamps to
 * MAX_PAYOUT_SLIPPAGE_CEIL_BPS. It is the same rate `usdgPayoutBand(...).floorBps` reports (payoff.ts), so a position
 * built with it (`PayoffPosition.conversionFloorBps`) values a call payout at that band's low end.
 */
import { MAX_PAYOUT_SLIPPAGE_CEIL_BPS, MAX_ROUTE_FEE_BPS } from "./payoff";

/** The site's lib/fees.ts helper, with the two literals (300, 100) named by the constants payoff.ts pins. */
export function conversionFloorBps(maxSlippageBps: number, routeFeeBps: number): number {
  if (![maxSlippageBps, routeFeeBps].every((rate) => Number.isSafeInteger(rate) && rate >= 0) || maxSlippageBps > MAX_PAYOUT_SLIPPAGE_CEIL_BPS) {
    throw new RangeError("Invalid conversion bounds");
  }
  return 10_000 - Math.min(MAX_PAYOUT_SLIPPAGE_CEIL_BPS, maxSlippageBps + Math.min(MAX_ROUTE_FEE_BPS, routeFeeBps));
}
