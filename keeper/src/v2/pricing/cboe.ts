/**
 * Any ticker's Cboe delayed option chain: fetched, cached per ticker, and judged before a single
 * mid can become a price.
 *
 * WHAT CARRIES OVER FROM v1 (src/vol.ts), unchanged and imported rather than copied, so the two
 * cannot drift: the hostile-response fetch (https only, one deadline over connect, headers and
 * body, a byte cap enforced while streaming, same-host redirects only, strict UTF-8, the schema
 * and its row cap), the symbol parser (exact root, real calendar day), the two clocks and their
 * freshness rule (maxAge on both, a file from the future or a trade newer than its file is
 * inconsistent, and the last trade must belong to the latest NYSE session that closed at least
 * SESSION_GRACE_S ago), the share of rows allowed to fail parsing, the spread and quote-size
 * limits, the bracket-gap limit and the delta-monotonicity tolerance.
 *
 * WHAT IS NEW: puts. v1 priced one weekly call, so its quote filter demanded a delta in (0, 1)
 * and its window check only knew that a call cannot cost more at a higher strike. Here both are
 * per side: a put's delta lies in (-1, 0), and a put cannot cost more at a LOWER strike. Delta
 * monotonicity and butterfly convexity read the same for both (put and call deltas both fall as
 * the strike rises; both prices are convex in strike). For calls the two functions below answer
 * exactly what vol.ts's do; a test pins that on every row of the real chain.
 *
 * THE CACHE. One entry per ticker. A download is reused for PRICING_MIN_REFETCH_MS, the floor v1 set
 * for the same reason (roll.ts VOL_MIN_REFETCH_MS): a service asked for 35 markets' fair values every
 * few seconds would otherwise pull megabytes from a free feed on every request, which is how an IP gets
 * blocked. A FAILED refetch keeps serving the last good chain of the same URL (with the error beside
 * it) and is retried after PRICING_FAILURE_RETRY_MS, doubling per consecutive failure up to the floor:
 * one timeout must not take a ticker's fair values away for five minutes. Reuse never makes data look
 * fresher, because every decision judges the chain's own clocks. Concurrent asks for the same ticker
 * share one download.
 *
 * Pure except ChainCache, which takes its fetch and its clock as seams.
 */
import { NYSE_HOLIDAYS_2026_2028 } from '../../calendar.js';
import {
  DELTA_MONOTONE_TOLERANCE,
  MAX_QUOTE_USD,
  MAX_SKIPPED_ROW_FRACTION,
  MAX_SPREAD_FRACTION_OF_MID,
  MAX_SPREAD_USD,
  chainFreshness,
  fetchCboeChain,
  maxBracketGap,
  type CboeChain,
  type CboeOption,
  type FetchChainOptions,
} from '../../vol.js';

/*//////////////////////////////////////////////////////////////
                         REASONS AND LIMITS
//////////////////////////////////////////////////////////////*/

export type OptionSide = 'C' | 'P';

/**
 * Why a price is not given. Every refusal anywhere in the service is one of these plus a detail
 * map of strings; nothing about bad market data is ever thrown to the HTTP layer.
 *   chain-unavailable    the download failed (network, status, size, shape)
 *   chain-stale          the last trade or the file is older than allowed, or not the latest session
 *   chain-inconsistent   wrong root, clocks that disagree, rows that mostly fail to parse, or quotes
 *                        that break put-call parity near the money
 *   spot-unavailable     the Stock Token feed could not be read, or answered nonsense
 *   spot-stale           the feed's last update is older than allowed
 *   spot-divergence      token spot / Cboe spot is further from 1 than allowed
 *   no-quotes            nothing usable to price from at this expiry or strike
 *   quotes-inconsistent  the quotes the price would come from fail a window check or a gap
 *   expired              the expiry is not in the future
 *   unknown-ticker       the registry has no such market
 */
export type PricingReason =
  | 'unknown-ticker'
  | 'chain-unavailable'
  | 'chain-stale'
  | 'chain-inconsistent'
  | 'spot-unavailable'
  | 'spot-stale'
  | 'spot-divergence'
  | 'no-quotes'
  | 'quotes-inconsistent'
  | 'expired';

