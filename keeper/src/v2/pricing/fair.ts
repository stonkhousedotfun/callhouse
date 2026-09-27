/**
 * Fair value for one series: (ticker, strike, expiry, type) -> USDG per whole token, with the vol
 * and delta it was priced at, or a refusal with a reason. What the web shows as a guideline, the
 * MM bot quotes around, the pricer reprices to, and the indexer proxies.
 *
 * THE RULE
 *   cboe   The provider lists the exact contract: the series' expiry is 16:00 New York on a listed
 *          expiry day, and that day lists the same side at the series strike (strikes are USD per
 *          token, listings USD per share; the numbers are compared as they are, to the listing's
 *          three decimals). Its quote passes every gate (cboe.ts isUsableQuote and the window around
 *          it, the expiry's parity forward) and its mid solves to a vol inside [IV_FLOOR, IV_CEILING].
 *          The price is that mid carried to the token (below). The legacy `source` label says
 *          "cboe" only when that provider IS Cboe's delayed file (cboe.ts CBOE_PROVIDER); the same
 *          exact-contract price from any other provider is labelled "model" (method still
 *          `listed-contract`), so a provider switch can never keep a false Cboe label.
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
 * is for. `asOf` is the chain's pricing clock (unix seconds): for Cboe its last trade, the legacy
 * meaning, unchanged. Every priced answer also carries `provenance` (provenance.ts): provider,
 * method, the listed inputs used, every source clock (null when the provider gives none), ages,
 * entitlement and quality. It is internal: server.ts does not serialize it (wire order).
 *
 * PROVIDER-NEUTRAL. The service reads chains only as chain.ts NormalizedChain, through the
 * cache's provider (cboe.ts createCboeProvider by default). It never sees a provider payload type.
 *
 * SHORT MATURITIES AND THE EXPIRY CLOCK. Before pricing, expiry-clock.ts checks the series
 * against both clocks (the service clock that `yearsToExpiry` runs from, and the surface clock every
 * listed T runs from) and refuses one with no regular session left as `expired`. After pricing,
 * short-maturity.ts bounds a read the listings do not identify, with the injected event calendar
 * (`events`; none by default) and PricingSettings.shortMaturity (proposal defaults). The point price,
 * iv, delta, source, method and asOf are never changed by either: the bounds and reasons go to
 * `provenance.quality`, the working to `diagnostics`, and under a `refuse` policy a model-uncertain
 * read is refused as `model-uncertainty` instead.
 *
 * TWO SPOTS AND A LIVE FORWARD. The equity price the token spot is mapped against, and gated
 * by maxSpotDivergenceBps, is the option book's own put-call parity forward (forward.ts) when the chain
 * supports one, and the provider's underlying price only when it does not (Massive's underlying is 15
 * minutes delayed on an options-only key; its quotes are real time). A market whose registry names a
 * v3 pool is priced on the MORE EXPENSIVE of two token spots, the Chainlink feed and the pool's TWAP
 * (pool-spot.ts): a call at the higher spot, a put at the lower (conservativeSpot). So an ask is never
 * cheaper than the Chainlink-only price, and a pushed pool can only make it dearer. When the two differ
 * by more than maxPoolChainlinkDivergenceBps the request is refused as `source-disagreement`. The pool
 * is never used alone: no Chainlink spot, no price. A pool that cannot be read or is below its
 * liquidity floor refuses the request (`spot-unavailable`, detail `source: pool`) unless poolRequired
 * is off, when the market falls back to Chainlink alone. Every input and which spot priced the request
 * go to `provenance.spotInputs`, and the latest per ticker to /health.
 *
 * THE SAFEST-ASK INPUTS. Every priced answer also carries `gamma` and `vega`
 * (bs.ts, at `iv`), the token's realized vol from its pool (realized.ts; null without a pool, a reader or
 * enough in-session history), and `askIv`: max(iv, realized, floor[ticker]) × (1 + markup), never below
 * `iv` and never above IV_CEILING (askIvFor). The point price, `iv` and `delta` are unchanged: askIv is an
 * input for a seller's ask, not a different fair value. `event` says whether a calendar event may land in
 * (now, expiry] (short-maturity.ts eventsInWindow), with 'missing' input meaning "unknown", never "clear".
 *
 * NEVER THROWS on market data: every failure is a PricingFailure. The service reads the chain
 * first and the RPC only once the chain has passed, so a dead Cboe feed costs no RPC calls.
 */
