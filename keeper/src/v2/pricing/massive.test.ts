/**
 * The Massive adapter (massive.ts) and its selection in main.ts. No network: every response is a
 * synthetic page (fixtures/synthetic-massive.ts) served by an injected fetch, and the key is a dummy.
 *
 *   mapping      what Massive states fills the chain; what it omits (greeks, iv, a quote side, the
 *                whole quote) stays null and keeps the row out of the surface; a malformed row is
 *                skipped, not the page; an adjusted root is kept as stated and refused downstream.
 *   entitlement  read per download from the quotes' `timeframe` and the pages' `status`.
 *   fetch        pages are followed under one deadline and one byte budget; the key rides only the
 *                Bearer header and never a URL; a next_url off the API host is refused; 401 / 403 / 429
 *                are named; no error text carries the key, even when the body echoes it.
 *   parity       the synthetic NVDA chain restated by Massive prices exactly as through the Cboe
 *                adapter (same fair, iv, delta, method, asOf); only the provider label differs.
 *   config       PRICING_CHAIN_PROVIDER, MASSIVE_API_KEY (required only for massive, never printed)
 *                and the provider-aware refetch floor.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspect } from 'node:util';
import type { Address } from 'viem';
import { massivePages, massiveRowsFromCboe, toNs, type MassiveRowJson } from '../../fixtures/synthetic-massive.js';
import { syntheticNvdaChain } from '../../fixtures/synthetic-chains.js';
import { ChainCache, PRICING_MIN_REFETCH_MS, checkChain } from './cboe.js';
import { listedOptionOf, listedOptions } from './chain.js';
import { PricingService, type FairOutcome, type FairQuote, type FairRequest } from './fair.js';
import { CBOE_MIN_ALLOWED_REFETCH_MS, RedactedSecret, chainProviderFor, loadPricingEnv } from './main.js';
import {
  MASSIVE_CHAIN_TIMEOUT_MS,
  MASSIVE_MIN_REFETCH_MS,
  MASSIVE_PAGE_LIMIT,
  MassiveFetchError,
  createMassiveProvider,
  fetchMassiveSnapshot,
  massiveEntitlement,
  massiveToNormalized,
  newYorkDayAfter,
} from './massive.js';
import type { PricingMarket } from './markets.js';
import type { FeedRound } from './spot.js';

/*//////////////////////////////////////////////////////////////
                              FIXTURES
//////////////////////////////////////////////////////////////*/

/** A dummy of the real key's shape. Never a real key. */
const KEY = 'TESTKEY0000000000000000000000000';
const NVDA_CBOE = syntheticNvdaChain();
const NVDA_AS_OF = Date.UTC(2026, 8, 14, 19, 59, 59) / 1000;
const NVDA_NOW_MS = Date.UTC(2026, 8, 15, 8, 30);
const NVDA_ROWS = massiveRowsFromCboe(NVDA_CBOE);

interface Call {
  url: string;
  headers: Record<string, string>;
}

type Reply = { status: number; body: unknown; headers?: Record<string, string> };

/** A fetch over canned replies keyed by the request's cursor (`first` for the first page). */
function fakeFetch(replies: Record<string, Reply | (() => Promise<Reply>)>): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
    const cursor = new URL(url).searchParams.get('cursor') ?? 'first';
    const entry = replies[cursor];
    if (entry === undefined) throw new Error(`no reply for ${cursor}`);
    const reply = typeof entry === 'function' ? await entry() : entry;
    return new Response(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body), { status: reply.status, headers: reply.headers ?? {} });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** Every synthetic page served by cursor. */
function servePages(rows: readonly MassiveRowJson[], root = 'NVDA', pageSize = MASSIVE_PAGE_LIMIT) {
  const pages = massivePages(rows, root, pageSize);
  const replies: Record<string, Reply> = {};
  pages.forEach((p, i) => (replies[i === 0 ? 'first' : `synthetic-${i}`] = { status: 200, body: p }));
  return fakeFetch(replies);
}

