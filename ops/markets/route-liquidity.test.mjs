/**
 * route-liquidity.mjs: the maths, the pinned constants, the Multicall3 codec, and the check itself over an
 * INJECTED chain source -- nothing here reads the chain. `cast` is used only to re-derive the pinned selectors, the
 * event topic and a reference aggregate3 calldata, so a typo in a pin fails here instead of on launch night.
 *
 *   node --test ops/markets/route-liquidity.test.mjs
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";

import {
  BAND_BPS,
  chainSource,
  MAX_ROUTE_FEE_BPS,
  MAX_ROUTE_FEE_TIER,
  MIN_DEPTH_USD,
  MIN_SHARE_OF_DEEPEST,
  SELECTORS,
  V4_INITIALIZE_TOPIC,
  decodeAggregate3,
  depth,
  encAddress,
  encInt,
  encodeAggregate3,
  judge,
  judgeFee,
  routeCost,
  routeLiquidityIssues,
  sqrtAtTick,
  walk,
} from "./route-liquidity.mjs";

const execFileP = promisify(execFile);
const cast = async (...args) => (await execFileP("cast", args)).stdout.trim();

/*//////////////////////////////////////////////////////////////
                              PINNED CONSTANTS
//////////////////////////////////////////////////////////////*/

test("every pinned selector equals cast sig of its signature", async () => {
  for (const [sig, sel] of Object.entries(SELECTORS)) {
    assert.equal(sel, await cast("sig", sig), sig);
  }
});

test("the v4 Initialize topic equals cast keccak of the event signature", async () => {
  assert.equal(V4_INITIALIZE_TOPIC, await cast("keccak", "Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)"));
});

/*//////////////////////////////////////////////////////////////
                                 MULTICALL3
//////////////////////////////////////////////////////////////*/

test("aggregate3 calldata equals cast calldata for the same two calls", async () => {
  const a = "0x1111111111111111111111111111111111111111";
  const b = "0x2222222222222222222222222222222222222222";
  const reqs = [
    { to: a, data: SELECTORS["liquidity()"] },
    { to: b, data: SELECTORS["tickBitmap(int16)"] + encInt(-3) },
  ];
  const want = await cast("calldata", "aggregate3((address,bool,bytes)[])", `[(${a},true,${reqs[0].data}),(${b},true,${reqs[1].data})]`);
  assert.equal(encodeAggregate3(reqs), want);
});

test("aggregate3 return data decodes to (success, bytes) per call, a failure included", async () => {
  const enc = await cast("abi-encode", "f((bool,bytes)[])", `[(true,0x${"00".repeat(31)}2a),(false,0x)]`);
  const out = decodeAggregate3(enc);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { success: true, data: "0x" + "00".repeat(31) + "2a" });
  assert.deepEqual(out[1], { success: false, data: "0x" });
});

test("negative ints encode as 256-bit two's complement (int16 word positions, int24 ticks)", () => {
  assert.equal(encInt(-1), "f".repeat(64));
  assert.equal(encInt(-887272).slice(-6), (0x1000000 - 887272).toString(16));
  assert.equal(encAddress("0xABCDEF0000000000000000000000000000000001"), "0".repeat(24) + "abcdef0000000000000000000000000000000001");
});

/*//////////////////////////////////////////////////////////////
                                  MATHS
//////////////////////////////////////////////////////////////*/

test("walk with constant liquidity equals the closed form in both directions", () => {
  const s = { sqrtP: 100, tick: 0, liquidity: 1e12, ticks: [] };
  const up = walk(s, 101);
  assert.ok(Math.abs(up.amount1 - 1e12 * 1) < 1e-3);
  assert.ok(Math.abs(up.amount0 - 1e12 * (1 / 100 - 1 / 101)) < 1e-3);
  const down = walk(s, 99);
  assert.ok(Math.abs(down.amount1 - 1e12 * 1) < 1e-3);
});

