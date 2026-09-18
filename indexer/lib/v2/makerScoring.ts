import type { FillableOrder } from "./book";

const DAY = 86_400n;
const WEEK = 7n * DAY;
const BPS = 10_000n;
const PPM = 1_000_000n;

/** One resting bid and one ask qualify a maker without an admin tier. */
export const MIN_RESTING_ORDERS = 2;
/** The fair-value band for a two-sided quote. */
export const FAIR_BAND_BPS = 100n;
/** Depth is measured in 0.01-share units inside one percent of fair. */
export const DEPTH_BAND_BPS = 100n;
export const MAX_FAIR_AGE_SECONDS = 3_600n;

/** Enrollment persists through the epoch so a maker's later fills and downtime are still recorded. */
export function enrolledMakerKeys(tiers: ReadonlyMap<string, number>, orderCounts: ReadonlyMap<string, number>,
  currentEpochMakers: Iterable<string>): Set<string> {
  const enrolled = new Set(currentEpochMakers);
  for (const [maker, tier] of tiers) if (tier > 0) enrolled.add(maker);
  for (const [maker, count] of orderCounts) if (count >= MIN_RESTING_ORDERS) enrolled.add(maker);
  return enrolled;
}

/** Monday 00:00 UTC in Unix seconds; unlike win windows, maker epochs do not follow NY DST. */
export function makerWeekStartUtc(at: bigint): bigint {
  if (at < 0n) throw new RangeError("maker epoch timestamp must be nonnegative");
  const day = at / DAY;
  const daysAfterMonday = (day + 3n) % 7n; // Unix day zero was Thursday.
  return (day - daysAfterMonday) * DAY;
}

/** The RewardsDistributor uint256 epoch ID; Monday starts are congruent to 345600 mod 604800. */
export function makerWeekIndex(start: bigint): bigint {
  if (makerWeekStartUtc(start) !== start) throw new RangeError("epoch start must be Monday UTC");
  return start / WEEK;
}

export function makerWeekStartFromIndex(index: bigint): bigint {
  if (index < 0n) throw new RangeError("epoch index must be nonnegative");
  return index * WEEK + 4n * DAY;
}

export type MakerQuality = { twoSided: boolean; spreadBps: bigint | null; depthWithin100bps: bigint };

function within(price: bigint, fair: bigint, bandBps: bigint): boolean {
  const delta = price > fair ? price - fair : fair - price;
  return delta * BPS <= fair * bandBps;
}

/** Orders have already passed the same expiry and AskWrite collateral checks as /v2/book. */
export function sampleMakerSeries(orders: readonly FillableOrder[], fair: bigint, fairBandBps = FAIR_BAND_BPS): MakerQuality {
  if (fair <= 0n || fairBandBps < 0n || fairBandBps > BPS) throw new RangeError("invalid fair quote or fair band");
  let bestBid: bigint | null = null;
  let bestAsk: bigint | null = null;
  let depth = 0n;
  for (const order of orders) {
    if (order.units <= 0n) continue;
    if (within(order.price, fair, DEPTH_BAND_BPS)) depth += order.units;
    if (!within(order.price, fair, fairBandBps)) continue;
    if (order.kind === "Bid") {
      if (bestBid === null || order.price > bestBid) bestBid = order.price;
    } else if (bestAsk === null || order.price < bestAsk) {
      bestAsk = order.price;
    }
  }
  if (bestBid === null || bestAsk === null) return { twoSided: false, spreadBps: null, depthWithin100bps: depth };
  const difference = bestAsk > bestBid ? bestAsk - bestBid : 0n;
  return { twoSided: true, spreadBps: (difference * BPS) / fair, depthWithin100bps: depth };
}