const baseFetch = { apiKey: KEY, timeoutMs: 5_000, maxBytes: 16_000_000 };

/*//////////////////////////////////////////////////////////////
                              MAPPING
//////////////////////////////////////////////////////////////*/

test('mapping: identity, quote, sizes, per-quote time and greeks as Massive states them; the underlying from the newest row', () => {
  const chain = massiveToNormalized('NVDA', NVDA_ROWS, 123);
  assert.equal(chain.rows.length, NVDA_CBOE.options.length);
  assert.equal(chain.skippedRows, 0);
  const first = NVDA_CBOE.options[0]!;
  const row = chain.rows[0]!;
  assert.deepEqual(row.instrument, { providerInstrumentId: `O:${first.symbol}`, root: 'NVDA', side: first.type, strike: first.strike, expiryDay: first.expiry, expiry: null, multiplier: 100, exercise: 'american', settlement: null });
  assert.deepEqual(row.quote, { bid: first.bid, ask: first.ask, bidSize: 10, askSize: 10, currency: 'USD', observedAt: NVDA_AS_OF });
  assert.deepEqual(row.analytics, { iv: first.iv, delta: first.delta, observedAt: null });
  assert.equal(row.theoretical, null);
  assert.equal(chain.underlying.providerSymbol, 'NVDA');
  assert.equal(chain.underlying.price, NVDA_CBOE.shareSpot);
  assert.equal(chain.underlying.observedAt, NVDA_AS_OF);
  assert.equal(chain.underlying.observedAtText, '2026-09-14T19:59:59.000Z DELAYED');
  // The chain's clock is the newest quote time in the download (every fixture quote is at NVDA_AS_OF).
  assert.deepEqual(chain.clocks, { quoteObservedAt: NVDA_AS_OF, tradeObservedAt: null, volatilityObservedAt: null, publishedAt: null, publishedAtText: null, receivedAt: 123 });
  assert.equal(chain.provider.id, 'massive-options');
  assert.deepEqual(chain.provider.entitlement, { class: 'real-time', declaredDelayS: 0, rightsRef: null });
});

/*
 * measured on the production key 2026-09-24: the underlying is DELAYED and exactly 900 s old while every
 * quote is REAL-TIME. Priced on the underlying's clock, every /fair asOf would be 15 minutes old and mm-bot's
 * MM_FAIR_MAX_AGE_S 60 would halt every market. The chain is priced on its newest quote instead.
 */
test('clock: a DELAYED underlying (900 s) under REAL-TIME quotes prices on the newest quote, not the underlying', () => {
  const now = NVDA_AS_OF + 5;
  const rows = massiveRowsFromCboe(NVDA_CBOE, { quoteAt: NVDA_AS_OF - 30, underlyingAt: NVDA_AS_OF - 900 });
  // One quote updated later than the rest: the snapshot is current to it.
  const newest = { ...rows[3]!, last_quote: { ...(rows[3]!.last_quote as object), last_updated: toNs(NVDA_AS_OF) } };
  const chain = massiveToNormalized('NVDA', [...rows.slice(0, 3), newest, ...rows.slice(4)], now);
  assert.equal(chain.clocks.quoteObservedAt, NVDA_AS_OF, 'the newest quote time');
  assert.equal(chain.underlying.observedAt, NVDA_AS_OF - 900, 'the underlying keeps its own (delayed) clock');
  const check = checkChain(chain, 'NVDA', now, { maxAgeS: 345_600 });
  assert.ok(check.ok, JSON.stringify(check));
  assert.equal(check.clockBasis, 'quote');
  assert.equal(check.ageSeconds, 5, 'aged from the newest quote: well inside a 60 s bound');

  // A download with no quote time at all keeps the underlying's clock, as before.
  const noQuoteTimes = massiveToNormalized('NVDA', rows.map((r) => ({ ...r, last_quote: { ...(r.last_quote as object), last_updated: undefined } })), now);
  assert.equal(noQuoteTimes.clocks.quoteObservedAt, null);
  const fallback = checkChain(noQuoteTimes, 'NVDA', now, { maxAgeS: 345_600 });
  assert.ok(fallback.ok && fallback.clockBasis === 'underlying' && fallback.ageSeconds === 905, JSON.stringify(fallback));
});

