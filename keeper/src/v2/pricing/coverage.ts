/**
 * Pricing coverage (K3-303): every rung the cranker would list, priced in process, one record each.
 *
 * WHAT IT COVERS. For each selected market the cranker's OWN ladder: cranker/planner.ts upcomingLadderExpiries
 * (ExpiryCalendar.nextExpiry from ladderSearchStart, the on-chain calendar or localNextExpiry below), ladderSlots
 * (which tenors, expiries and sides carry a ladder) and planLadder (the strikes of a first ladder at spot, exactly
 * as the cranker creates one). Nothing here restates a ladder rule. Two differences from a live cranker tick, both
 * stated in the report: the ladder is centred on the Stock Token feed's spot (the settlement oracle's primary source;
 * the cranker reads SettlementOracle.trySpot), and it is the ladder at today's spot, while a live ladder keeps the
 * strikes it was created at until it re-centres (planLadder's anchor).
 *
 * HOW A RUNG IS PRICED. PricingService.fair (fair.ts) through the provider-neutral seam (chain.ts
 * OptionChainProvider): Cboe's delayed file by default, any provider or fake injected. Its internal provenance
 * (provenance.ts) gives the provider, method, contributing expiries, clocks, ages, entitlement, readiness and
 * reasons; this file adds what only a coverage run knows:
 *   listing     whether the provider lists the exact contract (same New York day, side and strike, fair.ts's
 *               strike rule), whether that listed quote is usable, and its bid/ask/sizes as supplied;
 *   floor       belowFloor against a house floor (default PROPOSED_HOUSE_FLOOR_USDG6, the F3 D9 PROPOSAL of
 *               0.05 USDG fair, not an approved value). A zero fair is below it; a null fair is unknown (null);
 *   early close an expiry on an NYSE early-close day (calendar.ts NYSE_EARLY_CLOSES_2026_2028) is `early-close`:
 *               the listed market stops at 13:00 while the series settles at 16:00, and no clock models that;
 *   events      with an event calendar (earnings dates the operator supplies), an event inside the series' life
 *               or inside the listed inputs it was priced from is `event-uncertainty` (F3 D7: a later listed
 *               expiry cannot separate an earnings jump from ordinary variance). Without a calendar, `events` is
 *               null (unknown), never [] (none).
 * Either added reason keeps a rung from `ready`. A refused rung is `unavailable` with fair null and the service's
 * refusal reason verbatim; a price of zero is fair "0", never null.
 *
 * WHAT IT REPORTS. Per market and tenor counts (ready / degraded / unavailable / below floor), each tenor on its own
 * line, so a weekly pass never hides a daily failure. F1 registration inputs (identity, strike tick against the
 * listed spacing, ladder, expiries, listing, floor evidence) separately from MM/pricer quote readiness: a series that
 * is not ready blocks automated quoting on it, not the registration of its market (F3 D9). Suggestions
 * (suggestLadders) are derived output only: `overrides.ladder` and a strike-tick flag, never `expiriesAhead`, never
 * zero rungs, never a disabled daily (owner D6), and nothing here writes the registry.
 *
 * NO NETWORK OF ITS OWN. Every read goes through a seam: the provider, the feed reader and the calendar read.
 */
import { formatUnits } from 'viem';
import { z } from 'zod';
import { CLOSE_HOUR_ET, NYSE_EARLY_CLOSES_2026_2028, newYorkParts, newYorkTimeToUnix } from '../../calendar.js';
import { ladderSlots, ladderStrikes, planLadder, upcomingLadderExpiries, type NextExpiryRead } from '../cranker/planner.js';
import { TENORS, v2Markets, type LadderParams, type Tenor, type V2Market, type V2MarketStatus, type V2Registry } from '../registry.js';
import { isUsableQuote } from './cboe.js';
import { STANDARD_LISTED_MULTIPLIER, bookState, listedOptionOf, type BookState, type NormalizedChain, type ProviderDescriptor } from './chain.js';
import { canonicalIdentity, type FairMethod, type FairOutcome, type PricingService } from './fair.js';
import type { ProvenanceMethod } from './provenance.js';
import { money, type Money } from './server.js';
import type { EventCalendar as ServiceEventCalendar } from './short-maturity.js';
import { tokenSpotFromRound, type SpotReader } from './spot.js';

/*//////////////////////////////////////////////////////////////
                            CONSTANTS
//////////////////////////////////////////////////////////////*/

export const COVERAGE_CONTRACT = 'K3-303/1' as const;

/** F3 D9's PROPOSED house floor: 0.05 USDG fair. A proposal, not an approved parameter. */
export const PROPOSED_HOUSE_FLOOR_USDG6 = 50_000n;

/** Human output lists tenors daily first: the tenor most likely to fail is read first. */
export const DISPLAY_TENORS: readonly Tenor[] = ['daily', 'weekly'];

/** ExpiryCalendar.nextExpiry searches this far past `afterTs` (indexer/lib/v2/calendar.ts mirrors the same). */
export const NEXT_EXPIRY_SEARCH_S = 14 * 86_400;

/** Listed strikes within this fraction of the underlying price count as "near the money" for the spacing. */
export const NEAR_MONEY_BAND = 0.1;

const DAY_S = 86_400;

/*//////////////////////////////////////////////////////////////
                    THE EXPIRY GRID, OFFLINE
//////////////////////////////////////////////////////////////*/

const isoOfDayIndex = (day: number) => new Date(day * DAY_S * 1_000).toISOString().slice(0, 10);
/** Monday 0 … Sunday 6 (day index 0 = Thursday 1 January 1970). */
const weekdayOf = (day: number) => (day + 3) % 7;

function closeOfDayIndex(day: number): number {
  const [y, m, d] = isoOfDayIndex(day).split('-').map(Number) as [number, number, number];
  return newYorkTimeToUnix(y, m, d, CLOSE_HOUR_ET);
}

/**
 * A local mirror of ExpiryCalendar.nextExpiry on `holidays` (full-day NYSE closures): every weekday that is not a
 * holiday closes a daily at 16:00 New York; a weekly is the last such day of its Monday-Friday week (Thursday when
 * Friday is shut). Strictly after `afterTs`, within NEXT_EXPIRY_SEARCH_S; rejects otherwise, as the contract reverts.
 * Early closes keep their 16:00 grid close, as on chain. For offline runs and tests; a live run reads the contract.
 */
export function localNextExpiry(holidays: readonly string[]): NextExpiryRead {
  const shut = new Set(holidays);
  const session = (day: number) => weekdayOf(day) < 5 && !shut.has(isoOfDayIndex(day));
  const weeklyDay = (day: number) => {
    if (!session(day)) return false;
    for (let later = day + 1; weekdayOf(later) < 5; later += 1) if (session(later)) return false;
    return true;
  };
  return async (afterTs, weekly) => {
    const limit = afterTs + NEXT_EXPIRY_SEARCH_S;
    for (let day = Math.floor(afterTs / DAY_S); ; day += 1) {
      const close = closeOfDayIndex(day);
      if (close > limit) break;
      if (close > afterTs && (weekly ? weeklyDay(day) : session(day))) return close;
    }
    throw new Error(`no ${weekly ? 'weekly' : 'daily'} close within ${NEXT_EXPIRY_SEARCH_S / DAY_S} days after ${afterTs}`);
  };
}

/** YYYY-MM-DD and the weekday of an instant, in New York. */
export function newYorkDay(unixSeconds: number): { day: string; weekday: string } {
  const p = newYorkParts(unixSeconds);
  return { day: `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`, weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][p.weekday] ?? '?' };
}

