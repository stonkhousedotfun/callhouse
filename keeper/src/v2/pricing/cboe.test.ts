/**
 * The chain gates, generalised to puts and to any ticker, and the per-ticker cache.
 *
 * WHY THIS FILE EXISTS: the pricing service must keep every quality gate the v1 keeper earned
 * (vol.ts), while pricing puts and 35 roots. The first tests pin that the per-side functions are
 * EXACTLY v1's for calls, on every row of two synthetic chains; the rest pin what puts add, the chain
 * checks that map v1's reasons onto v2's, and the refetch floor that keeps a free feed from being
 * hammered.
 *
 * Fixtures: deterministic Black–Scholes quotes with invented forwards, vols and spreads. The
 * synthetic NVDA and TSLA-shaped chains include the relevant weekly and daily expiries.
 *
 * DELIBERATELY ABSENT: the network. Downloads go through the cache's fetch seam; where the v1
 * fetch gates are exercised, vol.ts fetchCboeChain runs against an injected fetchImpl.
 */
import assert from 'node:assert/strict';
import { createServer, type AddressInfo } from 'node:net';
import { test } from 'node:test';
import * as vol from '../../vol.js';
import { syntheticNvdaChain, syntheticTslaChain, syntheticTslaPayload } from '../../fixtures/synthetic-chains.js';
import { startPricingService } from './main.js';
import { MASSIVE_PROVIDER } from './massive.js';
import { ChainCache, PRICING_MIN_REFETCH_MS, DEFAULT_CHAIN_MAX_BYTES, cboeToNormalized, checkChain, checkQuoteWindow, filterQuotes, isUsableQuote, warmChains } from './cboe.js';
import type { ChainEntry } from './cboe.js';

/** A Cboe file as the service sees it (the Cboe adapter's normalized chain). */
const n = (chain: vol.CboeChain) => cboeToNormalized(chain, 0);
/** The cached entry holds `chain`'s file, normalized when it was received. */
const holds = (entry: ChainEntry, chain: vol.CboeChain) => entry.chain !== null && entry.chain.underlying.providerSymbol === chain.root && entry.chain.clocks.publishedAtText === chain.timestamp && entry.chain.rows.length === chain.options.length;

const TSLA_RAW = JSON.stringify(syntheticTslaPayload());
const NVDA = syntheticNvdaChain();
const TSLA = syntheticTslaChain();

/** Tuesday 2026-09-15 08:30 UTC and Thursday 2026-09-17 08:30 UTC: the mornings after. */
const NVDA_NOW = Date.UTC(2026, 8, 15, 8, 30) / 1000;
const TSLA_NOW = Date.UTC(2026, 8, 17, 8, 30) / 1000;

const onDay = (chain: vol.CboeChain, day: string) => chain.options.filter((o) => o.expiry === day);

/*//////////////////////////////////////////////////////////////
                          v1 PARITY (CALLS)
//////////////////////////////////////////////////////////////*/

test('isUsableQuote and filterQuotes: for calls, exactly vol.ts on every synthetic row', () => {
  let rows = 0;
  for (const chain of [NVDA, TSLA]) {
    for (const o of chain.options.filter((x) => x.type === 'C')) {
      assert.equal(isUsableQuote(o), vol.isUsableQuote(o), o.symbol);
      rows += 1;
    }
    for (const day of new Set(chain.options.map((o) => o.expiry))) {
      assert.deepEqual(filterQuotes(onDay(chain, day), 'C'), vol.filterQuotes(onDay(chain, day).filter((o) => o.type === 'C')), `${chain.root} ${day}`);
    }
  }
  assert.equal(rows, 27 * 2 + 37 * 5);
  assert.equal(filterQuotes(onDay(NVDA, '2026-09-18'), 'C').length, 27);
});

