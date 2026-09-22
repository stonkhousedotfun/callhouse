import type { FillableOrder } from "./book";

const DAY = 86_400n;
const WEEK = 7n * DAY;
const BPS = 10_000n;
const PPM = 1_000_000n;

/** One resting bid and one ask qualify a maker without an admin tier. */
export const MIN_RESTING_ORDERS = 2;
/**
 * The fair-value band for a two-sided quote, BEFORE the epoch band existed. Kept because
 * {@link sampleMakerSeries} still accepts a plain bps band for callers that have no policy, and because
 * removing it would silently change what an unpolicied caller measures.
 */
export const FAIR_BAND_BPS = 100n;
/**
 * Depth is measured in 0.01-share units inside one percent of fair. THIS CONSTANT NEVER MOVES AND NEVER
 * TAKES THE EPOCH BAND: `depthWithin100bps` is the one published field whose NAME pins its band
 * (02-interfaces.md:870-873), so re-pointing it at the policy band would change a published statistic's
 * meaning while leaving its name intact. `depthInBand` is the band-relative twin.
 */
export const DEPTH_BAND_BPS = 100n;
export const MAX_FAIR_AGE_SECONDS = 3_600n;

/** A band is bps of fair with an absolute USDG floor, so a cheap series is not scored on rounding. */
export type ScoringBand = { bps: bigint; minUsdg: bigint };

/**
 * THE ONE PLACE THE SCORING POLICY IS WRITTEN DOWN. The band and the weights are data, carried on the
 * epoch object so a consumer can see which policy produced a figure, and changing them later is a data
 * change rather than a code change at a dozen use sites.
 *
 * THESE VALUES ARE OQ-14 PLACEHOLDERS AND ARE NOT APPROVED FOR FUNDED USE
 * (02-interfaces.md:863-866, OWNER-DECISIONS-2026-09-19.md D9). Band 1000 bps with a 0.02 USDG floor and
 * weights 50/30/20/0 are PROPOSALS; a 0.03 USDG floor was also proposed and neither floor is approved.
 * X3-201 confirms them before any funded epoch. D9 also forbids widening the band merely to reward poor
 * quotes, so widening it is an owner decision, not a tuning knob.
 *
 * `minUsdg` is in USDG base units (6 dp), the same unit as an order price: 20_000n is 0.02 USDG.
 * Weights are percentages and MUST sum to 100.
 */
export const MAKER_SCORING_POLICY = Object.freeze({
  /** Bump whenever the band or the weights change what a score means. */
  version: 1,
  band: Object.freeze({ bps: 1_000n, minUsdg: 20_000n }) as ScoringBand,
  weights: Object.freeze({ uptime: 50n, depth: 30n, spread: 20n, volume: 0n }),
});

const WEIGHT_TOTAL = MAKER_SCORING_POLICY.weights.uptime + MAKER_SCORING_POLICY.weights.depth
  + MAKER_SCORING_POLICY.weights.spread + MAKER_SCORING_POLICY.weights.volume;
if (WEIGHT_TOTAL !== 100n) {
  // A weight set that does not sum to 100 does not produce a smaller score, it produces a score on a
  // different scale that still looks like a percentage. Fail at load rather than publish it.
  throw new RangeError(`maker scoring weights sum to ${WEIGHT_TOTAL}, not 100`);
}

/**
 * WHICH BENCHMARK PRODUCED A SCORE. Scores, uptime, spread and depth are comparable ONLY between rows
 * with the same policy; across policies they are different measurements that share a name.
 *   1 - the live /fair pricing estimate (6090d49 until callhouse 109e664b). It was never recorded, so a
 *       maker row or API item that carries no policy is a policy-1 figure.
 *   2 - chain only (T-307, callhouse 109e664b): the premium-weighted price of OTHER participants'
 *       fills on the series in the last hour. Replaying the same blocks gives the same figures.
 * Bump it whenever the benchmark or the sample rules change what a figure means.
 */
export const MAKER_BENCHMARK_POLICY = 2;

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

/**
 * `depthWithin100bps` is the 100 bps statistic and keeps that meaning forever; `depthInBand` is the same
 * measurement taken inside the epoch's band. They are equal only when the band happens to be 100 bps with
 * a floor small enough to change nothing, and a caller must never treat one as the other's alias.
 */
export type MakerQuality = { twoSided: boolean; spreadBps: bigint | null; depthWithin100bps: bigint; depthInBand: bigint };