import type { Address } from 'viem';
import { NYSE_HOLIDAYS_2026_2028 } from '../../calendar.js';
import { UNIT_UI_MULTIPLIER, mapSpot } from '../../vol.js';
import { bsDelta, bsGamma, bsPrice, bsVega, impliedVol, tradingYears, type OptionKind } from './bs.js';
import { CBOE_PROVIDER, ChainCache, checkChain, checkQuoteWindow, failure, mid, type ChainCacheOptions, type ChainEntry, type PricingFailure } from './cboe.js';
import type { CanonicalIdentity, NormalizedChain, ProviderDescriptor } from './chain.js';
import { checkExpiryClock } from './expiry-clock.js';
import { DEFAULT_FORWARD_SETTINGS, impliedForward, type ForwardSettings } from './forward.js';
import { DEFAULT_POOL_TWAP_S, poolSpotFromObservation, type PoolReader, type PoolSpot } from './pool-spot.js';
import { buildFairProvenance, type FairProvenance, type SpotInputs } from './provenance.js';
import { DEFAULT_REALIZED_SETTINGS, observeSchedule, realizedVolFromTwaps, twapSeries, type RealizedVol } from './realized.js';
import type { PricingMarket } from './markets.js';
import { tokenSpotFromRound, type FeedRound, type SpotReader, type TokenSpot } from './spot.js';
import {
  DEFAULT_SHORT_MATURITY_POLICY,
  NO_EVENT_INPUT,
  assessShortMaturity,
  eventsInWindow,
  type EventCalendar,
  type MarketEvent,
  type ShortMaturityDiagnostics,
  type ShortMaturityPolicy,
} from './short-maturity.js';
import { IV_CEILING, IV_FLOOR, SURFACE_HORIZON_DAYS, buildSurface, volAt, type Surface, type SurfaceInput } from './surface.js';

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
  /** d²Price/dSpot² at `iv` (bs.ts bsGamma), per USD of token spot. */
  gamma: number;
  /** dPrice/dVol at `iv` per 1.00 of vol (bs.ts bsVega), USD per token. */
  vega: number;
  source: 'cboe' | 'model';
  method: FairMethod;
  /** The listed expiry days the vol came from. */
  days: string[];
  /** The listed quotes the vol came from: (day, expiry, side, share strike) and the exact listed input
   *  used there (chain.ts ListedOption.symbol), so provenance names that instrument and no other row. */
  used: Array<{ day: string; expiry: number; side: 'C' | 'P'; strike: number; symbol: string }>;
  /** How each contributing expiry was read at the strike; [] for the exact listed contract. */
  strikeMethods: Array<SurfaceInput['strikeMethod']>;
  /** Trading years to expiry the price was computed with. */
  yearsToExpiry: number;
}

export interface FairQuote extends PricedContract {
  spotUsdg6: bigint;
  asOf: number;
  /** Internal; not part of the /fair body. */
  provenance: FairProvenance;
  /** Internal working behind the bounds and the expiry clock (short-maturity.ts); not part of the /fair body. */
  diagnostics: ShortMaturityDiagnostics;
  /** The vol a seller's ask is priced at (askIvFor); >= iv. */
  askIv: number;
  /** The pool's realized vol on the trading clock (realized.ts), null when there is none; `realizedWhy` says why. */
  realizedVol: number | null;
  realizedWhy: string | null;
  /** Calendar events that may land in (now, expiry] (short-maturity.ts eventsInWindow). */
  event: { input: 'supplied' | 'missing' | 'short'; inWindow: boolean; events: MarketEvent[] };
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
  /** YYYY-MM-DD New York days the NYSE closes early (expiry-clock.ts). None by default: calendar.ts
   *  models none on this revision, and the price's trading clock never uses them. */
  earlyCloses: readonly string[];
  /** Bounds, reasons and the refusal rule for unidentified reads (short-maturity.ts). */
  shortMaturity: ShortMaturityPolicy;
  /** The pool TWAP length, seconds (pool-spot.ts MIN_POOL_TWAP_S..MAX_POOL_TWAP_S). */
  poolTwapS: number;
  /** Pool spot vs Chainlink spot, bps of the ratio; above it the request is refused (source-disagreement). */
  maxPoolChainlinkDivergenceBps: number;
  /** A market with a registry pool refuses when the pool spot is unusable (true), or prices on Chainlink alone (false). */
  poolRequired: boolean;
  /** The parity forward's filters (forward.ts). */
  forward: ForwardSettings;
  /** askIv = max(iv, realized, floor) × (1 + markupBps / 10_000) (askIvFor). */
  askIv: AskIvSettings;
  /** The realized-vol read (realized.ts): observe a lookback in steps, cache it ttlMs. */
  realized: { lookbackS: number; stepS: number; minReturns: number; ttlMs: number };
}