test("walk stops adding depth past a tick that removes all liquidity", () => {
  // Current tick 10; an initialized tick at 20 whose liquidityNet removes everything when crossed upward.
  const L = 1e15;
  const s = { sqrtP: sqrtAtTick(10), tick: 10, liquidity: L, ticks: [{ tick: 20, liquidityNet: -L }] };
  const far = walk(s, sqrtAtTick(200));
  const toBoundary = walk({ ...s, ticks: [] }, sqrtAtTick(20));
  assert.ok(Math.abs(far.amount1 - toBoundary.amount1) / toBoundary.amount1 < 1e-12, "no depth beyond the boundary");
  // Downward crossing subtracts liquidityNet: a tick at 0 with net +L also empties the range below it.
  const down = walk({ ...s, ticks: [{ tick: 0, liquidityNet: L }] }, sqrtAtTick(-200));
  const toZero = walk({ ...s, ticks: [] }, sqrtAtTick(0));
  assert.ok(Math.abs(down.amount1 - toZero.amount1) / toZero.amount1 < 1e-12);
});

/*//////////////////////////////////////////////////////////////
                             FIXTURE CHAIN
//////////////////////////////////////////////////////////////*/

// USDG sorts below the asset, so USDG is token0 and the asset token1 -- like NVDA/USDG on 4663.
const USDG = "0x1000000000000000000000000000000000000001";
const ASSET = "0x2000000000000000000000000000000000000002";
const ROUTER = "0x3000000000000000000000000000000000000003";
const TWAP = "0x4000000000000000000000000000000000000004";
const FACTORY = "0x5000000000000000000000000000000000000005";
const PM = "0x6000000000000000000000000000000000000006";
const SV = "0x7000000000000000000000000000000000000007";
const DEEP_V3 = "0xd000000000000000000000000000000000000500";
const MID_V3 = "0xc000000000000000000000000000000000003000";
const ROUTE_ID = "0x" + "ab".repeat(32);
const JUNK_ID = "0x" + "cd".repeat(32);
const EXECUTOR = "0x8000000000000000000000000000000000000008";
const WETH = "0x9000000000000000000000000000000000000009";
const EXEC_POOL = "0xe000000000000000000000000000000000000100";
const ONE_PCT_V3 = "0xb000000000000000000000000000000000010000";
/**
 * v4 slot0 protocolFee packs two 12-bit pip values: the low half for zeroForOne swaps, the high half for oneForZero.
 * A payout SELLS the asset; here the asset sorts above USDG, so it is currency1 and the sale is oneForZero (high half).
 */
const packProtocolFee = ({ zeroForOne = 0, oneForZero = 0 }) => (oneForZero << 12) | zeroForOne;
// The default route: lpFee 375 + 100 pips on the sell side = 475 pips = 5 bps, which is what routeFeeBps caches.
const ROUTE_PROTOCOL_FEE = packProtocolFee({ zeroForOne: 100, oneForZero: 100 });

// Spot 200 USDG per asset: raw quote per raw base = 1/P, spot = (1/P)·1e12, so P = 5e9.
const SQRT_P = Math.sqrt(5e9);
const X96 = (sqrtP) => BigInt(Math.round(sqrtP * 2 ** 96));
/** A constant-L pool whose weaker-side (buy) depth over ±BAND_BPS is `usd`, at spot `spotMul` × 200. */
function poolWithDepth(usd, spotMul = 1) {
  const s = SQRT_P / Math.sqrt(spotMul);
  const b = BAND_BPS / 10_000;
  // quote = token0: buy moves P down to P/(1+b); USDG in = L·(√(1+b) − 1)/√P, in raw units (6 dp).
  const L = (usd * 1e6 * s) / (Math.sqrt(1 + b) - 1);
  return { sqrtPriceX96: X96(s), tick: Math.floor(Math.log(s * s) / Math.log(1.0001)), liquidity: BigInt(Math.round(L)), ticks: [], tickSpacing: 10 };
}

