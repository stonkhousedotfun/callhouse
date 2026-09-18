import type { Address } from "viem";

import { ALL_MARKETS, type Market } from "./markets";

/** A v1 factory can remain relevant after its market stops accepting new listings. */
export type LegacyMarket = Market & { factory: Address };

export const LEGACY_MARKETS: readonly LegacyMarket[] = ALL_MARKETS.filter(
  (market): market is LegacyMarket => market.factory !== null,
);

export function legacyMarket(ticker: string): LegacyMarket | undefined {
  return LEGACY_MARKETS.find((market) => market.ticker.toLowerCase() === ticker.toLowerCase());
}

export type MigrationStep = "wait" | "settle" | "claim" | "withdraw" | "recovery" | "deposit";

/** A claim left in Valorem after settle has no v1 retry method; never call migration complete. */
export function migrationStep(state: {
  listedExpiry: bigint;
  chainNow: bigint | null;
  usdg: bigint;
  idle: bigint;
  claimKey: bigint;
}): MigrationStep {
  if (state.listedExpiry > 0n) return state.chainNow === null || state.chainNow < state.listedExpiry ? "wait" : "settle";
  if (state.usdg > 0n) return "claim";
  if (state.idle > 0n) return "withdraw";
  if (state.claimKey > 0n) return "recovery";
  return "deposit";
}