export interface PricingFailure {
  ok: false;
  reason: PricingReason;
  detail: Record<string, string>;
}

export function failure(reason: PricingReason, detail: Record<string, string> = {}): PricingFailure {
  return { ok: false, reason, detail };
}

/** The least time between two downloads of one ticker's chain, wall clock. v1's floor. */
export const PRICING_MIN_REFETCH_MS = 5 * 60_000;

/** A failed download is retried after this, doubled per consecutive failure, at most PRICING_MIN_REFETCH_MS. */
export const PRICING_FAILURE_RETRY_MS = 60_000;

/** Deadline for one whole download. v1's default (KEEPER_VOL_TIMEOUT_MS). */
export const DEFAULT_CHAIN_TIMEOUT_MS = 10_000;

/** Byte cap for one chain. v1's 8 MB was sized for NVDA (~1.9 MB); the registry's largest chains
 *  are SPY (13,100 rows) and QQQ (11,432) at ~450 bytes a row, ~6 MB on a normal day and more
 *  in a quarterly-expiry week. vol.ts's MAX_OPTION_ROWS (50,000) still bounds the parse. */
export const DEFAULT_CHAIN_MAX_BYTES = 16_000_000;

/** Float comparisons on prices in dollars: well under a base unit (1e-6). vol.ts's EPSILON. */
const EPSILON = 1e-9;

/*//////////////////////////////////////////////////////////////
                              QUOTES
//////////////////////////////////////////////////////////////*/

/**
 * vol.ts isUsableQuote, per side: bid > 0, ask >= bid, both under MAX_QUOTE_USD, a finite
 * non-negative iv, a spread no wider than max(MAX_SPREAD_USD, MAX_SPREAD_FRACTION_OF_MID × mid),
 * and a delta strictly inside (0, 1) for a call or (-1, 0) for a put.
 */
export function isUsableQuote(o: Pick<CboeOption, 'type' | 'bid' | 'ask' | 'delta' | 'iv' | 'strike'>): boolean {
  if (![o.bid, o.ask, o.delta, o.iv, o.strike].every(Number.isFinite)) return false;
  const deltaOk = o.type === 'C' ? o.delta > 0 && o.delta < 1 : o.type === 'P' ? o.delta > -1 && o.delta < 0 : false;
  if (!(o.bid > 0) || !(o.ask >= o.bid) || !deltaOk || o.iv < 0 || !(o.strike > 0)) return false;
  if (!(o.ask <= MAX_QUOTE_USD)) return false;
  const mid = (o.bid + o.ask) / 2;
  if (!Number.isFinite(mid)) return false;
  return o.ask - o.bid <= Math.max(MAX_SPREAD_USD, MAX_SPREAD_FRACTION_OF_MID * mid) + EPSILON;
}

/** One side's usable quotes, sorted by strike. A strike listed twice is dropped entirely. */
export function filterQuotes(options: readonly CboeOption[], side: OptionSide): CboeOption[] {
  const usable = options.filter((o) => o.type === side && isUsableQuote(o));
  const counts = new Map<number, number>();
  for (const q of usable) counts.set(q.strike, (counts.get(q.strike) ?? 0) + 1);
  return usable.filter((q) => counts.get(q.strike) === 1).sort((a, b) => a.strike - b.strike);
}

export function mid(q: Pick<CboeOption, 'bid' | 'ask'>): number {
  return (q.bid + q.ask) / 2;
}

/**
 * vol.ts checkQuoteWindow, per side. `quotes` are one side's usable quotes (filterQuotes) and
 * `bracket` the pair of listed strikes a number comes from (both ends equal for one strike). The
 * check covers those quotes and one neighbour on each side, where a corrupt row would move the
 * answer, and leaves the deep wings alone. `quotes-inconsistent` when:
 *   gap       the bracket spans more than maxBracketGap
 *   delta     a delta that rises with the strike (beyond DELTA_MONOTONE_TOLERANCE); true of both sides
 *   vertical  calls: a higher strike bid above a lower strike's ask
 *             puts:  a lower strike bid above a higher strike's ask
 *   butterfly a middle strike bid above the strike-weighted asks of its neighbours (both sides)
 */