test('checkQuoteWindow: for calls, the same verdict as vol.ts on the synthetic chain and on each corruption', () => {
  const q = filterQuotes(onDay(NVDA, '2026-09-25'), 'C');
  const without = (strikes: number[]) => q.filter((o) => !strikes.includes(o.strike));
  const cases: Array<[vol.CboeOption[], [number, number]]> = [
    [q, [222.5, 225]],
    [q, [225, 225]],
    [without([217.5]), [215, 220]],
    [without([217.5, 220]), [215, 222.5]],
    [q.map((o) => (o.strike === 227.5 ? { ...o, delta: 0.16 } : o)), [222.5, 225]],
    [q.map((o) => (o.strike === 225 ? { ...o, bid: 1.25, ask: 1.3 } : o)), [222.5, 225]],
    [q.map((o) => (o.strike === 225 ? { ...o, bid: 1.1, ask: 1.12 } : o)), [225, 227.5]],
    [q, [222.5, 223]],
  ];
  for (const [quotes, bracket] of cases) {
    const v1 = vol.checkQuoteWindow(quotes, bracket);
    const v2 = checkQuoteWindow(quotes, 'C', bracket);
    assert.equal(v2 === null, v1 === null, `bracket ${bracket.join('-')}`);
    if (v1 !== null && v2 !== null) assert.equal(v2.reason, 'quotes-inconsistent');
  }
});

/*//////////////////////////////////////////////////////////////
                               PUTS
//////////////////////////////////////////////////////////////*/

test('puts: a delta in (-1, 0), and the same spread, size and iv limits as calls', () => {
  const put = { type: 'P' as const, strike: 205, bid: 1.26, ask: 1.3, iv: 0.40, delta: -0.2371 };
  assert.equal(isUsableQuote(put), true);
  assert.equal(isUsableQuote({ ...put, delta: 0.2371 }), false, 'a positive put delta is a corrupt row');
  assert.equal(isUsableQuote({ ...put, delta: -1 }), false);
  assert.equal(isUsableQuote({ ...put, delta: 0 }), false);
  assert.equal(isUsableQuote({ ...put, type: 'C' }), false, 'a negative call delta too');
  assert.equal(isUsableQuote({ ...put, bid: 0 }), false);
  assert.equal(isUsableQuote({ ...put, bid: 1, ask: 1.5 }), false, 'wider than 30% of the mid');
  assert.equal(isUsableQuote({ ...put, iv: -0.1 }), false);

  const nvda18 = filterQuotes(onDay(NVDA, '2026-09-18'), 'P');
  assert.equal(nvda18.length, 27);
  assert.ok(nvda18.every((o, i) => o.type === 'P' && (i === 0 || o.strike > nvda18[i - 1]!.strike)));
  const tsla21 = filterQuotes(onDay(TSLA, '2026-09-21'), 'P');
  assert.equal(tsla21.length, 37, 'every trimmed TSLA daily put near the money is usable');
});

test('checkQuoteWindow for puts: clean synthetic quotes; a put vertical, a rising delta, a butterfly or a gap is inconsistent', () => {
  const q = filterQuotes(onDay(TSLA, '2026-09-18'), 'P');
  for (const strike of [340, 350, 357.5, 360, 362.5, 370, 380]) assert.equal(checkQuoteWindow(q, 'P', [strike, strike]), null, `TSLA 18 Sep ${strike}P`);
  const nvda = filterQuotes(onDay(NVDA, '2026-09-25'), 'P');
  assert.equal(checkQuoteWindow(nvda, 'P', [205, 207.5]), null);
  const why = (r: ReturnType<typeof checkQuoteWindow>) => (r === null ? 'ok' : `${r.reason}: ${r.detail.why}`);
  // A lower strike put bid above the next higher strike's ask.
  const higherAsk = q.find((o) => o.strike === 360)!.ask;
  const vertical = q.map((o) => (o.strike === 357.5 ? { ...o, bid: higherAsk + 0.2, ask: higherAsk + 0.24 } : o));
  assert.match(why(checkQuoteWindow(vertical, 'P', [360, 360])), /lower strike put is bid above/);
  // Put quotes rise with the strike: read with the call rule, they are "arbitrage".
  assert.match(why(checkQuoteWindow(q, 'C', [360, 360])), /higher strike call is bid above/);
  // Put deltas fall as the strike rises; one climbing back is corrupt.
  const bump = q.map((o) => (o.strike === 362.5 ? { ...o, delta: -0.01 } : o));
  assert.match(why(checkQuoteWindow(bump, 'P', [360, 360])), /delta rises/);
  // Butterfly: middle bid above the chord of its neighbours' asks.
  const chord = (q.find((o) => o.strike === 357.5)!.ask + q.find((o) => o.strike === 362.5)!.ask) / 2;
  const bulge = q.map((o) => (o.strike === 360 ? { ...o, bid: chord + 0.1, ask: chord + 0.14 } : o));
  assert.match(why(checkQuoteWindow(bulge, 'P', [360, 360])), /convex bound/);
  // Gap: max(2.5, 2.5% of 350 = 8.75) passes 5, refuses 10.
  const holed = (strikes: number[]) => q.filter((o) => !strikes.includes(o.strike));
  assert.equal(checkQuoteWindow(holed([352.5]), 'P', [350, 355]), null);
  assert.match(why(checkQuoteWindow(holed([352.5, 355, 357.5]), 'P', [350, 360])), /too far apart/);
});