test('mapping: missing greeks and iv, a missing side, no quote, a zero bid, an adjusted root and a malformed row', () => {
  const [a, b, c, d, e] = NVDA_ROWS as [MassiveRowJson, MassiveRowJson, MassiveRowJson, MassiveRowJson, MassiveRowJson];
  const noGreeks = { ...a, greeks: {}, implied_volatility: undefined };
  const noAsk = { ...b, last_quote: { ...(b.last_quote as object), ask: undefined } };
  const noQuote = { ...c, last_quote: undefined };
  const zeroBid = { ...d, last_quote: { ...(d.last_quote as object), bid: 0 } };
  const adjusted = { ...e, details: { ...(e.details as object), ticker: 'O:NVDA1260918C00220000' } };
  const malformed = { details: { contract_type: 'call' } };
  const chain = massiveToNormalized('NVDA', [noGreeks, noAsk, noQuote, zeroBid, adjusted, malformed], 0);
  assert.equal(chain.rows.length, 5);
  assert.equal(chain.skippedRows, 1);
  assert.match(chain.firstSkip ?? '', /details\./);
  const [r0, r1, r2, r3, r4] = [chain.rows[0]!, chain.rows[1]!, chain.rows[2]!, chain.rows[3]!, chain.rows[4]!];
  assert.equal(r0.analytics, null, 'no greeks and no iv: no analytics, not zeros');
  assert.equal(listedOptionOf(r0, 'NVDA'), 'analytics-missing');
  assert.equal(r1.quote?.ask, null);
  assert.equal(listedOptionOf(r1, 'NVDA'), 'quote-side-missing');
  assert.equal(r2.quote, null);
  assert.equal(listedOptionOf(r2, 'NVDA'), 'no-quotes');
  assert.equal(r3.quote?.bid, 0, 'a stated zero stays zero');
  assert.equal(r4.instrument.root, 'NVDA1');
  assert.equal(listedOptionOf(r4, 'NVDA'), 'identity-mismatch');
});

test('mapping: an empty snapshot has no underlying price, so checkChain refuses it rather than pricing on nothing', () => {
  const chain = massiveToNormalized('NVDA', [], 0);
  assert.equal(chain.underlying.price, null);
  const check = checkChain(chain, 'NVDA', NVDA_AS_OF + 60, { maxAgeS: 345_600 });
  assert.equal(check.ok, false);
  assert.equal(!check.ok && check.reason, 'chain-inconsistent');
});

test('entitlement: real-time only when every quote says so; any DELAYED quote or page is delayed (900 s); no quote is unknown', () => {
  assert.equal(massiveEntitlement(['REAL-TIME', 'REAL-TIME'], ['OK']).class, 'real-time');
  assert.deepEqual(massiveEntitlement(['REAL-TIME', 'DELAYED'], ['OK']), { class: 'delayed', declaredDelayS: 900, rightsRef: null });
  assert.equal(massiveEntitlement(['REAL-TIME'], ['DELAYED']).class, 'delayed');
  assert.equal(massiveEntitlement([], ['OK']).class, 'unknown');
  assert.equal(massiveEntitlement(['REAL-TIME', undefined], ['OK']).class, 'unknown');
  const delayed = massiveToNormalized('NVDA', massiveRowsFromCboe(NVDA_CBOE, { quoteTimeframe: 'DELAYED' }), 0);
  assert.equal(delayed.provider.entitlement.class, 'delayed');
});

/*//////////////////////////////////////////////////////////////
                               FETCH
//////////////////////////////////////////////////////////////*/

