/**
 * Fair value for one series: (ticker, strike, expiry, type) -> USDG per whole token, with the vol
 * and delta it was priced at, or a refusal with a reason. What the web shows as a guideline, the
 * MM bot quotes around, the pricer reprices to, and the indexer proxies.
 *
 * THE RULE
 *   cboe   Cboe lists the exact contract: the series' expiry is 16:00 New York on a listed expiry
 *          day, and that day lists the same side at the series strike (strikes are USD per token,
 *          listings USD per share; the numbers are compared as they are, to the listing's three
 *          decimals). Its quote passes every gate (cboe.ts isUsableQuote and the window around it,
 *          the expiry's parity forward) and its mid solves to a vol inside [IV_FLOOR, IV_CEILING].
 *          The price is that mid carried to the token (below).
 *   model  otherwise: the surface's vol at the strike and expiry (surface.ts volAt), same pricing.
 *   null   otherwise, with the reason; and before either, whenever the chain or the token spot
 *          fails a gate: chain clocks and root (cboe.ts checkChain), feed freshness (spot.ts), and
 *          token spot against Cboe's spot within maxSpotDivergenceBps (vol.ts mapSpot).
 *
 * CARRYING A MID TO THE TOKEN. Vol crosses from the listed market to the token, not price. A mid's
 * vol is solved where the mid was made: against its expiry's parity forward, on the trading clock
 * from the chain's last trade. The token option is then Black-Scholes at that vol, the TOKEN spot
 * and the CURRENT clock. So:
 *   - with the feed exactly at the forward and no session elapsed, the fair value IS the mid;
 *   - with the token at m × the forward (m = the uiMultiplier, plus any move since Cboe's
 *     snapshot), it is m × C_share(K/m), because Black-Scholes at r = 0 is homogeneous: the mid
 *     scaled by tokenSpot/equitySpot AT THE SCALED STRIKE, which is how v1's fairCallPrice mapped
 *     strikes by moneyness. A bare `mid × m` misses the strike shift. On the NVDA fixture the 18
 *     Sep 220 call's mid is 0.625 against a forward of 211.06; at a token spot of 212.21 (m =
 *     1.0055) `mid × m` says 0.628, while a call of delta 0.15-0.18 is worth ~0.19 more for a 1.15
 *     move, and the fair value is 0.816164;
 *   - as the session clock runs, the premium decays instead of sitting at the last close.
 * The quoted `iv` is that vol and `delta` is dPrice/dTokenSpot at it: a call's in (0, 1), a put's in
 * (-1, 0).
 *
 * UNITS. Strikes arrive as USDG base units per token (bigint) and prices leave the same way,
 * rounded half up to the base unit, once, here. `spot` in the answer is the token spot the price
 * is for. `asOf` is the chain's last trade (unix seconds): the market data the number rests on.
 *
 * NEVER THROWS on market data: every failure is a PricingFailure. The service reads the chain
 * first and the RPC only once the chain has passed, so a dead Cboe feed costs no RPC calls.
 */
import type { Address } from 'viem';
import { NYSE_HOLIDAYS_2026_2028 } from '../../calendar.js';
import { mapSpot, type CboeChain } from '../../vol.js';
import { bsDelta, bsPrice, impliedVol, tradingYears, type OptionKind } from './bs.js';
import { ChainCache, checkChain, checkQuoteWindow, failure, mid, type ChainCacheOptions, type ChainEntry, type PricingFailure } from './cboe.js';
import type { PricingMarket } from './markets.js';
import { tokenSpotFromRound, type FeedRound, type SpotReader, type TokenSpot } from './spot.js';
import { IV_CEILING, IV_FLOOR, SURFACE_HORIZON_DAYS, buildSurface, volAt, type Surface } from './surface.js';

/*//////////////////////////////////////////////////////////////
                              TYPES
//////////////////////////////////////////////////////////////*/

export interface FairRequest {
  ticker: string;
  /** USDG base units per whole token. */
  strikeUsdg6: bigint;
  /** Unix seconds. */
  expiry: number;
  type: OptionKind;
}

export type FairMethod = 'listed-contract' | 'listed-expiry' | 'total-variance' | 'flat-before-first' | 'flat-after-last';