function fixture({
  routeUsd,
  deepUsd = 400_000,
  midUsd = 60_000,
  live,
  twap = DEEP_V3,
  junkSpotMul = 2,
  execUsd,
  // The v4 route's key fee (= its static lpFee), tick spacing and slot0 protocolFee, the router's cached
  // routeFeeBps, and an optional deep 1 % v3 pool.
  routeFee = 375,
  routeTickSpacing = 4,
  routeProtocolFee = ROUTE_PROTOCOL_FEE,
  cachedFeeBps = 5,
  onePctUsd,
} = {}) {
  const pools = {
    [DEEP_V3.toLowerCase()]: { ...poolWithDepth(deepUsd), fee: 500 },
    [MID_V3.toLowerCase()]: { ...poolWithDepth(midUsd), fee: 3000 },
    [EXEC_POOL.toLowerCase()]: { ...poolWithDepth(execUsd ?? 900_000), fee: 100 },
    ...(onePctUsd === undefined ? {} : { [ONE_PCT_V3.toLowerCase()]: { ...poolWithDepth(onePctUsd), fee: 10_000 } }),
  };
  const v4 = {
    [ROUTE_ID]: { ...poolWithDepth(routeUsd), tickSpacing: routeTickSpacing, lpFee: routeFee, protocolFee: routeProtocolFee },
    [JUNK_ID]: { ...poolWithDepth(10_000_000, junkSpotMul), tickSpacing: 60, lpFee: 3000, protocolFee: 0 },
  };
  const registry = {
    shared: { usdg: USDG },
    markets: [{ ticker: "TEST", asset: ASSET, v2: { payoutRoute: { venue: "v4", fee: routeFee, tickSpacing: routeTickSpacing, poolId: ROUTE_ID }, univ3Pool: DEEP_V3 } }],
    v2: { deployBlock: 1, contracts: { payoutAdapter: ROUTER, sources: { univ3: TWAP } }, uniswapV3: { factory: FACTORY }, flywheel: execUsd === undefined ? {} : { buybackExecutor: EXECUTOR } },
  };
  const src = {
    decimals: async (t) => (t.toLowerCase() === USDG.toLowerCase() ? 6 : 18),
    routerV4: async () => ({ poolManager: PM, stateView: SV }),
    payoutRoute: async () => live ?? { venue: "v4", fee: routeFee, tickSpacing: routeTickSpacing, v3Pool: "0x0000000000000000000000000000000000000000" },
    routeFeeBps: async () => cachedFeeBps,
    twapPool: async () => twap,
    v3GetPool: async (_f, _a, _b, fee) =>
      fee === 500
        ? DEEP_V3
        : fee === 3000
          ? MID_V3
          : fee === 100 && execUsd !== undefined
            ? EXEC_POOL
            : fee === 10_000 && onePctUsd !== undefined
              ? ONE_PCT_V3
              : "0x0000000000000000000000000000000000000000",
    v4Initialized: async () => [
      { poolId: ROUTE_ID, fee: routeFee, tickSpacing: routeTickSpacing, hooks: "0x0000000000000000000000000000000000000000" },
      { poolId: JUNK_ID, fee: 3000, tickSpacing: 60, hooks: "0x0000000000000000000000000000000000000000" },
      // A hooked pool is never a candidate, however deep.
      { poolId: "0x" + "ee".repeat(32), fee: 3000, tickSpacing: 60, hooks: "0x00000000000000000000000000000000000000ff" },
    ],
    v4LiquidityMany: async (_sv, ids) => ids.map((id) => ({ liquidity: v4[id].liquidity, sqrtPriceX96: v4[id].sqrtPriceX96 })),
    v3Pool: async (p) => pools[p.toLowerCase()],
    v4Pool: async (_sv, id) => v4[id],
    executorPools: async () => ({ v3Pool: EXEC_POOL, weth: WETH, poolId: JUNK_ID }),
  };
  return { registry, src };
}

/*//////////////////////////////////////////////////////////////
                               THE CHECK
//////////////////////////////////////////////////////////////*/

test("a shallow payout route FAILS by name; the deep oracle pool passes", async () => {
  const { registry, src } = fixture({ routeUsd: 800 });
  const { issues, pairs } = await routeLiquidityIssues(registry, src);
  assert.equal(issues.length, 1, issues.join("\n"));
  assert.match(issues[0], /^TEST: TEST payout route \(registry v4 375\/4 0xabababab…\) is SHALLOW/);
  assert.match(issues[0], /below the \$50,000 floor/);
  assert.match(issues[0], /of the depth of the deepest candidate v3 500 0xd0{36}500/);
  const oracle = pairs[0].refs.find((r) => r.role === "univ3Pool");
  assert.equal(oracle.verdict.ok, true);
  assert.ok(Math.abs(oracle.depth.weaker - 400_000) / 400_000 < 1e-6, `fixture depth is exact (${oracle.depth.weaker})`);
});

test("a deep payout route passes, and nothing is reported against the oracle pool", async () => {
  const { registry, src } = fixture({ routeUsd: 390_000 });
  const { issues } = await routeLiquidityIssues(registry, src);
  assert.deepEqual(issues, []);
});

