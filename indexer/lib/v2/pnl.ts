export type PositionTotals = {
  unitsBought: bigint;
  costUsdg: bigint;
  unitsSold: bigint;
  proceedsUsdg: bigint;
  unitsTransferredOut: bigint;
  unitsRedeemed: bigint;
  payoutUsdgValue: bigint;
  realisedUsdg: bigint;
  multiple: string | null;
  multiplePpm: bigint | null;
  closedAt: bigint | null;
  selfFill: boolean;
  belowMinCost: boolean;
  offMarket: boolean;
  transferIn: boolean;
  transferredOut: boolean;
};

export const emptyPosition = (): PositionTotals => ({
  unitsBought: 0n, costUsdg: 0n, unitsSold: 0n, proceedsUsdg: 0n, unitsTransferredOut: 0n,
  unitsRedeemed: 0n, payoutUsdgValue: 0n, realisedUsdg: 0n,
  multiple: null, multiplePpm: null, closedAt: null,
  selfFill: false, belowMinCost: false, offMarket: false, transferIn: false, transferredOut: false,
});

function multipleOf(position: PositionTotals): Pick<PositionTotals, "multiple" | "multiplePpm"> {
  if (position.costUsdg <= 0n) return { multiple: null, multiplePpm: null };
  const ppm = (position.proceedsUsdg + position.payoutUsdgValue) * 1_000_000n / position.costUsdg;
  return { multiplePpm: ppm, multiple: `${ppm / 1_000_000n}.${(ppm % 1_000_000n).toString().padStart(6, "0")}` };
}

export function buyPosition(position: PositionTotals, units: bigint, cost: bigint, selfFill = false, offMarket = false): PositionTotals {
  if (units <= 0n || cost < 0n) throw new Error("invalid buy");
  return { ...position, unitsBought: position.unitsBought + units, costUsdg: position.costUsdg + cost,
    selfFill: position.selfFill || selfFill, offMarket: position.offMarket || offMarket,
    closedAt: null, ...multipleOf({ ...position, costUsdg: position.costUsdg + cost }) };
}

export function sellPosition(
  position: PositionTotals, units: bigint, proceeds: bigint, consumedCost: bigint, transferIn: boolean,
): PositionTotals {
  if (units <= 0n || proceeds < 0n || consumedCost < 0n) throw new Error("invalid sale");
  const next = {
    ...position, unitsSold: position.unitsSold + units, proceedsUsdg: position.proceedsUsdg + proceeds,
    realisedUsdg: position.realisedUsdg + proceeds - consumedCost,
    transferIn: position.transferIn || transferIn,
  };
  return { ...next, ...multipleOf(next) };
}

export function redeemPosition(
  position: PositionTotals, units: bigint, payout: bigint, consumedCost: bigint, transferIn: boolean,
): PositionTotals {
  if (units <= 0n || payout < 0n || consumedCost < 0n) throw new Error("invalid redemption");
  const next = {
    ...position, unitsRedeemed: position.unitsRedeemed + units,
    payoutUsdgValue: position.payoutUsdgValue + payout,
    realisedUsdg: position.realisedUsdg + payout - consumedCost,
    transferIn: position.transferIn || transferIn,
  };
  return { ...next, ...multipleOf(next) };
}

/** A gift moves basis out without sale proceeds; neither wallet can claim it as an organic win. */
export function transferOutPosition(position: PositionTotals, units: bigint): PositionTotals {
  if (units <= 0n) throw new Error("invalid transfer quantity");
  return { ...position, unitsTransferredOut: position.unitsTransferredOut + units, transferredOut: true };
}

export function markTransferIn(position: PositionTotals): PositionTotals {
  return { ...position, transferIn: true };
}

/** A close is only published after no owned cost-basis units remain. */
export function closePosition(position: PositionTotals, at: bigint): PositionTotals {
  if (at < 0n) throw new Error("negative close timestamp");
  return { ...position, closedAt: at, belowMinCost: position.costUsdg < 100_000n, ...multipleOf(position) };
}

export function isWin(position: PositionTotals): boolean {
  return position.closedAt !== null && position.multiplePpm !== null && position.multiplePpm > 1_000_000n &&
    !isExcludedFromLeaderboard(position);
}

export function isExcludedFromLeaderboard(position: PositionTotals): boolean {
  return position.selfFill || position.belowMinCost || position.offMarket || position.transferIn || position.transferredOut ||
    position.costUsdg <= 0n;
}

/** Cost below 0.10 USDG is never eligible, even if the displayed multiple is large. */
export const MIN_FEED_COST_USDG = 100_000n;
