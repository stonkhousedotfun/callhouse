/**
 * The pricing service over HTTP: its response shapes, the registry it boots from, and the
 * entry K2-01 wires to V2_MODE=pricing.
 *
 * WHY THIS FILE EXISTS: the indexer (X2-05), the MM bot and the pricer read this service by its
 * JSON, not its types. The exact body for one synthetic contract is pinned here so a consumer
 * can build against it; so are the error shapes (a null with a reason is a 200, a caller's mistake
 * is a 400/404), the surface's share-space units, and a boot on the real registry that answers on a
 * socket.
 *
 * Handler tests go through `app.request` with an injected feed and chain. DELIBERATELY ABSENT: any
 * real RPC or Cboe download; the boot test binds port 0 on loopback with both seams injected.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Address } from 'viem';
import { VolFetchError, type CboeChain } from '../../vol.js';
import { syntheticNvdaChain } from '../../fixtures/synthetic-chains.js';
import { PricingService } from './fair.js';
import { DEFAULT_PRICING_PORT, KEEPER_PACKAGE_DIR, loadPricingEnv, startPricingService } from './main.js';
import { loadPricingRegistry, parsePricingRegistry, type PricingMarket } from './markets.js';
import { createPricingApp, parseFairQuery } from './server.js';
import type { FeedRound, SpotReader } from './spot.js';

const NVDA = syntheticNvdaChain();
const NVDA_NOW_MS = Date.UTC(2026, 8, 15, 8, 30);
const cboeUrl = (root: string) => `https://cdn.cboe.com/api/global/delayed_quotes/options/${root}.json`;
const NVDA_FEED: Address = '0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15';
const TSLA_FEED: Address = '0x4A1166a659A55625345e9515b32adECea5547C38';
const NVDA_ROUND: FeedRound = { roundId: 18_446_744_073_709_552_249n, answer: 21_221_000_000n, updatedAt: 1_789_416_000n, decimals: 8 };
const REGISTRY_PATH = join(KEEPER_PACKAGE_DIR, '..', 'ops', 'markets', 'tier1.json');

const MARKETS: ReadonlyMap<string, PricingMarket> = new Map([
  ['NVDA', { ticker: 'NVDA', feed: NVDA_FEED, cboe: { root: 'NVDA', url: cboeUrl('NVDA') } }],
  ['TSLA', { ticker: 'TSLA', feed: TSLA_FEED, cboe: { root: 'TSLA', url: cboeUrl('TSLA') } }],
  ['SGOV', { ticker: 'SGOV', feed: '0xa0DF4ee0fFf975306345875E3548Fcc519577A11', cboe: null }],
]);

function app(options: { nowMs?: number; chains?: Record<string, CboeChain | Error>; spotReader?: SpotReader } = {}) {
  const chains: Record<string, CboeChain | Error> = { [cboeUrl('NVDA')]: NVDA, ...options.chains };
  const service = new PricingService({
    markets: MARKETS,
    nowMs: () => options.nowMs ?? NVDA_NOW_MS,
    spotReader: options.spotReader ?? (async () => NVDA_ROUND),
    chains: {
      fetchChain: async (url) => {
        const c = chains[url] ?? new VolFetchError('http-status', 'HTTP 403');
        if (c instanceof Error) throw c;
        return c;
      },
    },
  });
  return createPricingApp(service);
}

async function get(a: ReturnType<typeof app>, path: string): Promise<{ status: number; body: Record<string, any> }> {
  const res = await a.request(path);
  assert.match(res.headers.get('content-type') ?? '', /application\/json/);
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

/*//////////////////////////////////////////////////////////////
                               /fair
//////////////////////////////////////////////////////////////*/

test('GET /fair: the exact body for the NVDA 18 Sep 220 call (source cboe), the contract X2-05 builds on', async () => {
  const res = await app().request('/fair?ticker=NVDA&strike=220000000&expiry=1789761600&type=call');
  assert.equal(res.status, 200);
  assert.equal(
    await res.text(),
    '{"fair":{"raw":"1772765","decimals":6,"formatted":"1.772765"},"iv":0.430071,"delta":0.261653,"source":"cboe","spot":{"raw":"212210000","decimals":6,"formatted":"212.21"},"asOf":1789415999}',
  );
});

test('GET /fair: the §5 example prices from the model; a put; case-insensitive ticker and type', async () => {
  const a = app();
  const model = await get(a, '/fair?ticker=NVDA&strike=231000000&expiry=1790020800&type=call');
  assert.equal(model.status, 200);
  assert.deepEqual(model.body, {
    fair: { raw: '491645', decimals: 6, formatted: '0.491645' },
    iv: 0.430184,
    delta: 0.08537,
    source: 'model',
    spot: { raw: '212210000', decimals: 6, formatted: '212.21' },
    asOf: 1789415999,
  });
  const put = await get(a, '/fair?ticker=nvda&strike=205000000&expiry=1789761600&type=PUT');
  assert.equal(put.status, 200);
  assert.ok(Number(put.body.fair.raw) > 0);
  assert.ok(put.body.delta < 0 && put.body.delta > -1);
  assert.equal(put.body.source, 'cboe');
});