test("above the absolute floor but under half of the deepest candidate still FAILS (the relative rule alone)", async () => {
  const { registry, src } = fixture({ routeUsd: 120_000 }); // > $50k, but 30 % of the $400k pool
  const { issues } = await routeLiquidityIssues(registry, src);
  assert.equal(issues.length, 1, issues.join("\n"));
  assert.doesNotMatch(issues[0], /below the \$50,000 floor/);
  assert.match(issues[0], /holds 30\.0 % of the depth of the deepest candidate/);
});

test("the registry and the live PayoutRouter disagreeing is a FAIL of its own, and the live v3 pool is measured", async () => {
  const { registry, src } = fixture({ routeUsd: 390_000, live: { venue: "v3", fee: 500, tickSpacing: 10, v3Pool: DEEP_V3 } });
  const { issues } = await routeLiquidityIssues(registry, src);
  assert.equal(issues.length, 1, issues.join("\n"));
  assert.match(issues[0], /registry v2\.payoutRoute is v4 fee 375 tickSpacing 4 but PayoutRouter\.routes\(asset\) on chain is v3 fee 500: the registry must describe the live route/);
});

test("a registry TWAP pool that is not the one the source reads on chain is a FAIL", async () => {
  const { registry, src } = fixture({ routeUsd: 390_000, twap: MID_V3 });
  const { issues } = await routeLiquidityIssues(registry, src);
  assert.ok(issues.some((i) => /registry v2\.univ3Pool is 0xd0{36}500 but UniV3TwapSource\.pools\(asset\) on chain is 0xc0{35}3000/.test(i)), issues.join("\n"));
});

test("a deep pool at a price far from the market is excluded, not used as the yardstick", async () => {
  const { registry, src } = fixture({ routeUsd: 390_000, junkSpotMul: 2 });
  const { pairs, issues } = await routeLiquidityIssues(registry, src);
  assert.deepEqual(issues, []);
  assert.ok(pairs[0].offPrice.some((l) => l.includes("cdcdcdcd")), "the $10M pool at 2x spot is named as excluded");
  assert.notEqual(pairs[0].deepest.poolId, JUNK_ID);
  // The same pool AT the market price becomes the deepest and the route fails against it.
  const atMarket = fixture({ routeUsd: 390_000, junkSpotMul: 1 });
  const res = await routeLiquidityIssues(atMarket.registry, atMarket.src);
  assert.equal(res.issues.length, 1, res.issues.join("\n"));
  assert.match(res.issues[0], /^TEST: TEST payout route .*deepest candidate v4 3000\/60 0xcdcdcdcd…/);
  // The oracle pool is NOT failed by a deeper v4 pool: a TWAP source can only move to another v3 pool.
  assert.equal(res.pairs[0].refs.find((r) => r.role === "univ3Pool").verdict.ok, true);
});

test("an immutable reference is REPORTED and never fails the check, even when shallow", async () => {
  const { registry, src } = fixture({ routeUsd: 390_000, execUsd: 900 });
  const { issues, reports } = await routeLiquidityIssues(registry, src);
  assert.deepEqual(issues, []);
  assert.equal(reports.length, 1);
  assert.match(reports[0], /buyback executor 0x80{38}8 v3Pool 0xe0{36}100: SHALLOW .*\(immutable: a fix is a redeploy\)/);
});

test("a DEPLOYED registry missing the addresses the check needs refuses to pass silently", async () => {
  const { registry, src } = fixture({ routeUsd: 390_000 });
  delete registry.v2.contracts.sources;
  const { issues } = await routeLiquidityIssues(registry, src);
  assert.equal(issues.length, 1);
  assert.match(issues[0], /nothing measured/);
});

test("a registry that is not deployed yet is reported as unmeasured, not failed", async () => {
  const { registry, src } = fixture({ routeUsd: 390_000 });
  delete registry.v2.contracts.sources;
  registry.v2.deployBlock = null;
  const { issues, reports } = await routeLiquidityIssues(registry, src);
  assert.deepEqual(issues, []);
  assert.match(reports[0], /not deployed \(v2\.deployBlock is null\)/);
});

/*//////////////////////////////////////////////////////////////
          DEPLOYED BUT NOT REGISTERED YET (WRITEBACK RUNS FIRST)
//////////////////////////////////////////////////////////////*/

// RegisterMarkets writes PayoutRouter.routes(asset) and UniV3TwapSource.pools(asset) AFTER the deploy writeback, so a
// fresh deploy's markets read empty on chain; the stonkctl fork run saw exactly this for NVDA and SPCX.
const NO_ROUTE = { venue: "none", fee: 0, tickSpacing: 0, v3Pool: "0x0000000000000000000000000000000000000000" };
const NO_POOL = "0x0000000000000000000000000000000000000000";