/*//////////////////////////////////////////////////////////////
                             THE CHAIN
//////////////////////////////////////////////////////////////*/

test('checkChain: root, both clocks with the session rule, parsed rows; v1 reasons become v2 reasons', () => {
  const settings = { maxAgeS: 345_600 };
  const ok = checkChain(n(NVDA), 'NVDA', NVDA_NOW, settings);
  assert.ok(ok.ok);
  assert.equal(ok.lastTradeUnix, Date.UTC(2026, 8, 14, 19, 59, 59) / 1000);
  assert.equal(ok.timestampUnix, Date.UTC(2026, 8, 15, 5, 45) / 1000);
  const tsla = checkChain(n(TSLA), 'TSLA', TSLA_NOW, settings);
  assert.ok(tsla.ok);
  assert.equal(tsla.lastTradeUnix, Date.UTC(2026, 8, 16, 19, 59, 59) / 1000);

  const reason = (r: ReturnType<typeof checkChain>) => (r.ok ? 'ok' : r.reason);
  assert.equal(reason(checkChain(n(NVDA), 'TSLA', NVDA_NOW, settings)), 'chain-inconsistent', 'another root');
  assert.equal(reason(checkChain(n(NVDA), 'NVDA', NVDA_NOW + 5 * 86_400, settings)), 'chain-stale');
  // Thursday 04:30 ET needs Wednesday's close: Monday's file is stale well inside four days.
  assert.equal(reason(checkChain(n(NVDA), 'NVDA', Date.UTC(2026, 8, 17, 8, 30) / 1000, settings)), 'chain-stale');
  assert.equal(reason(checkChain(n({ ...NVDA, lastTradeTime: 'garbage' }), 'NVDA', NVDA_NOW, settings)), 'chain-inconsistent');
  assert.equal(reason(checkChain(n(NVDA), 'NVDA', Date.UTC(2026, 8, 15, 4, 0) / 1000, settings)), 'chain-inconsistent', 'a file from the future');
  const drifted = checkChain(n({ ...NVDA, skippedRows: 400, firstSkip: 'delta: invalid_type' }), 'NVDA', NVDA_NOW, settings);
  assert.equal(!drifted.ok && drifted.reason, 'chain-inconsistent');
  assert.equal(!drifted.ok && drifted.detail.firstSkip, 'delta: invalid_type');
  assert.equal(reason(checkChain(n({ ...NVDA, skippedRows: 3 }), 'NVDA', NVDA_NOW, settings)), 'ok', 'a few bad rows are noise');
});

/*//////////////////////////////////////////////////////////////
                              CACHE
//////////////////////////////////////////////////////////////*/

const URL_NVDA = 'https://cdn.cboe.com/api/global/delayed_quotes/options/NVDA.json';
const URL_TSLA = 'https://cdn.cboe.com/api/global/delayed_quotes/options/TSLA.json';