test('GET /fair: bad market data is a 200 with fair null and the reason; bad parameters are 400; an unknown ticker 404', async () => {
  const stale = await get(app({ nowMs: Date.UTC(2026, 8, 19, 16) }), '/fair?ticker=NVDA&strike=220000000&expiry=1790366400&type=call');
  assert.equal(stale.status, 200);
  assert.equal(stale.body.fair, null);
  assert.equal(stale.body.reason, 'chain-stale');
  assert.equal(typeof stale.body.detail, 'object');
  const down = await get(app({ chains: { [cboeUrl('NVDA')]: new VolFetchError('timeout', 'no complete response within 10000 ms') } }), '/fair?ticker=NVDA&strike=220000000&expiry=1789761600&type=call');
  assert.deepEqual(down, { status: 200, body: { fair: null, reason: 'chain-unavailable', detail: { error: 'timeout: no complete response within 10000 ms' } } });
  const expired = await get(app(), '/fair?ticker=NVDA&strike=220000000&expiry=1789000000&type=call');
  assert.equal(expired.body.reason, 'expired');

  const missing = await get(app(), '/fair');
  assert.equal(missing.status, 400);
  assert.equal(missing.body.fair, null);
  assert.equal(missing.body.reason, 'bad-request');
  assert.deepEqual(Object.keys(missing.body.detail).sort(), ['expiry', 'strike', 'ticker', 'type'], 'every problem at once');
  for (const bad of ['strike=231.5', 'strike=0', 'strike=-1', 'strike=0x10', 'strike=10000000000000001', 'expiry=soon', 'type=straddle', 'ticker=N%20VDA']) {
    const query = new URLSearchParams({ ticker: 'NVDA', strike: '220000000', expiry: '1789761600', type: 'call', ...Object.fromEntries([bad.split('=') as [string, string]]) });
    query.set(bad.split('=')[0]!, decodeURIComponent(bad.split('=')[1]!));
    const r = await get(app(), `/fair?${query}`);
    assert.equal(r.status, 400, bad);
    assert.deepEqual(Object.keys(r.body.detail), [bad.split('=')[0]], bad);
  }
  const unknown = await get(app(), '/fair?ticker=AAPL&strike=220000000&expiry=1789761600&type=call');
  assert.deepEqual(unknown, { status: 404, body: { fair: null, reason: 'unknown-ticker', detail: { ticker: 'AAPL' } } });
});

test('parseFairQuery: strikes are integers of base units, expiries unix seconds', () => {
  assert.deepEqual(parseFairQuery({ ticker: ' tsla ', strike: '355000000', expiry: '1790020800', type: 'Call' }), {
    ok: true,
    ticker: 'TSLA',
    strikeUsdg6: 355_000_000n,
    expiry: 1_790_020_800,
    type: 'call',
  });
  assert.equal(parseFairQuery({ ticker: 'NVDA', strike: '1000000000000000', expiry: '1', type: 'put' }).ok, true, '10^15 is the cap, inclusive');
  assert.equal(parseFairQuery({ ticker: 'NVDA', strike: '1000000000000001', expiry: '1', type: 'put' }).ok, false);
});

test('GET /fair: an exception that is not market data is a 500 with fair null, never a crash', async () => {
  const exploding: SpotReader = () => {
    throw new TypeError('a bug');
  };
  const r = await get(app({ spotReader: exploding }), '/fair?ticker=NVDA&strike=220000000&expiry=1789761600&type=call');
  assert.deepEqual(r, { status: 500, body: { fair: null, reason: 'internal-error' } });
});

/*//////////////////////////////////////////////////////////////
                         /surface and /health
//////////////////////////////////////////////////////////////*/

