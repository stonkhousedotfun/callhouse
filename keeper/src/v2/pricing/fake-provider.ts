/**
 * Deterministic fake data providers for the provider-neutral seam (K3-311). No network, no
 * credential, no provider contact: a fake serves NormalizedChains that tests build from committed
 * fixtures, through the same OptionChainProvider interface a real adapter implements, so the service
 * cannot tell a fake from Cboe except by what the chain states.
 *
 * Two shapes, the ones §5.1 keeps apart:
 *   listed       raw bid/ask quotes with the provider's greeks, plus what a paid raw-quote feed
 *                states and Cboe's free file does not: a quote time, sizes, the contract multiplier
 *                and the exercise/settlement convention (fakeListedChain).
 *   theoretical  provider model values only: no quote, no greeks on a quote (fakeTheoreticalChain).
 *                Such a chain never becomes a listed input, so it can never price as `listed`.
 * `withTheoretical` adds theoretical values beside the listed quotes of a chain, for the mixed case.
 *
 * Each builder copies; the input chain is never mutated.
 */
import type { ChainRow, NormalizedChain, OptionChainProvider, ProviderDescriptor, ChainSource, ProviderFetchOptions } from './chain.js';

export const FAKE_LISTED_PROVIDER: ProviderDescriptor = {
  id: 'fake-listed',
  product: 'fake-raw-quotes',
  entitlement: { class: 'real-time', declaredDelayS: 0, rightsRef: 'test-fixture' },
};

export const FAKE_THEORETICAL_PROVIDER: ProviderDescriptor = {
  id: 'fake-theoretical',
  product: 'fake-fair-value',
  entitlement: { class: 'indicative', declaredDelayS: null, rightsRef: 'test-fixture' },
};

export interface FakeListedOptions {
  provider?: ProviderDescriptor;
  /** File-wide quote time, unix seconds; null for a provider that states none. */
  quoteObservedAt: number | null;
  /** The underlying's observation time; default the base chain's. */
  underlyingObservedAt?: number | null;
  /** The publication time; default `quoteObservedAt`. */
  publishedAt?: number | null;
  /** The provider's issuer id for the underlying; default null. */
  issuer?: string | null;
  /** Underlying symbol; default the base chain's. */
  providerSymbol?: string;
  /** Stated contract multiplier on every row; default 100. */
  multiplier?: number | null;
  /** Deterministic quote sizes; default 10 contracts a side. */
  size?: number | null;
}

/** `base` restated by a listed-quote provider. Quotes, greeks and strikes are unchanged. */
export function fakeListedChain(base: NormalizedChain, options: FakeListedOptions): NormalizedChain {
  const size = options.size === undefined ? 10 : options.size;
  const multiplier = options.multiplier === undefined ? 100 : options.multiplier;
  const underlyingAt = options.underlyingObservedAt === undefined ? base.underlying.observedAt : options.underlyingObservedAt;
  const publishedAt = options.publishedAt === undefined ? options.quoteObservedAt : options.publishedAt;
  const providerSymbol = options.providerSymbol ?? base.underlying.providerSymbol;
  return {
    ...base,
    provider: options.provider ?? FAKE_LISTED_PROVIDER,
    underlying: { ...base.underlying, providerSymbol, issuer: options.issuer ?? null, observedAt: underlyingAt, observedAtText: null },
    clocks: { ...base.clocks, quoteObservedAt: options.quoteObservedAt, publishedAt, publishedAtText: null },
    rows: base.rows.map((r) => ({
      ...r,
      instrument: { ...r.instrument, root: providerSymbol, multiplier, exercise: 'american', settlement: 'physical' },
      quote: r.quote === null ? null : { ...r.quote, bidSize: size, askSize: size },
    })),
  };
}

/** `base`'s rows as a theoretical-only provider would give them: the listed mid as a model value,
 *  no quote and no greeks on a quote. */
export function fakeTheoreticalChain(base: NormalizedChain, options: { observedAt: number | null; provider?: ProviderDescriptor }): NormalizedChain {
  return {
    ...base,
    provider: options.provider ?? FAKE_THEORETICAL_PROVIDER,
    clocks: { ...base.clocks, quoteObservedAt: null, volatilityObservedAt: options.observedAt },
    rows: base.rows.map((r): ChainRow => ({
      instrument: r.instrument,
      quote: null,
      analytics: null,
      theoretical: {
        product: (options.provider ?? FAKE_THEORETICAL_PROVIDER).product ?? 'theoretical',
        value: r.quote === null || r.quote.bid === null || r.quote.ask === null ? null : (r.quote.bid + r.quote.ask) / 2,
        iv: r.analytics?.iv ?? null,
        currency: 'USD',
        observedAt: options.observedAt,
      },
    })),
  };
}

/** `base` with a theoretical value beside every listed quote: `value(row)` per row (null keeps none). */
export function withTheoretical(base: NormalizedChain, product: string, observedAt: number | null, value: (row: ChainRow) => number | null): NormalizedChain {
  return {
    ...base,
    rows: base.rows.map((r) => {
      const v = value(r);
      return v === null ? r : { ...r, theoretical: { product, value: v, iv: null, currency: 'USD' as const, observedAt } };
    }),
  };
}

export interface FakeProvider extends OptionChainProvider {
  /** Every fetch, in order. */
  readonly fetched: ChainSource[];
}

/**
 * A provider serving `chains` by option root. An Error entry (or a missing root) is a failed
 * download. `receivedAt` is stamped from the service clock, like a real download; nothing else is.
 */
export function createFakeProvider(descriptor: ProviderDescriptor, chains: Readonly<Record<string, NormalizedChain | Error>>): FakeProvider {
  const fetched: ChainSource[] = [];
  return {
    descriptor,
    fetched,
    async fetch(source: ChainSource, options: ProviderFetchOptions): Promise<NormalizedChain> {
      fetched.push(source);
      const chain = chains[source.root];
      if (chain === undefined) throw new Error(`fake provider ${descriptor.id} has no chain for ${source.root}`);
      if (chain instanceof Error) throw chain;
      return { ...chain, clocks: { ...chain.clocks, receivedAt: Math.floor(options.nowMs() / 1000) } };
    },
  };
}