export interface AskIvSettings {
  /** Vol markup over the largest of the three, bps: 1_000 is ×1.10 (%). */
  markupBps: number;
  /** A floor for every ticker without its own, annualised on the trading clock; 0 is none. */
  floor: number;
  /** Per-ticker floors, over `floor`. */
  floors: Readonly<Record<string, number>>;
}

export const DEFAULT_ASK_IV_SETTINGS: AskIvSettings = { markupBps: 1_000, floor: 0, floors: {} };

/**
 * The vol a seller's ask is priced at: max(iv, realized, floor) marked up, clamped to IV_CEILING, and never
 * below `iv` whatever the settings (a negative markup, a NaN realized): the ask vol can only be the live vol
 * or more. `iv` itself is inside [IV_FLOOR, IV_CEILING] (surface.ts), so the clamp cannot undercut it.
 */
export function askIvFor(input: { iv: number; realizedVol: number | null; ticker: string; settings: AskIvSettings }): number {
  const { iv, realizedVol, ticker, settings } = input;
  const floor = settings.floors[ticker] ?? settings.floor;
  const candidates = [iv, realizedVol ?? 0, floor].filter((v) => Number.isFinite(v));
  const base = Math.max(...candidates);
  const markup = Number.isFinite(settings.markupBps) ? Math.max(0, settings.markupBps) / 10_000 : 0;
  return Math.max(iv, Math.min(base * (1 + markup), IV_CEILING));
}

/** The pricing service's own limits when the registry sets none. maxChainAgeS / maxSpotAgeS (4 days) are its
 *  dead-feed and dead-chain limits, not a copy of any v2 contract value: the feed prints only while the market is
 *  open and Cboe's file stops at the close, so both are days old over a long weekend (spot.ts header). The number
 *  is v1's (config.ts KEEPER_VOL_MAX_AGE_S; the v1 vault's maxPriceAge) and the registry's `defaults.maxPriceAgeS`
 *  sets the same 345 600 at runtime (pricing/main.ts). It is NOT the settlement oracle's per-market spotMaxAge
 *  (90 000 s in the registry, settable by SettlementOracle.setMarket): trySpot refuses an older print on its own,
 *  and the MM re-prices every fair at the oracle's spot and halts one whose spot is off it (mm/engine.ts
 *  fairCheckOf, MM_FAIR_SPOT_TOLERANCE_BPS). */
export const DEFAULT_PRICING_SETTINGS: PricingSettings = {
  maxChainAgeS: 345_600,
  maxSpotAgeS: 345_600,
  maxSpotDivergenceBps: 300,
  holidays: NYSE_HOLIDAYS_2026_2028,
  horizonDays: SURFACE_HORIZON_DAYS,
  spotTtlMs: 10_000,
  earlyCloses: [],
  shortMaturity: DEFAULT_SHORT_MATURITY_POLICY,
  poolTwapS: DEFAULT_POOL_TWAP_S,
  maxPoolChainlinkDivergenceBps: 150,
  poolRequired: true,
  forward: DEFAULT_FORWARD_SETTINGS,
  askIv: DEFAULT_ASK_IV_SETTINGS,
  // One regular session of 5-minute TWAPs, re-read at most every 5 minutes.
  realized: { lookbackS: 23_400, stepS: 300, minReturns: DEFAULT_REALIZED_SETTINGS.minReturns, ttlMs: 300_000 },
};

/**
 * The spot a request is priced at, from the Chainlink spot and the pool spot (null: no pool). A call is
 * priced at the higher and a put at the lower, so the price is never below the Chainlink-only price:
 * a call rises with spot and a put falls with it. The pool alone never prices.
 */
