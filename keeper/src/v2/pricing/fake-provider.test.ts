/**
 * The pricing service behind the provider-neutral seam, with deterministic fake providers
 * (fake-provider.ts) instead of Cboe. No network, no credential, no provider contact.
 *
 * WHY THIS FILE EXISTS: K3-311's contract is only real if a second provider can stand where Cboe
 * stands. These tests pin that:
 *   parity        the same listed quotes priced through a fake provider give the same numbers as
 *                 through the Cboe adapter, and only the provider label differs: an exact listed
 *                 contract from a non-Cboe provider is never labelled "cboe".
 *   theoretical   a provider's model values never price as listed quotes: a theoretical-only chain
 *                 is refused, and theoretical values beside listed quotes change no price.
 *   clocks        a quote time is priced on and aged when given; unknown times stay null through the
 *                 cache and a failed refetch; a frozen underlying next to fresh quotes is priced and
 *                 reported as `underlying-stale`, not as stale quotes.
 *   identity      another symbol is refused, adjusted contracts are left out, and the registry's
 *                 canonical Stock Token rides in the provenance.
 *   zero          a price that rounds to 0 is a price (fair raw "0"), never "unavailable".
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Address } from 'viem';
import { syntheticNvdaChain, syntheticTslaChain } from '../../fixtures/synthetic-chains.js';
import { PRICING_MIN_REFETCH_MS, cboeToNormalized, type PricingReason } from './cboe.js';
import type { ChainRow, NormalizedChain, OptionChainProvider } from './chain.js';
import { FAKE_LISTED_PROVIDER, FAKE_THEORETICAL_PROVIDER, createFakeProvider, fakeListedChain, fakeTheoreticalChain, withTheoretical } from './fake-provider.js';
import { PricingService, type FairOutcome, type FairQuote, type FairRequest } from './fair.js';
import type { PricingMarket } from './markets.js';
import { fairResponse } from './server.js';
import type { FeedRound } from './spot.js';

/*//////////////////////////////////////////////////////////////
                              FIXTURES
//////////////////////////////////////////////////////////////*/

const NVDA_CBOE = syntheticNvdaChain();
const TSLA_CBOE = syntheticTslaChain();
const NVDA_AS_OF = Date.UTC(2026, 8, 14, 19, 59, 59) / 1000;
const TSLA_AS_OF = Date.UTC(2026, 8, 16, 19, 59, 59) / 1000;
const NVDA_NOW_MS = Date.UTC(2026, 8, 15, 8, 30);
const TSLA_NOW_MS = Date.UTC(2026, 8, 17, 8, 30);
const closeOf = (day: number) => Date.UTC(2026, 8, day, 20) / 1000;

/** The Cboe adapter's view of the committed synthetic files (receivedAt is restamped per download). */
const NVDA = cboeToNormalized(NVDA_CBOE, 0);
const TSLA = cboeToNormalized(TSLA_CBOE, 0);

