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
 *
 * INTERFACE_VERSION 8 pins one more thing, and it is the point of the version gate: THE TWO REAL REGISTRIES
 * ARE TESTED AS A PAIR. `ops/markets/tier1.json` is the v8 file this keeper serves and must load;
 * `ops/markets/v7-legacy.json` is the frozen v7 file the run-off serves and must be REFUSED, by name, with a
 * message that says where it belongs. A keeper that quietly accepted the v7 file would call v7 contracts with
 * v8 selectors and mis-decode rather than fail.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { getAddress } from 'viem';
import {
  INTERFACE_VERSION,
  MAX_ROUTE_FEE_TIER,
  MINT_FEE_CEIL_PPM,
  SPEC_DEFAULTS,
  V2_ADDRESS_NAMES,
  V2_ADDRESS_PATH,
  V2_CONTRACT_NAMES,
  V2_FLYWHEEL_NAMES,
  V2RegistryError,
  V8_ALLOW_RENT_KEY,
  applyOverrides,
  loadV2Registry,
  marketByTicker,
  marketByUnderlying,
  parseV2Registry,
  v2Address,
  v2Markets,
  type MarketParams,
} from './registry.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const TIER1 = fileURLToPath(new URL('../../../ops/markets/tier1.json', import.meta.url));
/** The frozen v7 production registry, kept readable for the run-off and refused by this keeper. */
const V7_LEGACY = fileURLToPath(new URL('../../../ops/markets/v7-legacy.json', import.meta.url));
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

// The production registry as it stands before the v8 deploy write-back: the shape is final, the addresses
// are not. Both halves matter — the shape is what this loader is for, and "not deployed yet" is a fact the
// test states rather than an absence it tolerates silently.
test('today\'s ops/markets/tier1.json loads as an INTERFACE_VERSION 8 registry, before the deploy write-back', () => {
  const registry = loadV2Registry(TIER1);
  assert.equal(registry.path, TIER1);
  assert.equal(registry.hasV2Block, true);
  assert.equal(registry.interfaceVersion, INTERFACE_VERSION);
  assert.notEqual(registry.fees, null);
  assert.notEqual(registry.uniswapV3, null);
  assert.deepEqual(registry.defaults, SPEC_DEFAULTS);
  assert.equal(registry.chainId, 4663);
  assert.equal(registry.usdg, '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168');
  assert.ok(registry.markets.length >= 35);
  assert.ok(registry.markets.every((m) => m.v2 !== null));

  // NOT DEPLOYED YET. Asserted as `null`, never as "falsy": an address that came back `undefined` because a
  // name reached one list and not the other would pass a truthiness check and fail every `=== null` guard
  // downstream. v2.deployBlock is the registry's own statement that a deployment exists.
  assert.equal(registry.deployBlock, null, 'no v8 deployment yet: O8 writes this back');
  for (const name of V2_ADDRESS_NAMES) {
    assert.ok(name in registry.contracts || name in (registry.flywheel ?? {}), `${name} has a home`);
    assert.equal(v2Address(registry, name), null, `${name} (${V2_ADDRESS_PATH[name]})`);
  }
  for (const name of ['chainlink', 'univ3', 'dataStreams'] as const) assert.equal(registry.sources[name], null, name);
  // INTERFACE_VERSION 8: the flywheel is its own block, present and empty, never a v2.contracts key.
  assert.deepEqual(registry.flywheel, { feeSplitter: null, buybackExecutor: null, deployBlock: null });
  assert.ok(!(('feeSplitter' as string) in registry.contracts), 'the flywheel is not a v2.contracts key');

  const planned = v2Markets(registry, ['planned']);
  assert.equal(v2Markets(registry, ['live']).length, 0, 'nothing is live on v8 yet');
  assert.equal(planned.length, registry.markets.length, 'every market is planned until the deploy registers it');
  const nvda = marketByTicker(registry, 'NVDA');
  assert.equal(nvda?.v2?.status, 'planned');
  assert.equal(nvda?.underlying, '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC');
  assert.equal(nvda?.cboe?.root, 'NVDA');
  // The feeds print on a 0.5 % move or a 24 h heartbeat: a 1 h spot age made spot() revert for 2-100 % of each
  // session. 25 h (heartbeat + 1 h) left no stale session second on any of the 35 feeds (ops/deploy.md §15.13).
  assert.equal(SPEC_DEFAULTS.spotMaxAgeS, 90_000);
  for (const m of registry.markets) assert.equal(m.v2?.params.spotMaxAgeS, 90_000, `${m.ticker} spotMaxAgeS`);

  // INTERFACE_VERSION 8 (V3-D6, D17, D18), and the exact inversion of what v7 asserted here: the writer fee IS
  // the premium fee and it is ABOVE the resale fee, and there is no rent anywhere — stated as 0 with allowRent
  // false, not left unsaid.
  assert.equal(registry.fees?.premiumFeeBps, 500);
  assert.equal(registry.fees?.resaleFeeBps, 0);
  assert.ok((registry.fees?.premiumFeeBps ?? 0) > (registry.fees?.resaleFeeBps ?? 0), 'premium above resale');
  assert.equal(registry.fees?.allowRent, false);
  assert.equal(registry.fees?.mintFeePpm, 0);
  assert.equal(registry.vault?.maxDailyOutflow, 2_500_000_000n);
  for (const m of registry.markets) {
    assert.equal(m.v2?.mintFeePpm, 0, `${m.ticker} mintFeePpm`);
    // No payout route is configured before the deploy; a winning call is paid in kind until one is.
    assert.equal(m.v2?.payoutRoute, null, `${m.ticker} payoutRoute`);
  }
  assert.ok(MINT_FEE_CEIL_PPM === 5_000, 'the dial ceiling survives v8 even though the dial is at 0');
});