export function checkQuoteWindow(quotes: readonly CboeOption[], side: OptionSide, bracket: readonly [number, number]): PricingFailure | null {
  const fail = (why: string, extra: Record<string, string> = {}) =>
    failure('quotes-inconsistent', { why, side, bracket: `${bracket[0]}-${bracket[1]}`, ...extra });
  const loIdx = quotes.findIndex((q) => q.strike === bracket[0]);
  const hiIdx = quotes.findIndex((q) => q.strike === bracket[1]);
  if (loIdx < 0 || hiIdx < loIdx) return fail('the bracket is not in the usable quotes');
  const gap = bracket[1] - bracket[0];
  if (gap > maxBracketGap(bracket[0]) + EPSILON) {
    return fail('the bracketing listed strikes are too far apart', { gapUsd: String(gap), maxGapUsd: maxBracketGap(bracket[0]).toFixed(4) });
  }
  const from = Math.max(0, loIdx - 1);
  const to = Math.min(quotes.length - 1, hiIdx + 1);
  for (let i = from; i < to; i += 1) {
    const lo = quotes[i]!;
    const hi = quotes[i + 1]!;
    if (hi.delta > lo.delta + DELTA_MONOTONE_TOLERANCE) {
      return fail('delta rises with the strike', { lowStrike: String(lo.strike), lowDelta: String(lo.delta), highStrike: String(hi.strike), highDelta: String(hi.delta) });
    }
    if (side === 'C' && hi.bid > lo.ask + EPSILON) {
      return fail('a higher strike call is bid above a lower strike’s ask', { lowStrike: String(lo.strike), lowAsk: String(lo.ask), highStrike: String(hi.strike), highBid: String(hi.bid) });
    }
    if (side === 'P' && lo.bid > hi.ask + EPSILON) {
      return fail('a lower strike put is bid above a higher strike’s ask', { lowStrike: String(lo.strike), lowBid: String(lo.bid), highStrike: String(hi.strike), highAsk: String(hi.ask) });
    }
  }
  for (let i = from + 1; i < to; i += 1) {
    const a = quotes[i - 1]!;
    const b = quotes[i]!;
    const c = quotes[i + 1]!;
    const lambda = (c.strike - b.strike) / (c.strike - a.strike);
    const bound = lambda * a.ask + (1 - lambda) * c.ask;
    if (b.bid > bound + EPSILON) {
      return fail('an option is bid above the convex bound of its neighbours', { strike: String(b.strike), bid: String(b.bid), bound: bound.toFixed(6) });
    }
  }
  return null;
}

/*//////////////////////////////////////////////////////////////
                          THE CHAIN, CHECKED
//////////////////////////////////////////////////////////////*/

export interface ChainSettings {
  /** Oldest last trade (and file) priced on, seconds. v1's KEEPER_VOL_MAX_AGE_S. */
  maxAgeS: number;
  /** Full-day NYSE closures for the session rule. */
  holidays?: readonly string[];
}

export type ChainCheck = { ok: true; lastTradeUnix: number; timestampUnix: number; ageSeconds: number } | PricingFailure;

/**
 * Every check on a chain that does not depend on a strike, an expiry or the token: is it for the
 * market's root, are its clocks fresh and consistent (vol.ts chainFreshness, with the session
 * calendar), and did its rows parse.
 */
export function checkChain(chain: CboeChain, expectedRoot: string, nowSeconds: number, settings: ChainSettings): ChainCheck {
  if (chain.root !== expectedRoot) {
    return failure('chain-inconsistent', { why: 'the chain is for another symbol', symbol: chain.root, expectedRoot });
  }
  const fresh = chainFreshness(chain, nowSeconds, settings.maxAgeS, settings.holidays ?? NYSE_HOLIDAYS_2026_2028);
  if (!fresh.ok) return failure(fresh.reason === 'vol-stale' ? 'chain-stale' : 'chain-inconsistent', fresh.detail);
  const rows = chain.options.length + chain.skippedRows;
  if (chain.skippedRows > 0 && chain.skippedRows > MAX_SKIPPED_ROW_FRACTION * rows) {
    return failure('chain-inconsistent', {
      why: 'most option rows do not parse: the feed format changed',
      skippedRows: String(chain.skippedRows),
      rows: String(rows),
      firstSkip: chain.firstSkip ?? 'none',
    });
  }
  return { ok: true, lastTradeUnix: fresh.lastTradeUnix, timestampUnix: fresh.timestampUnix, ageSeconds: fresh.ageSeconds };
}

