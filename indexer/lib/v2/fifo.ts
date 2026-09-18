/** FIFO long cost basis. Amounts are USDG base units and 0.01-share contract units. */
export type CostLot = {
  unitsRemaining: bigint;
  costRemainingUsdg: bigint;
  source: "fill" | "transfer" | "mint";
};

export type ConsumedLot<T extends CostLot> = {
  lot: T;
  units: bigint;
  costUsdg: bigint;
};

export function consumeFifo<T extends CostLot>(
  orderedLots: readonly T[],
  units: bigint,
): { consumed: ConsumedLot<T>[]; costUsdg: bigint; transferIn: boolean } {
  if (units < 0n) throw new Error("negative FIFO quantity");
  let remaining = units;
  let costUsdg = 0n;
  let transferIn = false;
  const consumed: ConsumedLot<T>[] = [];

  for (const lot of orderedLots) {
    if (remaining === 0n) break;
    if (lot.unitsRemaining < 0n || lot.costRemainingUsdg < 0n) throw new Error("invalid FIFO lot");
    if (lot.unitsRemaining === 0n) continue;
    const take = remaining < lot.unitsRemaining ? remaining : lot.unitsRemaining;
    // Leave any indivisible USDG remainder with the last units of this lot.
    const cost = take === lot.unitsRemaining
      ? lot.costRemainingUsdg
      : lot.costRemainingUsdg * take / lot.unitsRemaining;
    consumed.push({ lot, units: take, costUsdg: cost });
    costUsdg += cost;
    // A directly minted long also has no observed purchase basis. If it later
    // shares a position with bought lots, exclude that mixed position from wins.
    transferIn ||= lot.source !== "fill";
    remaining -= take;
  }
  if (remaining > 0n) throw new Error(`FIFO inventory short by ${remaining} units`);
  return { consumed, costUsdg, transferIn };
}

/** Divide a call-level taker fee among fills by premium, assigning dust to the last fill. */
export function feeShares<T extends { premium: bigint }>(fills: readonly T[], fee: bigint): bigint[] {
  if (fee < 0n || fills.some((f) => f.premium < 0n)) throw new Error("negative fee or premium");
  if (fills.length === 0) {
    if (fee !== 0n) throw new Error("fee without fills");
    return [];
  }
  const total = fills.reduce((sum, f) => sum + f.premium, 0n);
  if (total === 0n && fee !== 0n) throw new Error("fee without premium");
  let allocated = 0n;
  return fills.map((fill, i) => {
    const share = i === fills.length - 1 ? fee - allocated : fee * fill.premium / total;
    allocated += share;
    return share;
  });
}

/** In-kind Stock Tokens are 18 decimals; the price is USDG per whole share (6 decimals). */
export function payoutValueUsdg(
  amount: bigint,
  settlementPrice: bigint,
  assetIsUsdg: boolean,
): bigint {
  if (amount < 0n || settlementPrice < 0n) throw new Error("negative payout");
  return assetIsUsdg ? amount : amount * settlementPrice / 10n ** 18n;
}