export interface PricedContract {
  ok: true;
  /** Rounded half up to the base unit. */
  fairUsdg6: bigint;
  iv: number;
  delta: number;
  source: 'cboe' | 'model';
  method: FairMethod;
  /** The listed expiry days the vol came from. */
  days: string[];
}

export interface FairQuote extends PricedContract {
  spotUsdg6: bigint;
  asOf: number;
}

export type FairOutcome = FairQuote | PricingFailure;

export interface PricingSettings {
  /** Oldest chain (last trade and file) priced on, seconds. Default the registry's maxPriceAgeS. */
  maxChainAgeS: number;
  /** Oldest feed update priced on, seconds. */
  maxSpotAgeS: number;
  /** Token spot vs Cboe spot, bps of the ratio. */
  maxSpotDivergenceBps: number;
  holidays: readonly string[];
  horizonDays: number;
  /** How long one feed read is reused, ms. The feed moves on a 0.5% deviation, not per request. */
  spotTtlMs: number;
}

/** v1's limits (config.ts KEEPER_VOL_MAX_AGE_S, KEEPER_VOL_MAX_SPOT_DIVERGENCE_BPS; the vault's
 *  maxPriceAge), which the registry's `defaults` repeat. */
export const DEFAULT_PRICING_SETTINGS: PricingSettings = {
  maxChainAgeS: 345_600,
  maxSpotAgeS: 345_600,
  maxSpotDivergenceBps: 300,
  holidays: NYSE_HOLIDAYS_2026_2028,
  horizonDays: SURFACE_HORIZON_DAYS,
  spotTtlMs: 10_000,
};

/*//////////////////////////////////////////////////////////////
                         PRICING (PURE)
//////////////////////////////////////////////////////////////*/

type ExactVol = { ok: true; iv: number; day: string } | { ok: false; why: string };

/** The exact listed contract's own vol, if it exists and passes every gate. See THE RULE. */
export function exactContractVol(surface: Surface, request: Pick<FairRequest, 'strikeUsdg6' | 'expiry' | 'type'>): ExactVol {
  const entry = surface.expiries.find((e) => e.expiry === request.expiry);
  if (entry === undefined) return { ok: false, why: 'the expiry is not listed' };
  if (entry.failure !== null || entry.forward === null) return { ok: false, why: `the expiry failed: ${entry.failure?.reason ?? 'no forward'}` };
  if (request.strikeUsdg6 % 1_000n !== 0n) return { ok: false, why: 'the strike has more decimals than a listing' };
  const thousandths = request.strikeUsdg6 / 1_000n;
  const side = request.type === 'call' ? 'C' : 'P';
  const quotes = side === 'C' ? entry.calls : entry.puts;
  const quote = quotes.find((q) => BigInt(Math.round(q.strike * 1_000)) === thousandths);
  if (quote === undefined) return { ok: false, why: 'no usable listed quote at the strike' };
  const window = checkQuoteWindow(quotes, side, [quote.strike, quote.strike]);
  if (window !== null) return { ok: false, why: window.detail.why ?? window.reason };
  const iv = impliedVol(mid(quote), { type: request.type, spot: entry.forward, strike: quote.strike, t: entry.t });
  if (iv === null || iv < IV_FLOOR || iv > IV_CEILING) return { ok: false, why: 'the mid does not solve to a vol inside the band' };
  return { ok: true, iv, day: entry.day };
}

/**
 * Price one contract on a surface at a token spot (USD per token, float) and a clock. The caller
 * has already checked the chain, the spot and that the expiry is in the future.
 */
export function priceContract(input: { surface: Surface; request: Pick<FairRequest, 'strikeUsdg6' | 'expiry' | 'type'>; tokenSpot: number; nowSeconds: number }): PricedContract | PricingFailure {
  const { surface, request, tokenSpot, nowSeconds } = input;
  const strike = Number(request.strikeUsdg6) / 1e6;
  if (!(strike > 0) || !(tokenSpot > 0)) return failure('spot-unavailable', { why: 'a spot or strike is not positive', strike: String(strike), tokenSpot: String(tokenSpot) });

  let iv: number;
  let source: 'cboe' | 'model';
  let method: FairMethod;
  let days: string[];
  const exact = exactContractVol(surface, request);
  if (exact.ok) {
    iv = exact.iv;
    source = 'cboe';
    method = 'listed-contract';
    days = [exact.day];
  } else {
    const v = volAt(surface, strike, request.expiry);
    if (!v.ok) return v;
    iv = v.iv;
    source = 'model';
    method = v.method;
    days = v.days;
  }

  const t = tradingYears(nowSeconds, request.expiry, surface.holidays);
  const bs = { type: request.type, spot: tokenSpot, strike, vol: iv, t };
  const price = bsPrice(bs);
  if (!Number.isFinite(price) || price < 0) return failure('no-quotes', { why: 'the model price is not a number', price: String(price) });
  return { ok: true, fairUsdg6: BigInt(Math.round(price * 1e6)), iv, delta: bsDelta(bs), source, method, days };
}