test('ChainCache: one download per ticker per five minutes, failures included, shared by concurrent callers', async () => {
  let clock = 1_000_000;
  const calls: Array<{ url: string; timeoutMs: number; maxBytes: number }> = [];
  let failNext = false;
  let release: (() => void) | null = null;
  const cache = new ChainCache({
    nowMs: () => clock,
    fetchChain: async (url, options) => {
      calls.push({ url, ...options });
      if (release === null) await new Promise<void>((r) => (release = r));
      if (failNext) throw new vol.VolFetchError('timeout', 'no complete response within 10000 ms');
      return url.startsWith(URL_NVDA) ? NVDA : TSLA;
    },
  });
  assert.equal(PRICING_MIN_REFETCH_MS, 300_000);

  // Two concurrent asks, one download.
  const a = cache.get('NVDA', URL_NVDA);
  const b = cache.get('NVDA', URL_NVDA);
  await new Promise((r) => setImmediate(r));
  release!();
  const [ea, eb] = await Promise.all([a, b]);
  assert.equal(calls.length, 1);
  assert.equal(ea, eb);
  assert.ok(holds(ea, NVDA));
  assert.equal(ea.chain?.clocks.receivedAt, 1_000, 'received when the download completed');
  assert.deepEqual(calls[0], { url: URL_NVDA, timeoutMs: 10_000, maxBytes: DEFAULT_CHAIN_MAX_BYTES });

  // Inside the floor: reused. Another ticker is its own entry.
  clock += PRICING_MIN_REFETCH_MS - 1;
  assert.equal((await cache.get('NVDA', URL_NVDA)).chain, ea.chain, 'the same cached chain, not a refreshed copy');
  assert.equal(calls.length, 1);
  assert.ok(holds(await cache.get('TSLA', URL_TSLA), TSLA));
  assert.equal(calls.length, 2);

  // At the floor: downloaded again, and this time it fails; the last good chain stays, the failure is reused for a minute.
  clock += 1;
  failNext = true;
  const failed = await cache.get('NVDA', URL_NVDA);
  assert.equal(failed.chain, ea.chain, 'the last good chain, its receivedAt included: a failure refreshes no clock');
  assert.equal(failed.error, 'timeout: no complete response within 10000 ms');
  assert.equal(calls.length, 3);
  clock += 59_999;
  assert.equal((await cache.get('NVDA', URL_NVDA)).error, failed.error);
  assert.equal(calls.length, 3, 'no retry storm inside the failure retry');
  // A changed URL is not the cached answer.
  failNext = false;
  assert.ok(holds(await cache.get('NVDA', `${URL_NVDA}?v=2`), NVDA));
  assert.equal(calls.length, 4);
  assert.deepEqual([...cache.snapshot().keys()].sort(), ['NVDA', 'TSLA']);
});