test("a deployed but UNREGISTERED market with empty chain slots passes the equality check, is reported, and is still measured", async () => {
  const { registry, src } = fixture({ routeUsd: 390_000, live: NO_ROUTE, twap: NO_POOL });
  assert.equal(registry.markets[0].v2.registeredAt, undefined, "the fixture market is not registered");
  const { issues, reports, pairs } = await routeLiquidityIssues(registry, src);
  assert.deepEqual(issues, []);
  assert.ok(reports.some((r) => /^TEST: not registered yet \(v2\.registeredAt null\) and PayoutRouter\.routes\(asset\) is empty/.test(r)), reports.join("\n"));
  assert.ok(reports.some((r) => /^TEST: not registered yet \(v2\.registeredAt null\) and UniV3TwapSource\.pools\(asset\) is empty/.test(r)), reports.join("\n"));
  assert.deepEqual(pairs[0].refs.map((r) => [r.role, r.verdict.ok]), [["payoutRoute", true], ["univ3Pool", true]], "both registry references are measured");
});

test("a REGISTERED market whose chain slots disagree with the registry FAILS naming the market, for the route and the pool", async () => {
  const { registry, src } = fixture({ routeUsd: 390_000, live: NO_ROUTE, twap: NO_POOL });
  registry.markets[0].v2.registeredAt = 1_790_066_500;
  const { issues } = await routeLiquidityIssues(registry, src);
  assert.equal(issues.length, 2, issues.join("\n"));
  assert.match(issues[0], /^TEST: registry v2\.payoutRoute is v4 fee 375 tickSpacing 4 but PayoutRouter\.routes\(asset\) on chain is none fee 0: the registry must describe the live route$/);
  assert.match(issues[1], /^TEST: registry v2\.univ3Pool is 0xd0{36}500 but UniV3TwapSource\.pools\(asset\) on chain is 0x0{40}$/);
});

test("the depth floor applies to an unregistered market too: a SHALLOW registry route still FAILS", async () => {
  const { registry, src } = fixture({ routeUsd: 800, live: NO_ROUTE, twap: NO_POOL });
  const { issues } = await routeLiquidityIssues(registry, src);
  assert.equal(issues.length, 1, issues.join("\n"));
  assert.match(issues[0], /^TEST: TEST payout route \(registry v4 375\/4 0xabababab…\) is SHALLOW — .*below the \$50,000 floor/);
});

test("an unregistered market whose chain slot is ALREADY set to something else still FAILS (only an empty slot is waived)", async () => {
  const { registry, src } = fixture({ routeUsd: 390_000, live: { venue: "v3", fee: 500, tickSpacing: 10, v3Pool: DEEP_V3 }, twap: MID_V3 });
  const { issues } = await routeLiquidityIssues(registry, src);
  assert.ok(issues.some((i) => /^TEST: registry v2\.payoutRoute is v4 fee 375 tickSpacing 4 but PayoutRouter\.routes\(asset\) on chain is v3 fee 500/.test(i)), issues.join("\n"));
  assert.ok(issues.some((i) => /^TEST: registry v2\.univ3Pool is 0xd0{36}500 but UniV3TwapSource\.pools\(asset\) on chain is 0xc0{35}3000$/.test(i)), issues.join("\n"));
});

/*//////////////////////////////////////////////////////////////
                         THE THRESHOLD COMPARISONS
//////////////////////////////////////////////////////////////*/

test("judge: exactly at the floor and exactly at the share pass; one unit under each fails", () => {
  const mk = (usd, id) => ({ id, label: id, depth: { weaker: usd } });
  const deepest = mk(200_000, "deep");
  assert.equal(judge(mk(MIN_DEPTH_USD, "a"), null).ok, true);
  assert.equal(judge(mk(MIN_DEPTH_USD - 1, "a"), null).ok, false);
  assert.equal(judge(mk(200_000 * MIN_SHARE_OF_DEEPEST, "a"), deepest).ok, true);
  assert.equal(judge(mk(200_000 * MIN_SHARE_OF_DEEPEST - 1, "a"), deepest).ok, false);
  // The deepest pool is never judged against itself.
  assert.equal(judge(deepest, deepest).ok, true);
});

