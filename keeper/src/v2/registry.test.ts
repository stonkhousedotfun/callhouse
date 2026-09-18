/**
 * The v2 registry loader against today's registry and three fixtures.
 *
 * WHY THIS FILE EXISTS: every v2 bot reads its markets and addresses from ops/markets/tier1.json,
 * whose `v2` blocks record the live deployment. Pinned here: that today's file loads with
 * the deployment addresses and §3 defaults; that §3's block as written parses; that the resolution
 * order is SPEC_DEFAULTS ← registry defaults ← market overrides, key by key; and that a present but
 * malformed block refuses to load with every problem listed under the market's ticker.
 *
 * Fixtures (src/v2/fixtures/): registry-no-v2.json (before O2-01), registry-v2-unset.json (§3's block
 * verbatim, every address null), registry-v2.json (a deployed block, partial defaults, overrides).
 * DELIBERATELY ABSENT: any RPC.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { getAddress } from 'viem';
import {
  INTERFACE_VERSION,
  MINT_FEE_CEIL_PPM,
  SPEC_DEFAULTS,
  V2_CONTRACT_NAMES,
  V2RegistryError,
  applyOverrides,
  loadV2Registry,
  marketByTicker,
  marketByUnderlying,
  parseV2Registry,
  v2Markets,
  type MarketParams,
} from './registry.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const TIER1 = fileURLToPath(new URL('../../../ops/markets/tier1.json', import.meta.url));
const fixture = (name: string) => join(FIXTURES, name);
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> & { markets: Array<Record<string, unknown>>; v2?: Record<string, unknown> };

/** Parse `json` and return the V2RegistryError it must throw. */
function refusal(json: unknown): V2RegistryError {
  try {
    parseV2Registry(json);
  } catch (error) {
    assert.ok(error instanceof V2RegistryError, `expected V2RegistryError, got ${String(error)}`);
    return error;
  }
  assert.fail('the registry was accepted');
}

/*//////////////////////////////////////////////////////////////
                         ABSENT v2 BLOCKS
//////////////////////////////////////////////////////////////*/

// The production registry records the dev-origin live deployment and NVDA canary.
test('today\'s ops/markets/tier1.json loads the live v2 deployment and NVDA market', () => {
  const registry = loadV2Registry(TIER1);
  assert.equal(registry.path, TIER1);
  assert.equal(registry.hasV2Block, true);
  assert.equal(registry.interfaceVersion, INTERFACE_VERSION);
  assert.equal(registry.deployBlock, 65_780_341n);
  for (const name of V2_CONTRACT_NAMES) assert.notEqual(registry.contracts[name], null, name);
  for (const name of ['chainlink', 'univ3', 'dataStreams'] as const) assert.notEqual(registry.sources[name], null, name);
  assert.notEqual(registry.fees, null);
  assert.notEqual(registry.uniswapV3, null);
  assert.deepEqual(registry.defaults, SPEC_DEFAULTS);
  assert.equal(registry.chainId, 4663);
  assert.equal(registry.usdg, '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168');
  assert.ok(registry.markets.length >= 35);
  assert.ok(registry.markets.every((m) => m.v2 !== null));
  assert.equal(v2Markets(registry, ['planned']).length, registry.markets.length - 1);
  assert.deepEqual(v2Markets(registry, ['live', 'paused']).map((m) => m.ticker), ['NVDA']);
  const nvda = marketByTicker(registry, 'NVDA');
  assert.equal(nvda?.underlying, '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC');
  assert.equal(nvda?.cboe?.root, 'NVDA');
  // The feeds print on a 0.5 % move or a 24 h heartbeat: a 1 h spot age made spot() revert for 2-100 % of each
  // session. 25 h (heartbeat + 1 h) left no stale session second on any of the 35 feeds (ops/deploy.md §15.13).
  assert.equal(SPEC_DEFAULTS.spotMaxAgeS, 90_000);
  for (const m of registry.markets) assert.equal(m.v2?.params.spotMaxAgeS, 90_000, `${m.ticker} spotMaxAgeS`);
  // INTERFACE_VERSION 7: with premiumFeeBps 0 the writer fee is collateral rent, so every launch market has to
  // carry a rate of its own (DECISIONS-2026-09-17 §11: a market at 0 ppm charges its writers nothing).
  assert.equal(registry.fees?.premiumFeeBps, 0);
  assert.equal(registry.vault?.maxDailyOutflow, 2_500_000_000n);
  for (const m of registry.markets) {
    const ppm = m.v2?.mintFeePpm;
    assert.ok(typeof ppm === 'number' && ppm > 0 && ppm <= MINT_FEE_CEIL_PPM, `${m.ticker} mintFeePpm ${ppm}`);
  }
});

