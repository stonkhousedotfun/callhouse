/**
 * pool-spot.ts: the v3 pool TWAP spot is the settlement source's number, to the base unit.
 *
 * The fixture (src/fixtures/univ3-observe-2026-09-23.json) is one block of chain 4663: each launch
 * market's pool `observe([90, 0])` and, at the SAME block, the deployed UniV3TwapSource's own
 * `observeWindow` over the same 90 s. The source is the independent answer: pool-spot.ts must reproduce
 * its price, mean tick and harmonic-mean liquidity exactly. NVDA's pool holds USDG as token0 and SPCX's
 * as token1 with a negative tick, so both branches of the quote and the floor rounding are covered by
 * real replies. Synthetic observations then pin each refusal. The production reader is then driven over a
 * scripted JSON-RPC transport: it ages the head block and runs observe AT that block.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createPublicClient, custom, encodeFunctionResult, numberToHex, type Address } from 'viem';
import {
  DEFAULT_POOL_TWAP_MAX_END_AGE_S,
  MAX_TICK,
  MIN_TICK,
  PoolTwapStaleError,
  poolObserveReader,
  poolSpotFromObservation,
  quoteAtTick,
  sqrtRatioAtTick,
  twapEndAgeS,
  uniswapV3PoolAbi,
  type PoolMeta,
  type PoolObservation,
  type PoolReaderOptions,
  type PricingPool,
} from './pool-spot.js';

interface RecordedMarket {
  asset: Address;
  pool: Address;
  minLiquidity: string;
  observe: { tickCumulatives: [string, string]; secondsPerLiquidityCumulativeX128s: [string, string] };
  token0: Address;
  token1: Address;
  assetDecimals: number;
  sourceConfig: { usdgIsToken0: boolean };
  sourceObserveWindow: { ok: boolean; price: string; meanTick: number; harmonicLiquidity: string };
}

const FIXTURE = JSON.parse(readFileSync(new URL('../../fixtures/univ3-observe-2026-09-23.json', import.meta.url), 'utf8')) as {
  blockNumber: string;
  windowS: number;
  usdg: Address;
  markets: Record<'NVDA' | 'SPCX', RecordedMarket>;
};

const observationOf = (m: RecordedMarket): PoolObservation => ({
  tickCumulatives: [BigInt(m.observe.tickCumulatives[0]), BigInt(m.observe.tickCumulatives[1])],
  secondsPerLiquidityCumulativeX128s: [BigInt(m.observe.secondsPerLiquidityCumulativeX128s[0]), BigInt(m.observe.secondsPerLiquidityCumulativeX128s[1])],
});
const metaOf = (m: RecordedMarket): PoolMeta => ({ token0: m.token0, token1: m.token1, assetDecimals: m.assetDecimals });
const poolOf = (m: RecordedMarket, minLiquidity = BigInt(m.minLiquidity)): PricingPool => ({ address: m.pool, minLiquidity, usdg: FIXTURE.usdg });

test('TickMath: the Q64.96 endpoints and tick 0 are Uniswap v3-core\'s constants', () => {
  assert.equal(sqrtRatioAtTick(0), 1n << 96n);
  assert.equal(sqrtRatioAtTick(MIN_TICK), 4295128739n, 'TickMath.MIN_SQRT_RATIO');
  assert.equal(sqrtRatioAtTick(MAX_TICK), 1461446703485210103287273052203988822378723970342n, 'TickMath.MAX_SQRT_RATIO');
  assert.throws(() => sqrtRatioAtTick(MAX_TICK + 1), RangeError);
  assert.throws(() => sqrtRatioAtTick(MIN_TICK - 1), RangeError);
});

test('quoteAtTick: 1.0001^tick is token1 per token0, so the two token orders invert each other', () => {
  // Tick 0 is a 1:1 ratio of base units: one whole 18-dp token is 10^18 USDG base units either way.
  assert.equal(quoteAtTick(0, true, 18), 10n ** 18n);
  assert.equal(quoteAtTick(0, false, 18), 10n ** 18n);
  // NVDA-shaped: USDG token0, ~228 USDG per token. Float check to 1 bp; the exact value is pinned against the source below.
  const nvda = Number(quoteAtTick(222_008, true, 18)) / 1e6;
  assert.ok(Math.abs(nvda / (1e12 / 1.0001 ** 222_008) - 1) < 1e-4, `${nvda}`);
  // SPCX-shaped: USDG token1.
  const spcx = Number(quoteAtTick(-225_948, false, 18)) / 1e6;
  assert.ok(Math.abs(spcx / (1e12 * 1.0001 ** -225_948) - 1) < 1e-4, `${spcx}`);
});

for (const ticker of ['NVDA', 'SPCX'] as const) {
  test(`recorded observe(): ${ticker}'s TWAP equals UniV3TwapSource.observeWindow at the same block, to the base unit`, () => {
    const m = FIXTURE.markets[ticker];
    const got = poolSpotFromObservation({ observation: observationOf(m), windowS: FIXTURE.windowS, meta: metaOf(m), asset: m.asset, pool: poolOf(m) });
    assert.ok(!('reason' in got), JSON.stringify('reason' in got ? got : ''));
    assert.equal(m.sourceObserveWindow.ok, true);
    assert.equal(got.spotUsdg6, BigInt(m.sourceObserveWindow.price), 'price');
    assert.equal(got.meanTick, m.sourceObserveWindow.meanTick, 'mean tick');
    assert.equal(got.harmonicLiquidity, BigInt(m.sourceObserveWindow.harmonicLiquidity), 'harmonic-mean liquidity');
    assert.equal(got.usdgIsToken0, m.sourceConfig.usdgIsToken0, 'token order read from the pool, as the source read it');
    assert.equal(got.windowS, FIXTURE.windowS);
  });
}

test('mean tick is floored toward negative infinity, not truncated (OracleLibrary.consult)', () => {
  const m = FIXTURE.markets.NVDA;
  // tickDelta = -91 over 90 s: truncation says -1, the floor says -2.
  const observation: PoolObservation = { tickCumulatives: [0n, -91n], secondsPerLiquidityCumulativeX128s: [0n, (90n << 128n) / (10n ** 20n)] };
  const got = poolSpotFromObservation({ observation, windowS: 90, meta: metaOf(m), asset: m.asset, pool: poolOf(m) });
  assert.ok(!('reason' in got));
  assert.equal(got.meanTick, -2);
  const exact: PoolObservation = { tickCumulatives: [0n, -180n], secondsPerLiquidityCumulativeX128s: observation.secondsPerLiquidityCumulativeX128s };
  const e = poolSpotFromObservation({ observation: exact, windowS: 90, meta: metaOf(m), asset: m.asset, pool: poolOf(m) });
  assert.ok(!('reason' in e));
  assert.equal(e.meanTick, -2, 'an exact negative quotient is not moved');
});

test('the seconds-per-liquidity delta wraps modulo 2^160, as v3-core accumulates it', () => {
  const m = FIXTURE.markets.NVDA;
  const rec = observationOf(m);
  const delta = rec.secondsPerLiquidityCumulativeX128s[1] - rec.secondsPerLiquidityCumulativeX128s[0];
  const start = (1n << 160n) - 5n;
  const wrapped: PoolObservation = { tickCumulatives: rec.tickCumulatives, secondsPerLiquidityCumulativeX128s: [start, (start + delta) % (1n << 160n)] };
  const a = poolSpotFromObservation({ observation: rec, windowS: 90, meta: metaOf(m), asset: m.asset, pool: poolOf(m) });
  const b = poolSpotFromObservation({ observation: wrapped, windowS: 90, meta: metaOf(m), asset: m.asset, pool: poolOf(m) });
  assert.ok(!('reason' in a) && !('reason' in b));
  assert.equal(b.harmonicLiquidity, a.harmonicLiquidity);
});

test('refusals: a thin pool, a zero liquidity delta, a pool that is not the market\'s USDG pair, a window under 30 s', () => {
  const m = FIXTURE.markets.NVDA;
  const base = { observation: observationOf(m), windowS: FIXTURE.windowS, meta: metaOf(m), asset: m.asset };
  const harmonic = BigInt(m.sourceObserveWindow.harmonicLiquidity);

  const atFloor = poolSpotFromObservation({ ...base, pool: poolOf(m, harmonic) });
  assert.ok(!('reason' in atFloor), 'the floor is inclusive, as the source\'s `<`');
  const thin = poolSpotFromObservation({ ...base, pool: poolOf(m, harmonic + 1n) });
  assert.ok('reason' in thin);
  assert.equal(thin.reason, 'spot-unavailable');
  assert.equal(thin.detail.code, 'pool-thin');
  assert.equal(thin.detail.source, 'pool');

  const flat = poolSpotFromObservation({ ...base, observation: { tickCumulatives: base.observation.tickCumulatives, secondsPerLiquidityCumulativeX128s: [7n, 7n] }, pool: poolOf(m) });
  assert.ok('reason' in flat);
  assert.match(flat.detail.why ?? '', /not a pool reply/);

  const other: Address = '0x000000000000000000000000000000000000dEaD';
  const wrongPair = poolSpotFromObservation({ ...base, meta: { ...metaOf(m), token0: other }, pool: poolOf(m) });
  assert.ok('reason' in wrongPair);
  assert.match(wrongPair.detail.why ?? '', /not the USDG pair/);
  const wrongAsset = poolSpotFromObservation({ ...base, asset: FIXTURE.markets.SPCX.asset, pool: poolOf(m) });
  assert.ok('reason' in wrongAsset, 'the NVDA pool is not SPCX\'s');

  for (const windowS of [29, 3_601, 1.5]) {
    const bad = poolSpotFromObservation({ ...base, windowS, pool: poolOf(m) });
    assert.ok('reason' in bad, `window ${windowS}`);
    assert.match(bad.detail.why ?? '', /window/);
  }
  // The same mean tick and liquidity over 30 s: cumulatives scaled to the window.
  const thirty: PoolObservation = { tickCumulatives: [0n, 222_008n * 30n], secondsPerLiquidityCumulativeX128s: [0n, (30n << 128n) / harmonic] };
  const ok30 = poolSpotFromObservation({ ...base, windowS: 30, observation: thirty, pool: poolOf(m) });
  assert.ok(!('reason' in ok30), 'a 30 s window is allowed');
  assert.equal(ok30.spotUsdg6, BigInt(m.sourceObserveWindow.price));
});

/*//////////////////////////////////////////////////////////////
              THE READER: THE TWAP'S END BLOCK AGE