test('ChainCache over the injected fetch: the v1 byte cap and redirect rule still refuse, as chain entries', async () => {
  const through = (fetchImpl: typeof fetch, maxBytes?: number) =>
    new ChainCache({ maxBytes, fetchChain: (url, options) => vol.fetchCboeChain(url, { ...options, fetchImpl }) });
  const ok = await through(async () => new Response(TSLA_RAW)).get('TSLA', URL_TSLA);
  assert.equal(ok.chain?.rows.length, 370);
  const small = await through(async () => new Response(TSLA_RAW), Buffer.byteLength(TSLA_RAW) - 1).get('TSLA', URL_TSLA);
  assert.match(small.error ?? '', /^oversize/);
  const offHost = await through(async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/TSLA.json' } })).get('TSLA', URL_TSLA);
  assert.match(offHost.error ?? '', /^redirect/);
  const html = await through(async () => new Response('<html>Access denied</html>')).get('TSLA', URL_TSLA);
  assert.match(html.error ?? '', /^bad-json/);
});

test('ChainCache: one failed refetch keeps serving the last good chain (its own clocks judge it) and is retried after a minute, backing off', async () => {
  let clock = 1_000_000;
  let calls = 0;
  let fail = false;
  const cache = new ChainCache({
    nowMs: () => clock,
    fetchChain: async () => {
      calls += 1;
      if (fail) throw new vol.VolFetchError('http-status', 'HTTP 503');
      return NVDA;
    },
  });
  const first = await cache.get('NVDA', URL_NVDA);
  assert.ok(holds(first, NVDA));
  clock += PRICING_MIN_REFETCH_MS;
  fail = true;
  const failed = await cache.get('NVDA', URL_NVDA);
  assert.equal(failed.chain, first.chain, 'the 10:00 chain is still served after the 10:05 refetch failed');
  assert.equal(failed.chain?.clocks.receivedAt, 1_000, 'and still says it was received at 10:00');
  assert.equal(failed.error, 'http-status: HTTP 503');
  assert.equal(calls, 2);
  clock += 59_999;
  await cache.get('NVDA', URL_NVDA);
  assert.equal(calls, 2, 'not before a minute');
  clock += 1;
  await cache.get('NVDA', URL_NVDA);
  assert.equal(calls, 3, 'retried after a minute');
  clock += 60_000;
  await cache.get('NVDA', URL_NVDA);
  assert.equal(calls, 3, 'a second failure backs off to two minutes');
  fail = false;
  clock += 60_000;
  const back = await cache.get('NVDA', URL_NVDA);
  assert.equal(calls, 4);
  assert.ok(holds(back, NVDA));
  assert.equal(back.error, null);
  assert.equal(back.chain?.clocks.receivedAt, Math.floor(clock / 1000), 'a successful refetch advances receivedAt only');
  assert.equal(back.chain?.clocks.publishedAt, first.chain?.clocks.publishedAt, 'the file time is the file\'s');
  assert.equal(back.chain?.underlying.observedAt, first.chain?.underlying.observedAt, 'and the last trade is the file\'s');
});

test('warmChains: every ticker once, one after another, through the given loader', async () => {
  const order: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const results = await warmChains(['NVDA', 'SPCX'], async (ticker) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    order.push(ticker);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    return { ok: true };
  });
  assert.deepEqual(order, ['NVDA', 'SPCX'], 'each ticker exactly once, in registry order');
  assert.equal(maxInFlight, 1, 'sequential: a boot must not burst the free feed');
  assert.deepEqual(results, [
    { ticker: 'NVDA', ok: true, reason: null },
    { ticker: 'SPCX', ok: true, reason: null },
  ]);
});

test('warmChains never rejects: a refusal and a throw are results, and the next ticker still warms', async () => {
  const seen: string[] = [];
  const results = await warmChains(['NVDA', 'SPCX', 'TSLA'], async (ticker) => {
    seen.push(ticker);
    if (ticker === 'NVDA') return { ok: false, reason: 'chain-unavailable' };
    if (ticker === 'SPCX') throw new Error('socket hang up');
    return { ok: true };
  });
  assert.deepEqual(seen, ['NVDA', 'SPCX', 'TSLA']);
  assert.deepEqual(results, [
    { ticker: 'NVDA', ok: false, reason: 'chain-unavailable' },
    { ticker: 'SPCX', ok: false, reason: 'socket hang up' },
    { ticker: 'TSLA', ok: true, reason: null },
  ]);
});

test('a warmed chain is the cached one: the first real read after warm-up downloads nothing', async () => {
  let calls = 0;
  const clock = 1_000_000;
  const cache = new ChainCache({ fetchChain: async () => { calls += 1; return NVDA; }, nowMs: () => clock });
  await warmChains(['NVDA'], async (ticker) => {
    const entry = await cache.get(ticker, URL_NVDA);
    return entry.error === null ? { ok: true } : { ok: false, reason: entry.error };
  });
  assert.equal(calls, 1, 'the warm-up downloaded once');
  const first = await cache.get('NVDA', URL_NVDA);
  assert.equal(calls, 1, 'and the first read reuses it inside the refetch floor');
  assert.ok(holds(first, NVDA));
});