test('fetch: follows next_url to the last page; the key rides only the Bearer header, never a URL', async () => {
  const { fetchImpl, calls } = servePages(NVDA_ROWS, 'NVDA', 50);
  const snap = await fetchMassiveSnapshot('NVDA', { ...baseFetch, expiryLte: '2026-12-14', fetchImpl });
  assert.equal(snap.rows.length, NVDA_ROWS.length);
  assert.equal(snap.pages, Math.ceil(NVDA_ROWS.length / 50));
  assert.equal(calls.length, snap.pages);
  const first = new URL(calls[0]!.url);
  assert.equal(first.origin + first.pathname, 'https://api.massive.com/v3/snapshot/options/NVDA');
  assert.equal(first.searchParams.get('limit'), '250');
  assert.equal(first.searchParams.get('expiration_date.lte'), '2026-12-14');
  for (const c of calls) {
    assert.equal(c.headers.authorization, `Bearer ${KEY}`);
    assert.ok(!c.url.includes(KEY), 'no key in any URL');
  }
});

test('fetch: an apiKey Massive echoes into next_url is removed; a next_url off the API host is refused', async () => {
  const page0 = { status: 'OK', results: NVDA_ROWS.slice(0, 2), next_url: `https://api.massive.com/v3/snapshot/options/NVDA?cursor=synthetic-1&apiKey=${KEY}` };
  const page1 = { status: 'OK', results: NVDA_ROWS.slice(2, 4) };
  const echoed = fakeFetch({ first: { status: 200, body: page0 }, 'synthetic-1': { status: 200, body: page1 } });
  assert.equal((await fetchMassiveSnapshot('NVDA', { ...baseFetch, fetchImpl: echoed.fetchImpl })).rows.length, 4);
  assert.ok(!echoed.calls[1]!.url.includes(KEY));
  const offHost = fakeFetch({ first: { status: 200, body: { ...page0, next_url: 'https://evil.example/v3/snapshot/options/NVDA?cursor=synthetic-1' } } });
  await assert.rejects(fetchMassiveSnapshot('NVDA', { ...baseFetch, fetchImpl: offHost.fetchImpl }), (e: unknown) => e instanceof MassiveFetchError && e.code === 'bad-shape' && /evil\.example/.test(e.message));
  assert.equal(offHost.calls.length, 1, 'the key was never sent off the API host');
});

test('fetch: 401, 403 and 429 are named, and no error text carries the key even when the body echoes it', async () => {
  const cases: Array<[number, string, RegExp]> = [
    [401, 'auth', /MASSIVE_API_KEY/],
    [403, 'not-entitled', /not entitled to NVDA option snapshots/],
    [429, 'rate-limited', /retry after 7 s/],
    [500, 'http-status', /HTTP 500/],
  ];
  for (const [status, code, message] of cases) {
    const { fetchImpl } = fakeFetch({ first: { status, body: { status: 'ERROR', message: `bad request for key ${KEY}` }, headers: status === 429 ? { 'retry-after': '7' } : {} } });
    await assert.rejects(fetchMassiveSnapshot('NVDA', { ...baseFetch, fetchImpl }), (e: unknown) => {
      assert.ok(e instanceof MassiveFetchError);
      assert.equal(e.code, code);
      assert.match(e.message, message);
      assert.ok(!e.message.includes(KEY), `${status}: the key leaked into ${e.message}`);
      assert.match(e.message, /\[redacted\]/);
      return true;
    });
  }
});