test('GET /surface/:ticker: per expiry, per listed strike, in Cboe share space', async () => {
  const { status, body } = await get(app(), '/surface/NVDA');
  assert.equal(status, 200);
  assert.equal(body.ticker, 'NVDA');
  assert.equal(body.root, 'NVDA');
  assert.equal(body.asOf, 1789415999);
  assert.equal(body.chainTimestamp, NVDA.timestamp);
  assert.deepEqual(body.spot, { raw: '212350000', decimals: 6, formatted: '212.35' }, 'the synthetic chain spot, not the token spot');
  assert.deepEqual(body.expiries.map((e: any) => [e.expiry, e.day, e.status, e.forward.raw, e.strikes.length]), [
    [1789761600, '2026-09-18', 'ok', '211400000', 27],
    [1790366400, '2026-09-25', 'ok', '211400000', 27],
  ]);
  assert.deepEqual(body.expiries[0].strikes.find((s: any) => s.strike.raw === '220000000'), {
    strike: { raw: '220000000', decimals: 6, formatted: '220' },
    iv: 0.430071,
    callMid: { raw: '1570000', decimals: 6, formatted: '1.57' },
    putMid: { raw: '10170000', decimals: 6, formatted: '10.17' },
    delta: 0.239214,
  });
  const strikes = body.expiries[1].strikes.map((s: any) => Number(s.strike.raw));
  assert.deepEqual(strikes, [...strikes].sort((x, y) => x - y));

  assert.deepEqual(await get(app(), '/surface/SGOV'), { status: 200, body: { expiries: null, reason: 'chain-unavailable', detail: { why: 'the registry has no Cboe chain for this market', ticker: 'SGOV' } } });
  assert.equal((await get(app(), '/surface/AAPL')).status, 404);
  assert.equal((await get(app(), '/surface/NV!DA')).status, 400);
});

test('GET /health: 200 while serving; degraded once a chain download has failed, with the error per ticker', async () => {
  const a = app();
  const fresh = await get(a, '/health');
  assert.equal(fresh.status, 200);
  assert.equal(fresh.body.status, 'ok');
  assert.equal(fresh.body.service, 'callhouse-pricing');
  assert.equal(fresh.body.markets, 3);
  assert.equal(fresh.body.marketsWithChain, 2);
  assert.deepEqual(fresh.body.chains, {});
  await a.request('/fair?ticker=NVDA&strike=220000000&expiry=1789761600&type=call');
  await a.request('/fair?ticker=TSLA&strike=360000000&expiry=1790020800&type=call');
  const after = await get(a, '/health');
  assert.equal(after.status, 200);
  assert.equal(after.body.status, 'degraded');
  assert.equal(after.body.chains.NVDA.ok, true);
  assert.equal(after.body.chains.NVDA.lastTradeTime, '2026-09-14T15:59:59');
  assert.equal(after.body.chains.NVDA.options, NVDA.options.length);
  assert.deepEqual({ ...after.body.chains.TSLA, fetchedAt: undefined }, { ok: false, usable: 'chain-unavailable', fetchedAt: undefined, error: 'http-status: HTTP 403', chainTimestamp: null, lastTradeTime: null, options: null });
  const index = await get(a, '/');
  assert.deepEqual(index.body.markets, ['NVDA', 'TSLA', 'SGOV']);
});

/*//////////////////////////////////////////////////////////////
                         REGISTRY AND BOOT
//////////////////////////////////////////////////////////////*/

test('the registry: every tier-1 market with its feed and Cboe chain, strict about what it cannot trust', () => {
  const registry = loadPricingRegistry(REGISTRY_PATH);
  assert.equal(registry.markets.size, 35);
  assert.deepEqual(registry.markets.get('NVDA'), { ticker: 'NVDA', feed: NVDA_FEED, cboe: { root: 'NVDA', url: cboeUrl('NVDA') } });
  assert.deepEqual(registry.markets.get('TSLA')?.cboe, { root: 'TSLA', url: cboeUrl('TSLA') });
  assert.equal(registry.maxPriceAgeS, 345_600);
  assert.equal(registry.maxSpotDivergenceBps, 300);

  const doc = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) as { markets: Array<Record<string, unknown>> };
  const withMarkets = (markets: Array<Record<string, unknown>>) => ({ ...doc, markets });
  const nvda = doc.markets.find((m) => m.ticker === 'NVDA')!;
  assert.equal(parsePricingRegistry(withMarkets([{ ...nvda, cboe: null }])).markets.get('NVDA')?.cboe, null, 'no chain is kept, and refused per request');
  assert.equal(parsePricingRegistry(withMarkets([{ ...nvda, feed: nvda.feed!.toString().toLowerCase() }])).markets.get('NVDA')?.feed, NVDA_FEED, 'checksummed');
  assert.throws(() => parsePricingRegistry(withMarkets([nvda, nvda])), /NVDA twice/);
  assert.throws(() => parsePricingRegistry(withMarkets([{ ...nvda, feed: '0x1234' }])), /markets\.0\.feed/);
  assert.throws(() => parsePricingRegistry(withMarkets([{ ...nvda, cboe: { root: 'NVDA', url: 'http://cdn.cboe.com/NVDA.json' } }])), /markets\.0\.cboe\.url: not an https URL/);
  assert.throws(() => parsePricingRegistry(withMarkets([])), /markets/);
  assert.throws(() => loadPricingRegistry('/nonexistent/tier1.json'), /cannot read the market registry/);
});