export function conservativeSpot(type: OptionKind, chainlinkUsdg6: bigint, poolUsdg6: bigint | null): { spotUsdg6: bigint; pricedWith: 'chainlink' | 'pool' } {
  if (poolUsdg6 === null) return { spotUsdg6: chainlinkUsdg6, pricedWith: 'chainlink' };
  const pool = type === 'call' ? poolUsdg6 > chainlinkUsdg6 : poolUsdg6 < chainlinkUsdg6;
  return pool ? { spotUsdg6: poolUsdg6, pricedWith: 'pool' } : { spotUsdg6: chainlinkUsdg6, pricedWith: 'chainlink' };
}

/** |pool / chainlink - 1| in bps. */
export function poolChainlinkDivergenceBps(chainlinkUsdg6: bigint, poolUsdg6: bigint): number {
  return Math.abs(Number(poolUsdg6) / Number(chainlinkUsdg6) - 1) * 10_000;
}

/*//////////////////////////////////////////////////////////////
                         PRICING (PURE)
//////////////////////////////////////////////////////////////*/

type ExactVol = { ok: true; iv: number; day: string; expiry: number; strike: number; symbol: string } | { ok: false; why: string };

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
  return { ok: true, iv, day: entry.day, expiry: entry.expiry, strike: quote.strike, symbol: quote.symbol };
}

/** The listed quotes behind a surface read: each contributing expiry's bracket strikes, on the side
 *  each surface point was solved from. */
function usedInputs(surface: Surface, inputs: readonly SurfaceInput[]): PricedContract['used'] {
  const used: PricedContract['used'] = [];
  for (const input of inputs) {
    const entry = surface.expiries.find((e) => e.day === input.day);
    for (const strike of new Set(input.bracket)) {
      const point = entry?.points.find((p) => p.strike === strike);
      if (entry === undefined || point === undefined) continue;
      const quote = (point.side === 'C' ? entry.calls : entry.puts).find((q) => q.strike === strike);
      if (quote !== undefined) used.push({ day: input.day, expiry: input.expiry, side: point.side, strike, symbol: quote.symbol });
    }
  }
  return used;
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
  let used: PricedContract['used'];
  let strikeMethods: PricedContract['strikeMethods'];
  const exact = exactContractVol(surface, request);
  if (exact.ok) {
    iv = exact.iv;
    source = surface.provider === CBOE_PROVIDER.id ? 'cboe' : 'model';
    method = 'listed-contract';
    days = [exact.day];
    used = [{ day: exact.day, expiry: exact.expiry, side: request.type === 'call' ? 'C' : 'P', strike: exact.strike, symbol: exact.symbol }];
    strikeMethods = [];
  } else {
    const v = volAt(surface, strike, request.expiry);
    if (!v.ok) return v;
    iv = v.iv;
    source = 'model';
    method = v.method;
    days = v.days;
    used = usedInputs(surface, v.inputs);
    strikeMethods = v.inputs.map((i) => i.strikeMethod);
  }

  const t = tradingYears(nowSeconds, request.expiry, surface.holidays);
  const bs = { type: request.type, spot: tokenSpot, strike, vol: iv, t };
  const price = bsPrice(bs);
  if (!Number.isFinite(price) || price < 0) return failure('no-quotes', { why: 'the model price is not a number', price: String(price) });
  return { ok: true, fairUsdg6: BigInt(Math.round(price * 1e6)), iv, delta: bsDelta(bs), gamma: bsGamma(bs), vega: bsVega(bs), source, method, days, used, strikeMethods, yearsToExpiry: t };
}

/** The registry's canonical identity of a market (markets.ts); null wherever the registry is silent. */
export function canonicalIdentity(market: PricingMarket): CanonicalIdentity {
  return {
    market: market.ticker,
    root: market.cboe?.root ?? null,
    issuer: null,
    token: { chainId: market.token?.chainId ?? null, address: market.token?.address ?? null, uiMultiplier: market.token?.uiMultiplier ?? null },
  };
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
  /** SEAM: per-ticker event input (short-maturity.ts eventCalendar). Default none: every ticker lacks it. */
  events?: EventCalendar;
  /** SEAM: the v3 pool read (pool-spot.ts createPoolObserveReader). Without it a market with a registry
   *  pool has no pool spot, which refuses it while poolRequired is on. */
  poolReader?: PoolReader;
}

export type SurfaceOutcome =
  | { ok: true; surface: Surface; chain: NormalizedChain; fetchedAtMs: number }
  | PricingFailure;

type Loaded = { ok: true; chain: NormalizedChain; surface: Surface; entry: ChainEntry } | PricingFailure;