/*//////////////////////////////////////////////////////////////
                          EVENT CALENDAR
//////////////////////////////////////////////////////////////*/

/** A dated event the operator supplies (earnings). Never invented here. */
export interface MarketEvent {
  kind: string;
  /** Unix seconds. */
  at: number;
  label: string | null;
  /** The New York day, for the pricing service's K3-312 event input (short-maturity.ts). */
  date: string;
  /** bmo before the open, amc after the close, null when only an instant was given (timing unknown). */
  timing: 'bmo' | 'amc' | null;
}

/** Per registry ticker. A ticker with no entry has no known event (the calendar as a whole is still present). */
export type EventCalendar = ReadonlyMap<string, readonly MarketEvent[]>;

const eventSchema = z
  .object({
    kind: z.string().min(1).default('earnings'),
    label: z.string().optional(),
    at: z.number().int().positive().optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    session: z.enum(['before-open', 'after-close']).optional(),
  })
  .strict()
  .refine((e) => (e.at !== undefined) !== (e.date !== undefined && e.session !== undefined), 'give either `at` (unix seconds) or both `date` and `session`');

/**
 * `{ "NVDA": [{ "kind": "earnings", "date": "YYYY-MM-DD", "session": "after-close" }] }` or `{ "at": <unix s> }`.
 * `before-open` is 09:00 New York that day (inside that day's series); `after-close` one second after its 16:00 close
 * (outside that day's series, inside the next one's). Throws with every problem listed.
 */
export function parseEventCalendar(json: unknown): EventCalendar {
  const parsed = z.record(z.string().regex(/^[A-Z0-9.]{1,8}$/), z.array(eventSchema)).safeParse(json);
  if (!parsed.success) {
    throw new Error(`the event calendar is not usable:\n  ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('\n  ')}`);
  }
  const out = new Map<string, MarketEvent[]>();
  for (const [ticker, events] of Object.entries(parsed.data)) {
    out.set(
      ticker,
      events.map((e) => {
        if (e.at !== undefined) {
          const { day } = newYorkDay(e.at);
          return { kind: e.kind, at: e.at, label: e.label ?? null, date: day, timing: null };
        }
        const [y, m, d] = e.date!.split('-').map(Number) as [number, number, number];
        const at = e.session === 'before-open' ? newYorkTimeToUnix(y, m, d, 9) : newYorkTimeToUnix(y, m, d, CLOSE_HOUR_ET) + 1;
        return { kind: e.kind, at, label: e.label ?? null, date: e.date!, timing: e.session === 'before-open' ? 'bmo' : 'amc' };
      }),
    );
  }
  return out;
}

/**
 * The same calendar as the pricing service's K3-312 event input (short-maturity.ts EventCalendar):
 * the single source of truth for event-uncertainty. The service's reasons ride verbatim in each
 * rung's `reasons`; the coverage's own `events` field only reports which of these events a rung
 * spans (inside-series / inside-inputs), which the service does not say.
 */
export function toServiceEventCalendar(events: EventCalendar): ServiceEventCalendar {
  const out = new Map<string, { events: Array<{ date: string; kind: string; timing: 'bmo' | 'amc' | null }>; through: string | null }>();
  for (const [ticker, list] of events) {
    out.set(ticker, { events: list.map((e) => ({ date: e.date, kind: e.kind, timing: e.timing })), through: null });
  }
  return out;
}

export interface RungEvent extends MarketEvent {
  /** inside-series: before the series expires; inside-inputs: after it, but inside a listed expiry it was priced from. */
  relation: 'inside-series' | 'inside-inputs';
}

/** The events a rung's price is exposed to: after `nowS`, up to its expiry or its latest contributing listed expiry. */
export function rungEvents(events: readonly MarketEvent[], nowS: number, expiry: number, contributingExpiries: readonly number[]): RungEvent[] {
  const end = Math.max(expiry, ...contributingExpiries);
  return events.filter((e) => e.at > nowS && e.at <= end).map((e) => ({ ...e, relation: e.at <= expiry ? 'inside-series' : 'inside-inputs' }));
}

/*//////////////////////////////////////////////////////////////
                              TYPES
//////////////////////////////////////////////////////////////*/

export interface CoverageClocks {
  quoteObservedAt: number | null;
  tradeObservedAt: number | null;
  underlyingObservedAt: number | null;
  volatilityObservedAt: number | null;
  publishedAt: number | null;
  /** null only when no chain was ever received. */
  receivedAt: number | null;
  computedAt: number;
}

export interface CoverageAges {
  quoteS: number | null;
  tradeS: number | null;
  underlyingS: number | null;
  volatilityS: number | null;
  publishedS: number | null;
  receivedS: number | null;
}

export interface ListingPresence {
  /** Whether the provider lists this New York expiry day at all; null when there is no chain to look in. */
  expiryListed: boolean | null;
  /** Whether it lists the exact contract (day, side, strike); null when there is no chain. */
  exact: boolean | null;
  providerInstrumentId: string | null;
  /** The exact listing's quote passes the quote gates (it could be a listed input). null without one. */
  usable: boolean | null;
  book: BookState['state'] | null;
  /** As the provider supplied them, listed-share USD; null = not supplied (0 is a supplied zero). */
  bid: number | null;
  ask: number | null;
  bidSize: number | null;
  askSize: number | null;
  quoteObservedAt: number | null;
  /** A provider model value on the same row, kept apart from the quote. */
  theoretical: number | null;
}

export interface CoverageIdentity {
  market: string;
  root: string | null;
  issuer: string | null;
  token: { chainId: number | null; address: string | null; uiMultiplier: string | null };
}

export interface RungRecord {
  kind: 'rung';
  contract: typeof COVERAGE_CONTRACT;
  ticker: string;
  tenor: Tenor;
  /** 0 = the rung nearest the money. */
  rung: number;
  side: 'call' | 'put';
  expiry: number;
  expiryDay: string;
  expiryWeekday: string;
  /** USDG per whole token. */
  strike: Money;
  identity: CoverageIdentity;
  provider: string;
  providerProduct: string | null;
  entitlement: ProviderDescriptor['entitlement'];
  method: ProvenanceMethod | null;
  methodDetail: FairMethod | null;
  contributingExpiries: number[];
  clocks: CoverageClocks;
  ages: CoverageAges;
  readiness: 'ready' | 'degraded' | 'unavailable';
  reasons: string[];
  /** null: unavailable (see `refusal`). { raw: "0" }: a zero estimate, a price. */
  fair: Money | null;
  iv: number | null;
  delta: number | null;
  pricedSpot: Money | null;
  refusal: { reason: string; detail: Record<string, string> } | null;
  /** fair < floor; null when fair is null. */
  belowFloor: boolean | null;
  listing: ListingPresence;
  session: { earlyClose: boolean; holidayShiftedWeekly: boolean };
  /** null: no event calendar was supplied (unknown); []: supplied, none applies. */
  events: RungEvent[] | null;
}

export interface ChainView {
  present: boolean;
  provider: string;
  providerProduct: string | null;
  entitlement: ProviderDescriptor['entitlement'];
  /** 'ok', or the reason every price of this chain is refused (fair.ts PricingService.surface). */
  state: string;
  refusal: { reason: string; detail: Record<string, string> } | null;
  /** The latest download's error (a failed refetch may still serve the last good chain). */
  fetchError: string | null;
  clocks: CoverageClocks;
  ages: CoverageAges;
  underlyingPrice: number | null;
  /** Every New York expiry day the chain lists for the market's root (standard contracts), ascending. */
  listedDays: string[];
}