// THE OTHER HALF OF THE PAIR. The v7 registry still exists and is still correct — for the v7 run-off image.
// Pointing a v8 bot at it is the concrete operator mistake the exact version gate exists to catch, so it is
// tested against the real file rather than a fixture: a fixture cannot go stale in the way the real one can.
test('ops/markets/v7-legacy.json is refused by name, and the message says where it belongs', () => {
  assert.throws(
    () => loadV2Registry(V7_LEGACY),
    (error: unknown) => {
      assert.ok(error instanceof V2RegistryError, `expected V2RegistryError, got ${String(error)}`);
      assert.match(
        error.message,
        new RegExp(`v2\\.interfaceVersion: 7, but this keeper implements INTERFACE_VERSION ${INTERFACE_VERSION}`),
      );
      assert.match(error.message, /v7-legacy\.json is the frozen v7 registry and is read by the v7 run-off image/);
      return true;
    },
  );
  // The file itself is still a v7 registry, so the refusal is about the version and nothing else: if it ever
  // grows a second problem, that is the frozen file being edited, which it must not be.
  const problems = (() => {
    try {
      loadV2Registry(V7_LEGACY);
    } catch (error) {
      return (error as V2RegistryError).problems;
    }
    return [];
  })();
  assert.equal(problems.length, 1, `only the version is wrong with the frozen v7 file:\n${problems.join('\n')}`);
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
  for (const name of V2_FLYWHEEL_NAMES) assert.equal(v2Address(registry, name), null, V2_ADDRESS_PATH[name]);
  // INTERFACE_VERSION 8 (V3-D6, D18): the fee block states the v8 position — a premium fee above the resale
  // fee, and rent explicitly 0 with allowRent false. It is spelled out rather than omitted because a loader
  // that read silence as "no rent" could not tell a v8 registry from a v6 one.
  assert.deepEqual(registry.fees, { premiumFeeBps: 500, mintFeePpm: 0, allowRent: false, resaleFeeBps: 0, takerFeeFlat: 100_000n, takerFeeCapBps: 1000, makerRebateBps: 5000, exerciseFeeBps: 25 });
  assert.deepEqual(registry.flywheel, { feeSplitter: null, buybackExecutor: null, deployBlock: null });
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
  assert.equal(nvda.v2.mintFeePpm, 0, 'the market names no rate of its own: the shared v2.fees.mintFeePpm 0');
  assert.equal(nvda.v2.payoutRoute, null, 'a market with no payoutRoute key is a market with no route');
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
  // INTERFACE_VERSION 8: the manager is a v2.contracts key, the two flywheel addresses are not, and v2Address
  // resolves all three by name without the caller knowing which block each lives in.
  assert.equal(registry.contracts.accessManager, getAddress('0x00000000000000000000000000000000c0de000b'));
  assert.equal(v2Address(registry, 'accessManager'), registry.contracts.accessManager);
  assert.deepEqual(registry.flywheel, {
    feeSplitter: getAddress('0x00000000000000000000000000000000c0de000c'),
    buybackExecutor: getAddress('0x00000000000000000000000000000000c0de000d'),
    deployBlock: 65_099_000n,
  });
  assert.equal(v2Address(registry, 'feeSplitter'), registry.flywheel?.feeSplitter);
  assert.equal(v2Address(registry, 'buybackExecutor'), registry.flywheel?.buybackExecutor);
  assert.deepEqual(
    V2_ADDRESS_NAMES.map((n) => V2_ADDRESS_PATH[n].split('.')[1]),
    V2_ADDRESS_NAMES.map((n) => ((V2_FLYWHEEL_NAMES as readonly string[]).includes(n) ? 'flywheel' : 'contracts')),
    'every name says which block it is read from',
  );
  // The splitter is deployed BEFORE the core, so its block is its own and is lower than v2.deployBlock.
  assert.ok((registry.flywheel?.deployBlock ?? 0n) < (registry.deployBlock ?? 0n), 'the splitter predates the core');
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

  // INTERFACE_VERSION 8: a route is per market and per venue, and it is NOT univ3Pool — NVDA carries both, a
  // v3 route and a (different) v3 settlement pool, which is the pair that would have collided under one key.
  assert.deepEqual(nvda?.payoutRoute, { venue: 'v3', fee: 3000 });
  assert.notEqual(nvda?.univ3Pool, null, 'the settlement TWAP source is a separate field');
  assert.deepEqual(tsla.payoutRoute, { venue: 'v4', fee: 500, tickSpacing: 10, poolId: `0x${'0c'.repeat(32)}` });
  assert.equal(sgov.payoutRoute, null, 'no route: a winning call is paid in Stock Tokens');

  // A market's own rate wins, and a market without one falls back to v2.fees.mintFeePpm, exactly as
  // RegisterMarkets resolves V2_MARKET_<T>_MINT_FEE_PPM over V2_MINT_FEE_PPM. INTERFACE_VERSION 8 launches
  // every market at 0, so this fixture is the one legal way a v8 registry carries rent at all: it says
  // `allowRent: true` out loud. The real registry (rent 0, allowRent false) is asserted above.
  assert.equal(registry.fees?.allowRent, true, 'the fixture opts in, so the rate resolution stays exercised');
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
  assert.equal(error.problems.length, 6, `exactly the six seeded faults:\n${error.problems.join('\n')}`);
});