type LoadedSpot = { ok: true; spot: TokenSpot; inputs: SpotInputs } | PricingFailure;

/**
 * The chain cache keeps the last good chain after a failed
 * refetch (cboe.ts THE CACHE). That suits Cboe's free file, which is 15 minutes behind anyway. It does not suit a
 * real-time feed: a failed Massive download (401 auth, 403 not-entitled, 429, a 5xx, a timeout) would keep pricing on
 * the last chain until its clocks aged past maxChainAgeS (four days). So for every provider but Cboe the latest
 * attempt must have succeeded: a failed one refuses `chain-unavailable` naming the provider and its error, the bot
 * halts that market, and the pricing alerts see the refusal. The cache's failure backoff retries it (the refetch
 * floor on Massive, 15 s). Null when the chain may be served.
 */
export function refuseLastGood(entry: Pick<ChainEntry, 'error' | 'failures'>, provider: ProviderDescriptor): PricingFailure | null {
  if (entry.error === null || provider.id === CBOE_PROVIDER.id) return null;
  return failure('chain-unavailable', {
    why: 'the latest download from a real-time provider failed; its last good chain is not served',
    provider: provider.id,
    error: entry.error,
    consecutiveFailures: String(entry.failures),
  });
}

export class PricingService {
  readonly markets: ReadonlyMap<string, PricingMarket>;
  readonly settings: PricingSettings;
  readonly startedAtMs: number;
  private readonly chains: ChainCache;
  private readonly spotReader: SpotReader;
  private readonly nowMs: () => number;
  private readonly log: PricingLog;
  private readonly events: EventCalendar;
  private readonly surfaces = new WeakMap<NormalizedChain, Surface>();
  private readonly spots = new Map<string, { atMs: number; round: Promise<FeedRound | Error> }>();
  private readonly poolReader: PoolReader | null;
  private readonly poolSpots = new Map<string, { atMs: number; read: Promise<PoolSpot | PricingFailure> }>();
  private readonly lastSpotInputs = new Map<string, SpotInputs & { atMs: number }>();
  private readonly realizedReads = new Map<string, { atMs: number; read: Promise<RealizedVol> }>();
  private readonly lastRealized = new Map<string, RealizedVol & { atMs: number }>();
  private readonly loggedAttempts = new Map<string, number>();

  constructor(options: PricingServiceOptions) {
    this.markets = options.markets;
    this.settings = { ...DEFAULT_PRICING_SETTINGS, ...options.settings };
    this.nowMs = options.nowMs ?? Date.now;
    this.chains = new ChainCache({ nowMs: this.nowMs, ...options.chains });
    this.spotReader = options.spotReader;
    this.log = options.log ?? silent;
    this.events = options.events ?? NO_EVENT_INPUT;
    this.poolReader = options.poolReader ?? null;
    this.startedAtMs = this.nowMs();
  }

  private nowSeconds(): number {
    return Math.floor(this.nowMs() / 1000);
  }