test("depth is measured on the quote side whichever token it is", () => {
  const st = poolWithDepth(100_000);
  const asToken0 = depth(st, { quoteIsToken0: true, quoteDecimals: 6 });
  assert.ok(Math.abs(asToken0.buy - 100_000) < 1e-6 * 100_000);
  assert.ok(asToken0.sell > asToken0.buy, "a sell of the same band moves more quote on this curve");
  // Mirror: with the quote as token1 the same state reports token1 amounts (a different, finite number).
  const asToken1 = depth(st, { quoteIsToken0: false, quoteDecimals: 6 });
  assert.ok(Number.isFinite(asToken1.weaker) && asToken1.weaker > 0);
});

/*//////////////////////////////////////////////////////////////
          THE FEE RULE (a deep route the floor cannot pay for)
//////////////////////////////////////////////////////////////*/

test("routeCost mirrors PayoutRouter._v4FeeBps: lpFee plus the protocol-fee half for the swap's direction, bps rounded up", () => {
  const pf = packProtocolFee({ zeroForOne: 7, oneForZero: 1000 });
  assert.deepEqual(routeCost({ venue: "v4", lpFee: 9000, protocolFee: pf }, true), { pips: 9007, bps: 91, lp: 9000, protocol: 7 });
  assert.deepEqual(routeCost({ venue: "v4", lpFee: 9000, protocolFee: pf }, false), { pips: 10_000, bps: 100, lp: 9000, protocol: 1000 });
  // v3's protocol fee is a share of the LP fee, never added to it (_v3FeeBps is fee / 100 rounded up).
  assert.deepEqual(routeCost({ venue: "v3", fee: 500 }, true), { pips: 500, bps: 5, lp: 500, protocol: 0 });
  assert.deepEqual(routeCost({ venue: "v3", fee: 10_000 }, false), { pips: 10_000, bps: 100, lp: 10_000, protocol: 0 });
  // A fee that was not read is unknown, not zero.
  assert.equal(routeCost({ venue: "v4", protocolFee: 0 }, true), null);
  assert.equal(routeCost({ venue: "v3" }, true), null);
});

test("judgeFee: exactly MAX_ROUTE_FEE_TIER pips passes, one pip more FAILS; a cache one bps short FAILS", () => {
  assert.equal(MAX_ROUTE_FEE_BPS, MAX_ROUTE_FEE_TIER / 100);
  const at = { venue: "v4", lpFee: 9000, protocolFee: packProtocolFee({ zeroForOne: 1000 }) };
  assert.equal(judgeFee(at, { zeroForOne: true }).ok, true);
  assert.equal(judgeFee(at, { zeroForOne: true, cachedBps: 100 }).ok, true);
  const over = judgeFee({ ...at, protocolFee: packProtocolFee({ zeroForOne: 1001 }) }, { zeroForOne: true });
  assert.equal(over.ok, false);
  assert.match(over.reasons[0], /^lpFee 9000 \+ protocol fee 1001 pips on the sell side = 10001 pips is above MAX_ROUTE_FEE_TIER 10000/);
  // The cache is held to the cost only when it is passed: 100 bps against a cached 99.
  const stale = judgeFee(at, { zeroForOne: true, cachedBps: 99 });
  assert.equal(stale.ok, false);
  assert.match(stale.reasons[0], /costs 100 bps but the floor credits 99 \(PayoutRouter\.routeFeeBps\(asset\) = 99\): the cached fee is stale, call refreshRouteFee\(asset\)$/);
  // A cache above MAX_ROUTE_FEE_BPS (the floor clamps it to 100) covers any route the tier arm lets through.
  assert.equal(judgeFee(at, { zeroForOne: true, cachedBps: 150 }).ok, true);
  // An unreadable fee FAILS rather than passing as free.
  const unknown = judgeFee({ venue: "v4", lpFee: 375 }, { zeroForOne: true, cachedBps: 5 });
  assert.equal(unknown.ok, false);
  assert.match(unknown.reasons[0], /could not be read/);
});

test("the default fixture route passes the fee rule EXACTLY: 475 pips = 5 bps against a cached 5", async () => {
  const { registry, src } = fixture({ routeUsd: 390_000 });
  const { issues, pairs } = await routeLiquidityIssues(registry, src);
  assert.deepEqual(issues, []);
  const route = pairs[0].refs.find((r) => r.role === "payoutRoute");
  assert.equal(route.feeVerdict.ok, true);
  assert.deepEqual(route.feeVerdict.cost, { pips: 475, bps: 5, lp: 375, protocol: 100 });
  // The TWAP pool is read, never swapped through: it gets no fee verdict.
  assert.equal(pairs[0].refs.find((r) => r.role === "univ3Pool").feeVerdict, undefined);
});