/**
 * One enrolled maker on one tracked series at one tick. The three kinds are different facts and are
 * counted separately, so "never quoted" can never read as "quoted and scored zero":
 *   absent           - no fillable quote on either side. Definite downtime; no benchmark is needed.
 *   valid            - quoted, and measured against a chain reference. It may still measure zero.
 *   missingReference - quoted, but no chain reference exists, so nothing could be measured.
 * Absent and valid samples enter uptime and depth; a missing reference does not, because a missing
 * benchmark is not the maker's downtime.
 */
export type MakerSample =
  | { kind: "absent" }
  | { kind: "valid"; quality: MakerQuality }
  | { kind: "missingReference" };

function within(price: bigint, fair: bigint, bandBps: bigint): boolean {
  const delta = price > fair ? price - fair : fair - price;
  return delta * BPS <= fair * bandBps;
}

/**
 * The band test, exactly as 02-interfaces.md:895 states it: a price is inside the band when
 * `|price - fair| <= max(fair * bps / 10_000, minUsdg)`. The floor is what keeps a cheap series from being
 * scored on rounding: 1000 bps of a 0.05 USDG fair is 0.005 USDG, narrower than one price tick.
 */
export function withinBand(price: bigint, fair: bigint, band: ScoringBand): boolean {
  const delta = price > fair ? price - fair : fair - price;
  const proportional = (fair * band.bps) / BPS;
  const allowed = proportional > band.minUsdg ? proportional : band.minUsdg;
  return delta <= allowed;
}

/**
 * Orders have already passed the same expiry and AskWrite collateral checks as /v2/book.
 *
 * `band` decides the two-sided test behind uptime and spread AND `depthInBand` (02-interfaces.md:895-897).
 * `depthWithin100bps` is computed from {@link DEPTH_BAND_BPS} in the same pass and ignores `band` entirely,
 * which is the whole point of keeping both: one field's name pins its band, the other's does not.
 */
export function sampleMakerSeries(orders: readonly FillableOrder[], fair: bigint,
  band: ScoringBand = MAKER_SCORING_POLICY.band): MakerQuality {
  if (fair <= 0n) throw new RangeError("invalid fair quote");
  if (band.bps < 0n || band.bps > BPS || band.minUsdg < 0n) throw new RangeError("invalid scoring band");
  let bestBid: bigint | null = null;
  let bestAsk: bigint | null = null;
  let depthWithin100bps = 0n;
  let depthInBand = 0n;
  for (const order of orders) {
    if (order.units <= 0n) continue;
    if (within(order.price, fair, DEPTH_BAND_BPS)) depthWithin100bps += order.units;
    if (!withinBand(order.price, fair, band)) continue;
    depthInBand += order.units;
    if (order.kind === "Bid") {
      if (bestBid === null || order.price > bestBid) bestBid = order.price;
    } else if (bestAsk === null || order.price < bestAsk) {
      bestAsk = order.price;
    }
  }
  if (bestBid === null || bestAsk === null) return { twoSided: false, spreadBps: null, depthWithin100bps, depthInBand };
  const difference = bestAsk > bestBid ? bestAsk - bestBid : 0n;
  return { twoSided: true, spreadBps: (difference * BPS) / fair, depthWithin100bps, depthInBand };
}

export type FlowTotals = { fills: number; volumeUsdg: bigint; rebatesUsdg: bigint };
export type MakerEpochState = {
  maker: `0x${string}`;
  epoch: bigint;
  tierBps: number;
  /** {@link MAKER_BENCHMARK_POLICY} at the time the row was scored. */
  benchmarkPolicy: number;
  /** absentSamples + validSamples: the samples uptime and depth are averaged over. */
  samples: number;
  absentSamples: number;
  validSamples: number;
  missingReferenceSamples: number;
  twoSidedSamples: number;
  uptimePpm: bigint;
  avgSpreadBps: bigint;
  depthWithin100bps: bigint;
  /** The same mean, taken inside the epoch's band. Scored; `depthWithin100bps` is published, not scored. */
  depthInBand: bigint;
  fills: number;
  volumeUsdg: bigint;
  rebatesUsdg: bigint;
  scorePpm: bigint;
};

export function emptyMakerEpoch(maker: `0x${string}`, epoch: bigint, tierBps = 0): MakerEpochState {
  return { maker, epoch, tierBps, benchmarkPolicy: MAKER_BENCHMARK_POLICY, samples: 0, absentSamples: 0,
    validSamples: 0, missingReferenceSamples: 0, twoSidedSamples: 0, uptimePpm: 0n, avgSpreadBps: 0n,
    depthWithin100bps: 0n, depthInBand: 0n, fills: 0, volumeUsdg: 0n, rebatesUsdg: 0n, scorePpm: 0n };
}