  /** The chain, checked, and its surface (built once per downloaded chain). */
  private async loadChain(market: PricingMarket, nowSeconds: number): Promise<Loaded> {
    if (market.cboe === null) return failure('chain-unavailable', { why: 'the registry has no Cboe chain for this market', ticker: market.ticker });
    const entry = await this.chains.get(market.ticker, market.cboe.url, market.cboe.root);
    // Once per download, not per request: a cached failure is logged when it happened.
    if (this.loggedAttempts.get(market.ticker) !== entry.fetchedAtMs) {
      this.loggedAttempts.set(market.ticker, entry.fetchedAtMs);
      if (entry.error !== null) this.log.warn({ ticker: market.ticker, provider: this.chains.descriptor.id, err: entry.error, servingLastGood: entry.chain !== null }, 'could not fetch the option chain');
      else if (entry.chain !== null) this.log.debug({ ticker: market.ticker, provider: entry.chain.provider.id, chainTimestamp: entry.chain.clocks.publishedAtText, lastTradeTime: entry.chain.underlying.observedAtText, options: entry.chain.rows.length, skippedRows: entry.chain.skippedRows }, 'fetched the option chain');
    }
    if (entry.chain === null) return failure('chain-unavailable', { error: entry.error ?? 'no chain' });
    const lastGood = refuseLastGood(entry, this.chains.descriptor);
    if (lastGood !== null) return lastGood;
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

  /** One pool read per ticker per spotTtlMs, shared by concurrent callers; failures are reused too. */
  private readPoolSpot(market: PricingMarket): Promise<PoolSpot | PricingFailure> {
    const pool = market.pool!;
    const cached = this.poolSpots.get(market.ticker);
    if (cached !== undefined && this.nowMs() - cached.atMs < this.settings.spotTtlMs) return cached.read;
    const windowS = this.settings.poolTwapS;
    const reader = this.poolReader;
    const read: Promise<PoolSpot | PricingFailure> =
      reader === null || market.token === undefined
        ? Promise.resolve(failure('spot-unavailable', { source: 'pool', pool: pool.address, why: 'no pool reader is configured' }))
        : Promise.all([reader.meta(pool.address, market.token.address), reader.observe(pool.address, windowS)]).then(
            ([meta, observation]) => poolSpotFromObservation({ observation, windowS, meta, asset: market.token!.address, pool }),
            (error: unknown) => failure('spot-unavailable', { source: 'pool', pool: pool.address, why: 'the pool read failed', error: (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '' }),
          );
    this.poolSpots.set(market.ticker, { atMs: this.nowMs(), read });
    return read;
  }

  /**
   * The pool's realized vol, one observe per ticker per realized.ttlMs, shared by concurrent callers. Never
   * refuses a price: without a pool, a series reader or enough history it is `ok: false` with the reason, and
   * askIv falls back to max(iv, floor).
   */
  private readRealized(market: PricingMarket, nowSeconds: number): Promise<RealizedVol> {
    const cached = this.realizedReads.get(market.ticker);
    if (cached !== undefined && this.nowMs() - cached.atMs < this.settings.realized.ttlMs) return cached.read;
    const reader = this.poolReader;
    const pool = market.pool;
    const none = (why: string): Promise<RealizedVol> => Promise.resolve({ ok: false, why, returns: 0, skipped: 0 });
    let read: Promise<RealizedVol>;
    if (pool === undefined) read = none('the registry names no v3 pool for this market');
    else if (reader === null || reader.observeSeries === undefined || market.token === undefined) read = none('no pool series reader is configured');
    else {
      const { lookbackS, stepS, minReturns } = this.settings.realized;
      const { instants, secondsAgos } = observeSchedule(nowSeconds, lookbackS, stepS);
      const asset = market.token.address;
      read = Promise.all([reader.meta(pool.address, asset), reader.observeSeries(pool.address, secondsAgos)]).then(
        ([meta, ticks]) => {
          const usdgIsToken0 = meta.token1.toLowerCase() === asset.toLowerCase();
          return realizedVolFromTwaps(twapSeries(instants, ticks, usdgIsToken0), { minReturns, holidays: this.settings.holidays });
        },
        (error: unknown): RealizedVol => ({ ok: false, why: `the pool series read failed: ${(error instanceof Error ? error.message : String(error)).split('\n')[0] ?? ''}`, returns: 0, skipped: 0 }),
      );
    }
    const atMs = this.nowMs();
    this.realizedReads.set(market.ticker, { atMs, read });
    void read.then((r) => this.lastRealized.set(market.ticker, { ...r, atMs }));
    return read;
  }

  /**
   * The token spot and every input behind it: the Chainlink round, the equity reference (the parity
   * forward, else the provider's underlying) with the divergence gate, and the pool spot. See TWO SPOTS
   * AND A LIVE FORWARD. `inputs.chainlinkUsdg6` is the Chainlink spot; which spot prices a request is
   * decided per side in fair().
   */
  private async loadSpot(market: PricingMarket, chain: NormalizedChain, nowSeconds: number): Promise<LoadedSpot> {
    const round = await this.readRound(market);
    if (round instanceof Error) return failure('spot-unavailable', { why: 'the feed read failed', feed: market.feed, error: round.message.split('\n')[0] ?? '' });
    const spot = tokenSpotFromRound(round, this.settings.maxSpotAgeS, nowSeconds);
    if ('ok' in spot) return { ...spot, detail: { feed: market.feed, ...spot.detail } };

    // The forward's strikes are chosen near the provider's underlying when it has one, else near the
    // token spot in share terms; the reference never enters the forward itself.
    const tokenSpot = Number(spot.spotUsdg6) / 1e6;
    const ui = market.token?.uiMultiplier ?? null;
    const shareOfToken = ui === null ? tokenSpot : (tokenSpot * Number(UNIT_UI_MULTIPLIER)) / Number(ui);
    const provider = chain.underlying.price;
    const reference = provider !== null && Number.isFinite(provider) && provider > 0 ? provider : shareOfToken;
    const fwd = impliedForward(chain, reference, nowSeconds, this.settings.forward);
    const equity = fwd.ok ? fwd.forward : (provider ?? Number.NaN);
    const mapped = mapSpot(equity, spot.spotUsdg6, this.settings.maxSpotDivergenceBps, ui);
    if (!mapped.ok) {
      return failure(mapped.reason === 'vol-spot-divergence' ? 'spot-divergence' : 'chain-inconsistent', { ...mapped.detail, equitySource: fwd.ok ? 'parity-forward' : 'provider-underlying' });
    }

    const inputs: SpotInputs = {
      chainlinkUsdg6: spot.spotUsdg6,
      chainlinkUpdatedAt: spot.updatedAt,
      equity: fwd.ok
        ? { source: 'parity-forward', price: fwd.forward, observedAt: fwd.observedAt, expiryDay: fwd.expiryDay, pairs: fwd.pairs.length, fallbackWhy: null }
        : { source: 'provider-underlying', price: provider, observedAt: chain.underlying.observedAt, expiryDay: fwd.expiryDay, pairs: 0, fallbackWhy: fwd.why },
      equityDivergenceBps: mapped.divergenceBps,
      pool: null,
      pricedWith: 'chainlink',
    };

    if (market.pool !== undefined) {
      const pool = await this.readPoolSpot(market);
      if ('reason' in pool) {
        if (this.settings.poolRequired) return pool;
        inputs.pool = { address: market.pool.address, spotUsdg6: null, windowS: this.settings.poolTwapS, harmonicLiquidity: null, minLiquidity: market.pool.minLiquidity, divergenceBps: null, unusable: pool.detail.why ?? pool.reason };
      } else {
        const p = pool;
        const divergenceBps = poolChainlinkDivergenceBps(spot.spotUsdg6, p.spotUsdg6);
        inputs.pool = { address: market.pool.address, spotUsdg6: p.spotUsdg6, windowS: p.windowS, harmonicLiquidity: p.harmonicLiquidity, minLiquidity: market.pool.minLiquidity, divergenceBps, unusable: null };
        // 1e-6: the limit is inclusive, not a float artefact (vol.ts mapSpot).
        if (divergenceBps > this.settings.maxPoolChainlinkDivergenceBps + 1e-6) {
          this.lastSpotInputs.set(market.ticker, { ...inputs, atMs: this.nowMs() });
          return failure('source-disagreement', {
            why: 'the pool TWAP and the Chainlink spot disagree by more than the limit',
            chainlinkUsdg6: spot.spotUsdg6.toString(),
            poolUsdg6: p.spotUsdg6.toString(),
            divergenceBps: divergenceBps.toFixed(1),
            maxPoolChainlinkDivergenceBps: String(this.settings.maxPoolChainlinkDivergenceBps),
            pool: market.pool.address,
          });
        }
      }
    }
    this.lastSpotInputs.set(market.ticker, { ...inputs, atMs: this.nowMs() });
    return { ok: true, spot, inputs };
  }

  async fair(request: FairRequest): Promise<FairOutcome> {
    const market = this.markets.get(request.ticker);
    if (market === undefined) return failure('unknown-ticker', { ticker: request.ticker });
    const nowSeconds = this.nowSeconds();
    if (request.expiry <= nowSeconds) return failure('expired', { expiry: String(request.expiry), nowSeconds: String(nowSeconds) });
    const loaded = await this.loadChain(market, nowSeconds);
    if (!loaded.ok) return loaded;
    // Before the RPC: a series the trading clock cannot price costs no feed read.
    const clock = checkExpiryClock({
      nowSeconds,
      surfaceAsOf: loaded.surface.asOf,
      surfaceClockBasis: loaded.chain.clocks.quoteObservedAt !== null ? 'quote' : 'underlying',
      expiry: request.expiry,
      holidays: this.settings.holidays,
      earlyCloses: this.settings.earlyCloses,
    });
    if (!clock.ok) return clock;
    const loadedSpot = await this.loadSpot(market, loaded.chain, nowSeconds);
    if (!loadedSpot.ok) return loadedSpot;
    const chosen = conservativeSpot(request.type, loadedSpot.inputs.chainlinkUsdg6, loadedSpot.inputs.pool?.spotUsdg6 ?? null);
    const spot = { spotUsdg6: chosen.spotUsdg6 };
    const spotInputs: SpotInputs = { ...loadedSpot.inputs, pricedWith: chosen.pricedWith };
    this.lastSpotInputs.set(market.ticker, { ...spotInputs, atMs: this.nowMs() });
    const tokenSpot = Number(spot.spotUsdg6) / 1e6;
    const priced = priceContract({ surface: loaded.surface, request, tokenSpot, nowSeconds });
    if (!priced.ok) return priced;
    const policy = this.settings.shortMaturity;
    const assessed = assessShortMaturity({ surface: loaded.surface, request, priced, tokenSpot, clock, events: this.events.get(market.ticker) ?? null, policy });
    if (assessed.modelUncertain && policy.onModelUncertainty === 'refuse') {
      const u = assessed.uncertainty;
      return failure('model-uncertainty', {
        why: 'the estimate is less certain than the short-maturity policy allows',
        method: priced.method,
        reasons: assessed.reasons.join(','),
        eventInput: assessed.diagnostics.eventInput,
        iv: String(priced.iv),
        ivLow: String(u?.ivLow ?? null),
        ivHigh: String(u?.ivHigh ?? null),
        relativeIvWidth: String(assessed.diagnostics.relativeIvWidth),
        maxRelativeIvWidth: String(policy.maxRelativeIvWidth),
      });
    }
    const maxAgeS = this.settings.maxChainAgeS;
    const provenance = buildFairProvenance({
      chain: loaded.chain,
      canonical: canonicalIdentity(market),
      request,
      priced,
      spotUsdg6: spot.spotUsdg6,
      nowSeconds,
      limits: { maxQuoteAgeS: maxAgeS, maxUnderlyingAgeS: maxAgeS, maxVolatilityAgeS: maxAgeS },
      uncertainty: assessed.uncertainty,
      uncertaintyReasons: assessed.reasons,
      spotInputs,
    });
    const realized = await this.readRealized(market, nowSeconds);
    const realizedVol = realized.ok ? realized.vol : null;
    const askIv = askIvFor({ iv: priced.iv, realizedVol, ticker: market.ticker, settings: this.settings.askIv });
    const event = eventsInWindow(this.events.get(market.ticker) ?? null, nowSeconds, request.expiry);
    return { ...priced, spotUsdg6: spot.spotUsdg6, asOf: loaded.surface.asOf, provenance, diagnostics: assessed.diagnostics, askIv, realizedVol, realizedWhy: realized.ok ? null : realized.why, event };
  }

  /** Each ticker's latest realized-vol read, for /health. */
  realizedReadsSnapshot(): ReadonlyMap<string, RealizedVol & { atMs: number }> {
    return this.lastRealized;
  }

  /** Whether an event calendar was supplied at all, and for which tickers, for /health. */
  eventCalendarTickers(): string[] {
    return [...this.events.keys()].sort();
  }

  /** The ticker's surface, in the listed market's terms. Needs no spot. */
  async surface(ticker: string): Promise<SurfaceOutcome> {
    const market = this.markets.get(ticker);
    if (market === undefined) return failure('unknown-ticker', { ticker });
    const loaded = await this.loadChain(market, this.nowSeconds());
    if (!loaded.ok) return loaded;
    return { ok: true, surface: loaded.surface, chain: loaded.chain, fetchedAtMs: loaded.entry.fetchedAtMs };
  }

  /** The option-chain provider the cache downloads from. */
  get chainProvider(): ProviderDescriptor {
    return this.chains.descriptor;
  }

  /** The spot inputs of each ticker's latest priced or refused request, for /health. */
  spotInputs(): ReadonlyMap<string, SpotInputs & { atMs: number }> {
    return this.lastSpotInputs;
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
    const lastGood = refuseLastGood(entry, this.chains.descriptor);
    if (lastGood !== null) return lastGood.reason;
    const check = checkChain(entry.chain, market.cboe.root, this.nowSeconds(), { maxAgeS: this.settings.maxChainAgeS, holidays: this.settings.holidays });
    return check.ok ? 'ok' : check.reason;
  }

  uptimeSeconds(): number {
    return Math.floor((this.nowMs() - this.startedAtMs) / 1000);
  }
}