export interface MarketCoverage {
  ticker: string;
  status: V2MarketStatus;
  wave: string;
  identity: CoverageIdentity;
  strikeTick: bigint;
  puts: boolean;
  ladder: Record<Tenor, LadderParams>;
  expiriesAhead: Record<Tenor, number>;
  /** The expiries this market's ladder targets, per tenor (possibly fewer than asked: the calendar ran out). */
  expiries: Record<Tenor, number[]>;
  spot: { usdg6: bigint; updatedAt: number; ageSeconds: number } | null;
  /** Why no ladder was built (the cranker would skip the market too: no fresh spot). */
  ladderError: { reason: string; detail: Record<string, string> } | null;
  chain: ChainView;
  listedSpacing: { day: string; spacingUsd: number } | null;
  rungs: RungRecord[];
}

export interface CoverageReport {
  contract: typeof COVERAGE_CONTRACT;
  computedAt: number;
  provider: ProviderDescriptor;
  expirySource: string;
  /** Why the calendar read ended early (a revert, an RPC failure), verbatim; [] when it answered every read. */
  expiryErrors: string[];
  floor: { usdg6: bigint; proposal: boolean };
  eventCalendar: 'provided' | 'absent';
  ladderSpot: 'feed';
  markets: MarketCoverage[];
}

/*//////////////////////////////////////////////////////////////
                            SELECTION
//////////////////////////////////////////////////////////////*/

export class CoverageUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoverageUsageError';
  }
}

/**
 * The markets to cover, in registry order: `tickers` when given (any v2 status; each must exist and carry a `v2`
 * block), else every v2 market whose status is in `statuses` (default live, what the cranker ladders).
 */
export function selectMarkets(registry: V2Registry, selection: { tickers: readonly string[] | null; statuses: readonly V2MarketStatus[] }): V2Market[] {
  if (selection.tickers === null) return v2Markets(registry, selection.statuses);
  const problems: string[] = [];
  const wanted = new Set(selection.tickers);
  for (const t of wanted) {
    const m = registry.markets.find((x) => x.ticker === t);
    if (m === undefined) problems.push(`${t}: not in the registry`);
    else if (m.v2 === null) problems.push(`${t}: no v2 block (not a v2 market): the cranker has no ladder for it`);
  }
  if (problems.length > 0) throw new CoverageUsageError(`--tickers: ${problems.join('; ')}`);
  return registry.markets.filter((m): m is V2Market => m.v2 !== null && wanted.has(m.ticker));
}

/*//////////////////////////////////////////////////////////////
                         LISTING AND CHAIN
//////////////////////////////////////////////////////////////*/

const ageOf = (at: number | null, nowS: number) => (at === null ? null : nowS - at);

function agesOf(c: Omit<CoverageClocks, 'computedAt'>, nowS: number, quoteS?: number | null, tradeS?: number | null, underlyingS?: number | null, volatilityS?: number | null): CoverageAges {
  return {
    quoteS: quoteS === undefined ? ageOf(c.quoteObservedAt, nowS) : quoteS,
    tradeS: tradeS === undefined ? ageOf(c.tradeObservedAt, nowS) : tradeS,
    underlyingS: underlyingS === undefined ? ageOf(c.underlyingObservedAt, nowS) : underlyingS,
    volatilityS: volatilityS === undefined ? ageOf(c.volatilityObservedAt, nowS) : volatilityS,
    publishedS: ageOf(c.publishedAt, nowS),
    receivedS: ageOf(c.receivedAt, nowS),
  };
}

/** Rows the market's root states as standard contracts (a null root or multiplier is "not stated", kept). */
function standardRows(chain: NormalizedChain, root: string) {
  return chain.rows.filter((r) => (r.instrument.root === null || r.instrument.root === root) && (r.instrument.multiplier === null || r.instrument.multiplier === STANDARD_LISTED_MULTIPLIER));
}

/** Whether `chain` lists the exact contract; fair.ts's strike rule (the numbers compared to the listing's 3 dp). */
export function listingPresence(chain: NormalizedChain | null, root: string | null, request: { day: string; side: 'C' | 'P'; strikeUsdg6: bigint }): ListingPresence {
  const none: ListingPresence = { expiryListed: null, exact: null, providerInstrumentId: null, usable: null, book: null, bid: null, ask: null, bidSize: null, askSize: null, quoteObservedAt: null, theoretical: null };
  if (chain === null || root === null) return none;
  const rows = standardRows(chain, root).filter((r) => r.instrument.expiryDay === request.day);
  const thousandths = request.strikeUsdg6 % 1_000n === 0n ? request.strikeUsdg6 / 1_000n : null;
  const row = thousandths === null ? undefined : rows.find((r) => r.instrument.side === request.side && BigInt(Math.round(r.instrument.strike * 1_000)) === thousandths);
  if (row === undefined) return { ...none, expiryListed: rows.length > 0, exact: false };
  const listed = listedOptionOf(row, root);
  const q = row.quote;
  return {
    expiryListed: true,
    exact: true,
    providerInstrumentId: row.instrument.providerInstrumentId,
    usable: typeof listed !== 'string' && isUsableQuote(listed),
    book: bookState(q).state,
    bid: q?.bid ?? null,
    ask: q?.ask ?? null,
    bidSize: q?.bidSize ?? null,
    askSize: q?.askSize ?? null,
    quoteObservedAt: q?.observedAt ?? chain.clocks.quoteObservedAt,
    theoretical: row.theoretical?.value ?? null,
  };
}

/**
 * The listed strike spacing near the money: on the first listed day at or after `fromDay` with at least three
 * strikes within NEAR_MONEY_BAND of the underlying price, the most common gap between them (ties: the smallest).
 */
export function listedStrikeSpacing(chain: NormalizedChain | null, root: string | null, fromDay: string): { day: string; spacingUsd: number } | null {
  if (chain === null || root === null) return null;
  const price = chain.underlying.price;
  if (price === null || !(price > 0)) return null;
  const byDay = new Map<string, Set<number>>();
  for (const r of standardRows(chain, root)) {
    if (r.instrument.expiryDay < fromDay) continue;
    if (Math.abs(r.instrument.strike / price - 1) > NEAR_MONEY_BAND) continue;
    const set = byDay.get(r.instrument.expiryDay) ?? new Set<number>();
    set.add(Math.round(r.instrument.strike * 1_000));
    byDay.set(r.instrument.expiryDay, set);
  }
  for (const day of [...byDay.keys()].sort()) {
    const strikes = [...byDay.get(day)!].sort((a, b) => a - b);
    if (strikes.length < 3) continue;
    const counts = new Map<number, number>();
    for (let i = 1; i < strikes.length; i += 1) counts.set(strikes[i]! - strikes[i - 1]!, (counts.get(strikes[i]! - strikes[i - 1]!) ?? 0) + 1);
    const [gap] = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]!;
    return { day, spacingUsd: gap / 1_000 };
  }
  return null;
}

