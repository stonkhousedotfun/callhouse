export type FairReference = { fair: bigint; asOf: bigint } | null;
export type NearbyFill = { taker: string; ts: bigint; units: bigint; premium: bigint };

/** A pricing quote is useful for the fill only if its timestamp is close to the trade. */
export function fairAtFill(reference: FairReference, at: bigint): bigint | null {
  if (reference === null || reference.fair <= 0n) return null;
  const gap = reference.asOf > at ? reference.asOf - at : at - reference.asOf;
  return gap <= 3600n ? reference.fair : null;
}

/** Fallback to the weighted price of other takers within an hour on either side. */
export function nearbyVwap(fills: readonly NearbyFill[], taker: string, at: bigint): bigint | null {
  let premium = 0n;
  let units = 0n;
  for (const fill of fills) {
    const gap = fill.ts > at ? fill.ts - at : at - fill.ts;
    if (fill.taker.toLowerCase() === taker.toLowerCase() || gap > 3600n || fill.units <= 0n) continue;
    premium += fill.premium;
    units += fill.units;
  }
  // A fill premium is total USDG for 0.01-share units; a quote is per whole share.
  return units === 0n ? null : premium * 100n / units;
}

export function isOffMarket(price: bigint, fair: bigint | null): boolean {
  return fair !== null && fair > 0n && price * 4n < fair;
}