test("a DEEP SPCX-shaped route, v4 10000/200 with 10 bps of protocol fee on the sell side, FAILS on fee alone", async () => {
  const { registry, src } = fixture({
    routeUsd: 390_000,
    routeFee: 10_000,
    routeTickSpacing: 200,
    routeProtocolFee: packProtocolFee({ oneForZero: 1000 }),
    cachedFeeBps: 100, // what a clamping router caches for it
  });
  const { issues, pairs } = await routeLiquidityIssues(registry, src);
  assert.equal(issues.length, 1, issues.join("\n"));
  assert.match(
    issues[0],
    /^TEST: TEST payout route \(registry v4 10000\/200 0xabababab…\) is TOO EXPENSIVE — lpFee 10000 \+ protocol fee 1000 pips on the sell side = 11000 pips is above MAX_ROUTE_FEE_TIER 10000: the conversion floor credits at most 100 bps of route fee; replace the route \(PayoutRouter\._v4FeeBps refuses it with ROUTE_COST\)$/,
  );
  assert.equal(pairs[0].refs.find((r) => r.role === "payoutRoute").verdict.ok, true, "the route is deep: depth could never see this");
});

test("direction: the protocol fee of the BUY side does not count against a payout, the SELL side does", async () => {
  // The asset sorts above USDG (currency1), so a payout is oneForZero and reads the HIGH half.
  const buySide = fixture({ routeUsd: 390_000, routeFee: 10_000, routeTickSpacing: 200, routeProtocolFee: packProtocolFee({ zeroForOne: 1000 }), cachedFeeBps: 100 });
  assert.deepEqual((await routeLiquidityIssues(buySide.registry, buySide.src)).issues, []);
  const sellSide = fixture({ routeUsd: 390_000, routeFee: 10_000, routeTickSpacing: 200, routeProtocolFee: packProtocolFee({ oneForZero: 1000 }), cachedFeeBps: 100 });
  const { issues } = await routeLiquidityIssues(sellSide.registry, sellSide.src);
  assert.equal(issues.length, 1, issues.join("\n"));
  assert.match(issues[0], /protocol fee 1000 pips on the sell side = 11000 pips/);
});

test("a protocol fee raised after setRoute leaves the cached routeFeeBps short: the LIVE route FAILS naming refreshRouteFee", async () => {
  // 375 + 700 = 1075 pips = 11 bps, while the router still caches the 5 bps it computed at setRoute time.
  const { registry, src } = fixture({ routeUsd: 390_000, routeProtocolFee: packProtocolFee({ oneForZero: 700 }), cachedFeeBps: 5 });
  const { issues } = await routeLiquidityIssues(registry, src);
  assert.equal(issues.length, 1, issues.join("\n"));
  assert.match(issues[0], /^TEST: TEST payout route \(registry v4 375\/4 0xabababab…\) is TOO EXPENSIVE — lpFee 375 \+ protocol fee 700 pips on the sell side = 1075 pips costs 11 bps but the floor credits 5 \(PayoutRouter\.routeFeeBps\(asset\) = 5\): the cached fee is stale, call refreshRouteFee\(asset\)$/);
  // Control: the same route with the cache refreshed to 11 passes.
  const refreshed = fixture({ routeUsd: 390_000, routeProtocolFee: packProtocolFee({ oneForZero: 700 }), cachedFeeBps: 11 });
  assert.deepEqual((await routeLiquidityIssues(refreshed.registry, refreshed.src)).issues, []);
});