test('registry-no-v2.json: the same, on the trimmed fixture', () => {
  const registry = loadV2Registry(fixture('registry-no-v2.json'));
  assert.equal(registry.hasV2Block, false);
  assert.deepEqual(registry.markets.map((m) => m.ticker), ['AAPL', 'NVDA', 'SGOV', 'TSLA']);
  assert.equal(marketByTicker(registry, 'SGOV')?.feed, '0xa0DF4ee0fFf975306345875E3548Fcc519577A11');
});

/*//////////////////////////////////////////////////////////////
                         §3 AS WRITTEN
//////////////////////////////////////////////////////////////*/

test('registry-v2-unset.json: §3\'s block verbatim parses; addresses null, fees and periphery typed, every market on the defaults', () => {
  const registry = loadV2Registry(fixture('registry-v2-unset.json'));
  assert.equal(registry.hasV2Block, true);
  assert.equal(registry.interfaceVersion, INTERFACE_VERSION);
  assert.equal(registry.deployBlock, null);
  for (const name of V2_CONTRACT_NAMES) assert.equal(registry.contracts[name], null, name);
  // INTERFACE_VERSION 7 (c05): premiumFeeBps is 0 and the writer fee is collateral rent. This fixture leaves the
  // v7 fields out, so the shared rate and the vault block come back null and every market falls back to null too.
  assert.deepEqual(registry.fees, { premiumFeeBps: 0, mintFeePpm: null, resaleFeeBps: 0, takerFeeFlat: 100_000n, takerFeeCapBps: 1000, makerRebateBps: 5000, exerciseFeeBps: 25 });
  assert.equal(registry.vault, null, 'no v2.vault block');
  // §3 writes them lower-case; they come back checksummed.
  assert.deepEqual(registry.uniswapV3, {
    factory: '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA',
    swapRouter02: '0xCaf681a66D020601342297493863E78C959E5cb2',
    quoterV2: '0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7',
  });
  assert.deepEqual(registry.defaults, SPEC_DEFAULTS);

  const nvda = marketByTicker(registry, 'NVDA');
  assert.ok(nvda?.v2);
  assert.equal(nvda.v2.status, 'planned');
  assert.equal(nvda.v2.strikeTick, 1_000_000n);
  assert.equal(nvda.v2.univ3Pool, '0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3');
  assert.equal(nvda.v2.mintFeePpm, null, 'neither the market nor v2.fees names a rate');
  assert.deepEqual(nvda.v2.overrides, {});
  assert.deepEqual(nvda.v2.params, SPEC_DEFAULTS);
  assert.equal(marketByTicker(registry, 'AAPL')?.v2, null, 'a row without a v2 block is not a v2 market');
  assert.deepEqual(v2Markets(registry).map((m) => m.ticker), [], 'nothing is live');
  assert.deepEqual(v2Markets(registry, ['planned']).map((m) => m.ticker), ['NVDA', 'SGOV', 'TSLA']);
});

/*//////////////////////////////////////////////////////////////
                    DEFAULTS AND OVERRIDES
//////////////////////////////////////////////////////////////*/

test('registry-v2.json: addresses checksummed, deploy block a bigint, partial registry defaults merged over §3', () => {
  const registry = loadV2Registry(fixture('registry-v2.json'));
  assert.equal(registry.contracts.clearinghouse, '0x00000000000000000000000000000000C0DE0001');
  assert.equal(registry.contracts.rewardsDistributor, getAddress('0x00000000000000000000000000000000c0de000a'));
  assert.equal(registry.sources.dataStreams, null);
  assert.equal(registry.deployBlock, 65_100_000n);
  // `defaults` names uncorroboratedDelayS and daily.rungs only; everything else is §3's.
  const expected: MarketParams = {
    ...SPEC_DEFAULTS,
    uncorroboratedDelayS: 7200,
    ladder: { weekly: SPEC_DEFAULTS.ladder.weekly, daily: { ...SPEC_DEFAULTS.ladder.daily, rungs: 4 } },
  };
  assert.deepEqual(registry.defaults, expected);
  assert.deepEqual(marketByTicker(registry, 'NVDA')?.v2?.params, expected, 'no overrides: the registry defaults');
});