//////////////////////////////////////////////////////////////*/

const NOW_MS = 1_790_150_000_000;
const HEAD_NUMBER = 4_242_424n;

/** The production reader over a scripted transport: `latest` is a block stamped `headAgeS` before NOW_MS, and every
 *  eth_call answers the fixture's NVDA observe reply. Records every request. */
function scriptedReader(headAgeS: number, options: PoolReaderOptions = {}) {
  const m = FIXTURE.markets.NVDA;
  const calls: Array<{ method: string; params: readonly unknown[] }> = [];
  const client = createPublicClient({
    transport: custom({
      async request({ method, params }: { method: string; params?: unknown }) {
        calls.push({ method, params: Array.isArray(params) ? params : [] });
        if (method === 'eth_getBlockByNumber') {
          return { number: numberToHex(HEAD_NUMBER), timestamp: numberToHex(NOW_MS / 1000 - headAgeS), hash: `0x${'11'.repeat(32)}`, transactions: [] };
        }
        if (method === 'eth_call') {
          const o = observationOf(m);
          return encodeFunctionResult({ abi: uniswapV3PoolAbi, functionName: 'observe', result: [[...o.tickCumulatives], [...o.secondsPerLiquidityCumulativeX128s]] });
        }
        throw new Error(`unscripted ${method}`);
      },
    }),
  });
  return { reader: poolObserveReader(client, { nowMs: () => NOW_MS, ...options }), calls, pool: m.pool };
}