/*//////////////////////////////////////////////////////////////
                             SERVICE
//////////////////////////////////////////////////////////////*/

/** The subset of a pino logger the service writes to. */
export interface PricingLog {
  debug(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

const silent: PricingLog = { debug: () => undefined, warn: () => undefined };

export interface PricingServiceOptions {
  markets: ReadonlyMap<string, PricingMarket>;
  /** SEAM: the feed read. Production passes spot.ts createFeedSpotReader. */
  spotReader: SpotReader;
  /** Cache options, including the fetch SEAM. */
  chains?: ChainCacheOptions;
  settings?: Partial<PricingSettings>;
  /** SEAM: wall clock, ms. Shared with the chain cache unless `chains.nowMs` is given. */
  nowMs?: () => number;
  log?: PricingLog;
}

export type SurfaceOutcome =
  | { ok: true; surface: Surface; chain: CboeChain; fetchedAtMs: number }
  | PricingFailure;

type Loaded = { ok: true; chain: CboeChain; surface: Surface; entry: ChainEntry } | PricingFailure;

export class PricingService {
  readonly markets: ReadonlyMap<string, PricingMarket>;
  readonly settings: PricingSettings;
  readonly startedAtMs: number;
  private readonly chains: ChainCache;
  private readonly spotReader: SpotReader;
  private readonly nowMs: () => number;
  private readonly log: PricingLog;
  private readonly surfaces = new WeakMap<CboeChain, Surface>();
  private readonly spots = new Map<string, { atMs: number; round: Promise<FeedRound | Error> }>();
  private readonly loggedAttempts = new Map<string, number>();

  constructor(options: PricingServiceOptions) {
    this.markets = options.markets;
    this.settings = { ...DEFAULT_PRICING_SETTINGS, ...options.settings };
    this.nowMs = options.nowMs ?? Date.now;
    this.chains = new ChainCache({ nowMs: this.nowMs, ...options.chains });
    this.spotReader = options.spotReader;
    this.log = options.log ?? silent;
    this.startedAtMs = this.nowMs();
  }

  private nowSeconds(): number {
    return Math.floor(this.nowMs() / 1000);
  }

  /** The chain, checked, and its surface (built once per downloaded chain). */
  private async loadChain(market: PricingMarket, nowSeconds: number): Promise<Loaded> {
    if (market.cboe === null) return failure('chain-unavailable', { why: 'the registry has no Cboe chain for this market', ticker: market.ticker });
    const entry = await this.chains.get(market.ticker, market.cboe.url);
    // Once per download, not per request: a cached failure is logged when it happened.
    if (this.loggedAttempts.get(market.ticker) !== entry.fetchedAtMs) {
      this.loggedAttempts.set(market.ticker, entry.fetchedAtMs);
      if (entry.error !== null) this.log.warn({ ticker: market.ticker, err: entry.error, servingLastGood: entry.chain !== null }, 'could not fetch the option chain');
      else if (entry.chain !== null) this.log.debug({ ticker: market.ticker, chainTimestamp: entry.chain.timestamp, lastTradeTime: entry.chain.lastTradeTime, options: entry.chain.options.length, skippedRows: entry.chain.skippedRows }, 'fetched the option chain');
    }
    if (entry.chain === null) return failure('chain-unavailable', { error: entry.error ?? 'no chain' });
    const check = checkChain(entry.chain, market.cboe.root, nowSeconds, { maxAgeS: this.settings.maxChainAgeS, holidays: this.settings.holidays });
    if (!check.ok) return check;
    let surface = this.surfaces.get(entry.chain);
    if (surface === undefined) {
      surface = buildSurface(entry.chain, check.lastTradeUnix, { holidays: this.settings.holidays, horizonDays: this.settings.horizonDays });
      this.surfaces.set(entry.chain, surface);
    }
    return { ok: true, chain: entry.chain, surface, entry };
  }

  /** One feed read per ticker per spotTtlMs, shared by concurrent callers; failures are reused too. */
  private readRound(market: PricingMarket): Promise<FeedRound | Error> {
    const cached = this.spots.get(market.ticker);
    if (cached !== undefined && this.nowMs() - cached.atMs < this.settings.spotTtlMs) return cached.round;
    const round = this.spotReader(market.feed as Address).then(
      (r) => r,
      (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
    );
    this.spots.set(market.ticker, { atMs: this.nowMs(), round });
    return round;
  }

  private async loadSpot(market: PricingMarket, chain: CboeChain, nowSeconds: number): Promise<TokenSpot | PricingFailure> {
    const round = await this.readRound(market);
    if (round instanceof Error) return failure('spot-unavailable', { why: 'the feed read failed', feed: market.feed, error: round.message.split('\n')[0] ?? '' });
    const spot = tokenSpotFromRound(round, this.settings.maxSpotAgeS, nowSeconds);
    if ('ok' in spot) return { ...spot, detail: { feed: market.feed, ...spot.detail } };
    const mapped = mapSpot(chain.shareSpot, spot.spotUsdg6, this.settings.maxSpotDivergenceBps);
    if (!mapped.ok) return failure(mapped.reason === 'vol-spot-divergence' ? 'spot-divergence' : 'chain-inconsistent', mapped.detail);
    return spot;
  }

  async fair(request: FairRequest): Promise<FairOutcome> {
    const market = this.markets.get(request.ticker);
    if (market === undefined) return failure('unknown-ticker', { ticker: request.ticker });
    const nowSeconds = this.nowSeconds();
    if (request.expiry <= nowSeconds) return failure('expired', { expiry: String(request.expiry), nowSeconds: String(nowSeconds) });
    const loaded = await this.loadChain(market, nowSeconds);
    if (!loaded.ok) return loaded;
    const spot = await this.loadSpot(market, loaded.chain, nowSeconds);
    if ('ok' in spot) return spot;
    const priced = priceContract({ surface: loaded.surface, request, tokenSpot: Number(spot.spotUsdg6) / 1e6, nowSeconds });
    if (!priced.ok) return priced;
    return { ...priced, spotUsdg6: spot.spotUsdg6, asOf: loaded.surface.asOf };
  }

  /** The ticker's surface, in the listed market's terms. Needs no spot. */
  async surface(ticker: string): Promise<SurfaceOutcome> {
    const market = this.markets.get(ticker);
    if (market === undefined) return failure('unknown-ticker', { ticker });
    const loaded = await this.loadChain(market, this.nowSeconds());
    if (!loaded.ok) return loaded;
    return { ok: true, surface: loaded.surface, chain: loaded.chain, fetchedAtMs: loaded.entry.fetchedAtMs };
  }

  /** Every ticker's latest chain attempt, for /health. */
  chainAttempts(): ReadonlyMap<string, ChainEntry> {
    return this.chains.snapshot();
  }

  /**
   * Whether the chain `ticker` is served from would price now (cboe.ts checkChain on its own clocks), for /health:
   * 'ok', or the reason every /fair of it refuses (chain-stale, chain-inconsistent, chain-unavailable). Downloads nothing.
   */
  chainUsable(ticker: string): 'ok' | PricingFailure['reason'] {
    const market = this.markets.get(ticker);
    const entry = this.chains.snapshot().get(ticker);
    if (market === undefined) return 'unknown-ticker';
    if (market.cboe === null || entry === undefined || entry.chain === null) return 'chain-unavailable';
    const check = checkChain(entry.chain, market.cboe.root, this.nowSeconds(), { maxAgeS: this.settings.maxChainAgeS, holidays: this.settings.holidays });
    return check.ok ? 'ok' : check.reason;
  }

  uptimeSeconds(): number {
    return Math.floor((this.nowMs() - this.startedAtMs) / 1000);
  }
}