test('registry-v2.json: a market override beats the registry default, key by key, and leaves its siblings alone', () => {
  const registry = loadV2Registry(fixture('registry-v2.json'));

  const tsla = marketByTicker(registry, 'TSLA')?.v2;
  assert.ok(tsla);
  assert.equal(tsla.strikeTick, 2_500_000n, 'a plain JSON integer is accepted when exact');
  assert.equal(tsla.puts, true);
  assert.equal(tsla.dataStreamsFeedId, `0x${'0b'.repeat(32)}`);
  assert.equal(tsla.params.uncorroboratedDelayS, 1800, 'override 1800 over the registry default 7200');
  assert.deepEqual(tsla.params.ladder.weekly, { ...SPEC_DEFAULTS.ladder.weekly, rungs: 7 });
  assert.equal(tsla.params.ladder.daily.rungs, 4, 'the registry default still applies to what TSLA does not override');
  assert.equal(tsla.params.maxDeviationBps, 150);

  const sgov = marketByTicker(registry, 'SGOV')?.v2;
  assert.ok(sgov);
  assert.equal(sgov.status, 'paused');
  assert.deepEqual(sgov.params.expiriesAhead, { weekly: 2, daily: 0 }, 'no dailies');
  assert.deepEqual(sgov.params.ladder.weekly, { rungs: 5, firstOtmBps: 50, stepBps: 50, cardTargetBps: 100 });

  const nvda = marketByTicker(registry, 'NVDA')?.v2;
  assert.equal(nvda?.univ3MinLiquidity, 10n ** 18n);
  assert.equal(nvda?.registeredAt, 1_790_000_000);
  assert.equal(nvda?.registerTx, `0x${'ab'.repeat(32)}`);

  assert.deepEqual(v2Markets(registry).map((m) => m.ticker), ['NVDA', 'TSLA'], 'live only by default');

  // INTERFACE_VERSION 7 (c05): a market's own rate wins, and a market without one falls back to v2.fees.mintFeePpm,
  // exactly as RegisterMarkets resolves V2_MARKET_<T>_MINT_FEE_PPM over V2_MINT_FEE_PPM.
  assert.equal(registry.fees?.mintFeePpm, 80, 'the shared rate');
  assert.equal(nvda?.mintFeePpm, 80, 'NVDA names its own rate');
  assert.equal(tsla.mintFeePpm, 300, 'TSLA names a different one');
  assert.equal(sgov.mintFeePpm, 80, 'SGOV names none: the shared rate');
  // INTERFACE_VERSION 7 (c21): the MakerVault Limits the deploy sets, all six fields in setLimits order.
  assert.deepEqual(registry.vault, {
    maxSeriesUnits: 10_000n,
    maxTotalNotional: 250_000_000_000n,
    askToleranceBps: 100,
    maxBidBpsOfSpot: 1000,
    maxOrderLifetime: 0,
    maxDailyOutflow: 2_500_000_000n,
  });
  assert.deepEqual(v2Markets(registry, ['live', 'paused']).map((m) => m.ticker), ['NVDA', 'SGOV', 'TSLA']);
  assert.equal(marketByUnderlying(registry, '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec')?.ticker, 'NVDA', 'lower-case lookup');
  assert.equal(marketByUnderlying(registry, '0x0000000000000000000000000000000000000001'), null);
});

test('applyOverrides is pure: no layer returns the base, a layer never mutates it, undefined keys do not erase', () => {
  const base = structuredClone(SPEC_DEFAULTS);
  assert.equal(applyOverrides(base, undefined), base);
  const out = applyOverrides(base, { spotMaxAgeS: 60, ladder: { daily: { stepBps: 300, rungs: undefined } }, expiriesAhead: { weekly: 1 } });
  assert.deepEqual(base, SPEC_DEFAULTS, 'base untouched');
  assert.equal(out.spotMaxAgeS, 60);
  assert.deepEqual(out.ladder.daily, { rungs: 5, firstOtmBps: 100, stepBps: 300, cardTargetBps: 200 });
  assert.deepEqual(out.ladder.weekly, SPEC_DEFAULTS.ladder.weekly);
  assert.deepEqual(out.expiriesAhead, { weekly: 1, daily: 3 });
});

/*//////////////////////////////////////////////////////////////
                           REFUSALS
//////////////////////////////////////////////////////////////*/

test('a malformed v2 block refuses to load, every problem listed under its market\'s ticker', () => {
  const json = readJson(fixture('registry-v2.json'));
  const byTicker = (t: string) => json.markets.find((m) => m.ticker === t) as { v2: Record<string, unknown> };
  byTicker('NVDA').v2.strikeTick = '1000050'; // not a multiple of 100
  byTicker('TSLA').v2.status = 'retired';
  byTicker('TSLA').v2.overrides = { ladders: { weekly: { rungs: 3 } } }; // typo: must not be ignored
  byTicker('SGOV').v2.overrides = { ladder: { weekly: { firstOtm: 50 } } }; // typo one level down
  (json.v2 as { fees: Record<string, unknown> }).fees.exerciseFeeBps = 300; // above EXERCISE_FEE_CEIL_BPS
  (json.v2 as { contracts: Record<string, unknown> }).contracts.orderBook = '0x1234';

  const error = refusal(json);
  const text = error.message;
  assert.match(text, /markets\[1\] \(NVDA\)\.v2\.strikeTick: must be > 0, a multiple of 100/);
  assert.match(text, /markets\[3\] \(TSLA\)\.v2\.status: /);
  assert.match(text, /markets\[3\] \(TSLA\)\.v2\.overrides: Unrecognized key\(s\) in object: 'ladders'/);
  assert.match(text, /markets\[2\] \(SGOV\)\.v2\.overrides\.ladder\.weekly: Unrecognized key\(s\) in object: 'firstOtm'/);
  assert.match(text, /v2\.fees\.exerciseFeeBps: Number must be less than or equal to 200/);
  assert.match(text, /v2\.contracts\.orderBook: not a 20-byte hex address/);
  assert.equal(error.problems.length, 6);
});