/**
 * A tick contributes one sample per tracked series. An absent sample counts as a one-sided, zero-depth
 * observation; a missing-reference sample is counted but averaged into nothing.
 */
export function advanceMakerEpoch(previous: MakerEpochState, samples: readonly MakerSample[], flows: FlowTotals, tierBps: number): MakerEpochState {
  // One epoch row is one definition. Ponder never serves two builds from one schema, so a mismatch here
  // means a row was written by other code; averaging into it is exactly the silent mix T-312 forbids.
  if (previous.benchmarkPolicy !== MAKER_BENCHMARK_POLICY) {
    throw new RangeError(`maker epoch row is benchmark policy ${previous.benchmarkPolicy}, not ${MAKER_BENCHMARK_POLICY}`);
  }
  const measured = samples.flatMap((sample) => sample.kind === "valid" ? [sample.quality] : []);
  const absent = samples.filter((sample) => sample.kind === "absent").length;
  const missingReference = samples.filter((sample) => sample.kind === "missingReference").length;
  const count = previous.samples + absent + measured.length;
  const sided = previous.twoSidedSamples + measured.filter((value) => value.twoSided).length;
  const spreadSum = measured.reduce((sum, value) => sum + (value.spreadBps ?? 0n), 0n);
  const depthSum = measured.reduce((sum, value) => sum + value.depthWithin100bps, 0n);
  const bandDepthSum = measured.reduce((sum, value) => sum + value.depthInBand, 0n);
  return {
    ...previous,
    tierBps,
    samples: count,
    absentSamples: previous.absentSamples + absent,
    validSamples: previous.validSamples + measured.length,
    missingReferenceSamples: previous.missingReferenceSamples + missingReference,
    twoSidedSamples: sided,
    uptimePpm: count === 0 ? 0n : (BigInt(sided) * PPM) / BigInt(count),
    avgSpreadBps: sided === 0 ? 0n : (previous.avgSpreadBps * BigInt(previous.twoSidedSamples) + spreadSum) / BigInt(sided),
    depthWithin100bps: count === 0 ? 0n : (previous.depthWithin100bps * BigInt(previous.samples) + depthSum) / BigInt(count),
    // Averaged over the same denominator as depthWithin100bps, so the two are comparable per sample even
    // though they measure different bands.
    depthInBand: count === 0 ? 0n : (previous.depthInBand * BigInt(previous.samples) + bandDepthSum) / BigInt(count),
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

/**
 * The epoch's weights applied to uptime and the three ranks, all in ppm. The weights come from
 * {@link MAKER_SCORING_POLICY} and are never written here: a weight inlined at this site is a weight the
 * published `band`/policy cannot describe.
 *
 * DEPTH IS RANKED ON `depthInBand`, not on `depthWithin100bps`. The score is defined against the epoch's
 * policy (02-interfaces.md:857-860), and `depthWithin100bps` is a published statistic on a fixed band that
 * the policy does not control.
 */
export function scoreMakerEpochs(rows: readonly MakerEpochState[]): MakerEpochState[] {
  const weights = MAKER_SCORING_POLICY.weights;
  return rows.map((row) => {
    const depthRank = rank(rows, row, (value) => value.depthInBand);
    const spreadRank = row.twoSidedSamples === 0 ? 0n : rank(rows, row, (value) => value.twoSidedSamples > 0 ? value.avgSpreadBps + 1n : 0n, true);
    const volumeRank = rank(rows, row, (value) => value.volumeUsdg);
    const scorePpm = (weights.uptime * row.uptimePpm + weights.depth * depthRank
      + weights.spread * spreadRank + weights.volume * volumeRank) / 100n;
    return { ...row, scorePpm };
  });
}

export function flowTotalsForMaker<T extends { maker: `0x${string}`; premium: bigint; makerRebate: bigint }>(rows: readonly T[], maker: string): FlowTotals {
  const filtered = rows.filter((row) => row.maker.toLowerCase() === maker.toLowerCase());
  return { fills: filtered.length, volumeUsdg: filtered.reduce((sum, row) => sum + row.premium, 0n),
    rebatesUsdg: filtered.reduce((sum, row) => sum + row.makerRebate, 0n) };
}