test('fetch: one deadline over every page; the page cap, the byte budget, non-JSON and a bad shape', async () => {
  const pages = massivePages(NVDA_ROWS, 'NVDA', 50);
  const hang = fakeFetch({
    first: { status: 200, body: pages[0] },
    'synthetic-1': () => new Promise<Reply>(() => undefined),
  });
  const slow = fetchMassiveSnapshot('NVDA', { ...baseFetch, timeoutMs: 50, fetchImpl: hang.fetchImpl });
  await assert.rejects(slow, (e: unknown) => e instanceof MassiveFetchError && e.code === 'timeout' && /1 pages read/.test(e.message));

  const many = servePages(NVDA_ROWS, 'NVDA', 10);
  await assert.rejects(fetchMassiveSnapshot('NVDA', { ...baseFetch, maxPages: 3, fetchImpl: many.fetchImpl }), (e: unknown) => e instanceof MassiveFetchError && e.code === 'too-many-pages');

  const big = servePages(NVDA_ROWS, 'NVDA', 50);
  await assert.rejects(fetchMassiveSnapshot('NVDA', { ...baseFetch, maxBytes: 20_000, fetchImpl: big.fetchImpl }), (e: unknown) => e instanceof MassiveFetchError && e.code === 'oversize');

  const html = fakeFetch({ first: { status: 200, body: '<html>maintenance</html>' } });
  await assert.rejects(fetchMassiveSnapshot('NVDA', { ...baseFetch, fetchImpl: html.fetchImpl }), (e: unknown) => e instanceof MassiveFetchError && e.code === 'bad-json');

  const shape = fakeFetch({ first: { status: 200, body: { results: 'nope' } } });
  await assert.rejects(fetchMassiveSnapshot('NVDA', { ...baseFetch, fetchImpl: shape.fetchImpl }), (e: unknown) => e instanceof MassiveFetchError && e.code === 'bad-shape');

  await assert.rejects(fetchMassiveSnapshot('NVDA', { ...baseFetch, baseUrl: 'http://api.massive.com' }), (e: unknown) => e instanceof MassiveFetchError && e.code === 'bad-url');
});

test('provider: the horizon cut is a New York day, and the cache keeps the last good chain (with the error) when a refetch fails', async () => {
  assert.equal(newYorkDayAfter(Date.UTC(2026, 8, 15, 3, 0), 0), '2026-09-14', '03:00Z is still the 14th in New York');
  let fail = false;
  const good = massivePages(NVDA_ROWS, 'NVDA')[0]!;
  const { fetchImpl, calls } = fakeFetch({
    first: () => Promise.resolve(fail ? { status: 429, body: { status: 'ERROR', message: 'slow down' } } : { status: 200, body: good }),
  });
  let now = NVDA_NOW_MS;
  const cache = new ChainCache({ provider: createMassiveProvider({ apiKey: KEY, horizonDays: 90, fetchImpl }), minRefetchMs: MASSIVE_MIN_REFETCH_MS, nowMs: () => now });
  const first = await cache.get('NVDA', 'unused', 'NVDA');
  assert.equal(first.error, null);
  assert.equal(new URL(calls[0]!.url).searchParams.get('expiration_date.lte'), '2026-12-15', '90 days plus one from 2026-09-15 New York');
  assert.equal(listedOptions(first.chain!, 'NVDA').length, NVDA_CBOE.options.length);
  now += MASSIVE_MIN_REFETCH_MS - 1;
  await cache.get('NVDA', 'unused', 'NVDA');
  assert.equal(calls.length, 1, 'reused inside the refetch floor');
  fail = true;
  now += 1;
  const failed = await cache.get('NVDA', 'unused', 'NVDA');
  assert.equal(calls.length, 2, 'refetched at the floor');
  assert.match(failed.error ?? '', /^rate-limited: HTTP 429/);
  assert.equal(failed.chain, first.chain, 'the last good chain is still served');
});

/*//////////////////////////////////////////////////////////////
                               PARITY
//////////////////////////////////////////////////////////////*/

