/**
 * The provider-neutral option-chain contract (K3-311): what any data provider's chain becomes before
 * the pricing service reads it, and the pure checks that judge it. Cboe is one adapter (cboe.ts
 * cboeToNormalized); a paid feed (K3-308) or a fake (fake-provider.ts) is another. Past this seam no
 * business logic reads a provider's payload type.
 *
 * FOUR THINGS, KEPT APART (F3 D12, 02-interfaces.md §5.1):
 *   identity     who the provider says each instrument is: its own instrument id, root, call/put,
 *                strike, expiry day in New York, and the contract multiplier, exercise and
 *                settlement convention AS STATED. `null` means the provider did not say, never
 *                "matches Stonkhouse". The canonical side (registry ticker, Stock Token, issuer)
 *                comes from the registry, not the provider (CanonicalIdentity).
 *   observation  what the provider saw: a raw listed quote (bid, ask, sizes, its own time) in
 *                `quote`; the provider's greeks on that quote in `analytics`; a provider MODEL value
 *                (fair/theoretical/indicative) in `theoretical`. A theoretical value never fills a
 *                quote field and never becomes a ListedOption, so it can never price as "listed".
 *   method       decided later, by fair.ts (exact listed contract, interpolation, extrapolation).
 *   quality      bookState, clockAges, sourceDisagreement and checkIdentity below: empty,
 *                one-sided, crossed and stale books, unknown clocks, disagreeing sources and
 *                identity or multiplier mismatches each get their own reason code.
 *
 * MISSING IS NOT ZERO. A quote side the provider did not supply is `null`; a side it supplied as 0
 * is 0 (a zero bid is an empty bid side, not an unknown one). A clock the provider did not supply is
 * `null` and stays `null` through the cache and every fallback: nothing here fills an unknown time
 * from the download time, the file time or the underlying's clock. Quote age comes only from a quote
 * clock, so a frozen underlying last trade next to moving option quotes does not make the quotes
 * stale, and a refetch (which advances only `receivedAt`) never makes an old observation fresh.
 *
 * Pure.
 */
import { EARLY_CLOSE_TOLERANCE_S, CLOCK_SKEW_TOLERANCE_S, latestSettledSessionClose } from '../../vol.js';

/*//////////////////////////////////////////////////////////////
                             CONTRACT
//////////////////////////////////////////////////////////////*/

/** Version of this in-process contract. Wire provenance (02-interfaces §5.1) is `O3-307/1`. */
export const CHAIN_CONTRACT = 'K3-311/1' as const;

/** Listed US equity options deliver 100 shares. A provider that states another multiplier (an
 *  adjusted contract after a corporate action) is not the standard contract the surface models. */
export const STANDARD_LISTED_MULTIPLIER = 100;

export type EntitlementClass = 'real-time' | 'delayed' | 'end-of-day' | 'indicative' | 'unknown';

export interface ProviderDescriptor {
  /** Open, stable data-provider id, e.g. `cboe-delayed`. Says nothing about the method. */
  id: string;
  /** The provider's product or feed (a raw-quote tier versus a theoretical tier), or null. */
  product: string | null;
  entitlement: { class: EntitlementClass; declaredDelayS: number | null; rightsRef: string | null };
}

export type OptionSide = 'C' | 'P';

/** One instrument as the provider states it. */
export interface InstrumentIdentity {
  providerInstrumentId: string | null;
  root: string | null;
  side: OptionSide;
  /** Per share, USD, as listed. */
  strike: number;
  /** YYYY-MM-DD, New York, the listed expiry date. */
  expiryDay: string;
  /** The provider's stated expiry instant (unix seconds), or null when it gives only a day. */
  expiry: number | null;
  multiplier: number | null;
  exercise: string | null;
  settlement: string | null;
}

/** A raw venue quote in listed-share USD. Every field is what the provider supplied, or null. */
export interface ListedQuote {
  bid: number | null;
  ask: number | null;
  bidSize: number | null;
  askSize: number | null;
  currency: 'USD';
  /** The quote's own observation time, unix seconds, or null when the provider gives none. */
  observedAt: number | null;
}

