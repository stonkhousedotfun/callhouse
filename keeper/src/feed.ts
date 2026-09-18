/**
 * The Chainlink spot, read the way the contracts read it.
 *
 * WHY THIS MODULE EXISTS: the pooled vault exposes `spotUsdg()`, a view that does the feed read,
 * the staleness gate and the decimal normalisation on chain, and the keeper simply asked it. A
 * factory market has no vault. The factory and its WriterAccount clones read the feed themselves
 * inside `list()` and every fill (ValoremLib.spotUsdg through Policy.normalizeSpot), so the keeper
 * must reproduce that read here, integer for integer, or it prices a week the accounts will refuse:
 *
 *   spotUsdg(feed, maxAge):
 *     (, answer,, updatedAt,) = feed.latestRoundData()
 *     if (block.timestamp - updatedAt > maxAge) revert StalePrice
 *     return Policy.normalizeSpot(answer, feed.decimals())
 *
 *   normalizeSpot(answer, dec):
 *     if (answer <= 0) revert SpotZero
 *     dec >= 6 ? answer / 10^(dec-6) : answer * 10^(6-dec)       -- integer division, truncating
 *     if (result == 0) revert SpotZero
 *
 * The keeper is stricter than the contracts in one respect: a `roundId` of 0 is refused too. The
 * contracts do not look at it, but a proxy whose aggregator has never posted answers with round 0
 * and (on some implementations) a non-zero stale answer; nothing should be priced on that.
 *
 * `decimals()` is immutable per aggregator and is cached per feed address for the life of the
 * process. Every Robinhood equity feed is 8 dp (ops/markets/tier1.json `verification.feedDecimals`),
 * but the cache is keyed by address so a 6 or 18 dp feed would also be right.
 *
 * `nowSeconds` is the head block's timestamp, never the wall clock: the age a fill sees is
 * `block.timestamp - updatedAt`, and the head block is the closest the keeper has to that.
 */
import type { Address } from 'viem';
import { publicClient } from './clients.js';

/*//////////////////////////////////////////////////////////////
                              ABI
//////////////////////////////////////////////////////////////*/

/** AggregatorV3Interface, the two functions the contracts call. */
export const feedAbi = [
  {
    type: 'function',
    name: 'latestRoundData',
    inputs: [],
    outputs: [
      { name: 'roundId', type: 'uint80' },
      { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'decimals',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
    stateMutability: 'view',
  },
] as const;

/*//////////////////////////////////////////////////////////////
                              TYPES
//////////////////////////////////////////////////////////////*/

/** One `latestRoundData()` answer, as read. */
export interface FeedRound {
  roundId: bigint;
  answer: bigint;
  updatedAt: bigint;
}

export interface FeedSpot {
  /** Spot for ONE lot in USDG base units (6 dp), exactly `Policy.normalizeSpot`. */
  spotUsdg6: bigint;
  /** The raw answer, in the feed's own decimals. */
  answer: bigint;
  updatedAt: number;
  /** `nowSeconds - updatedAt`, floored at zero. */
  ageS: number;
  roundId: bigint;
  decimals: number;
}

/** Why a round could not be priced on. `stale` is the contracts' own StalePrice; the other two
 *  are SpotZero (`not-positive`, `normalises-to-zero`) and the keeper's own round-0 refusal. */
export type FeedRejectCode = 'not-positive' | 'normalises-to-zero' | 'round-zero' | 'stale';

export class FeedError extends Error {
  constructor(
    readonly code: FeedRejectCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'FeedError';
  }
}

/*//////////////////////////////////////////////////////////////
                          PURE NORMALISATION
//////////////////////////////////////////////////////////////*/

/**
 * `Policy.normalizeSpot`, in bigint. Throws FeedError('not-positive') on `answer <= 0` and
 * FeedError('normalises-to-zero') when the truncation leaves nothing (a 4 dp feed printing 0.0001
 * still normalises to 100; a 12 dp feed printing 1 does not).
 */
export function normalizeSpot(answer: bigint, feedDecimals: number): bigint {
  if (!Number.isInteger(feedDecimals) || feedDecimals < 0 || feedDecimals > 77) {
    throw new RangeError(`feed decimals out of range: ${feedDecimals}`);
  }
  if (answer <= 0n) throw new FeedError('not-positive', `answer ${answer} is not positive`);
  const spot = feedDecimals >= 6 ? answer / 10n ** BigInt(feedDecimals - 6) : answer * 10n ** BigInt(6 - feedDecimals);
  if (spot === 0n) throw new FeedError('normalises-to-zero', `answer ${answer} at ${feedDecimals} dp is under one USDG base unit`);
  return spot;
}

/**
 * Every check between a raw round and a usable spot, in the contracts' order plus the round-0
 * refusal: positive answer, a real round, not older than `maxAgeS` at `nowSeconds`, then
 * normalised. Pure, so the unit test drives it without a chain.
 */
export function feedSpotFromRound(round: FeedRound, decimals: number, maxAgeS: number, nowSeconds: number): FeedSpot {
  if (round.answer <= 0n) throw new FeedError('not-positive', `answer ${round.answer} is not positive`);
  if (round.roundId === 0n) throw new FeedError('round-zero', 'roundId is 0: the aggregator has never posted');
  const updatedAt = Number(round.updatedAt);
  // A feed updated in the head block itself reads as age 0; a feed "from the future" only
  // happens when the RPC served a lagging head, and is not this module's problem to refuse.
  const ageS = Math.max(0, nowSeconds - updatedAt);
  if (ageS > maxAgeS) {
    throw new FeedError('stale', `updated ${updatedAt}, ${ageS}s ago at block time ${nowSeconds}; the limit is ${maxAgeS}s (StalePrice)`);
  }
  return { spotUsdg6: normalizeSpot(round.answer, decimals), answer: round.answer, updatedAt, ageS, roundId: round.roundId, decimals };
}

/*//////////////////////////////////////////////////////////////
                            CHAIN READS
//////////////////////////////////////////////////////////////*/

const decimalsCache = new Map<string, number>();

/** `feed.decimals()`, read once per address per process. */
export async function readFeedDecimals(feed: Address): Promise<number> {
  const key = feed.toLowerCase();
  const cached = decimalsCache.get(key);
  if (cached !== undefined) return cached;
  const decimals = await publicClient.readContract({ address: feed, abi: feedAbi, functionName: 'decimals' });
  decimalsCache.set(key, Number(decimals));
  return Number(decimals);
}

/** SEAM for tests: forget every cached `decimals()`. */
export function resetFeedCache(): void {
  decimalsCache.clear();
}

/**
 * The spot the factory's accounts would price this instant: `latestRoundData()` at `feed`,
 * refused when stale against `maxAgeS` (the factory's `maxPriceAge()`) at `nowSeconds` (the head
 * block's clock), normalised to USDG base units per lot. Throws FeedError on a refusal and lets an
 * RPC failure propagate; the caller decides which of those is a skipped week and which is a tick
 * to retry.
 */
export async function readFeedSpot(feed: Address, maxAgeS: number, nowSeconds: number): Promise<FeedSpot> {
  const [decimals, round] = await Promise.all([
    readFeedDecimals(feed),
    publicClient.readContract({ address: feed, abi: feedAbi, functionName: 'latestRoundData' }),
  ]);
  const [roundId, answer, , updatedAt] = round;
  return feedSpotFromRound({ roundId, answer, updatedAt }, decimals, maxAgeS, nowSeconds);
}