// The ceiling survives every version: a rate above MINT_FEE_CEIL_PPM is what Clearinghouse._checkConfig
// reverts with CeilingExceeded, and maxDailyOutflow 0 would deploy the vault unable to bid, take or replace
// upwards. Both are bounds on a value, so they live in the schema and fire whatever the version says.
test('refused: a rent rate above MINT_FEE_CEIL_PPM, a zero outflow cap', () => {
  const overCeiling = readJson(fixture('registry-v2.json'));
  (overCeiling.markets.find((m) => m.ticker === 'NVDA') as { v2: Record<string, unknown> }).v2.mintFeePpm = MINT_FEE_CEIL_PPM + 1;
  assert.match(refusal(overCeiling).message, /markets\[1\] \(NVDA\)\.v2\.mintFeePpm: Number must be less than or equal to 5000/);

  const shared = readJson(fixture('registry-v2.json'));
  (shared.v2 as { fees: Record<string, unknown> }).fees.mintFeePpm = MINT_FEE_CEIL_PPM + 1;
  assert.match(refusal(shared).message, /v2\.fees\.mintFeePpm: Number must be less than or equal to 5000/);

  const frozen = readJson(fixture('registry-v2.json'));
  (frozen.v2 as { vault: Record<string, unknown> }).vault.maxDailyOutflow = '0';
  assert.match(refusal(frozen).message, /v2\.vault\.maxDailyOutflow: must be > 0 and fit uint128/);
});

/**
 * INTERFACE_VERSION 8's two fee rules, and both directions of each. They are the EXACT INVERSIONS of v7's, so
 * this is the test that would catch a half-inverted pair — which accepts every registry or none, and is the
 * failure ops/markets/build-markets.mjs warns about in the same words (:793-796).
 *
 * v7 refused `premiumFeeBps > resaleFeeBps` and refused rent 0.
 * v8 refuses `premiumFeeBps <= resaleFeeBps` and refuses rent ≠ 0 without `allowRent: true`.
 */