/** The provider's greeks on its quote (Cboe computes them from the mid). Not a price. */
export interface ProviderAnalytics {
  iv: number | null;
  delta: number | null;
  observedAt: number | null;
}

/** A provider MODEL output: a theoretical, fair or indicative value. Never a quote. */
export interface VendorTheoretical {
  product: string;
  /** Per share, USD, or null when the row carries the product without a value. */
  value: number | null;
  iv: number | null;
  currency: 'USD';
  observedAt: number | null;
}

export interface ChainRow {
  instrument: InstrumentIdentity;
  quote: ListedQuote | null;
  analytics: ProviderAnalytics | null;
  theoretical: VendorTheoretical | null;
}

export interface ChainUnderlying {
  /** The provider's underlying symbol, e.g. `NVDA`. */
  providerSymbol: string;
  /** The provider's canonical issuer id (e.g. an ISIN), or null when it gives none. */
  issuer: string | null;
  /** One share, USD: the provider's underlying price, or null. */
  price: number | null;
  /** When that price was observed (Cboe: the underlying's last trade), or null. */
  observedAt: number | null;
  /** The provider's own text for `observedAt`, verbatim, for /health and diagnostics. */
  observedAtText: string | null;
}

/** Every clock the provider gives, in unix seconds; null when it gives none. */
export interface ChainClocks {
  /** One time for every option quote in the file, when the provider stamps the file that way. */
  quoteObservedAt: number | null;
  /** Option last-trade time, when supplied. */
  tradeObservedAt: number | null;
  /** Time of the provider's volatility input. */
  volatilityObservedAt: number | null;
  /** The provider's publication time (Cboe: the file timestamp). */
  publishedAt: number | null;
  publishedAtText: string | null;
  /** When the service received the bytes. The only clock a refetch advances. */
  receivedAt: number;
}

export interface NormalizedChain {
  contract: typeof CHAIN_CONTRACT;
  provider: ProviderDescriptor;
  underlying: ChainUnderlying;
  clocks: ChainClocks;
  rows: ChainRow[];
  /** Rows the adapter dropped as malformed (reported, never priced). */
  skippedRows: number;
  firstSkip: string | null;
}

/** Where the registry says a market's chain lives. `url` is the provider's locator, if any. */
export interface ChainSource {
  ticker: string;
  root: string;
  url: string;
}

export interface ProviderFetchOptions {
  timeoutMs: number;
  maxBytes: number;
  /** The service's wall clock, ms: `receivedAt` is read from it when the bytes are in. */
  nowMs: () => number;
}

/** A data provider. Throws on a failed download; the cache turns that into an entry error. */
export interface OptionChainProvider {
  readonly descriptor: ProviderDescriptor;
  fetch(source: ChainSource, options: ProviderFetchOptions): Promise<NormalizedChain>;
}

/*//////////////////////////////////////////////////////////////
                    THE SURFACE'S VIEW OF A ROW
//////////////////////////////////////////////////////////////*/

/**
 * A listed quote the surface can use: both sides supplied and finite, and the provider's iv and
 * delta supplied (the quote gates need both). Same fields the v1 gates were written against, so
 * cboe.ts's gates apply unchanged. Only `quote` and `analytics` feed it; `theoretical` never does.
 */
export interface ListedOption {
  /** The provider's instrument id, or `root expiry side strike` when it gives none. */
  symbol: string;
  expiry: string;
  type: OptionSide;
  strike: number;
  bid: number;
  ask: number;
  iv: number;
  delta: number;
}

/** The row as a ListedOption, or the reason code it is not one. */
export function listedOptionOf(row: ChainRow, expectedRoot: string): ListedOption | string {
  const { instrument: i, quote: q, analytics: a } = row;
  if (i.root !== null && i.root !== expectedRoot) return 'identity-mismatch';
  if (i.multiplier !== null && i.multiplier !== STANDARD_LISTED_MULTIPLIER) return 'multiplier-mismatch';
  if (q === null) return 'no-quotes';
  if (q.bid === null || q.ask === null) return 'quote-side-missing';
  if (a === null || a.iv === null || a.delta === null) return 'analytics-missing';
  return {
    symbol: i.providerInstrumentId ?? `${expectedRoot} ${i.expiryDay} ${i.side} ${i.strike}`,
    expiry: i.expiryDay,
    type: i.side,
    strike: i.strike,
    bid: q.bid,
    ask: q.ask,
    iv: a.iv,
    delta: a.delta,
  };
}