test('the TWAP end block bound defaults to the keeper\'s RPC lag alert threshold, KEEPER_RPC_LAG_ALERT_MS, in seconds', () => {
  const config = readFileSync(new URL('../../config.ts', import.meta.url), 'utf8');
  const lag = /KEEPER_RPC_LAG_ALERT_MS:[^\n]*\.default\(([\d_]+)\)/.exec(config);
  assert.ok(lag !== null, 'KEEPER_RPC_LAG_ALERT_MS and its default are declared in config.ts');
  assert.equal(DEFAULT_POOL_TWAP_MAX_END_AGE_S, Number(lag[1]!.replace(/_/g, '')) / 1000);
  assert.equal(twapEndAgeS(BigInt(NOW_MS / 1000 - 7), NOW_MS), 7);
  assert.equal(twapEndAgeS(BigInt(NOW_MS / 1000 + 9), NOW_MS), 0, 'a head stamped ahead of the wall clock is age 0, not negative');
});

test('a fresh TWAP end block passes, and observe runs AT the block whose age was checked, not at latest', async () => {
  const { reader, calls, pool } = scriptedReader(12);
  const got = await reader.observe(pool, 90);
  assert.deepEqual(got, observationOf(FIXTURE.markets.NVDA));
  assert.deepEqual(calls.map((c) => c.method), ['eth_getBlockByNumber', 'eth_call']);
  assert.equal(calls[0]!.params[0], 'latest');
  assert.equal(calls[1]!.params[1], numberToHex(HEAD_NUMBER), 'the observe call is pinned to the aged head, so a lagging node cannot answer it with older state');
});

