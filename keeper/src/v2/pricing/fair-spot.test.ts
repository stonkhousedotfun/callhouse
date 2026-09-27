/**
 * fair(): two token spots and a live forward (fair.ts TWO SPOTS AND A LIVE FORWARD).
 *
 * Pinned on the synthetic NVDA chain served by a fake real-time provider, an injected Chainlink round
 * (212.21) and an injected v3 pool whose TWAP is placed where each test needs it:
 *   - a CALL is priced at the higher of the Chainlink and pool spots, a PUT at the lower, so the price
 *     is never below the Chainlink-only price (the pool can only make an ask dearer);
 *   - a pool more than maxPoolChainlinkDivergenceBps from Chainlink refuses as `source-disagreement`;
 *   - an unusable pool refuses while poolRequired is on, and falls back to Chainlink alone when off;
 *   - with fresh option quotes the equity side of the spot gate is the parity forward, not the provider's
 *     delayed underlying; with stale quotes it falls back to the underlying and says so.
 * No network.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Address } from 'viem';
import { syntheticNvdaChain } from '../../fixtures/synthetic-chains.js';
import { cboeToNormalized } from './cboe.js';
import type { NormalizedChain } from './chain.js';
import { FAKE_LISTED_PROVIDER, createFakeProvider, fakeListedChain } from './fake-provider.js';
import { PricingService, conservativeSpot, type FairOutcome, type FairQuote, type FairRequest, type PricingSettings } from './fair.js';
import type { PricingMarket } from './markets.js';
import { quoteAtTick, type PoolObservation, type PoolReader } from './pool-spot.js';
import { createPricingApp } from './server.js';
import type { FeedRound } from './spot.js';

/*//////////////////////////////////////////////////////////////
                              FIXTURES
//////////////////////////////////////////////////////////////*/

/** 04:30 New York the morning after the synthetic chain's session. */
const NOW_MS = Date.UTC(2026, 8, 15, 8, 30);
const NOW = NOW_MS / 1000;
const closeOf = (day: number) => Date.UTC(2026, 8, day, 20) / 1000;

const NVDA_FEED: Address = '0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15';
const ASSET: Address = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC';
const POOL: Address = '0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3';
const USDG: Address = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
/** Chainlink: 212.21 per token. */
const ROUND: FeedRound = { roundId: 18_446_744_073_709_552_249n, answer: 21_221_000_000n, updatedAt: 1_789_416_000n, decimals: 8 };
const CHAINLINK_USDG6 = 212_210_000n;

const NVDA = cboeToNormalized(syntheticNvdaChain(), NOW_MS);
/** The synthetic chain as a real-time provider states it: every quote stamped `quoteAt`. */
function realTime(quoteAt: number | null, underlying: number | null = NVDA.underlying.price): NormalizedChain {
  const listed = fakeListedChain(NVDA, { quoteObservedAt: quoteAt });
  return { ...listed, underlying: { ...listed.underlying, price: underlying }, rows: listed.rows.map((r) => ({ ...r, quote: r.quote === null ? null : { ...r.quote, observedAt: quoteAt } })) };
}

const withPool: PricingMarket = {
  ticker: 'NVDA',
  feed: NVDA_FEED,
  cboe: { root: 'NVDA', url: 'https://cdn.cboe.com/api/global/delayed_quotes/options/NVDA.json' },
  token: { chainId: 4663, address: ASSET, uiMultiplier: null },
  pool: { address: POOL, minLiquidity: 10n ** 18n, usdg: USDG },
};
const { pool: _pool, ...withoutPool } = withPool;

/** The tick whose USDG-as-token0 quote is nearest `usd` per token, and that quote. */
function tickFor(usd: number): { tick: number; usdg6: bigint } {
  const tick = Math.round(Math.log(1e12 / usd) / Math.log(1.0001));
  return { tick, usdg6: quoteAtTick(tick, true, 18) };
}