/** startPricingService with every download recorded and refused, and its warm-up knob as given. */
// The service boots on Massive (the default; production refuses Cboe), so the recording seam is the
// provider, with a synthetic key. warmChains itself is provider-neutral.
// Bound to 127.0.0.1, the address every read below uses; the test after the next one says why.
async function bootRecording(warmUp: string | undefined) {
  const fetched: string[] = [];
  const running = await startPricingService({
    env: { RH_RPC: 'http://127.0.0.1:9', PRICING_PORT: '0', KEEPER_LOG_LEVEL: 'silent', MASSIVE_API_KEY: 'SYNTHETIC0000000000000000000000000', ...(warmUp === undefined ? {} : { PRICING_CHAIN_WARM_UP: warmUp }) },
    hostname: '127.0.0.1',
    spotReader: async () => { throw new Error('no spot in tests'); },
    provider: {
      descriptor: MASSIVE_PROVIDER,
      fetch: async (source) => {
        fetched.push(source.url);
        throw new Error('network: offline in tests');
      },
    },
  });
  return { running, fetched };
}

test('startPricingService: PRICING_CHAIN_WARM_UP=1 downloads every registry market once with no /fair; unset downloads nothing', async () => {
  const on = await bootRecording('1');
  try {
    const markets = (await (await fetch(`http://127.0.0.1:${on.running.port}/health`)).json()) as { markets: number };
    for (let i = 0; i < 200 && on.fetched.length < markets.markets; i += 1) await new Promise((r) => setTimeout(r, 5));
    assert.equal(on.fetched.length, markets.markets, 'one download per market');
    assert.equal(new Set(on.fetched).size, on.fetched.length, 'each market once');
    assert.ok(on.fetched.every((u) => u.startsWith('https://cdn.cboe.com/')), 'through the service\'s own chain path');
  } finally {
    await on.running.close();
  }
  for (const knob of [undefined, '0']) {
    const off = await bootRecording(knob);
    try {
      await fetch(`http://127.0.0.1:${off.running.port}/health`);
      await new Promise((r) => setTimeout(r, 50));
      assert.deepEqual(off.fetched, [], `PRICING_CHAIN_WARM_UP=${knob ?? 'unset'}: no download before a /fair asks`);
    } finally {
      await off.running.close();
    }
  }
});

/** Binds 127.0.0.1:`port` and lets go at once; rejects (EADDRINUSE) when something already holds it there. As runtime.test.ts. */
function bindAndRelease(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve()));
  });
}

// Why the /health read above failed under full-suite load with "Unexpected end of JSON input". On macOS a
// no-host (`::`) listener does not own its port on 127.0.0.1: another process can hold the same port there (the port-0
// counter even hands a no-host bind a port already held on 127.0.0.1), and a read of 127.0.0.1 then reaches that other
// listener, which answered an empty body. A 127.0.0.1 bind owns the port there, which is why bootRecording passes one.
// Proven on the booted port itself, one extra port for a few milliseconds. The first version held 30
// ports just ahead of the box-wide port-0 counter, where other processes' no-host binds could be handed them.
test('bootRecording: its port is the pricing service\'s on 127.0.0.1, so no other listener can take it there and answer /health', async () => {
  // Positive control, macOS (where the hazard was measured, 20 of 20 on this box): a no-host listener DOES share its
  // port with a later 127.0.0.1 bind, so the refusal asserted below is the 127.0.0.1 bind's doing, not the OS's.
  if (process.platform === 'darwin') {
    const noHost = createServer();
    await new Promise<void>((resolve, reject) => {
      noHost.once('error', reject);
      noHost.listen(0, () => resolve());
    });
    try {
      await bindAndRelease((noHost.address() as AddressInfo).port);
    } finally {
      await new Promise((done) => noHost.close(done));
    }
  }
  const boot = await bootRecording(undefined);
  try {
    await assert.rejects(bindAndRelease(boot.running.port), /EADDRINUSE/, 'another listener could bind 127.0.0.1 on the pricing port');
    const body = await (await fetch(`http://127.0.0.1:${boot.running.port}/health`)).text();
    assert.match(body, /"service":"callhouse-pricing"/, `port ${boot.running.port}: /health was answered by another listener: ${JSON.stringify(body)}`);
  } finally {
    await boot.running.close();
  }
});