/*//////////////////////////////////////////////////////////////
                              CACHE
//////////////////////////////////////////////////////////////*/

export interface ChainEntry {
  url: string;
  /** The last chain downloaded from `url`, or null when none ever was. */
  chain: CboeChain | null;
  /** Why the LATEST attempt failed (VolFetchError's `code: message`), or null when it succeeded. */
  error: string | null;
  /** Wall clock of the latest attempt, ms. */
  fetchedAtMs: number;
  /** Consecutive failed attempts (0 after a success). */
  failures: number;
}

export type FetchChain = (url: string, options: FetchChainOptions) => Promise<CboeChain>;

export interface ChainCacheOptions {
  /** SEAM for tests. Defaults to vol.ts fetchCboeChain with every gate. */
  fetchChain?: FetchChain;
  timeoutMs?: number;
  maxBytes?: number;
  minRefetchMs?: number;
  /** SEAM for tests: the wall clock, ms. */
  nowMs?: () => number;
}

export class ChainCache {
  private readonly entries = new Map<string, ChainEntry>();
  private readonly inflight = new Map<string, Promise<ChainEntry>>();
  private readonly fetchChain: FetchChain;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly minRefetchMs: number;
  private readonly nowMs: () => number;

  constructor(options: ChainCacheOptions = {}) {
    this.fetchChain = options.fetchChain ?? fetchCboeChain;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CHAIN_TIMEOUT_MS;
    this.maxBytes = options.maxBytes ?? DEFAULT_CHAIN_MAX_BYTES;
    this.minRefetchMs = options.minRefetchMs ?? PRICING_MIN_REFETCH_MS;
    this.nowMs = options.nowMs ?? Date.now;
  }

  /**
   * `ticker`'s chain from `url`: the cached attempt while it is younger than the refetch floor (a
   * failed one: the failure retry) and for the same URL, else one download shared by every concurrent
   * caller. Never rejects: a failed download is an entry with the error and the last good chain.
   */
  async get(ticker: string, url: string): Promise<ChainEntry> {
    const cached = this.entries.get(ticker);
    if (cached !== undefined && cached.url === url) {
      const reuseMs = cached.failures === 0 ? this.minRefetchMs : Math.min(this.minRefetchMs, PRICING_FAILURE_RETRY_MS * 2 ** (cached.failures - 1));
      if (this.nowMs() - cached.fetchedAtMs < reuseMs) return cached;
    }
    const pending = this.inflight.get(ticker);
    if (pending !== undefined) return pending;
    const attempt = this.download(ticker, url).finally(() => this.inflight.delete(ticker));
    this.inflight.set(ticker, attempt);
    return attempt;
  }

  /** Every ticker's latest attempt, for /health. */
  snapshot(): ReadonlyMap<string, ChainEntry> {
    return this.entries;
  }

  private async download(ticker: string, url: string): Promise<ChainEntry> {
    let entry: ChainEntry;
    const previous = this.entries.get(ticker);
    try {
      const chain = await this.fetchChain(url, { timeoutMs: this.timeoutMs, maxBytes: this.maxBytes });
      entry = { url, chain, error: null, fetchedAtMs: this.nowMs(), failures: 0 };
    } catch (error) {
      const same = previous !== undefined && previous.url === url;
      entry = { url, chain: same ? previous.chain : null, error: error instanceof Error ? error.message : String(error), fetchedAtMs: this.nowMs(), failures: same ? previous.failures + 1 : 1 };
    }
    this.entries.set(ticker, entry);
    return entry;
  }
}