const cboeUrl = (root: string) => `https://cdn.cboe.com/api/global/delayed_quotes/options/${root}.json`;
const NVDA_FEED: Address = '0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15';
const TSLA_FEED: Address = '0x4A1166a659A55625345e9515b32adECea5547C38';
const NVDA_TOKEN = { chainId: 4663, address: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC' as Address, uiMultiplier: '1000775159164630595' };

const MARKETS: ReadonlyMap<string, PricingMarket> = new Map([
  ['NVDA', { ticker: 'NVDA', feed: NVDA_FEED, cboe: { root: 'NVDA', url: cboeUrl('NVDA') }, token: NVDA_TOKEN }],
  ['TSLA', { ticker: 'TSLA', feed: TSLA_FEED, cboe: { root: 'TSLA', url: cboeUrl('TSLA') } }],
]);

const NVDA_ROUND: FeedRound = { roundId: 18_446_744_073_709_552_249n, answer: 21_221_000_000n, updatedAt: 1_789_416_000n, decimals: 8 };
const TSLA_ROUND: FeedRound = { roundId: 18_446_744_073_709_552_900n, answer: 36_020_000_000n, updatedAt: 1_789_588_800n, decimals: 8 };

function service(nowMs: number, chains: { provider?: OptionChainProvider }): { svc: PricingService; setNow(ms: number): void } {
  let now = nowMs;
  const svc = new PricingService({
    markets: MARKETS,
    nowMs: () => now,
    spotReader: async (feed) => {
      if (feed === NVDA_FEED) return NVDA_ROUND;
      if (feed === TSLA_FEED) return TSLA_ROUND;
      throw new Error('no such feed');
    },
    chains: chains.provider === undefined
      ? { fetchChain: async (url) => (url === cboeUrl('NVDA') ? NVDA_CBOE : TSLA_CBOE) }
      : { provider: chains.provider },
  });
  return { svc, setNow: (ms) => (now = ms) };
}

const request = (ticker: string, strike: number, expiry: number, type: 'call' | 'put'): FairRequest => ({ ticker, strikeUsdg6: BigInt(Math.round(strike * 1e6)), expiry, type });

function priced(outcome: FairOutcome): FairQuote {
  assert.ok(outcome.ok, `expected a price, got ${outcome.ok ? '' : `${outcome.reason} ${JSON.stringify(outcome.detail)}`}`);
  return outcome;
}

function refused(outcome: FairOutcome, reason: PricingReason) {
  assert.equal(outcome.ok, false, `expected ${reason}, got a price`);
  assert.equal(!outcome.ok && outcome.reason, reason, !outcome.ok ? JSON.stringify(outcome.detail) : '');
  return outcome as Extract<FairOutcome, { ok: false }>;
}

/** A listed fake restating a Cboe file, stamped with that file's own last trade as its quote time. */
const listedTwin = (base: NormalizedChain, asOf: number) => fakeListedChain(base, { quoteObservedAt: asOf, underlyingObservedAt: asOf, publishedAt: base.clocks.publishedAt });

/** Exact listed contracts, strike and expiry interpolation, a put, a flat extrapolation and a TSLA daily. */
const GRID: Array<[number, FairRequest]> = [
  [NVDA_NOW_MS, request('NVDA', 220, closeOf(18), 'call')],
  [NVDA_NOW_MS, request('NVDA', 205, closeOf(18), 'put')],
  [NVDA_NOW_MS, request('NVDA', 221, closeOf(18), 'call')],
  [NVDA_NOW_MS, { ticker: 'NVDA', strikeUsdg6: 231_000_000n, expiry: 1_790_020_800, type: 'call' }],
  [NVDA_NOW_MS, request('NVDA', 200, closeOf(21), 'put')],
  [NVDA_NOW_MS, request('NVDA', 215, closeOf(16), 'call')],
  [TSLA_NOW_MS, request('TSLA', 360, closeOf(21), 'call')],
  [TSLA_NOW_MS, request('TSLA', 361, closeOf(22), 'call')],
  [TSLA_NOW_MS, request('TSLA', 350, closeOf(23), 'put')],
];

/*//////////////////////////////////////////////////////////////
                               PARITY
//////////////////////////////////////////////////////////////*/

test('parity: the same listed quotes through a fake provider price exactly as through the Cboe adapter; only the provider label differs', async () => {
  const fake = createFakeProvider(FAKE_LISTED_PROVIDER, { NVDA: listedTwin(NVDA, NVDA_AS_OF), TSLA: listedTwin(TSLA, TSLA_AS_OF) });
  for (const [nowMs, req] of GRID) {
    const cboe = priced(await service(nowMs, {}).svc.fair(req));
    const viaFake = priced(await service(nowMs, { provider: fake }).svc.fair(req));
    const what = `${req.ticker} ${req.strikeUsdg6} ${req.expiry} ${req.type}`;
    assert.deepEqual(
      [viaFake.fairUsdg6, viaFake.iv, viaFake.delta, viaFake.method, viaFake.days, viaFake.spotUsdg6, viaFake.asOf, viaFake.used],
      [cboe.fairUsdg6, cboe.iv, cboe.delta, cboe.method, cboe.days, cboe.spotUsdg6, cboe.asOf, cboe.used],
      what,
    );
    assert.equal(viaFake.provenance.method, cboe.provenance.method, what);
    assert.equal(viaFake.provenance.provider, 'fake-listed');
    assert.equal(cboe.provenance.provider, 'cboe-delayed');
    // "cboe" only for Cboe's own exact contract; the fake's exact contract is still method listed, source model.
    assert.equal(cboe.source, cboe.method === 'listed-contract' ? 'cboe' : 'model', what);
    assert.equal(viaFake.source, 'model', what);
  }
  assert.deepEqual(fake.fetched.map((s) => s.root).sort(), [...Array(6).fill('NVDA'), ...Array(3).fill('TSLA')].sort(), 'one download per fresh service');
});

test('provenance: the Cboe listed price says what Cboe states and nothing more; the fake states its quote time and sizes', async () => {
  const cboe = priced(await service(NVDA_NOW_MS, {}).svc.fair(request('NVDA', 220, closeOf(18), 'call')));
  const p = cboe.provenance;
  assert.equal(p.contract, 'O3-307/1');
  assert.equal(p.method, 'listed');
  assert.equal(p.methodDetail, 'listed-contract');
  assert.deepEqual(p.contributingExpiries, [closeOf(18)]);
  assert.deepEqual(p.identity.listed.map((i) => i.providerInstrumentId), ['NVDA260918C00220000']);
  assert.deepEqual(p.identity.listed[0], { providerInstrumentId: 'NVDA260918C00220000', root: 'NVDA', side: 'C', strike: 220, expiryDay: '2026-09-18', expiry: null, multiplier: null, exercise: null, settlement: null });
  assert.deepEqual(p.identity.token, NVDA_TOKEN);
  assert.equal(p.identity.issuer, null, 'the registry has no issuer; none is invented');
  assert.equal(p.observations.listedQuotes.length, 1);
  assert.deepEqual(p.observations.vendorTheoretical, []);
  assert.equal(p.observations.listedQuotes[0]!.observedAt, null);
  assert.deepEqual(p.clocks, {
    quoteObservedAt: null,
    tradeObservedAt: null,
    underlyingObservedAt: NVDA_AS_OF,
    volatilityObservedAt: null,
    publishedAt: Date.UTC(2026, 8, 15, 5, 45) / 1000,
    receivedAt: NVDA_NOW_MS / 1000,
    computedAt: NVDA_NOW_MS / 1000,
  });
  assert.equal(p.ages.quoteS, null, 'no quote time: no quote age, not the file age or the download age');
  assert.deepEqual(p.entitlement, { class: 'delayed', declaredDelayS: null, rightsRef: null });
  assert.deepEqual(p.quality.reasons, ['quote-age-unknown']);
  assert.equal(p.quality.readiness, 'degraded', 'ready with an unknown input would be a lie');
  assert.equal(p.pricedSpotUsdg6, 212_210_000n);
  assert.equal(p.expiryClock.basis, 'trading-time');
  assert.ok(p.expiryClock.yearsToExpiry! > 0);

  const fake = createFakeProvider(FAKE_LISTED_PROVIDER, { NVDA: listedTwin(NVDA, NVDA_AS_OF) });
  const q = priced(await service(NVDA_NOW_MS, { provider: fake }).svc.fair(request('NVDA', 220, closeOf(18), 'call'))).provenance;
  assert.equal(q.clocks.quoteObservedAt, NVDA_AS_OF);
  assert.equal(q.ages.quoteS, NVDA_NOW_MS / 1000 - NVDA_AS_OF);
  assert.deepEqual(q.quality.reasons, [], 'a stated, fresh quote time, a mapped token, standard contract: nothing to report');
  assert.equal(q.quality.readiness, 'ready');
  assert.deepEqual(q.entitlement, FAKE_LISTED_PROVIDER.entitlement);
  assert.deepEqual([q.observations.listedQuotes[0]!.bidSize, q.observations.listedQuotes[0]!.askSize], [10, 10]);
  assert.deepEqual([q.identity.listed[0]!.multiplier, q.identity.listed[0]!.exercise, q.identity.listed[0]!.settlement], [100, 'american', 'physical']);

  // A modeled read lists every contributing listed quote and its expiries; a wing read is an extrapolation.
  const monday = priced(await service(NVDA_NOW_MS, {}).svc.fair({ ticker: 'NVDA', strikeUsdg6: 231_000_000n, expiry: 1_790_020_800, type: 'call' })).provenance;
  assert.equal(monday.method, 'interpolated');
  assert.equal(monday.methodDetail, 'total-variance');
  assert.deepEqual(monday.contributingExpiries, [closeOf(18), closeOf(25)]);
  assert.ok(monday.identity.listed.length >= 2 && monday.identity.listed.every((i) => i.expiryDay === '2026-09-18' || i.expiryDay === '2026-09-25'));
  const wing = priced(await service(NVDA_NOW_MS, {}).svc.fair(request('NVDA', 400, closeOf(18), 'call'))).provenance;
  assert.equal(wing.method, 'extrapolated');
  assert.ok(wing.quality.reasons.includes('extrapolated'));
  // TSLA has no token in this registry: the provenance says unmapped instead of guessing one.
  const tsla = priced(await service(TSLA_NOW_MS, {}).svc.fair(request('TSLA', 360, closeOf(21), 'call'))).provenance;
  assert.deepEqual(tsla.identity.token, { chainId: null, address: null, uiMultiplier: null });
  assert.ok(tsla.quality.reasons.includes('identity-unmapped'));
});

/*//////////////////////////////////////////////////////////////
                            THEORETICAL
//////////////////////////////////////////////////////////////*/

test('theoretical: a model-value-only provider is never priced as listed; model values beside quotes change nothing', async () => {
  const theo = createFakeProvider(FAKE_THEORETICAL_PROVIDER, { NVDA: fakeTheoreticalChain(NVDA, { observedAt: NVDA_AS_OF }) });
  const { svc } = service(NVDA_NOW_MS, { provider: theo });
  refused(await svc.fair(request('NVDA', 220, closeOf(18), 'call')), 'no-quotes');
  const surface = await svc.surface('NVDA');
  assert.ok(surface.ok);
  assert.deepEqual(surface.surface.expiries, [], 'no listed input: no expiry on the surface');
  assert.equal(surface.chain.rows.every((r) => r.quote === null && r.theoretical !== null), true, 'the model values are kept, as model values');

  // Absurd theoretical values next to the real quotes: same prices, carried separately in the provenance.
  const listed = listedTwin(NVDA, NVDA_AS_OF);
  const mixed = withTheoretical(listed, 'fake-fair-value', NVDA_AS_OF, (r) => (r.quote?.ask ?? 0) * 3 + 1);
  const clean = priced(await service(NVDA_NOW_MS, { provider: createFakeProvider(FAKE_LISTED_PROVIDER, { NVDA: listed }) }).svc.fair(request('NVDA', 220, closeOf(18), 'call')));
  const withTheo = priced(await service(NVDA_NOW_MS, { provider: createFakeProvider(FAKE_LISTED_PROVIDER, { NVDA: mixed }) }).svc.fair(request('NVDA', 220, closeOf(18), 'call')));
  assert.deepEqual([withTheo.fairUsdg6, withTheo.iv, withTheo.method], [clean.fairUsdg6, clean.iv, clean.method]);
  const row = NVDA_CBOE.options.find((o) => o.symbol === 'NVDA260918C00220000')!;
  assert.deepEqual(withTheo.provenance.observations.listedQuotes.map((x) => [x.bid, x.ask]), [[row.bid, row.ask]], 'the quote is the quote');
  assert.deepEqual(withTheo.provenance.observations.vendorTheoretical.map((x) => x.value), [row.ask * 3 + 1], 'the model value is beside it, never in it');
  assert.equal(withTheo.provenance.method, 'listed');
});

/*//////////////////////////////////////////////////////////////
                              CLOCKS
//////////////////////////////////////////////////////////////*/

test('clocks: a frozen underlying beside fresh quotes is priced and reported; without a quote time the same file is stale; no time at all is refused', async () => {
  const now = NVDA_NOW_MS / 1000;
  const frozen = fakeListedChain(NVDA, { quoteObservedAt: now - 60, underlyingObservedAt: now - 5 * 86_400 });
  const fresh = priced(await service(NVDA_NOW_MS, { provider: createFakeProvider(FAKE_LISTED_PROVIDER, { NVDA: frozen }) }).svc.fair(request('NVDA', 220, closeOf(18), 'call')));
  assert.equal(fresh.asOf, now - 60, 'priced on the quote clock');
  assert.equal(fresh.provenance.ages.quoteS, 60);
  assert.equal(fresh.provenance.ages.underlyingS, 5 * 86_400);
  assert.deepEqual(fresh.provenance.quality.reasons, ['underlying-stale'], 'the underlying is stale; the quotes are not');

  const noQuoteTime = fakeListedChain(NVDA, { quoteObservedAt: null, underlyingObservedAt: now - 5 * 86_400, publishedAt: now - 60 });
  refused(await service(NVDA_NOW_MS, { provider: createFakeProvider(FAKE_LISTED_PROVIDER, { NVDA: noQuoteTime }) }).svc.fair(request('NVDA', 220, closeOf(18), 'call')), 'chain-stale');

  const timeless = fakeListedChain(NVDA, { quoteObservedAt: null, underlyingObservedAt: null, publishedAt: null });
  const r = refused(await service(NVDA_NOW_MS, { provider: createFakeProvider(FAKE_LISTED_PROVIDER, { NVDA: timeless }) }).svc.fair(request('NVDA', 220, closeOf(18), 'call')), 'chain-inconsistent');
  assert.equal(r.detail.why, 'the source gives no observation time', 'never priced on the download time');
});

test('clocks: a refetch advances only receivedAt, and a failed refetch serves the old chain with its old clocks', async () => {
  let fail = false;
  const base = listedTwin(NVDA, NVDA_AS_OF);
  const provider: OptionChainProvider = {
    descriptor: FAKE_LISTED_PROVIDER,
    fetch: async (source, options) => {
      if (fail) throw new Error('http-status: HTTP 503');
      return createFakeProvider(FAKE_LISTED_PROVIDER, { NVDA: base }).fetch(source, options);
    },
  };
  const { svc, setNow } = service(NVDA_NOW_MS, { provider });
  const first = priced(await svc.fair(request('NVDA', 220, closeOf(18), 'call'))).provenance;
  assert.equal(first.clocks.receivedAt, NVDA_NOW_MS / 1000);
  setNow(NVDA_NOW_MS + PRICING_MIN_REFETCH_MS);
  const again = priced(await svc.fair(request('NVDA', 220, closeOf(18), 'call'))).provenance;
  assert.equal(again.clocks.receivedAt, (NVDA_NOW_MS + PRICING_MIN_REFETCH_MS) / 1000, 'the refetch was received later');
  assert.deepEqual([again.clocks.quoteObservedAt, again.clocks.publishedAt, again.clocks.underlyingObservedAt], [first.clocks.quoteObservedAt, first.clocks.publishedAt, first.clocks.underlyingObservedAt], 'and observed nothing newer');
  assert.equal(again.ages.quoteS, first.ages.quoteS! + PRICING_MIN_REFETCH_MS / 1000, 'so the quotes are five minutes older, not fresh');
  fail = true;
  setNow(NVDA_NOW_MS + 2 * PRICING_MIN_REFETCH_MS);
  const fallback = priced(await svc.fair(request('NVDA', 220, closeOf(18), 'call'))).provenance;
  assert.equal(fallback.clocks.receivedAt, again.clocks.receivedAt, 'serving the last good chain after a failure refreshes nothing');
  assert.equal(svc.chainAttempts().get('NVDA')?.error, 'http-status: HTTP 503');
});

/*//////////////////////////////////////////////////////////////
                              IDENTITY
//////////////////////////////////////////////////////////////*/

test('identity: another underlying symbol is refused; adjusted (non-standard multiplier) contracts are left out of the surface', async () => {
  const wrong = fakeListedChain(NVDA, { quoteObservedAt: NVDA_AS_OF, providerSymbol: 'NVDX' });
  const r = refused(await service(NVDA_NOW_MS, { provider: createFakeProvider(FAKE_LISTED_PROVIDER, { NVDA: wrong }) }).svc.fair(request('NVDA', 220, closeOf(18), 'call')), 'chain-inconsistent');
  assert.equal(r.detail.symbol, 'NVDX');

  const adjusted = fakeListedChain(NVDA, { quoteObservedAt: NVDA_AS_OF, underlyingObservedAt: NVDA_AS_OF, publishedAt: NVDA.clocks.publishedAt, multiplier: 150 });
  const { svc } = service(NVDA_NOW_MS, { provider: createFakeProvider(FAKE_LISTED_PROVIDER, { NVDA: adjusted }) });
  refused(await svc.fair(request('NVDA', 220, closeOf(18), 'call')), 'no-quotes');
  const surface = await svc.surface('NVDA');
  assert.ok(surface.ok && surface.surface.expiries.length === 0, 'no adjusted contract is modelled as a standard one');
});

/** `base` plus, after every row, a same-(day, side, strike) decoy the surface must never price from. */
function withDecoys(base: NormalizedChain, kind: 'other-root' | 'adjusted' | 'theoretical-only'): NormalizedChain {
  const rows = base.rows.flatMap((row) => {
    const id = row.instrument.providerInstrumentId ?? 'row';
    const decoy: ChainRow =
      kind === 'other-root'
        ? { ...row, instrument: { ...row.instrument, root: 'NVDA1', providerInstrumentId: `NVDA1-${id}` }, quote: row.quote && { ...row.quote, bid: 50, ask: 51 } }
        : kind === 'adjusted'
          ? { ...row, instrument: { ...row.instrument, multiplier: 150, providerInstrumentId: `ADJ-${id}` }, quote: row.quote && { ...row.quote, bid: 60, ask: 61 } }
          : { ...row, instrument: { ...row.instrument, providerInstrumentId: `THEO-${id}` }, quote: null, analytics: null, theoretical: { product: 'fake-fair-value', value: 9.99, iv: 0.5, currency: 'USD', observedAt: NVDA_AS_OF } };
    return [row, decoy];
  });
  return { ...base, rows };
}

test('provenance names only the listed input actually used: same-key rows for another root, an adjusted contract or a model value are never attributed', async () => {
  const listed = listedTwin(NVDA, NVDA_AS_OF);
  const exact = request('NVDA', 220, closeOf(18), 'call');
  const monday: FairRequest = { ticker: 'NVDA', strikeUsdg6: 231_000_000n, expiry: 1_790_020_800, type: 'call' };
  const svcOf = (chain: NormalizedChain) => service(NVDA_NOW_MS, { provider: createFakeProvider(FAKE_LISTED_PROVIDER, { NVDA: chain }) }).svc;
  const cleanExact = priced(await svcOf(listed).fair(exact));
  const cleanMonday = priced(await svcOf(listed).fair(monday));
  const row = NVDA_CBOE.options.find((o) => o.symbol === 'NVDA260918C00220000')!;
  for (const kind of ['other-root', 'adjusted', 'theoretical-only'] as const) {
    const svc = svcOf(withDecoys(listed, kind));
    const e = priced(await svc.fair(exact));
    assert.deepEqual([e.fairUsdg6, e.iv, e.method], [cleanExact.fairUsdg6, cleanExact.iv, cleanExact.method], `${kind}: the price is untouched`);
    assert.equal(e.provenance.method, 'listed');
    assert.deepEqual(e.provenance.identity.listed.map((i) => i.providerInstrumentId), ['NVDA260918C00220000'], `${kind}: the used instrument, not the decoy`);
    assert.deepEqual(e.provenance.observations.listedQuotes.map((x) => [x.bid, x.ask]), [[row.bid, row.ask]], `${kind}: the used quote`);
    assert.deepEqual(e.provenance.observations.vendorTheoretical, [], `${kind}: a same-key model value is not an input of a listed price`);
    const m = priced(await svc.fair(monday));
    assert.deepEqual(m.provenance.identity.listed, cleanMonday.provenance.identity.listed, `${kind}: interpolated inputs are the used rows`);
    assert.deepEqual(m.provenance.observations, cleanMonday.provenance.observations);
  }
});

test('clocks: an underlying price with no stated time keeps the estimate from ready (underlying-age-unknown)', async () => {
  const noUnderlyingTime = fakeListedChain(NVDA, { quoteObservedAt: NVDA_AS_OF, underlyingObservedAt: null, publishedAt: NVDA.clocks.publishedAt });
  const q = priced(await service(NVDA_NOW_MS, { provider: createFakeProvider(FAKE_LISTED_PROVIDER, { NVDA: noUnderlyingTime }) }).svc.fair(request('NVDA', 220, closeOf(18), 'call'))).provenance;
  assert.equal(q.clocks.underlyingObservedAt, null, 'never filled from the quote, file or download time');
  assert.equal(q.ages.underlyingS, null);
  assert.deepEqual(q.quality.reasons, ['underlying-age-unknown']);
  assert.equal(q.quality.readiness, 'degraded');
});

/*//////////////////////////////////////////////////////////////
                         ZERO IS NOT MISSING
//////////////////////////////////////////////////////////////*/

test('zero: a far out-of-the-money price that rounds to 0 is a price, fair raw "0"; a refusal is fair null', async () => {
  const { svc } = service(NVDA_NOW_MS, {});
  const zero = priced(await svc.fair(request('NVDA', 900, closeOf(18), 'call')));
  assert.equal(zero.fairUsdg6, 0n);
  const body = fairResponse(zero).body as { fair: { raw: string } | null };
  assert.deepEqual(body.fair, { raw: '0', decimals: 6, formatted: '0' });
  const none = fairResponse(refused(await svc.fair(request('NVDA', 220, NVDA_AS_OF, 'call')), 'expired')).body;
  assert.equal(none.fair, null);
  // The legacy body never carries the internal provenance.
  assert.equal('provenance' in fairResponse(zero).body, false);
});