test('loadPricingEnv: defaults, the registry path resolved against the keeper package, every problem listed', () => {
  const env = loadPricingEnv({ RH_RPC: 'https://rpc.mainnet.chain.robinhood.com' });
  assert.equal(env.port, DEFAULT_PRICING_PORT);
  assert.equal(DEFAULT_PRICING_PORT, 8790);
  assert.equal(env.registryPath, REGISTRY_PATH);
  assert.deepEqual(env.rpcUrls, ['https://rpc.mainnet.chain.robinhood.com']);
  assert.equal(env.logLevel, 'info');
  const custom = loadPricingEnv({ RH_RPC: 'http://127.0.0.1:8545', RH_RPC_2: 'https://backup.example', PRICING_PORT: '9000', V2_REGISTRY_PATH: 'ops/x.json', KEEPER_LOG_LEVEL: 'warn' });
  assert.equal(custom.port, 9000);
  assert.equal(custom.registryPath, join(KEEPER_PACKAGE_DIR, 'ops', 'x.json'));
  assert.deepEqual(custom.rpcUrls, ['http://127.0.0.1:8545', 'https://backup.example']);
  assert.equal(loadPricingEnv({ RH_RPC: 'http://x', V2_REGISTRY_PATH: '/abs/tier1.json' }).registryPath, '/abs/tier1.json');
  assert.equal(loadPricingEnv({ RH_RPC: 'http://x', PRICING_PORT: '  ' }).port, 8790, 'blank is unset');
  assert.throws(
    () => loadPricingEnv({ PRICING_PORT: '70000', RH_RPC_2: 'ftp://nope' }),
    (error: unknown) => error instanceof Error && /RH_RPC:/.test(error.message) && /PRICING_PORT/.test(error.message) && /RH_RPC_2/.test(error.message) && !/ftp:\/\/nope/.test(error.message),
  );
});

test('startPricingService: boots on the real registry with injected seams and answers on a socket', async () => {
  const fetched: string[] = [];
  const running = await startPricingService({
    env: { RH_RPC: 'http://127.0.0.1:9', PRICING_PORT: '0', KEEPER_LOG_LEVEL: 'silent' },
    spotReader: async () => NVDA_ROUND,
    fetchChain: async (url) => {
      fetched.push(url);
      throw new VolFetchError('network', 'offline in tests');
    },
  });
  try {
    assert.ok(running.port > 0);
    const health = await fetch(`http://127.0.0.1:${running.port}/health`);
    assert.equal(health.status, 200);
    const body = (await health.json()) as { markets: number; marketsWithChain: number; settings: { maxChainAgeS: number } };
    assert.equal(body.markets, 35);
    assert.equal(body.marketsWithChain, 35);
    assert.equal(body.settings.maxChainAgeS, 345_600, "the registry's defaults");
    const fair = await fetch(`http://127.0.0.1:${running.port}/fair?ticker=AMD&strike=500000000&expiry=4102444800&type=put`);
    assert.deepEqual(await fair.json(), { fair: null, reason: 'chain-unavailable', detail: { error: 'network: offline in tests' } });
    assert.deepEqual(fetched, [cboeUrl('AMD')]);
  } finally {
    await running.close();
  }
});

test('GET /health: degraded when a downloaded chain no longer passes its own clocks (stale market data), with the reason per ticker', async () => {
  // Five days after the fixture's last trade: the download succeeded, but every /fair refuses chain-stale.
  const later = app({ nowMs: NVDA_NOW_MS + 5 * 86_400_000 });
  const fair = await get(later, '/fair?ticker=NVDA&strike=231000000&expiry=1790625600&type=call');
  assert.equal(fair.body.reason, 'chain-stale');
  const health = await get(later, '/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.status, 'degraded');
  assert.equal(health.body.chains.NVDA.ok, true, 'the download itself worked');
  assert.equal(health.body.chains.NVDA.usable, 'chain-stale');
  const fresh = app();
  await fresh.request('/fair?ticker=NVDA&strike=220000000&expiry=1789761600&type=call');
  const ok = await get(fresh, '/health');
  assert.equal(ok.body.status, 'ok');
  assert.equal(ok.body.chains.NVDA.usable, 'ok');
});

test('loadPricingEnv: PRICING_NYSE_HOLIDAYS replaces the built-in closure table (a year the code does not know yet); a malformed date is refused', () => {
  assert.equal(loadPricingEnv({ RH_RPC: 'http://x' }).holidays, null, 'unset: the built-in table');
  assert.deepEqual(loadPricingEnv({ RH_RPC: 'http://x', PRICING_NYSE_HOLIDAYS: '2029-01-15, 2029-02-19' }).holidays, ['2029-01-15', '2029-02-19']);
  assert.throws(() => loadPricingEnv({ RH_RPC: 'http://x', PRICING_NYSE_HOLIDAYS: '2029-13-40' }), /PRICING_NYSE_HOLIDAYS/);
});