test('INTERFACE_VERSION 8: the premium fee must be ABOVE the resale fee, which is v7\'s rule inverted', () => {
  // Equal is refused, not just lower: at premium == resale a round trip pays the same as a first sale, so the
  // resale fee is already taxing the market maker rather than the writer.
  const equal = readJson(fixture('registry-v2.json'));
  (equal.v2 as { fees: Record<string, unknown> }).fees.premiumFeeBps = 0; // resaleFeeBps is 0
  assert.match(refusal(equal).message, /v2\.fees\.premiumFeeBps 0 is not above v2\.fees\.resaleFeeBps 0/);
  assert.match(refusal(equal).message, /the writer fee IS the premium fee/);

  const below = readJson(fixture('registry-v2.json'));
  (below.v2 as { fees: Record<string, unknown> }).fees.premiumFeeBps = 100;
  (below.v2 as { fees: Record<string, unknown> }).fees.resaleFeeBps = 200;
  assert.match(refusal(below).message, /v2\.fees\.premiumFeeBps 100 is not above v2\.fees\.resaleFeeBps 200/);

  // The v7 shape — a premium fee AT OR BELOW the resale fee — is exactly what v8 rejects, and the v7 shape
  // that v7 rejected (500 over 0) is what the fixture carries and what tier1.json ships.
  const v8Shape = readJson(fixture('registry-v2.json'));
  assert.equal((v8Shape.v2 as { fees: { premiumFeeBps: number } }).fees.premiumFeeBps, 500);
  assert.equal((v8Shape.v2 as { fees: { resaleFeeBps: number } }).fees.resaleFeeBps, 0);
  assert.doesNotThrow(() => parseV2Registry(v8Shape), 'the v8 shape is the accepted one');
});

test('INTERFACE_VERSION 8: rent must be 0 unless the registry says allowRent, shared and per market', () => {
  // The fixture opts in, so flipping the opt-in alone must refuse BOTH the shared rate and every market that
  // resolves to a non-zero one. Deleting either half of that pair is what this test exists to catch.
  const optedOut = readJson(fixture('registry-v2.json'));
  (optedOut.v2 as { fees: Record<string, unknown> }).fees.allowRent = false;
  const out = refusal(optedOut);
  assert.match(out.message, /v2\.fees\.mintFeePpm is 80, and INTERFACE_VERSION 8 launches every market at 0 rent/);
  assert.match(out.message, /markets\[1\] \(NVDA\)\.v2\.mintFeePpm resolves to 80/);
  assert.match(out.message, /markets\[3\] \(TSLA\)\.v2\.mintFeePpm resolves to 300/);
  assert.match(out.message, new RegExp(`Set ${V8_ALLOW_RENT_KEY.replace(/\./g, '\\.')}: true`));

  // A registry-wide 0 with one stray market at a rate is the case a shared-only check would pass: the
  // per-market value is what gets pinned into every series the market creates.
  const stray = readJson(fixture('registry-v2.json'));
  (stray.v2 as { fees: Record<string, unknown> }).fees.allowRent = false;
  (stray.v2 as { fees: Record<string, unknown> }).fees.mintFeePpm = 0;
  for (const m of stray.markets) {
    const block = m.v2 as Record<string, unknown> | undefined;
    if (block !== undefined) delete block.mintFeePpm;
  }
  ((stray.markets.find((m) => m.ticker === 'TSLA') as { v2: Record<string, unknown> }).v2).mintFeePpm = 1500;
  const strayError = refusal(stray);
  assert.match(strayError.message, /markets\[3\] \(TSLA\)\.v2\.mintFeePpm resolves to 1500/);
  assert.doesNotMatch(strayError.message, /v2\.fees\.mintFeePpm is /, 'the shared rate is fine; only the market is not');

  // SILENCE IS NOT CONSENT. A v8 registry that omits the rate or the opt-in is refused rather than defaulted,
  // because "no rent stated" and "rent 0" are the same bytes to a loader that guesses and different facts to
  // an operator.
  const noRate = readJson(fixture('registry-v2.json'));
  delete (noRate.v2 as { fees: Record<string, unknown> }).fees.mintFeePpm;
  assert.match(refusal(noRate).message, /v2\.fees\.mintFeePpm: missing\. INTERFACE_VERSION 8 states the rent dial explicitly/);

  const noOptIn = readJson(fixture('registry-v2.json'));
  delete (noOptIn.v2 as { fees: Record<string, unknown> }).fees.allowRent;
  assert.match(refusal(noOptIn).message, new RegExp(`${V8_ALLOW_RENT_KEY.replace(/\./g, '\\.')}: missing`));
});