/** A pool reader serving a constant TWAP at `usd`, with harmonic liquidity `liquidity`. */
function poolAt(usd: number, liquidity = 10n ** 20n): PoolReader & { observed: number[] } {
  const { tick } = tickFor(usd);
  const observed: number[] = [];
  return {
    observed,
    meta: async () => ({ token0: USDG, token1: ASSET, assetDecimals: 18 }),
    observe: async (_pool, windowS): Promise<PoolObservation> => {
      observed.push(windowS);
      return { tickCumulatives: [0n, BigInt(tick) * BigInt(windowS)], secondsPerLiquidityCumulativeX128s: [0n, (BigInt(windowS) << 128n) / liquidity] };
    },
  };
}

function service(options: { market?: PricingMarket; poolReader?: PoolReader; chain?: NormalizedChain; settings?: Partial<PricingSettings> } = {}): PricingService {
  return new PricingService({
    markets: new Map([['NVDA', options.market ?? withPool]]),
    nowMs: () => NOW_MS,
    spotReader: async () => ROUND,
    chains: { provider: createFakeProvider(FAKE_LISTED_PROVIDER, { NVDA: options.chain ?? realTime(NOW - 5) }) },
    ...(options.poolReader === undefined ? {} : { poolReader: options.poolReader }),
    ...(options.settings === undefined ? {} : { settings: options.settings }),
  });
}

const request = (strike: number, type: 'call' | 'put'): FairRequest => ({ ticker: 'NVDA', strikeUsdg6: BigInt(strike) * 1_000_000n, expiry: closeOf(18), type });

function priced(outcome: FairOutcome): FairQuote {
  assert.ok(outcome.ok, outcome.ok ? '' : `${outcome.reason} ${JSON.stringify(outcome.detail)}`);
  return outcome;
}

/** The Chainlink-only price: the same service with no pool in the registry. */
async function chainlinkOnly(req: FairRequest): Promise<FairQuote> {
  return priced(await service({ market: withoutPool }).fair(req));
}

const ABOVE = 213.0; // ~37 bps over Chainlink
const BELOW = 211.4; // ~38 bps under

/*//////////////////////////////////////////////////////////////
                         THE CONSERVATIVE RULE
//////////////////////////////////////////////////////////////*/

test('conservativeSpot: a call takes the higher spot, a put the lower, and no pool means Chainlink', () => {
  assert.deepEqual(conservativeSpot('call', 100n, 101n), { spotUsdg6: 101n, pricedWith: 'pool' });
  assert.deepEqual(conservativeSpot('call', 100n, 99n), { spotUsdg6: 100n, pricedWith: 'chainlink' });
  assert.deepEqual(conservativeSpot('put', 100n, 99n), { spotUsdg6: 99n, pricedWith: 'pool' });
  assert.deepEqual(conservativeSpot('put', 100n, 101n), { spotUsdg6: 100n, pricedWith: 'chainlink' });
  assert.deepEqual(conservativeSpot('call', 100n, null), { spotUsdg6: 100n, pricedWith: 'chainlink' });
  assert.deepEqual(conservativeSpot('put', 100n, 100n), { spotUsdg6: 100n, pricedWith: 'chainlink' }, 'a tie stays on the anchor');
});

test('call uses the higher spot: a pool above Chainlink prices the call at the pool, dearer than Chainlink alone', async () => {
  const req = request(220, 'call');
  const q = priced(await service({ poolReader: poolAt(ABOVE) }).fair(req));
  assert.equal(q.provenance.spotInputs?.pricedWith, 'pool');
  assert.equal(q.spotUsdg6, tickFor(ABOVE).usdg6);
  assert.ok(q.fairUsdg6 > (await chainlinkOnly(req)).fairUsdg6, 'dearer than the Chainlink-only price');
});

test('call uses the higher spot: a pool below Chainlink leaves the call on Chainlink', async () => {
  const req = request(220, 'call');
  const q = priced(await service({ poolReader: poolAt(BELOW) }).fair(req));
  assert.equal(q.provenance.spotInputs?.pricedWith, 'chainlink');
  assert.equal(q.spotUsdg6, CHAINLINK_USDG6);
  assert.equal(q.fairUsdg6, (await chainlinkOnly(req)).fairUsdg6);
});

test('put uses the lower spot: a pool below Chainlink prices the put at the pool, dearer than Chainlink alone', async () => {
  const req = request(205, 'put');
  const q = priced(await service({ poolReader: poolAt(BELOW) }).fair(req));
  assert.equal(q.provenance.spotInputs?.pricedWith, 'pool');
  assert.equal(q.spotUsdg6, tickFor(BELOW).usdg6);
  assert.ok(q.fairUsdg6 > (await chainlinkOnly(req)).fairUsdg6, 'dearer than the Chainlink-only price');
});