/** Every row that is a usable listed input for `expectedRoot`, in chain order. */
export function listedOptions(chain: NormalizedChain, expectedRoot: string): ListedOption[] {
  const out: ListedOption[] = [];
  for (const row of chain.rows) {
    const o = listedOptionOf(row, expectedRoot);
    if (typeof o !== 'string') out.push(o);
  }
  return out;
}

/*//////////////////////////////////////////////////////////////
                              QUALITY
//////////////////////////////////////////////////////////////*/

/** Reason codes from 02-interfaces §5.1 used here. Open strings on the wire. */
export type QualityReason =
  | 'quote-stale'
  | 'quote-age-unknown'
  | 'underlying-stale'
  | 'underlying-age-unknown'
  | 'volatility-stale'
  | 'identity-unmapped'
  | 'identity-mismatch'
  | 'multiplier-mismatch'
  | 'book-empty'
  | 'book-one-sided'
  | 'book-crossed'
  | 'no-quotes'
  | 'source-disagreement';

export type SideState = 'missing' | 'zero' | 'positive' | 'invalid';

export interface BookState {
  state: 'absent' | 'empty' | 'one-sided' | 'crossed' | 'two-sided';
  bid: SideState;
  ask: SideState;
  /** The reason code, or null for a two-sided book. */
  reason: QualityReason | null;
}

function sideState(x: number | null): SideState {
  if (x === null) return 'missing';
  if (!Number.isFinite(x) || x < 0) return 'invalid';
  return x === 0 ? 'zero' : 'positive';
}

/**
 * One quote's book. `absent`: no quote at all. A side is present only when positive: a missing side
 * and a zero side both leave it empty, and `bid`/`ask` keep which one it was. Crossed: both sides
 * present and bid above ask. A locked book (bid = ask) is two-sided.
 */
export function bookState(quote: ListedQuote | null): BookState {
  if (quote === null) return { state: 'absent', bid: 'missing', ask: 'missing', reason: 'no-quotes' };
  const bid = sideState(quote.bid);
  const ask = sideState(quote.ask);
  const hasBid = bid === 'positive';
  const hasAsk = ask === 'positive';
  if (!hasBid && !hasAsk) return { state: 'empty', bid, ask, reason: 'book-empty' };
  if (!hasBid || !hasAsk) return { state: 'one-sided', bid, ask, reason: 'book-one-sided' };
  if (quote.bid! > quote.ask!) return { state: 'crossed', bid, ask, reason: 'book-crossed' };
  return { state: 'two-sided', bid, ask, reason: null };
}

export interface AgeLimits {
  maxQuoteAgeS: number;
  maxUnderlyingAgeS: number;
  maxVolatilityAgeS: number;
}

export interface ClockAges {
  quoteS: number | null;
  tradeS: number | null;
  underlyingS: number | null;
  volatilityS: number | null;
  reasons: QualityReason[];
}

const age = (at: number | null, nowSeconds: number) => (at === null ? null : nowSeconds - at);

/**
 * The ages of one observation's clocks at `nowSeconds`, and what is wrong with them. The quote clock
 * is the quote's own time, else the chain's quote time, else unknown: never `receivedAt`,
 * `publishedAt`, a trade or the underlying's clock. An unknown quote clock is `quote-age-unknown`,
 * not stale and not fresh. The underlying is judged on its own clock only.
 */