// INTERFACE_VERSION 7: the three new bounds. A rate above MINT_FEE_CEIL_PPM is what
// Clearinghouse._checkConfig reverts with CeilingExceeded; a premium fee above the resale fee is the dodge the
// rent replaces; maxDailyOutflow 0 would deploy the vault unable to bid, take or replace upwards.
test('refused: a rent rate above MINT_FEE_CEIL_PPM, a premium fee above the resale fee, a zero outflow cap', () => {
  const overCeiling = readJson(fixture('registry-v2.json'));
  (overCeiling.markets.find((m) => m.ticker === 'NVDA') as { v2: Record<string, unknown> }).v2.mintFeePpm = 5001;
  assert.match(refusal(overCeiling).message, /markets\[1\] \(NVDA\)\.v2\.mintFeePpm: Number must be less than or equal to 5000/);

  const shared = readJson(fixture('registry-v2.json'));
  (shared.v2 as { fees: Record<string, unknown> }).fees.mintFeePpm = 5001;
  assert.match(refusal(shared).message, /v2\.fees\.mintFeePpm: Number must be less than or equal to 5000/);

  const avoidable = readJson(fixture('registry-v2.json'));
  (avoidable.v2 as { fees: Record<string, unknown> }).fees.premiumFeeBps = 500; // resaleFeeBps is 0
  assert.match(refusal(avoidable).message, /v2\.fees: premiumFeeBps is above resaleFeeBps/);

  const frozen = readJson(fixture('registry-v2.json'));
  (frozen.v2 as { vault: Record<string, unknown> }).vault.maxDailyOutflow = '0';
  assert.match(refusal(frozen).message, /v2\.vault\.maxDailyOutflow: must be > 0 and fit uint128/);
});

test('refused: another interface version, a ticker twice, two markets on one underlying, an inexact big integer', () => {
  const versioned = readJson(fixture('registry-v2.json'));
  (versioned.v2 as { interfaceVersion: number }).interfaceVersion = 4;
  assert.match(refusal(versioned).message, /v2\.interfaceVersion: 4, but this keeper implements INTERFACE_VERSION 7/);

  const twice = readJson(fixture('registry-no-v2.json'));
  twice.markets.push({ ...twice.markets[0]!, asset: '0x0000000000000000000000000000000000000abc' });
  assert.match(refusal(twice).message, /markets: AAPL is listed twice/);

  const shared = readJson(fixture('registry-no-v2.json'));
  shared.markets[1] = { ...shared.markets[1]!, asset: shared.markets[0]!.asset };
  assert.match(refusal(shared).message, /markets: NVDA and AAPL share the underlying 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9/);

  const inexact = readJson(fixture('registry-v2.json'));
  (inexact.markets[1]!.v2 as Record<string, unknown>).univ3MinLiquidity = 1e20;
  assert.match(refusal(inexact).message, /univ3MinLiquidity: not a non-negative safe integer: 100000000000000000000 \(write big values as a decimal string\)/);
});

test('ladder and oracle bounds: zero rungs, a 0 card target, a 10-minute veto window and 7 weekly expiries ahead are refused', () => {
  const json = readJson(fixture('registry-v2.json'));
  (json.v2 as Record<string, unknown>).defaults = {
    uncorroboratedDelayS: 600,
    ladder: { weekly: { rungs: 0, cardTargetBps: 0 } },
    expiriesAhead: { weekly: 7 },
  };
  const error = refusal(json);
  assert.match(error.message, /v2\.defaults\.uncorroboratedDelayS: Number must be greater than or equal to 1800/);
  assert.match(error.message, /v2\.defaults\.ladder\.weekly\.rungs: Number must be greater than or equal to 1/);
  assert.match(error.message, /v2\.defaults\.ladder\.weekly\.cardTargetBps: Number must be greater than or equal to 1/);
  assert.match(error.message, /v2\.defaults\.expiriesAhead\.weekly: Number must be less than or equal to 6/);
});

test('an unreadable file is a V2RegistryError naming the path', () => {
  const path = fixture('does-not-exist.json');
  assert.throws(
    () => loadV2Registry(path),
    (error: unknown) => error instanceof V2RegistryError && error.message.startsWith(`cannot read the market registry at ${path}`),
  );
});
