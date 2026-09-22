/**
 * The provenance of one fair value (02-interfaces.md §5.1 PricingProvenance, contract `O3-307/1`),
 * built in process from the neutral chain it was priced on. K3-311 keeps it INTERNAL: fair.ts
 * attaches it to every FairQuote, and server.ts does not serialize it, so the legacy /fair body is
 * unchanged until the consumer-first order of §5.1 lets a producer emit it (X3-302, K3-301).
 * Money stays bigint USDG base units here; the wire shape is the serializer's job.
 *
 * WHAT IT NEVER DOES: guess. A clock the chain does not carry is null and its age is null. The
 * provider never implies the method: `listed` means one exact listed contract passed every gate,
 * whoever supplied it, and a provider theoretical value is never a listed quote (chain.ts). Readiness
 * is `ready` only with no reason at all; Cboe states no quote time, so a Cboe price is `degraded` with
 * `quote-age-unknown`, which is the truth about that feed.
 *
 * UNCERTAINTY (K3-312). `quality.uncertainty` carries the bounds short-maturity.ts derives for a read
 * the listings do not identify (before the first listing, an event inside a bracket, an event realized
 * since the surface, an early close); its reason codes follow the method's. Every bounded read has at
 * least one reason (`extrapolated`, `event-uncertainty` or `clock-early-close`), so it is never
 * `ready`. `null` means no bound was derived, not a zero-width one.
 *
 * Pure.
 */
import type { OptionKind } from './bs.js';
import {
  bookState,
  checkIdentity,
  clockAges,
  listedOptionOf,
  type AgeLimits,
  type CanonicalIdentity,
  type ChainRow,
  type InstrumentIdentity,
  type ListedQuote,
  type NormalizedChain,
  type ProviderDescriptor,
  type VendorTheoretical,
} from './chain.js';
import { isUsableQuote } from './cboe.js';
import type { FairMethod } from './fair.js';
import type { SurfaceInput } from './surface.js';

export type ProvenanceMethod = 'listed' | 'interpolated' | 'extrapolated' | 'modeled' | 'external-indicative';

/** §5.1 `quality.uncertainty`, with Money as bigint USDG base units per token. ivLow ≤ iv ≤ ivHigh and
 *  fairLowUsdg6 ≤ fair ≤ fairHighUsdg6 (short-maturity.ts). */
export interface FairUncertainty {
  ivLow: number | null;
  ivHigh: number | null;
  fairLowUsdg6: bigint | null;
  fairHighUsdg6: bigint | null;
}

export interface FairProvenance {
  contract: 'O3-307/1';
  provider: string;
  providerProduct: string | null;
  method: ProvenanceMethod;
  /** The service's own finer label (fair.ts FairMethod). */
  methodDetail: FairMethod;
  /** Listed expiries (unix seconds) whose inputs were used. */
  contributingExpiries: number[];
  identity: {
    market: string;
    issuer: string | null;
    token: CanonicalIdentity['token'];
    option: {
      side: OptionKind;
      strikeUsdg6: bigint;
      expiry: number;
      timeZone: 'America/New_York';
      exercise: 'european';
      payoff: 'cash-value';
      settlement: 'oracle-twap';
    };
    /** The provider's instruments whose quotes were used, as stated; [] when none. */
    listed: InstrumentIdentity[];
  };
  observations: {
    listedQuotes: Array<ListedQuote & { providerInstrumentId: string | null }>;
    vendorTheoretical: Array<VendorTheoretical & { providerInstrumentId: string | null }>;
  };
  clocks: {
    quoteObservedAt: number | null;
    tradeObservedAt: number | null;
    underlyingObservedAt: number | null;
    volatilityObservedAt: number | null;
    publishedAt: number | null;
    receivedAt: number;
    computedAt: number;
  };
  ages: { quoteS: number | null; tradeS: number | null; underlyingS: number | null; volatilityS: number | null };
  entitlement: ProviderDescriptor['entitlement'];
  expiryClock: { expiry: number; timeZone: 'America/New_York'; basis: 'trading-time'; yearsToExpiry: number | null };
  quality: {
    readiness: 'ready' | 'degraded' | 'unavailable';
    reasons: string[];
    uncertainty: FairUncertainty | null;
    disagreement: null;
    fallback: null;
  };
  pricedSpotUsdg6: bigint | null;
}

/** §5.1's method for the service's FairMethod and the strike reads under it. A wing read (flat vol
 *  beyond the outermost listed strike) is an extrapolation even inside a listed expiry. */
export function provenanceMethod(method: FairMethod, strikeMethods: ReadonlyArray<SurfaceInput['strikeMethod']>): ProvenanceMethod {
  if (method === 'listed-contract') return 'listed';
  if (method === 'flat-before-first' || method === 'flat-after-last') return 'extrapolated';
  return strikeMethods.includes('wing') ? 'extrapolated' : 'interpolated';
}

const rowKey = (symbol: string, day: string, side: string, strike: number) => `${symbol}|${day}|${side}|${Math.round(strike * 1_000)}`;