export function clockAges(clocks: ChainClocks, underlying: Pick<ChainUnderlying, 'observedAt'>, quote: ListedQuote | null, nowSeconds: number, limits: AgeLimits): ClockAges {
  const quoteAt = quote?.observedAt ?? clocks.quoteObservedAt;
  const out: ClockAges = {
    quoteS: age(quoteAt, nowSeconds),
    tradeS: age(clocks.tradeObservedAt, nowSeconds),
    underlyingS: age(underlying.observedAt, nowSeconds),
    volatilityS: age(clocks.volatilityObservedAt, nowSeconds),
    reasons: [],
  };
  if (out.quoteS === null) out.reasons.push('quote-age-unknown');
  else if (out.quoteS > limits.maxQuoteAgeS) out.reasons.push('quote-stale');
  if (out.underlyingS !== null && out.underlyingS > limits.maxUnderlyingAgeS) out.reasons.push('underlying-stale');
  if (out.volatilityS !== null && out.volatilityS > limits.maxVolatilityAgeS) out.reasons.push('volatility-stale');
  return out;
}

export interface Disagreement {
  provider: string;
  /** |a/b − 1| in bps, or null when either value is unknown or b is not positive. */
  fairBps: number | null;
  disagrees: boolean;
}

/**
 * Two sources' values for the same instrument (mids, theoretical values or fair values, same
 * units). Unknown on either side is `fairBps: null`, which is not agreement: `disagrees` is true
 * only for a measured gap above `maxBps`.
 */
export function sourceDisagreement(a: number | null, b: { provider: string; value: number | null }, maxBps: number): Disagreement {
  if (a === null || b.value === null || !Number.isFinite(a) || !Number.isFinite(b.value) || !(b.value > 0) || a < 0) {
    return { provider: b.provider, fairBps: null, disagrees: false };
  }
  const bps = Math.abs(a / b.value - 1) * 10_000;
  return { provider: b.provider, fairBps: bps, disagrees: bps > maxBps };
}

/** The registry's side of a market's identity. Everything not in the registry is null. */
export interface CanonicalIdentity {
  market: string;
  /** The listed option root the market maps to (registry `cboe.root`). */
  root: string | null;
  issuer: string | null;
  token: { chainId: number | null; address: string | null; uiMultiplier: string | null };
}

export interface IdentityCheck {
  ok: boolean;
  reasons: QualityReason[];
  detail: Record<string, string>;
  /** Rows whose stated multiplier is not the standard contract. */
  nonStandardRows: number;
}

/**
 * Does the provider's chain describe the registry's market? `identity-unmapped`: the registry does
 * not map the market to a root or a Stock Token. `identity-mismatch`: another underlying symbol, or
 * an issuer that differs where both sides state one. `multiplier-mismatch`: a row stating a
 * non-standard contract multiplier, or an observed token uiMultiplier (e.g. read on chain) that
 * differs from the registry's. Ticker alone is never an identity (F3 §6): with no root mapping the
 * chain is unmapped even when the symbol equals the ticker.
 */
export function checkIdentity(chain: Pick<NormalizedChain, 'underlying' | 'rows'>, canonical: CanonicalIdentity, observedUiMultiplier: string | null = null): IdentityCheck {
  const reasons: QualityReason[] = [];
  const detail: Record<string, string> = {};
  if (canonical.root === null || canonical.token.address === null) {
    reasons.push('identity-unmapped');
    detail.unmapped = canonical.root === null ? 'root' : 'token';
  }
  if (canonical.root !== null && chain.underlying.providerSymbol !== canonical.root) {
    reasons.push('identity-mismatch');
    detail.symbol = chain.underlying.providerSymbol;
    detail.expectedRoot = canonical.root;
  }
  if (canonical.issuer !== null && chain.underlying.issuer !== null && chain.underlying.issuer !== canonical.issuer) {
    if (!reasons.includes('identity-mismatch')) reasons.push('identity-mismatch');
    detail.issuer = chain.underlying.issuer;
    detail.expectedIssuer = canonical.issuer;
  }
  const nonStandardRows = chain.rows.filter((r) => r.instrument.multiplier !== null && r.instrument.multiplier !== STANDARD_LISTED_MULTIPLIER).length;
  if (nonStandardRows > 0) {
    reasons.push('multiplier-mismatch');
    detail.nonStandardRows = String(nonStandardRows);
  }
  if (observedUiMultiplier !== null && canonical.token.uiMultiplier !== null && observedUiMultiplier !== canonical.token.uiMultiplier) {
    if (!reasons.includes('multiplier-mismatch')) reasons.push('multiplier-mismatch');
    detail.uiMultiplier = observedUiMultiplier;
    detail.expectedUiMultiplier = canonical.token.uiMultiplier;
  }
  return { ok: reasons.length === 0, reasons, detail, nonStandardRows };
}