test('INTERFACE_VERSION 8: the flywheel block is strict, and its two addresses are refused out of order', () => {
  // The executor only ever spends the splitter's USDG, so an executor without a splitter is a half-written
  // write-back, not a configuration (ops/markets/build-markets.mjs :824-829).
  const orphanExecutor = readJson(fixture('registry-v2.json'));
  (orphanExecutor.v2 as { flywheel: Record<string, unknown> }).flywheel.feeSplitter = null;
  assert.match(refusal(orphanExecutor).message, /v2\.flywheel\.buybackExecutor is set while v2\.flywheel\.feeSplitter is null/);

  const noBlock = readJson(fixture('registry-v2.json'));
  (noBlock.v2 as { flywheel: Record<string, unknown> }).flywheel.deployBlock = null;
  assert.match(refusal(noBlock).message, /v2\.flywheel\.feeSplitter is set but v2\.flywheel\.deployBlock is null/);

  // Strict, unlike the address containers: a typo in a key that names an address would otherwise read as
  // "not deployed yet" and the bot would run with the address missing and nothing to say about it.
  const typo = readJson(fixture('registry-v2.json'));
  const flywheel = (typo.v2 as { flywheel: Record<string, unknown> }).flywheel;
  flywheel.feeSpliter = flywheel.feeSplitter;
  delete flywheel.feeSplitter;
  assert.match(refusal(typo).message, /v2\.flywheel: Unrecognized key\(s\) in object: 'feeSpliter'/);
});

test('INTERFACE_VERSION 8: a payout route is closed per venue and is not the settlement pool', () => {
  const badVenue = readJson(fixture('registry-v2.json'));
  ((badVenue.markets.find((m) => m.ticker === 'NVDA') as { v2: Record<string, unknown> }).v2).payoutRoute = { venue: 'v2', fee: 3000 };
  assert.match(refusal(badVenue).message, /markets\[1\] \(NVDA\)\.v2\.payoutRoute\.venue/);

  // 0 is refused as hard as a tier above the ceiling: no venue has a zero static fee tier, so a 0 is a field
  // somebody left empty, and on v4 it neighbours the dynamic-fee flag.
  const zeroFee = readJson(fixture('registry-v2.json'));
  ((zeroFee.markets.find((m) => m.ticker === 'NVDA') as { v2: Record<string, unknown> }).v2).payoutRoute = { venue: 'v3', fee: 0 };
  assert.match(refusal(zeroFee).message, /markets\[1\] \(NVDA\)\.v2\.payoutRoute\.fee: Number must be greater than or equal to 1/);

  const overCeil = readJson(fixture('registry-v2.json'));
  ((overCeil.markets.find((m) => m.ticker === 'NVDA') as { v2: Record<string, unknown> }).v2).payoutRoute = { venue: 'v3', fee: MAX_ROUTE_FEE_TIER + 1 };
  assert.match(refusal(overCeil).message, /markets\[1\] \(NVDA\)\.v2\.payoutRoute\.fee: Number must be less than or equal to 10000/);

  // A v4 pool has no address, so the id IS the pin; and a v3 route may not carry v4 keys, because a route that
  // silently ignored tickSpacing would name a different pool than the one it was written for.
  const v4NoId = readJson(fixture('registry-v2.json'));
  ((v4NoId.markets.find((m) => m.ticker === 'TSLA') as { v2: Record<string, unknown> }).v2).payoutRoute = { venue: 'v4', fee: 500, tickSpacing: 10 };
  assert.match(refusal(v4NoId).message, /markets\[3\] \(TSLA\)\.v2\.payoutRoute\.poolId: Required/);

  const v3WithV4Keys = readJson(fixture('registry-v2.json'));
  ((v3WithV4Keys.markets.find((m) => m.ticker === 'NVDA') as { v2: Record<string, unknown> }).v2).payoutRoute = { venue: 'v3', fee: 3000, tickSpacing: 10 };
  assert.match(refusal(v3WithV4Keys).message, /markets\[1\] \(NVDA\)\.v2\.payoutRoute: Unrecognized key\(s\) in object: 'tickSpacing'/);
});

test('refused: another interface version, a ticker twice, two markets on one underlying, an inexact big integer', () => {
  const versioned = readJson(fixture('registry-v2.json'));
  (versioned.v2 as { interfaceVersion: number }).interfaceVersion = 4;
  assert.match(
    refusal(versioned).message,
    new RegExp(`v2\\.interfaceVersion: 4, but this keeper implements INTERFACE_VERSION ${INTERFACE_VERSION}`),
  );
  // A version the keeper does not implement is refused whichever side it falls on, and only the v7 case gets
  // the run-off hint — an operator holding a v9 registry is early, not pointed at the wrong file.
  assert.doesNotMatch(refusal(versioned).message, /v7-legacy/);

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