test("the cache describes the LIVE route only: a registry route the router does not hold is not held to it", async () => {
  // Live: v3 500 (5 bps, cached 5). Registry: v4 375/4 at 11 bps. The drift is the one FAIL; the registry route is
  // under the tier, so it has no fee FAIL of its own, and the live v3 route matches its cache.
  const { registry, src } = fixture({ routeUsd: 390_000, routeProtocolFee: packProtocolFee({ oneForZero: 700 }), live: { venue: "v3", fee: 500, tickSpacing: 10, v3Pool: DEEP_V3 }, cachedFeeBps: 5 });
  const { issues, pairs } = await routeLiquidityIssues(registry, src);
  assert.equal(issues.length, 1, issues.join("\n"));
  assert.match(issues[0], /registry v2\.payoutRoute is v4 fee 375 tickSpacing 4 but PayoutRouter\.routes\(asset\) on chain is v3 fee 500/);
  const byVenue = Object.fromEntries(pairs[0].refs.filter((r) => r.role === "payoutRoute").map((r) => [r.venue, r.feeVerdict]));
  assert.deepEqual([byVenue.v4.ok, byVenue.v4.cost.bps, byVenue.v3.ok, byVenue.v3.cost.bps], [true, 11, true, 5]);
  // And when no reference is the live route, routeFeeBps is never read.
  const none = fixture({ routeUsd: 390_000, live: { venue: "none", fee: 0, tickSpacing: 0, v3Pool: "0x0000000000000000000000000000000000000000" } });
  none.src.routeFeeBps = async () => assert.fail("routeFeeBps read with no live route");
  await routeLiquidityIssues(none.registry, none.src);
});

test("a deep v3 1 % route costs exactly the 100 bps the floor credits: passes on a cache of 100, FAILS on 99", async () => {
  const v3Route = (cachedFeeBps) => {
    const f = fixture({ routeUsd: 390_000, onePctUsd: 400_000, live: { venue: "v3", fee: 10_000, tickSpacing: 200, v3Pool: ONE_PCT_V3 }, cachedFeeBps });
    f.registry.markets[0].v2.payoutRoute = { venue: "v3", fee: 10_000 };
    return f;
  };
  const ok = v3Route(100);
  assert.deepEqual((await routeLiquidityIssues(ok.registry, ok.src)).issues, []);
  const short = v3Route(99);
  const { issues } = await routeLiquidityIssues(short.registry, short.src);
  assert.equal(issues.length, 1, issues.join("\n"));
  assert.match(issues[0], /^TEST: TEST payout route \(registry v3 10000 0xb0{34}10000\) is TOO EXPENSIVE — pool fee 10000 pips costs 100 bps but the floor credits 99/);
});

test("a payout route whose fees the source did not return FAILS as unknown instead of passing as free", async () => {
  const { registry, src } = fixture({ routeUsd: 390_000 });
  const v4Pool = src.v4Pool;
  src.v4Pool = async (sv, id) => {
    const { lpFee: _lp, protocolFee: _pf, ...rest } = await v4Pool(sv, id);
    return rest;
  };
  const { issues } = await routeLiquidityIssues(registry, src);
  assert.equal(issues.length, 1, issues.join("\n"));
  assert.match(issues[0], /^TEST: TEST payout route .* is TOO EXPENSIVE — its fee could not be read/);
});

test("chainSource decodes StateView.getSlot0's protocolFee and lpFee words, and reads routeFeeBps(asset), as cast encodes them", async () => {
  // Return data and calldata come from cast, not from this file's own encoder, so a swapped word or a wrong selector
  // cannot agree with itself here.
  const sv = "0x7000000000000000000000000000000000000007";
  const router = "0x3000000000000000000000000000000000000003";
  const poolId = "0x" + "ab".repeat(32);
  const asset = "0x2000000000000000000000000000000000000002";
  const pf = packProtocolFee({ zeroForOne: 25, oneForZero: 1000 });
  const replies = {
    [await cast("calldata", "getSlot0(bytes32)", poolId)]: await cast("abi-encode", "f(uint160,int24,uint24,uint24)", String(2n ** 96n), "-7", String(pf), "9000"),
    [await cast("calldata", "getLiquidity(bytes32)", poolId)]: await cast("abi-encode", "f(uint128)", "1000000"),
    [await cast("calldata", "routeFeeBps(address)", asset)]: await cast("abi-encode", "f(uint16)", "91"),
  };
  const t = {
    call: async (_to, data) => replies[data] ?? "0x" + "00".repeat(32), // tick bitmap words: empty
  };
  const src = chainSource(t);
  const state = await src.v4Pool(sv, poolId, 10);
  assert.deepEqual([state.protocolFee, state.lpFee, state.tick, state.liquidity], [pf, 9000, -7, 1_000_000n]);
  assert.deepEqual(routeCost({ venue: "v4", ...state }, false), { pips: 10_000, bps: 100, lp: 9000, protocol: 1000 });
  assert.equal(await src.routeFeeBps(router, asset), 91);
});