const NVDA_FEED: Address = '0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15';
const NVDA_ROUND: FeedRound = { roundId: 18_446_744_073_709_552_249n, answer: 21_221_000_000n, updatedAt: 1_789_416_000n, decimals: 8 };
const MARKETS: ReadonlyMap<string, PricingMarket> = new Map([
  ['NVDA', { ticker: 'NVDA', feed: NVDA_FEED, cboe: { root: 'NVDA', url: 'https://cdn.cboe.com/api/global/delayed_quotes/options/NVDA.json' } }],
]);
const closeOf = (day: number) => Date.UTC(2026, 8, day, 20) / 1000;
const request = (strike: number, expiry: number, type: 'call' | 'put'): FairRequest => ({ ticker: 'NVDA', strikeUsdg6: BigInt(Math.round(strike * 1e6)), expiry, type });

function svc(chains: ConstructorParameters<typeof PricingService>[0]['chains']): PricingService {
  return new PricingService({ markets: MARKETS, nowMs: () => NVDA_NOW_MS, spotReader: async () => NVDA_ROUND, chains });
}

function priced(outcome: FairOutcome): FairQuote {
  assert.ok(outcome.ok, `expected a price, got ${outcome.ok ? '' : `${outcome.reason} ${JSON.stringify(outcome.detail)}`}`);
  return outcome;
}

test('parity: the synthetic NVDA chain restated by Massive prices exactly as through the Cboe adapter; only the label and quote clocks differ', async () => {
  const { fetchImpl } = servePages(NVDA_ROWS);
  const viaCboe = svc({ fetchChain: async () => NVDA_CBOE });
  const viaMassive = svc({ provider: createMassiveProvider({ apiKey: KEY, fetchImpl }) });
  for (const req of [request(220, closeOf(18), 'call'), request(205, closeOf(18), 'put'), request(221, closeOf(18), 'call'), request(200, closeOf(21), 'put')]) {
    const a = priced(await viaCboe.fair(req));
    const b = priced(await viaMassive.fair(req));
    const what = `${req.strikeUsdg6} ${req.expiry} ${req.type}`;
    assert.deepEqual(
      [b.fairUsdg6, b.iv, b.delta, b.method, b.days, b.spotUsdg6, b.asOf, b.used.map((u) => ({ ...u, symbol: u.symbol.replace(/^O:/, '') }))],
      [a.fairUsdg6, a.iv, a.delta, a.method, a.days, a.spotUsdg6, a.asOf, a.used],
      what,
    );
    assert.equal(b.provenance.provider, 'massive-options');
    assert.equal(b.provenance.entitlement.class, 'real-time');
    assert.equal(b.source, 'model', 'only Cboe’s own exact contract is labelled cboe');
    assert.equal(b.provenance.clocks.quoteObservedAt, NVDA_AS_OF, 'Massive states the quote time Cboe does not');
    assert.equal(a.provenance.clocks.quoteObservedAt, null);
  }
  assert.equal(viaMassive.chainProvider.id, 'massive-options');
});

/*//////////////////////////////////////////////////////////////
                               CONFIG
//////////////////////////////////////////////////////////////*/