test('put uses the lower spot: a pool above Chainlink leaves the put on Chainlink', async () => {
  const req = request(205, 'put');
  const q = priced(await service({ poolReader: poolAt(ABOVE) }).fair(req));
  assert.equal(q.provenance.spotInputs?.pricedWith, 'chainlink');
  assert.equal(q.fairUsdg6, (await chainlinkOnly(req)).fairUsdg6);
});

test('never cheaper than the Chainlink-only price, whichever side of Chainlink the pool sits', async () => {
  for (const at of [210.0, BELOW, 212.21, ABOVE, 214.5]) {
    for (const req of [request(215, 'call'), request(220, 'call'), request(205, 'put'), request(210, 'put')]) {
      const q = priced(await service({ poolReader: poolAt(at) }).fair(req));
      const base = await chainlinkOnly(req);
      assert.ok(q.fairUsdg6 >= base.fairUsdg6, `${req.type} ${req.strikeUsdg6} with the pool at ${at}: ${q.fairUsdg6} < ${base.fairUsdg6}`);
    }
  }
});

/*//////////////////////////////////////////////////////////////
                    DIVERGENCE AND AN UNUSABLE POOL
//////////////////////////////////////////////////////////////*/

test('a pool more than maxPoolChainlinkDivergenceBps from Chainlink refuses as source-disagreement, on both sides', async () => {
  for (const at of [212.21 * 1.02, 212.21 * 0.98]) {
    for (const type of ['call', 'put'] as const) {
      const out = await service({ poolReader: poolAt(at) }).fair(request(215, type));
      assert.ok(!out.ok);
      assert.equal(out.reason, 'source-disagreement', `${type} at ${at}`);
      assert.equal(out.detail.maxPoolChainlinkDivergenceBps, '150');
      assert.equal(out.detail.pool, POOL);
    }
  }
  // Inside the bound it prices; a tighter configured bound refuses the same pool.
  const inside = poolAt(212.21 * 1.014);
  assert.ok((await service({ poolReader: inside }).fair(request(215, 'call'))).ok);
  const tight = await service({ poolReader: poolAt(212.21 * 1.014), settings: { maxPoolChainlinkDivergenceBps: 100 } }).fair(request(215, 'call'));
  assert.ok(!tight.ok);
  assert.equal(tight.reason, 'source-disagreement');
});

test('an unusable pool refuses while poolRequired is on: below its floor, a failed read, no reader', async () => {
  const thin = await service({ poolReader: poolAt(ABOVE, 10n ** 17n) }).fair(request(215, 'call'));
  assert.ok(!thin.ok);
  assert.equal(thin.reason, 'spot-unavailable');
  assert.equal(thin.detail.source, 'pool');
  assert.equal(thin.detail.code, 'pool-thin');
  const failing: PoolReader = { meta: async () => ({ token0: USDG, token1: ASSET, assetDecimals: 18 }), observe: async () => { throw new Error('execution reverted: OLD'); } };
  const failed = await service({ poolReader: failing }).fair(request(215, 'call'));
  assert.ok(!failed.ok);
  assert.equal(failed.detail.source, 'pool');
  assert.match(failed.detail.error ?? '', /OLD/);
  const none = await service({}).fair(request(215, 'call'));
  assert.ok(!none.ok, 'a registry pool with no reader is not silently skipped');
  assert.equal(none.detail.source, 'pool');
});

test('poolRequired off: an unusable pool falls back to Chainlink alone and provenance says why', async () => {
  const req = request(220, 'call');
  const q = priced(await service({ poolReader: poolAt(ABOVE, 10n ** 17n), settings: { poolRequired: false } }).fair(req));
  assert.equal(q.provenance.spotInputs?.pricedWith, 'chainlink');
  assert.equal(q.provenance.spotInputs?.pool?.spotUsdg6, null);
  assert.match(q.provenance.spotInputs?.pool?.unusable ?? '', /floor/);
  assert.equal(q.fairUsdg6, (await chainlinkOnly(req)).fairUsdg6);
});

