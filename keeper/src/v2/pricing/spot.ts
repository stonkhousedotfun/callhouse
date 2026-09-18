/**
 * The Stock Token's spot, from the market's Chainlink push feed, for the pricing service.
 *
 * WHY THE FEED AND NOT CBOE'S PRICE. Series strikes and premiums are USDG per TOKEN (ADR-04), and
 * the token is not quite a share: its feed answer already includes `uiMultiplier()` (~1.0008 for
 * NVDA), and it prints around the clock on weekdays while Cboe's file stops at the close. The feed
 * is also what the settlement oracle reads, so the fair value of a series and its payoff are
 * measured against the same number.
 *
 * WHY NOT feed.ts. v1's reader does the same normalisation (Policy.normalizeSpot) but imports the
 * v1 clients and config, which exit the process without a vault or factory key in the
 * environment. The pricing service needs neither, so the two small pieces are restated here:
 * the pure round -> spot conversion (tested against the same integers) and a viem reader over
 * RH_RPC. The reader is a SEAM: tests pass their own and touch no network.
 *
 * Freshness is judged against the wall clock the service is given, not a block: the feed prints
 * on a 0.5% move or a 24 h heartbeat, and only while the market is open, so its age is hours on a
 * quiet day and days over a weekend. The limit (the registry's `maxPriceAgeS`, v1's 4 days) is
 * there to catch a dead feed; the divergence check against Cboe's spot in fair.ts catches a wrong
 * one.
 */
import { createPublicClient, fallback, http, type Address } from 'viem';
import { failure, type PricingFailure } from './cboe.js';

/** AggregatorV3Interface: the two views read. Chainlink's interface, not a v2 contract ABI. */
export const aggregatorV3Abi = [
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
  { type: 'function', name: 'decimals', inputs: [], outputs: [{ name: '', type: 'uint8' }], stateMutability: 'view' },
] as const;

/** One `latestRoundData()` answer with the feed's `decimals()`, as read. */
export interface FeedRound {
  roundId: bigint;
  answer: bigint;
  updatedAt: bigint;
  decimals: number;
}

/** SEAM: read `feed`'s latest round. Rejects on an RPC failure. */
export type SpotReader = (feed: Address) => Promise<FeedRound>;

export interface TokenSpot {
  /** USDG base units per whole token, exactly Policy.normalizeSpot (truncating). */
  spotUsdg6: bigint;
  updatedAt: number;
  /** `nowSeconds - updatedAt`, floored at zero. */
  ageSeconds: number;
  roundId: bigint;
}

/**
 * A round, checked and normalised: positive answer, a real round (roundId 0 is an aggregator that
 * never posted), not older than `maxAgeS` at `nowSeconds`, and non-zero once truncated to 6 dp.
 */
export function tokenSpotFromRound(round: FeedRound, maxAgeS: number, nowSeconds: number): TokenSpot | PricingFailure {
  const detail = { roundId: round.roundId.toString(), answer: round.answer.toString(), updatedAt: round.updatedAt.toString(), decimals: String(round.decimals) };
  if (!Number.isInteger(round.decimals) || round.decimals < 0 || round.decimals > 77) {
    return failure('spot-unavailable', { why: 'feed decimals out of range', ...detail });
  }
  if (round.answer <= 0n) return failure('spot-unavailable', { why: 'the feed answer is not positive', ...detail });
  if (round.roundId === 0n) return failure('spot-unavailable', { why: 'roundId is 0: the aggregator has never posted', ...detail });
  const updatedAt = Number(round.updatedAt);
  const ageSeconds = Math.max(0, nowSeconds - updatedAt);
  if (ageSeconds > maxAgeS) {
    return failure('spot-stale', { why: 'the feed has not updated within the limit', ageSeconds: String(ageSeconds), maxAgeS: String(maxAgeS), ...detail });
  }
  const spotUsdg6 = round.decimals >= 6 ? round.answer / 10n ** BigInt(round.decimals - 6) : round.answer * 10n ** BigInt(6 - round.decimals);
  if (spotUsdg6 === 0n) return failure('spot-unavailable', { why: 'the answer is under one USDG base unit', ...detail });
  return { spotUsdg6, updatedAt, ageSeconds, roundId: round.roundId };
}

/**
 * The production reader: `decimals()` once per feed (immutable per aggregator), `latestRoundData()`
 * every call, over RH_RPC with RH_RPC_2 as a fallback transport when given.
 */
export function createFeedSpotReader(rpcUrls: readonly string[], timeoutMs = 10_000): SpotReader {
  if (rpcUrls.length === 0) throw new Error('createFeedSpotReader: no RPC URL');
  const transports = rpcUrls.map((url) => http(url, { timeout: timeoutMs, retryCount: 1 }));
  const client = createPublicClient({ transport: transports.length === 1 ? transports[0]! : fallback(transports) });
  const decimalsByFeed = new Map<string, number>();
  return async (feed) => {
    const key = feed.toLowerCase();
    const cached = decimalsByFeed.get(key);
    const [decimals, round] = await Promise.all([
      cached !== undefined ? Promise.resolve(cached) : client.readContract({ address: feed, abi: aggregatorV3Abi, functionName: 'decimals' }).then(Number),
      client.readContract({ address: feed, abi: aggregatorV3Abi, functionName: 'latestRoundData' }),
    ]);
    decimalsByFeed.set(key, decimals);
    const [roundId, answer, , updatedAt] = round;
    return { roundId, answer, updatedAt, decimals };
  };
}