test('a TWAP end block older than the bound is refused by name, before observe is sent', async () => {
  const { reader, calls, pool } = scriptedReader(DEFAULT_POOL_TWAP_MAX_END_AGE_S + 1);
  await assert.rejects(reader.observe(pool, 90), (error: unknown) => {
    assert.ok(error instanceof PoolTwapStaleError);
    assert.equal(error.code, 'pool-twap-stale');
    assert.equal(error.blockNumber, HEAD_NUMBER);
    assert.equal(error.ageS, DEFAULT_POOL_TWAP_MAX_END_AGE_S + 1);
    assert.match(error.message, /^pool-twap-stale: /, 'fair.ts reports the first line of the message');
    return true;
  });
  assert.deepEqual(calls.map((c) => c.method), ['eth_getBlockByNumber'], 'no observe is read from a stale block');

  const atBound = scriptedReader(DEFAULT_POOL_TWAP_MAX_END_AGE_S);
  await atBound.reader.observe(atBound.pool, 90);
  assert.equal(atBound.calls.length, 2, 'the bound is inclusive, as the rpc_lag alert\'s `>`');
});

test('the bound is configurable, and a bound that is not a whole number of seconds >= 1 is refused', async () => {
  const tight = scriptedReader(61, { maxEndAgeS: 60 });
  await assert.rejects(tight.reader.observe(tight.pool, 90), PoolTwapStaleError);
  const ok = scriptedReader(60, { maxEndAgeS: 60 });
  await ok.reader.observe(ok.pool, 90);
  const loose = scriptedReader(DEFAULT_POOL_TWAP_MAX_END_AGE_S + 1, { maxEndAgeS: 3_600 });
  await loose.reader.observe(loose.pool, 90);
  for (const maxEndAgeS of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => scriptedReader(0, { maxEndAgeS }), RangeError, String(maxEndAgeS));
  }
});