export interface ProvenanceInput {
  chain: NormalizedChain;
  canonical: CanonicalIdentity;
  request: { strikeUsdg6: bigint; expiry: number; type: OptionKind };
  priced: {
    method: FairMethod;
    /** The listed inputs the vol came from: (day, side, strike) and the input's ListedOption symbol. */
    used: Array<{ day: string; expiry: number; side: 'C' | 'P'; strike: number; symbol: string }>;
    /** How each listed expiry's vol was read at the strike (surface.ts SurfaceInput); [] for a listed contract. */
    strikeMethods: Array<SurfaceInput['strikeMethod']>;
    yearsToExpiry: number | null;
  };
  spotUsdg6: bigint | null;
  nowSeconds: number;
  limits: AgeLimits;
  /** Extra reason codes the caller already knows (kept verbatim, first). */
  reasons?: string[];
  /** The read's uncertainty bounds and their reason codes (short-maturity.ts), kept after the method's. */
  uncertainty?: FairUncertainty | null;
  uncertaintyReasons?: readonly string[];
}

export function buildFairProvenance(input: ProvenanceInput): FairProvenance {
  const { chain, canonical, request, priced, nowSeconds } = input;
  // Only rows the surface could have priced from are candidates: a usable listed input for the chain's
  // own root (surface.ts builds from exactly these). A same-(day, side, strike) row for another root,
  // a non-standard multiplier, or with only a theoretical value is never attributed as the input used.
  // The surface drops a strike with two usable quotes, so a used key names exactly one row.
  const root = chain.underlying.providerSymbol;
  const index = new Map<string, ChainRow>();
  for (const row of chain.rows) {
    const listed = listedOptionOf(row, root);
    if (typeof listed === 'string' || !isUsableQuote(listed)) continue;
    index.set(rowKey(listed.symbol, listed.expiry, listed.type, listed.strike), row);
  }
  const seen = new Set<string>();
  const rows: ChainRow[] = [];
  for (const u of priced.used) {
    const key = rowKey(u.symbol, u.day, u.side, u.strike);
    const row = index.get(key);
    if (row === undefined || seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }

  // The quote clock of the price is its OLDEST input's; one input without a time makes it unknown.
  const quoteTimes = rows.map((r) => r.quote?.observedAt ?? chain.clocks.quoteObservedAt);
  const quoteObservedAt = quoteTimes.length === 0 || quoteTimes.some((t) => t === null) ? null : Math.min(...(quoteTimes as number[]));
  const ages = clockAges({ ...chain.clocks, quoteObservedAt }, chain.underlying, null, nowSeconds, input.limits);

  const method = provenanceMethod(priced.method, priced.strikeMethods);
  const reasons: string[] = [...(input.reasons ?? [])];
  const add = (r: string | null) => {
    if (r !== null && !reasons.includes(r)) reasons.push(r);
  };
  for (const r of ages.reasons) add(r);
  // The underlying price is always an input (forward, spot divergence); an unknown clock on it is not
  // fresh, so it keeps the estimate from `ready` (§5.1: ready never rests on an unknown input).
  if (chain.underlying.price !== null && chain.underlying.observedAt === null) add('underlying-age-unknown');
  for (const row of rows) add(bookState(row.quote).reason);
  for (const r of checkIdentity(chain, canonical).reasons) add(r);
  if (method === 'extrapolated') add('extrapolated');
  for (const r of input.uncertaintyReasons ?? []) add(r);
  const uncertainty = input.uncertainty ?? null;
  // A bound is never ready: it always comes with a reason, and ready never rests on an unidentified input.
  const ready = reasons.length === 0 && uncertainty === null;

  return {
    contract: 'O3-307/1',
    provider: chain.provider.id,
    providerProduct: chain.provider.product,
    method,
    methodDetail: priced.method,
    contributingExpiries: [...new Set(priced.used.map((u) => u.expiry))].sort((a, b) => a - b),
    identity: {
      market: canonical.market,
      issuer: canonical.issuer,
      token: canonical.token,
      option: { side: request.type, strikeUsdg6: request.strikeUsdg6, expiry: request.expiry, timeZone: 'America/New_York', exercise: 'european', payoff: 'cash-value', settlement: 'oracle-twap' },
      listed: rows.map((r) => r.instrument),
    },
    observations: {
      listedQuotes: rows.flatMap((r) => (r.quote === null ? [] : [{ providerInstrumentId: r.instrument.providerInstrumentId, ...r.quote }])),
      vendorTheoretical: rows.flatMap((r) => (r.theoretical === null ? [] : [{ providerInstrumentId: r.instrument.providerInstrumentId, ...r.theoretical }])),
    },
    clocks: {
      quoteObservedAt,
      tradeObservedAt: chain.clocks.tradeObservedAt,
      underlyingObservedAt: chain.underlying.observedAt,
      volatilityObservedAt: chain.clocks.volatilityObservedAt,
      publishedAt: chain.clocks.publishedAt,
      receivedAt: chain.clocks.receivedAt,
      computedAt: nowSeconds,
    },
    ages: { quoteS: ages.quoteS, tradeS: ages.tradeS, underlyingS: ages.underlyingS, volatilityS: ages.volatilityS },
    entitlement: chain.provider.entitlement,
    expiryClock: { expiry: request.expiry, timeZone: 'America/New_York', basis: 'trading-time', yearsToExpiry: priced.yearsToExpiry },
    quality: { readiness: ready ? 'ready' : 'degraded', reasons, uncertainty, disagreement: null, fallback: null },
    pricedSpotUsdg6: input.spotUsdg6,
  };
}