export type FlowTotals = { fills: number; volumeUsdg: bigint; rebatesUsdg: bigint };
export type MakerEpochState = {
  maker: `0x${string}`;
  epoch: bigint;
  tierBps: number;
  samples: number;
  twoSidedSamples: number;
  uptimePpm: bigint;
  avgSpreadBps: bigint;
  depthWithin100bps: bigint;
  fills: number;
  volumeUsdg: bigint;
  rebatesUsdg: bigint;
  scorePpm: bigint;
};

export function emptyMakerEpoch(maker: `0x${string}`, epoch: bigint, tierBps = 0): MakerEpochState {
  return { maker, epoch, tierBps, samples: 0, twoSidedSamples: 0, uptimePpm: 0n, avgSpreadBps: 0n,
    depthWithin100bps: 0n, fills: 0, volumeUsdg: 0n, rebatesUsdg: 0n, scorePpm: 0n };
}

/** A tick contributes one sample per tracked series whose fair quote is fresh. */
export function advanceMakerEpoch(previous: MakerEpochState, observations: readonly MakerQuality[], flows: FlowTotals, tierBps: number): MakerEpochState {
  const count = previous.samples + observations.length;
  const sided = previous.twoSidedSamples + observations.filter((value) => value.twoSided).length;
  const spreadSum = observations.reduce((sum, value) => sum + (value.spreadBps ?? 0n), 0n);
  const depthSum = observations.reduce((sum, value) => sum + value.depthWithin100bps, 0n);
  return {
    ...previous,
    tierBps,
    samples: count,
    twoSidedSamples: sided,
    uptimePpm: count === 0 ? 0n : (BigInt(sided) * PPM) / BigInt(count),
    avgSpreadBps: sided === 0 ? 0n : (previous.avgSpreadBps * BigInt(previous.twoSidedSamples) + spreadSum) / BigInt(sided),
    depthWithin100bps: count === 0 ? 0n : (previous.depthWithin100bps * BigInt(previous.samples) + depthSum) / BigInt(count),
    // Event-derived flows are recomputed over the epoch at each tick; never add the same fill twice.
    fills: flows.fills,
    volumeUsdg: flows.volumeUsdg,
    rebatesUsdg: flows.rebatesUsdg,
  };
}

/** Rank 0..1e6 within an epoch; equal positive values tie at the same rank. */
function rank(rows: readonly MakerEpochState[], current: MakerEpochState, value: (row: MakerEpochState) => bigint, lowerIsBetter = false): bigint {
  const currentValue = value(current);
  if (currentValue <= 0n) return 0n;
  const eligible = rows.filter((row) => value(row) > 0n);
  if (eligible.length <= 1) return PPM;
  const better = eligible.filter((row) => lowerIsBetter ? value(row) < currentValue : value(row) > currentValue).length;
  return PPM - (BigInt(better) * PPM) / BigInt(eligible.length - 1);
}

/** 0.4 uptime + 0.3 depth rank + 0.2 spread rank + 0.1 volume rank, all in ppm. */
export function scoreMakerEpochs(rows: readonly MakerEpochState[]): MakerEpochState[] {
  return rows.map((row) => {
    const depthRank = rank(rows, row, (value) => value.depthWithin100bps);
    const spreadRank = row.twoSidedSamples === 0 ? 0n : rank(rows, row, (value) => value.twoSidedSamples > 0 ? value.avgSpreadBps + 1n : 0n, true);
    const volumeRank = rank(rows, row, (value) => value.volumeUsdg);
    const scorePpm = (4n * row.uptimePpm + 3n * depthRank + 2n * spreadRank + volumeRank) / 10n;
    return { ...row, scorePpm };
  });
}

export function flowTotalsForMaker<T extends { maker: `0x${string}`; premium: bigint; makerRebate: bigint }>(rows: readonly T[], maker: string): FlowTotals {
  const filtered = rows.filter((row) => row.maker.toLowerCase() === maker.toLowerCase());
  return { fills: filtered.length, volumeUsdg: filtered.reduce((sum, row) => sum + row.premium, 0n),
    rebatesUsdg: filtered.reduce((sum, row) => sum + row.makerRebate, 0n) };
}