function chainView(service: PricingService, ticker: string, provider: ProviderDescriptor, root: string | null, refusal: { reason: string; detail: Record<string, string> } | null, nowS: number): ChainView {
  const entry = service.chainAttempts().get(ticker);
  const chain = entry?.chain ?? null;
  const clocks: Omit<CoverageClocks, 'computedAt'> =
    chain === null
      ? { quoteObservedAt: null, tradeObservedAt: null, underlyingObservedAt: null, volatilityObservedAt: null, publishedAt: null, receivedAt: null }
      : {
          quoteObservedAt: chain.clocks.quoteObservedAt,
          tradeObservedAt: chain.clocks.tradeObservedAt,
          underlyingObservedAt: chain.underlying.observedAt,
          volatilityObservedAt: chain.clocks.volatilityObservedAt,
          publishedAt: chain.clocks.publishedAt,
          receivedAt: chain.clocks.receivedAt,
        };
  const listedDays = chain === null || root === null ? [] : [...new Set(standardRows(chain, root).map((r) => r.instrument.expiryDay))].sort();
  return {
    present: chain !== null,
    provider: chain?.provider.id ?? provider.id,
    providerProduct: chain === null ? provider.product : chain.provider.product,
    entitlement: chain?.provider.entitlement ?? provider.entitlement,
    state: refusal === null ? 'ok' : refusal.reason,
    refusal,
    fetchError: entry?.error ?? null,
    clocks: { ...clocks, computedAt: nowS },
    ages: agesOf(clocks, nowS),
    underlyingPrice: chain?.underlying.price ?? null,
    listedDays,
  };
}

/*//////////////////////////////////////////////////////////////
                              RUNS
//////////////////////////////////////////////////////////////*/

export interface CoverageOptions {
  registry: V2Registry;
  service: PricingService;
  /** The provider the service was built with: labels a record when no chain was ever received. */
  provider: ProviderDescriptor;
  /** SEAM: the Stock Token feed read that centres the ladder (the service reads its own for prices). */
  spotReader: SpotReader;
  /** SEAM: ExpiryCalendar.nextExpiry (the contract, or localNextExpiry). */
  nextExpiry: NextExpiryRead;
  /** What `nextExpiry` is, for the report: `chain:<address>` or `local-mirror`. */
  expirySource: string;
  nowMs: () => number;
  selection: { tickers: readonly string[] | null; statuses: readonly V2MarketStatus[] };
  floorUsdg6: bigint;
  events: EventCalendar | null;
  earlyCloses?: readonly string[];
}

type LadderSpot = { ok: true; usdg6: bigint; updatedAt: number; ageSeconds: number } | { ok: false; reason: string; detail: Record<string, string> };