/*//////////////////////////////////////////////////////////////
                         THE PRICING CLOCK
//////////////////////////////////////////////////////////////*/

export type PricingClock =
  | { ok: true; clock: number; basis: 'quote' | 'underlying'; ageSeconds: number; publishedAt: number | null }
  | { ok: false; reason: 'stale' | 'inconsistent'; detail: Record<string, string> };

/**
 * The clock a chain is priced on, and whether it is fresh: the chain's quote time when the provider
 * gives one, else the underlying's observation time (Cboe's last trade, v1's rule). Judged exactly as
 * vol.ts chainFreshness judges Cboe's two clocks: unknown is inconsistent; a file dated in the future
 * or a pricing clock newer than its file (beyond CLOCK_SKEW_TOLERANCE_S) is inconsistent; older than
 * `maxAgeS` (clock or file) is stale; and with `holidays`, a clock before the latest completed NYSE
 * session (less EARLY_CLOSE_TOLERANCE_S) is stale. A provider without a file time is judged on the
 * pricing clock alone.
 */
export function pricingClock(chain: Pick<NormalizedChain, 'clocks' | 'underlying'>, nowSeconds: number, maxAgeS: number, holidays?: readonly string[]): PricingClock {
  const quoteAt = chain.clocks.quoteObservedAt;
  const basis: 'quote' | 'underlying' = quoteAt !== null ? 'quote' : 'underlying';
  const clock = quoteAt ?? chain.underlying.observedAt;
  const publishedAt = chain.clocks.publishedAt;
  const detail: Record<string, string> = {
    lastTradeTime: chain.underlying.observedAtText ?? String(chain.underlying.observedAt),
    chainTimestamp: chain.clocks.publishedAtText ?? String(publishedAt),
    nowSeconds: String(nowSeconds),
    ...(basis === 'quote' ? { clockBasis: 'quote', quoteObservedAt: String(quoteAt) } : {}),
  };
  const unparsed = (chain.underlying.observedAt === null && chain.underlying.observedAtText !== null) || (publishedAt === null && chain.clocks.publishedAtText !== null);
  if (unparsed && (basis === 'underlying' || publishedAt === null)) {
    return { ok: false, reason: 'inconsistent', detail: { ...detail, why: 'a clock does not parse' } };
  }
  if (clock === null) return { ok: false, reason: 'inconsistent', detail: { ...detail, why: 'the source gives no observation time' } };
  if (publishedAt !== null && publishedAt > nowSeconds + CLOCK_SKEW_TOLERANCE_S) {
    return { ok: false, reason: 'inconsistent', detail: { ...detail, why: 'the file is dated in the future' } };
  }
  if (publishedAt !== null && clock > publishedAt + CLOCK_SKEW_TOLERANCE_S) {
    return { ok: false, reason: 'inconsistent', detail: { ...detail, why: 'the last trade is newer than the file' } };
  }
  if (publishedAt === null && clock > nowSeconds + CLOCK_SKEW_TOLERANCE_S) {
    return { ok: false, reason: 'inconsistent', detail: { ...detail, why: 'the pricing clock is in the future' } };
  }
  const ageSeconds = nowSeconds - clock;
  if (ageSeconds > maxAgeS || (publishedAt !== null && nowSeconds - publishedAt > maxAgeS)) {
    return { ok: false, reason: 'stale', detail: { ...detail, ageSeconds: String(ageSeconds), maxAgeS: String(maxAgeS) } };
  }
  if (holidays !== undefined) {
    const sessionClose = latestSettledSessionClose(nowSeconds, holidays);
    if (sessionClose !== null && clock < sessionClose - EARLY_CLOSE_TOLERANCE_S) {
      return {
        ok: false,
        reason: 'stale',
        detail: { ...detail, ageSeconds: String(ageSeconds), sessionClose: String(sessionClose), why: 'the last trade predates the latest completed NYSE session' },
      };
    }
  }
  return { ok: true, clock, basis, ageSeconds, publishedAt };
}