test('config: Massive by default, needs its key, refetches every 15 s, never prints the key; Cboe only by name off production', () => {
  const base = { RH_RPC: 'https://rpc.mainnet.chain.robinhood.com' };
  // Cboe is no longer the default, and production (the default registry is tier1.json) refuses it. The
  // devnet registry may still name it, at its five-minute floor.
  assert.throws(() => loadPricingEnv(base), /MASSIVE_API_KEY: required when PRICING_CHAIN_PROVIDER=massive/);
  assert.throws(() => loadPricingEnv({ ...base, PRICING_CHAIN_PROVIDER: 'cboe' }), /PRICING_CHAIN_PROVIDER: cboe is refused in production/);
  const offProduction = { ...base, V2_REGISTRY_PATH: '../ops/markets/dev.json' };
  const cboe = loadPricingEnv({ ...offProduction, PRICING_CHAIN_PROVIDER: 'cboe' });
  assert.deepEqual(cboe.chain, { provider: 'cboe', massiveApiKey: null, massiveApiUrl: 'https://api.massive.com', refetchMs: PRICING_MIN_REFETCH_MS, timeoutMs: 10_000 });
  assert.equal(chainProviderFor(cboe), undefined, 'an explicit off-production cboe is the cache default');

  assert.throws(() => loadPricingEnv({ ...base, PRICING_CHAIN_PROVIDER: 'massive' }), /MASSIVE_API_KEY: required when PRICING_CHAIN_PROVIDER=massive/);
  assert.throws(
    () => loadPricingEnv({ ...base, PRICING_CHAIN_PROVIDER: 'massive', MASSIVE_API_KEY: 'has spaces in it!' }),
    (e: unknown) => e instanceof Error && /MASSIVE_API_KEY: not a Massive API key \(value not shown\)/.test(e.message) && !e.message.includes('has spaces'),
  );
  assert.throws(() => loadPricingEnv({ ...offProduction, PRICING_CHAIN_PROVIDER: 'cboe', MASSIVE_API_KEY: KEY }), (e: unknown) => e instanceof Error && /set while PRICING_CHAIN_PROVIDER is cboe/.test(e.message) && !e.message.includes(KEY));
  assert.throws(() => loadPricingEnv({ ...offProduction, PRICING_CHAIN_PROVIDER: 'cboe', PRICING_CHAIN_REFETCH_MS: '15000' }), new RegExp(`at least ${CBOE_MIN_ALLOWED_REFETCH_MS}`));
  assert.equal(loadPricingEnv({ ...base, MASSIVE_API_KEY: KEY }).chain.provider, 'massive', 'the key alone selects massive: it is the default');
  assert.throws(() => loadPricingEnv({ ...base, PRICING_CHAIN_PROVIDER: 'polygon' }), /PRICING_CHAIN_PROVIDER/);

  const massive = loadPricingEnv({ ...base, PRICING_CHAIN_PROVIDER: 'massive', MASSIVE_API_KEY: KEY });
  assert.equal(massive.chain.provider, 'massive');
  assert.equal(massive.chain.refetchMs, MASSIVE_MIN_REFETCH_MS);
  assert.ok(MASSIVE_MIN_REFETCH_MS < 60_000, 'a real-time feed is read inside a minute');
  assert.equal(massive.chain.timeoutMs, MASSIVE_CHAIN_TIMEOUT_MS);
  assert.ok(massive.chain.massiveApiKey instanceof RedactedSecret);
  assert.equal(massive.chain.massiveApiKey.reveal(), KEY);
  for (const printed of [JSON.stringify(massive), String(massive.chain.massiveApiKey), inspect(massive, { depth: 5 }), `${massive.chain.massiveApiKey}`]) {
    assert.ok(!printed.includes(KEY), `the key leaked: ${printed.slice(0, 80)}`);
  }
  assert.equal(chainProviderFor(massive)?.descriptor.id, 'massive-options');

  const tuned = loadPricingEnv({ ...base, PRICING_CHAIN_PROVIDER: 'massive', MASSIVE_API_KEY: KEY, PRICING_CHAIN_REFETCH_MS: '5000', PRICING_CHAIN_TIMEOUT_MS: '30000', MASSIVE_API_URL: 'https://proxy.example' });
  assert.deepEqual([tuned.chain.refetchMs, tuned.chain.timeoutMs, tuned.chain.massiveApiUrl], [5_000, 30_000, 'https://proxy.example']);
  assert.throws(() => loadPricingEnv({ ...base, PRICING_CHAIN_PROVIDER: 'massive', MASSIVE_API_KEY: KEY, MASSIVE_API_URL: 'http://api.massive.com' }), /MASSIVE_API_URL/);
});

test('fixture: the synthetic pages carry nanosecond clocks and no key', () => {
  const pages = massivePages(NVDA_ROWS, 'NVDA');
  assert.equal((pages[0]!.results[0] as { last_quote: { last_updated: number } }).last_quote.last_updated, toNs(NVDA_AS_OF));
  assert.ok(!JSON.stringify(pages).includes(KEY));
});