async function readLadderSpot(spotReader: SpotReader, market: V2Market, nowS: number): Promise<LadderSpot> {
  let round;
  try {
    round = await spotReader(market.feed);
  } catch (error) {
    return { ok: false, reason: 'spot-unavailable', detail: { why: 'the feed read failed', feed: market.feed, error: (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '' } };
  }
  // The oracle's own freshness limit: a spot it would refuse is one the cranker skips the market on.
  const spot = tokenSpotFromRound(round, market.v2.params.spotMaxAgeS, nowS);
  if ('ok' in spot) return { ok: false, reason: spot.reason, detail: { feed: market.feed, ...spot.detail } };
  return { ok: true, usdg6: spot.spotUsdg6, updatedAt: spot.updatedAt, ageSeconds: spot.ageSeconds };
}

async function coverMarket(options: CoverageOptions, market: V2Market, expiries: Record<Tenor, number[]>, nowS: number): Promise<MarketCoverage> {
  const { service } = options;
  const pricingMarket = service.markets.get(market.ticker);
  const canonical = pricingMarket === undefined ? { market: market.ticker, root: market.cboe?.root ?? null, issuer: null, token: { chainId: null, address: null, uiMultiplier: null } } : canonicalIdentity(pricingMarket);
  const identity: CoverageIdentity = { market: canonical.market, root: canonical.root, issuer: canonical.issuer, token: canonical.token };
  const surface = await service.surface(market.ticker);
  const chainRefusal = surface.ok ? null : { reason: surface.reason, detail: surface.detail };
  const view = chainView(service, market.ticker, options.provider, identity.root, chainRefusal, nowS);
  const chain = service.chainAttempts().get(market.ticker)?.chain ?? null;
  const own: Record<Tenor, number[]> = { weekly: expiries.weekly.slice(0, market.v2.params.expiriesAhead.weekly), daily: expiries.daily.slice(0, market.v2.params.expiriesAhead.daily) };
  const firstDay = [...own.daily, ...own.weekly].sort((a, b) => a - b)[0];
  const base: MarketCoverage = {
    ticker: market.ticker,
    status: market.v2.status,
    wave: market.v2.wave,
    identity,
    strikeTick: market.v2.strikeTick,
    puts: market.v2.puts,
    ladder: market.v2.params.ladder,
    expiriesAhead: market.v2.params.expiriesAhead,
    expiries: own,
    spot: null,
    ladderError: null,
    chain: view,
    listedSpacing: listedStrikeSpacing(chain, identity.root, firstDay === undefined ? '0000-00-00' : newYorkDay(firstDay).day),
    rungs: [],
  };

  const spot = await readLadderSpot(options.spotReader, market, nowS);
  if (!spot.ok) return { ...base, ladderError: { reason: spot.reason, detail: spot.detail } };
  const earlyCloses = new Set(options.earlyCloses ?? NYSE_EARLY_CLOSES_2026_2028);
  const events = options.events === null ? null : (options.events.get(market.ticker) ?? []);
  const rungs: RungRecord[] = [];
  for (const { tenor, expiry, isPut } of ladderSlots(market.v2.params, market.v2.puts, expiries)) {
    // The cranker's first ladder at this spot: nothing exists, no anchor (cranker/steps.ts stepLadders).
    const strikes = planLadder({ spot: spot.usdg6, ladder: market.v2.params.ladder[tenor], strikeTick: market.v2.strikeTick, isPut, existing: [], anchor: null }).create;
    const { day, weekday } = newYorkDay(expiry);
    for (const [i, strike] of strikes.entries()) {
      const side = isPut ? 'put' : 'call';
      const outcome = await service.fair({ ticker: market.ticker, strikeUsdg6: strike, expiry, type: side });
      rungs.push(
        rungRecord({
          outcome,
          ticker: market.ticker,
          tenor,
          rung: isPut ? strikes.length - 1 - i : i,
          side,
          expiry,
          day,
          weekday,
          strike,
          identity,
          view,
          listing: listingPresence(chain, identity.root, { day, side: isPut ? 'P' : 'C', strikeUsdg6: strike }),
          floorUsdg6: options.floorUsdg6,
          earlyClose: earlyCloses.has(day),
          holidayShiftedWeekly: tenor === 'weekly' && weekday !== 'Fri',
          events,
          nowS,
        }),
      );
    }
  }
  return { ...base, spot: { usdg6: spot.usdg6, updatedAt: spot.updatedAt, ageSeconds: spot.ageSeconds }, rungs };
}

interface RungInput {
  outcome: FairOutcome;
  ticker: string;
  tenor: Tenor;
  rung: number;
  side: 'call' | 'put';
  expiry: number;
  day: string;
  weekday: string;
  strike: bigint;
  identity: CoverageIdentity;
  view: ChainView;
  listing: ListingPresence;
  floorUsdg6: bigint;
  earlyClose: boolean;
  holidayShiftedWeekly: boolean;
  events: readonly MarketEvent[] | null;
  nowS: number;
}

function rungRecord(input: RungInput): RungRecord {
  const { outcome, view, nowS } = input;
  const contributing = outcome.ok ? outcome.provenance.contributingExpiries : [];
  const events = input.events === null ? null : rungEvents(input.events, nowS, input.expiry, contributing);
  const extra: string[] = [];
  if (input.earlyClose) extra.push('early-close');
  if (events !== null && events.length > 0) extra.push('event-uncertainty');
  const common = {
    kind: 'rung' as const,
    contract: COVERAGE_CONTRACT,
    ticker: input.ticker,
    tenor: input.tenor,
    rung: input.rung,
    side: input.side,
    expiry: input.expiry,
    expiryDay: input.day,
    expiryWeekday: input.weekday,
    strike: money(input.strike),
    identity: input.identity,
    listing: input.listing,
    session: { earlyClose: input.earlyClose, holidayShiftedWeekly: input.holidayShiftedWeekly },
    events,
  };
  if (!outcome.ok) {
    return {
      ...common,
      provider: view.provider,
      providerProduct: view.providerProduct,
      entitlement: view.entitlement,
      method: null,
      methodDetail: null,
      contributingExpiries: [],
      clocks: view.clocks,
      ages: view.ages,
      readiness: 'unavailable',
      reasons: [outcome.reason, ...extra.filter((r) => r !== outcome.reason)],
      fair: null,
      iv: null,
      delta: null,
      pricedSpot: null,
      refusal: { reason: outcome.reason, detail: outcome.detail },
      belowFloor: null,
    };
  }
  const p = outcome.provenance;
  const reasons = [...p.quality.reasons];
  for (const r of extra) if (!reasons.includes(r)) reasons.push(r);
  const { computedAt, ...clocks } = p.clocks;
  return {
    ...common,
    provider: p.provider,
    providerProduct: p.providerProduct,
    entitlement: p.entitlement,
    method: p.method,
    methodDetail: p.methodDetail,
    contributingExpiries: p.contributingExpiries,
    clocks: p.clocks,
    ages: agesOf(clocks, computedAt, p.ages.quoteS, p.ages.tradeS, p.ages.underlyingS, p.ages.volatilityS),
    // §5.1: ready only with no reason at all.
    readiness: reasons.length === 0 ? 'ready' : p.quality.readiness === 'ready' ? 'degraded' : p.quality.readiness,
    reasons,
    fair: money(outcome.fairUsdg6),
    iv: outcome.iv,
    delta: outcome.delta,
    pricedSpot: p.pricedSpotUsdg6 === null ? null : money(p.pricedSpotUsdg6),
    refusal: null,
    belowFloor: outcome.fairUsdg6 < input.floorUsdg6,
  };
}

/** One coverage pass over the selected markets. Markets run concurrently; the report keeps registry order. */
export async function runCoverage(options: CoverageOptions): Promise<CoverageReport> {
  const nowS = Math.floor(options.nowMs() / 1000);
  const markets = selectMarkets(options.registry, options.selection);
  // One upcoming list per tenor at the largest expiriesAhead, each market taking its own prefix (as stepLadders does).
  const maxAhead: Record<Tenor, number> = { weekly: 0, daily: 0 };
  for (const m of markets) for (const tenor of TENORS) maxAhead[tenor] = Math.max(maxAhead[tenor], m.v2.params.expiriesAhead[tenor]);
  // upcomingLadderExpiries ends a list at the first rejected read; keep why, so a short calendar is explained.
  const expiryErrors: string[] = [];
  const read: NextExpiryRead = async (afterTs, weekly) => {
    try {
      return await options.nextExpiry(afterTs, weekly);
    } catch (error) {
      const message = `${weekly ? 'weekly' : 'daily'}: ${(error instanceof Error ? error.message : String(error)).split('\n')[0] ?? ''}`;
      if (!expiryErrors.includes(message)) expiryErrors.push(message);
      throw error;
    }
  };
  const expiries: Record<Tenor, number[]> = {
    weekly: maxAhead.weekly > 0 ? await upcomingLadderExpiries(nowS, true, maxAhead.weekly, read) : [],
    daily: maxAhead.daily > 0 ? await upcomingLadderExpiries(nowS, false, maxAhead.daily, read) : [],
  };
  const covered = await Promise.all(markets.map((m) => coverMarket(options, m, expiries, nowS)));
  return {
    contract: COVERAGE_CONTRACT,
    computedAt: nowS,
    provider: options.provider,
    expirySource: options.expirySource,
    expiryErrors,
    floor: { usdg6: options.floorUsdg6, proposal: options.floorUsdg6 === PROPOSED_HOUSE_FLOOR_USDG6 },
    eventCalendar: options.events === null ? 'absent' : 'provided',
    ladderSpot: 'feed',
    markets: covered,
  };
}

/*//////////////////////////////////////////////////////////////
                            SUMMARIES
//////////////////////////////////////////////////////////////*/

export interface TenorSummary {
  kind: 'tenor-summary';
  ticker: string;
  tenor: Tenor;
  /** expiriesAhead > 0: the tenor carries series. */
  enabled: boolean;
  expiriesWanted: number;
  expiries: number;
  rungs: number;
  ready: number;
  degraded: number;
  unavailable: number;
  belowFloor: number;
  exactListed: number;
  methods: Record<string, number>;
  /** null for a tenor that carries no series; otherwise every rung ready and the whole ladder built. */
  quoteReady: boolean | null;
  blockers: string[];
}

/** One line per market per tenor, daily first. A tenor never borrows another's result. */
export function summarize(report: CoverageReport): TenorSummary[] {
  const out: TenorSummary[] = [];
  for (const m of report.markets) {
    for (const tenor of DISPLAY_TENORS) {
      const rungs = m.rungs.filter((r) => r.tenor === tenor);
      const wanted = m.expiriesAhead[tenor];
      const s: TenorSummary = {
        kind: 'tenor-summary',
        ticker: m.ticker,
        tenor,
        enabled: wanted > 0,
        expiriesWanted: wanted,
        expiries: m.expiries[tenor].length,
        rungs: rungs.length,
        ready: rungs.filter((r) => r.readiness === 'ready').length,
        degraded: rungs.filter((r) => r.readiness === 'degraded').length,
        unavailable: rungs.filter((r) => r.readiness === 'unavailable').length,
        belowFloor: rungs.filter((r) => r.belowFloor === true).length,
        exactListed: rungs.filter((r) => r.listing.exact === true).length,
        methods: {},
        quoteReady: null,
        blockers: [],
      };
      for (const r of rungs) s.methods[r.method ?? 'refused'] = (s.methods[r.method ?? 'refused'] ?? 0) + 1;
      if (s.enabled) {
        if (m.ladderError !== null) s.blockers.push(`no ladder: ${m.ladderError.reason}`);
        if (s.expiries < wanted) s.blockers.push(`calendar gave ${s.expiries} of ${wanted} expiries`);
        if (m.ladderError === null && s.rungs === 0) s.blockers.push('no rung');
        if (s.ready < s.rungs) s.blockers.push(`${s.rungs - s.ready} of ${s.rungs} rungs not ready`);
        s.quoteReady = s.blockers.length === 0;
      } else {
        s.blockers.push('off in the registry (expiriesAhead 0): no series to quote');
      }
      out.push(s);
    }
  }
  return out;
}

export interface FailingSeries {
  ticker: string;
  tenor: Tenor;
  expiry: number;
  expiryDay: string;
  side: 'call' | 'put';
  strike: string;
  readiness: RungRecord['readiness'];
  reasons: string[];
}

export interface QuoteReadiness {
  kind: 'quote-readiness';
  /** Every enabled series of every selected market ready, and at least one market selected. */
  ready: boolean;
  markets: Array<{ ticker: string } & Record<Tenor, 'ready' | 'not-ready' | 'off'>>;
  blockers: Array<{ ticker: string; tenor: Tenor | null; blocker: string }>;
  failing: FailingSeries[];
}

/** MM/pricer quote readiness: per series, never aggregated across tenors. */
export function quoteReadiness(report: CoverageReport, summaries: readonly TenorSummary[] = summarize(report)): QuoteReadiness {
  const markets = report.markets.map((m) => {
    const row = { ticker: m.ticker } as { ticker: string } & Record<Tenor, 'ready' | 'not-ready' | 'off'>;
    for (const tenor of DISPLAY_TENORS) {
      const s = summaries.find((x) => x.ticker === m.ticker && x.tenor === tenor)!;
      row[tenor] = s.quoteReady === null ? 'off' : s.quoteReady ? 'ready' : 'not-ready';
    }
    return row;
  });
  const blockers: QuoteReadiness['blockers'] = [];
  if (report.markets.length === 0) blockers.push({ ticker: '-', tenor: null, blocker: 'no market selected: nothing is proven ready' });
  for (const s of summaries) if (s.quoteReady === false) for (const b of s.blockers) blockers.push({ ticker: s.ticker, tenor: s.tenor, blocker: b });
  const failing = report.markets.flatMap((m) =>
    DISPLAY_TENORS.flatMap((tenor) => m.rungs.filter((r) => r.tenor === tenor))
      .filter((r) => r.readiness !== 'ready')
      .map((r) => ({ ticker: r.ticker, tenor: r.tenor, expiry: r.expiry, expiryDay: r.expiryDay, side: r.side, strike: r.strike.formatted, readiness: r.readiness, reasons: r.reasons })),
  );
  return { kind: 'quote-readiness', ready: blockers.length === 0 && failing.length === 0, markets, blockers, failing };
}

export type StrikeTickFlag = 'match' | 'coarser-than-listed' | 'off-listed-grid' | 'no-listing';

/** The ladder's strike tick against the listed spacing near the money (USDG per token vs USD per share, as numbers). */
export function strikeTickFlag(strikeTick: bigint, spacing: { spacingUsd: number } | null): { flag: StrikeTickFlag; listedSpacingUsdg6: bigint | null; suggestedUsdg6: bigint | null } {
  if (spacing === null) return { flag: 'no-listing', listedSpacingUsdg6: null, suggestedUsdg6: null };
  const listed = BigInt(Math.round(spacing.spacingUsd * 1e6));
  if (listed <= 0n) return { flag: 'no-listing', listedSpacingUsdg6: null, suggestedUsdg6: null };
  if (strikeTick === listed) return { flag: 'match', listedSpacingUsdg6: listed, suggestedUsdg6: null };
  if (strikeTick % listed === 0n) return { flag: 'coarser-than-listed', listedSpacingUsdg6: listed, suggestedUsdg6: null };
  // registry.ts: a strike tick is a multiple of PRICE_TICK (100).
  return { flag: 'off-listed-grid', listedSpacingUsdg6: listed, suggestedUsdg6: ((listed + 99n) / 100n) * 100n };
}

export interface F1Inputs {
  kind: 'f1-inputs';
  ticker: string;
  status: V2MarketStatus;
  wave: string;
  identity: CoverageIdentity;
  strikeTick: Money;
  strikeTickVsListing: StrikeTickFlag;
  listedStrikeSpacing: { day: string; spacing: Money } | null;
  puts: boolean;
  ladder: Record<Tenor, LadderParams>;
  expiriesAhead: Record<Tenor, number>;
  ladderSpot: Money | null;
  ladderError: MarketCoverage['ladderError'];
  listedExpiryDays: string[];
  ladderExpiries: Record<Tenor, Array<{ expiry: number; day: string; weekday: string; listed: boolean | null; earlyClose: boolean }>>;
  perTenor: Record<Tenor, { rungs: number; exactListed: number; priced: number; belowFloor: number }>;
}

/** What F1 needs to register the market, whatever its quote readiness. */
export function f1Inputs(report: CoverageReport, earlyCloses: readonly string[] = NYSE_EARLY_CLOSES_2026_2028): F1Inputs[] {
  const early = new Set(earlyCloses);
  return report.markets.map((m) => {
    const tick = strikeTickFlag(m.strikeTick, m.listedSpacing);
    const listed = new Set(m.chain.listedDays);
    const expiryRows = (tenor: Tenor) =>
      m.expiries[tenor].map((e) => {
        const { day, weekday } = newYorkDay(e);
        return { expiry: e, day, weekday, listed: m.chain.present ? listed.has(day) : null, earlyClose: early.has(day) };
      });
    const tenorRow = (tenor: Tenor) => {
      const rungs = m.rungs.filter((r) => r.tenor === tenor);
      return { rungs: rungs.length, exactListed: rungs.filter((r) => r.listing.exact === true).length, priced: rungs.filter((r) => r.fair !== null).length, belowFloor: rungs.filter((r) => r.belowFloor === true).length };
    };
    const lastLadderDay = [...m.expiries.daily, ...m.expiries.weekly].map((e) => newYorkDay(e).day).sort().at(-1);
    return {
      kind: 'f1-inputs',
      ticker: m.ticker,
      status: m.status,
      wave: m.wave,
      identity: m.identity,
      strikeTick: money(m.strikeTick),
      strikeTickVsListing: tick.flag,
      listedStrikeSpacing: m.listedSpacing === null ? null : { day: m.listedSpacing.day, spacing: money(BigInt(Math.round(m.listedSpacing.spacingUsd * 1e6))) },
      puts: m.puts,
      ladder: m.ladder,
      expiriesAhead: m.expiriesAhead,
      ladderSpot: m.spot === null ? null : money(m.spot.usdg6),
      ladderError: m.ladderError,
      listedExpiryDays: lastLadderDay === undefined ? [] : m.chain.listedDays.filter((d) => d <= lastLadderDay && d >= newYorkDay(report.computedAt).day),
      ladderExpiries: { weekly: expiryRows('weekly'), daily: expiryRows('daily') },
      perTenor: { weekly: tenorRow('weekly'), daily: tenorRow('daily') },
    };
  });
}

/*//////////////////////////////////////////////////////////////
                           SUGGESTIONS
//////////////////////////////////////////////////////////////*/

export interface LadderSuggestion {
  kind: 'suggestion';
  ticker: string;
  derived: true;
  writesRegistry: false;
  /** A candidate `overrides` block: `ladder` only. Never `expiriesAhead`, never zero rungs. */
  overrides: { ladder?: Partial<Record<Tenor, Partial<Pick<LadderParams, 'rungs' | 'firstOtmBps'>>>> };
  strikeTick: { current: string; listedSpacing: string | null; flag: StrikeTickFlag; suggested: string | null };
  notes: string[];
}

/** The first rung index at which every priced rung of the tenor (all expiries, both sides) is below the floor. */
function firstIndexAllBelow(rungs: readonly RungRecord[]): number | null {
  const byIndex = new Map<number, RungRecord[]>();
  for (const r of rungs) if (r.fair !== null) byIndex.set(r.rung, [...(byIndex.get(r.rung) ?? []), r]);
  for (const i of [...byIndex.keys()].sort((a, b) => a - b)) if (byIndex.get(i)!.every((r) => r.belowFloor === true)) return i;
  return null;
}

/**
 * Derived suggestions per market. For each enabled tenor with priced rungs:
 *   - the outer rungs are below the floor at every expiry from rung k > 0 on: `rungs: k`;
 *   - even rung 0 is: the largest `firstOtmBps` among ¾, ½, ¼ of today's and 0 whose first rung prices at or above
 *     the floor at every expiry (repriced through the same service), else nothing and a note that the floor, not
 *     the ladder, needs review.
 * A tenor that is off stays off and a tenor that is on stays on: no suggestion touches `expiriesAhead` (owner D6
 * keeps every approved daily). Nothing is written anywhere.
 */
export async function suggestLadders(report: CoverageReport, service: PricingService): Promise<LadderSuggestion[]> {
  const out: LadderSuggestion[] = [];
  for (const m of report.markets) {
    const tick = strikeTickFlag(m.strikeTick, m.listedSpacing);
    const s: LadderSuggestion = {
      kind: 'suggestion',
      ticker: m.ticker,
      derived: true,
      writesRegistry: false,
      overrides: {},
      strikeTick: { current: m.strikeTick.toString(), listedSpacing: tick.listedSpacingUsdg6?.toString() ?? null, flag: tick.flag, suggested: tick.suggestedUsdg6?.toString() ?? null },
      notes: [],
    };
    if (tick.flag === 'off-listed-grid') s.notes.push(`strikeTick ${formatUnits(m.strikeTick, 6)} puts ladder strikes between the listed ${formatUnits(tick.listedSpacingUsdg6!, 6)} strikes: those rungs are never an exact listed contract`);
    const ladder: NonNullable<LadderSuggestion['overrides']['ladder']> = {};
    for (const tenor of DISPLAY_TENORS) {
      const keep = tenor === 'daily' ? '; dailies stay on (owner D6)' : '';
      if (m.expiriesAhead[tenor] === 0) {
        s.notes.push(`${tenor}: off in the registry; no ladder suggestion (the tenor's on/off is not a pricing suggestion)`);
        continue;
      }
      const rungs = m.rungs.filter((r) => r.tenor === tenor);
      if (rungs.every((r) => r.fair === null)) {
        s.notes.push(`${tenor}: no priced rung, so no floor evidence${keep}`);
        continue;
      }
      const cut = firstIndexAllBelow(rungs);
      if (cut === null) continue;
      if (cut > 0) {
        ladder[tenor] = { rungs: cut };
        s.notes.push(`${tenor}: rungs ${cut}+ are below the floor at every priced expiry; ${cut} rung(s) stay above it${keep}`);
        continue;
      }
      const current = m.ladder[tenor].firstOtmBps;
      const candidates = [...new Set([Math.floor((current * 3) / 4), Math.floor(current / 2), Math.floor(current / 4), 0])].filter((c) => c < current);
      let found: number | null = null;
      for (const candidate of candidates) {
        if (m.spot === null) break;
        let ok = true;
        for (const r of rungs.filter((x) => x.rung === 0 && x.fair !== null)) {
          const [strike] = ladderStrikes(m.spot.usdg6, { rungs: 1, firstOtmBps: candidate, stepBps: m.ladder[tenor].stepBps }, m.strikeTick, r.side === 'put');
          const priced = strike === undefined ? null : await service.fair({ ticker: m.ticker, strikeUsdg6: strike, expiry: r.expiry, type: r.side });
          if (priced === null || !priced.ok || priced.fairUsdg6 < report.floor.usdg6) {
            ok = false;
            break;
          }
        }
        if (ok) {
          found = candidate;
          break;
        }
      }
      if (found !== null) {
        ladder[tenor] = { firstOtmBps: found };
        s.notes.push(`${tenor}: every rung is below the floor; firstOtmBps ${found} (from ${current}) prices the first rung at or above it at every expiry; re-run with the override to check the outer rungs${keep}`);
      } else {
        s.notes.push(`${tenor}: even an at-the-money first rung is below the floor at some expiry: review the floor, not the ladder${keep}`);
      }
    }
    if (Object.keys(ladder).length > 0) s.overrides.ladder = ladder;
    out.push(s);
  }
  return out;
}

/*//////////////////////////////////////////////////////////////
                              WATCH
//////////////////////////////////////////////////////////////*/

export interface WatchLine {
  kind: 'watch';
  contract: typeof COVERAGE_CONTRACT;
  iteration: number;
  at: number;
  ticker: string;
  provider: string;
  providerProduct: string | null;
  entitlement: ProviderDescriptor['entitlement'];
  chain: { present: boolean; state: string; fetchError: string | null };
  clocks: Omit<CoverageClocks, 'computedAt'>;
  ages: CoverageAges;
  refusal: ChainView['refusal'];
  ladderError: MarketCoverage['ladderError'];
  tenors: Record<Tenor, { rungs: number; ready: number; degraded: number; unavailable: number }>;
}

/** One line per market for one refresh: the chain's clocks and ages (null kept null) and its refusal state. */
export function watchLines(report: CoverageReport, iteration: number): WatchLine[] {
  return report.markets.map((m) => {
    const { computedAt: _computedAt, ...clocks } = m.chain.clocks;
    const tenor = (t: Tenor) => {
      const rungs = m.rungs.filter((r) => r.tenor === t);
      return { rungs: rungs.length, ready: rungs.filter((r) => r.readiness === 'ready').length, degraded: rungs.filter((r) => r.readiness === 'degraded').length, unavailable: rungs.filter((r) => r.readiness === 'unavailable').length };
    };
    return {
      kind: 'watch',
      contract: COVERAGE_CONTRACT,
      iteration,
      at: report.computedAt,
      ticker: m.ticker,
      provider: m.chain.provider,
      providerProduct: m.chain.providerProduct,
      entitlement: m.chain.entitlement,
      chain: { present: m.chain.present, state: m.chain.state, fetchError: m.chain.fetchError },
      clocks,
      ages: m.chain.ages,
      refusal: m.chain.refusal,
      ladderError: m.ladderError,
      tenors: { daily: tenor('daily'), weekly: tenor('weekly') },
    };
  });
}

/*//////////////////////////////////////////////////////////////
                             OUTPUT
//////////////////////////////////////////////////////////////*/

/** JSON with bigints as decimal strings. */
export function toJsonLine(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
}

export interface RenderedReport {
  report: CoverageReport;
  summaries: TenorSummary[];
  f1: F1Inputs[];
  readiness: QuoteReadiness;
  suggestions: LadderSuggestion[] | null;
}

/** Every record as a JSON line: the run header, each rung, tenor summaries, F1 inputs, quote readiness, suggestions. */
export function jsonLines(r: RenderedReport, mode: string): string[] {
  const { report } = r;
  const header = {
    kind: 'run',
    contract: COVERAGE_CONTRACT,
    mode,
    computedAt: report.computedAt,
    provider: report.provider,
    expirySource: report.expirySource,
    expiryErrors: report.expiryErrors,
    ladderSpot: report.ladderSpot,
    floor: { usdg: money(report.floor.usdg6), proposal: report.floor.proposal, note: report.floor.proposal ? 'F3 D9 proposal, not an approved value' : 'operator-supplied' },
    eventCalendar: report.eventCalendar,
    markets: report.markets.map((m) => m.ticker),
    derivedOnly: true,
  };
  return [header, ...report.markets.flatMap((m) => m.rungs), ...r.summaries, ...r.f1, r.readiness, ...(r.suggestions ?? [])].map(toJsonLine);
}

const pad = (s: string, n: number) => (s.length >= n ? `${s} ` : s.padEnd(n));
const fmtMoney = (m: Money | null) => (m === null ? '-' : m.raw === '0' ? '0 (zero)' : m.formatted);
const utc = (s: number) => new Date(s * 1000).toISOString().replace('.000Z', 'Z');

function listingCell(l: ListingPresence): string {
  if (l.exact === null) return '?';
  if (l.exact) return l.usable ? 'exact' : `exact:${l.book ?? '?'}`;
  return l.expiryListed ? 'day-only' : 'no';
}

/** The human report. */
export function renderTable(r: RenderedReport, mode: string): string {
  const { report } = r;
  const lines: string[] = [];
  const floor = `${formatUnits(report.floor.usdg6, 6)} USDG${report.floor.proposal ? ' (PROPOSAL, F3 D9; not approved)' : ' (operator-supplied)'}`;
  lines.push(`Stonkhouse pricing coverage (${mode}) at ${utc(report.computedAt)}`);
  lines.push(`provider ${report.provider.id} (${report.provider.product ?? 'no product'}, ${report.provider.entitlement.class}) · expiries ${report.expirySource} · ladder centred on the feed spot · floor ${floor}`);
  for (const e of report.expiryErrors) lines.push(`expiry calendar stopped early: ${e}`);
  lines.push(`event calendar: ${report.eventCalendar === 'provided' ? 'provided (fed to the pricing service: its event-uncertainty and bounds are its own)' : 'absent (no dated event can be flagged; a before-first read assumes one unknown event per the K3-312 policy and flags event-uncertainty anyway)'}`);
  lines.push('Derived report only: nothing here writes the registry or sends anything.');
  for (const m of report.markets) {
    lines.push('');
    const spot = m.spot === null ? `no ladder (${m.ladderError?.reason ?? '?'})` : `ladder spot ${formatUnits(m.spot.usdg6, 6)} (feed age ${m.spot.ageSeconds} s)`;
    lines.push(`${m.ticker} [${m.status}/${m.wave}] ${spot} · strikeTick ${formatUnits(m.strikeTick, 6)} · chain ${m.chain.state}${m.chain.fetchError === null ? '' : ` (last fetch: ${m.chain.fetchError})`}`);
    if (m.rungs.length === 0) continue;
    lines.push(`  ${pad('tenor', 7)}${pad('expiry', 15)}${pad('side', 5)}${pad('strike', 10)}${pad('listed', 11)}${pad('method', 13)}${pad('fair', 12)}${pad('iv', 8)}${pad('readiness', 12)}reasons`);
    for (const tenor of DISPLAY_TENORS) {
      for (const x of m.rungs.filter((y) => y.tenor === tenor)) {
        const reasons = x.reasons.join(', ') + (x.belowFloor === true ? ' [below floor]' : '');
        lines.push(
          `  ${pad(x.tenor, 7)}${pad(`${x.expiryDay} ${x.expiryWeekday}`, 15)}${pad(x.side, 5)}${pad(x.strike.formatted, 10)}${pad(listingCell(x.listing), 11)}${pad(x.method ?? 'refused', 13)}${pad(fmtMoney(x.fair), 12)}${pad(x.iv === null ? '-' : x.iv.toFixed(4), 8)}${pad(x.readiness, 12)}${reasons || '-'}`,
        );
      }
    }
  }
  lines.push('');
  lines.push('Coverage per market and tenor (each tenor on its own line: a weekly pass never hides a daily failure)');
  lines.push(`  ${pad('ticker', 8)}${pad('tenor', 7)}${pad('expiries', 9)}${pad('rungs', 6)}${pad('ready', 6)}${pad('degraded', 9)}${pad('unavail', 8)}${pad('<floor', 7)}${pad('exact', 7)}quote-ready`);
  for (const s of r.summaries) {
    const verdict = s.quoteReady === null ? 'off' : s.quoteReady ? 'yes' : `NO (${s.blockers.join('; ')})`;
    lines.push(`  ${pad(s.ticker, 8)}${pad(s.tenor, 7)}${pad(`${s.expiries}/${s.expiriesWanted}`, 9)}${pad(String(s.rungs), 6)}${pad(String(s.ready), 6)}${pad(String(s.degraded), 9)}${pad(String(s.unavailable), 8)}${pad(String(s.belowFloor), 7)}${pad(`${s.exactListed}/${s.rungs}`, 7)}${verdict}`);
  }
  lines.push('');
  lines.push('F1 registration inputs (from the registry and the listing; independent of quote readiness)');
  for (const f of r.f1) {
    const t = f.identity.token;
    lines.push(`  ${f.ticker}: token ${t.address ?? 'unmapped'} chainId ${t.chainId ?? '-'} uiMultiplier ${t.uiMultiplier ?? '-'} issuer ${f.identity.issuer ?? 'unmapped'} root ${f.identity.root ?? 'unmapped'}`);
    lines.push(`    strikeTick ${f.strikeTick.formatted} vs listed spacing near the money ${f.listedStrikeSpacing === null ? '-' : `${f.listedStrikeSpacing.spacing.formatted} (${f.listedStrikeSpacing.day})`}: ${f.strikeTickVsListing} · puts ${f.puts ? 'yes' : 'no'}`);
    lines.push(`    ladder ${DISPLAY_TENORS.map((tn) => `${tn} ${f.ladder[tn].rungs} rungs ${f.ladder[tn].firstOtmBps}/${f.ladder[tn].stepBps} bps x ${f.expiriesAhead[tn]} expiries`).join(' · ')}`);
    for (const tn of DISPLAY_TENORS) {
      const days = f.ladderExpiries[tn].map((e) => `${e.day} ${e.weekday}${e.listed === null ? '?' : e.listed ? ' listed' : ''}${e.earlyClose ? ' early-close' : ''}`).join(', ');
      const p = f.perTenor[tn];
      lines.push(`    ${tn}: ${days || 'none'} · exact listed ${p.exactListed}/${p.rungs} · priced ${p.priced}/${p.rungs} · below floor ${p.belowFloor}`);
    }
  }
  lines.push('');
  lines.push(`MM/pricer quote readiness: ${r.readiness.ready ? 'READY' : 'NOT READY'}${mode === 'quote-readiness' ? ' (this mode exits 1 unless every enabled series is ready)' : ''}`);
  for (const m of r.readiness.markets) lines.push(`  ${m.ticker}: daily ${m.daily} · weekly ${m.weekly}`);
  for (const b of r.readiness.blockers) lines.push(`  blocker ${b.ticker}${b.tenor === null ? '' : ` ${b.tenor}`}: ${b.blocker}`);
  if (mode === 'quote-readiness' && r.readiness.failing.length > 0) {
    lines.push(`  failing series (${r.readiness.failing.length}):`);
    for (const f of r.readiness.failing) lines.push(`    ${f.ticker} ${f.tenor} ${f.expiryDay} ${f.side} ${f.strike}: ${f.readiness} (${f.reasons.join(', ')})`);
  }
  if (r.suggestions !== null) {
    lines.push('');
    lines.push('Suggestions (derived only: nothing is written; no suggestion turns a tenor on or off, and dailies stay on per owner D6)');
    for (const s of r.suggestions) {
      lines.push(`  ${s.ticker}: strikeTick ${s.strikeTick.flag}${s.strikeTick.suggested === null ? '' : ` (suggested ${formatUnits(BigInt(s.strikeTick.suggested), 6)})`} · overrides ${JSON.stringify(s.overrides)}`);
      for (const n of s.notes) lines.push(`    - ${n}`);
    }
  }
  return lines.join('\n');
}
