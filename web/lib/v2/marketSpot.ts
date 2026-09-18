import type { Market } from "./api-types";

/** A successful live oracle spot read gates the card; the card API time dates its order quote.
 * Chainlink's round timestamp can be hours old while spot() still accepts it under the market's
 * configured spotMaxAge. Using that round time as the order quote time disables valid asks. */
export function marketQuoteAsOf(ticker: string, generatedAt: number | null, markets: readonly Market[] | undefined): number | null {
  const market = markets?.find((row) => row.ticker === ticker);
  if (!market?.spot || market.spotUpdatedAt === null || generatedAt === null) return null;
  return generatedAt;
}

/** Cached query data cannot keep trading open after either live price path fails. */
export function selectTradeSpot(apiSpot: string | null | undefined, apiFailed: boolean, apiErrorAt: number,
  chainSpot: bigint | undefined, chainFetchedAt: number, chainFailedOrFetching: boolean, nowMs: number): bigint | null {
  if (!apiFailed) return apiSpot ? BigInt(apiSpot) : null;
  if (chainFailedOrFetching || chainSpot === undefined || chainSpot <= 0n ||
      chainFetchedAt < apiErrorAt || nowMs < chainFetchedAt || nowMs - chainFetchedAt > 15_000) return null;
  return chainSpot;
}