test('the pool is read over the configured TWAP window and cached like the feed', async () => {
  const reader = poolAt(ABOVE);
  const svc = service({ poolReader: reader, settings: { poolTwapS: 45 } });
  priced(await svc.fair(request(215, 'call')));
  priced(await svc.fair(request(220, 'call')));
  assert.deepEqual(reader.observed, [45], 'one read inside spotTtlMs, over 45 s');
});

/*//////////////////////////////////////////////////////////////
                       THE PARITY FORWARD
//////////////////////////////////////////////////////////////*/

test('fresh quotes: the spot gate reads the parity forward, so a stale delayed underlying no longer refuses', async () => {
  // The provider's underlying at 205 is 3.4% under the token spot: over the 300 bps gate.
  const delayed = 205;
  const fresh = priced(await service({ market: withoutPool, chain: realTime(NOW - 5, delayed) }).fair(request(220, 'call')));
  const inputs = fresh.provenance.spotInputs!;
  assert.equal(inputs.equity.source, 'parity-forward');
  assert.equal(inputs.equity.fallbackWhy, null);
  assert.ok(inputs.equity.pairs >= 2);
  assert.ok(Math.abs((inputs.equity.price ?? 0) - 211.4) < 1e-6, `${inputs.equity.price}`);
  assert.ok(inputs.equityDivergenceBps < 300);
});

test('fallback: stale quotes leave the gate on the provider underlying, which refuses the same stale price', async () => {
  const out = await service({ market: withoutPool, chain: realTime(NOW - 3_600, 205) }).fair(request(220, 'call'));
  assert.ok(!out.ok);
  assert.equal(out.reason, 'spot-divergence');
  assert.equal(out.detail.equitySource, 'provider-underlying');
  // With the provider's own (good) underlying the fallback prices, and provenance names the fallback.
  const ok = priced(await service({ market: withoutPool, chain: realTime(NOW - 3_600) }).fair(request(220, 'call')));
  assert.equal(ok.provenance.spotInputs?.equity.source, 'provider-underlying');
  assert.match(ok.provenance.spotInputs?.equity.fallbackWhy ?? '', /fewer than/);
});

test('/health-facing inputs: the latest per ticker, with the side\'s choice', async () => {
  const svc = service({ poolReader: poolAt(ABOVE) });
  priced(await svc.fair(request(205, 'put')));
  assert.equal(svc.spotInputs().get('NVDA')?.pricedWith, 'chainlink');
  priced(await svc.fair(request(220, 'call')));
  const last = svc.spotInputs().get('NVDA')!;
  assert.equal(last.pricedWith, 'pool');
  assert.equal(last.pool?.spotUsdg6, tickFor(ABOVE).usdg6);
  assert.ok((last.pool?.divergenceBps ?? 0) > 30 && (last.pool?.divergenceBps ?? 0) < 45);
});

test('GET /health: the pool and forward limits under settings, and each ticker\'s latest spot inputs under spots', async () => {
  const svc = service({ poolReader: poolAt(ABOVE) });
  priced(await svc.fair(request(220, 'call')));
  const res = await createPricingApp(svc).request('/health');
  assert.equal(res.status, 200);
  const body = (await res.json()) as { settings: Record<string, unknown>; spots: Record<string, Record<string, unknown>> };
  assert.equal(body.settings.poolTwapS, 90);
  assert.equal(body.settings.maxPoolChainlinkDivergenceBps, 150);
  assert.equal(body.settings.poolRequired, true);
  assert.equal(body.settings.forwardMaxQuoteAgeS, 120);
  const nvda = body.spots.NVDA!;
  assert.equal(nvda.forwardSource, 'parity-forward');
  assert.equal(nvda.pricedWith, 'pool');
  assert.deepEqual(nvda.chainlink, { raw: '212210000', decimals: 6, formatted: '212.21' });
  const pool = nvda.pool as Record<string, unknown>;
  assert.equal(pool.address, POOL);
  assert.equal((pool.spot as { raw: string }).raw, tickFor(ABOVE).usdg6.toString());
  assert.equal(pool.windowS, 90);
  assert.equal(typeof pool.divergenceBps, 'number');
  assert.equal(pool.unusable, null);
});
