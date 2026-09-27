// node --test ops/v2/rehearse/launch-set.test.mjs
//
// The numbered rehearsal's tickers, roles and fresh input copy. The first block reads the COMMITTED
// registry (ops/markets/tier1.json), so a launch-set change there shows up here rather than in a fork run.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { MM_FAIR_SPOT_TOLERANCE_BPS } from "./keeper-defaults.mjs";
import { createRequire } from "node:module";
import {
  NULLED_SINGLE_FIELDS, ROUTE_VENUES, dualOpen, freshInput, launchTickers, paidThroughRegistryRoute, payoutRouteIssues, rehearsalRoles, routeVenue,
  v4PoolId,
} from "./launch-set.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TIER1 = path.join(ROOT, "ops", "markets", "tier1.json");
const tier1 = () => JSON.parse(readFileSync(TIER1, "utf8"));

test("the committed registry: launch set, roles, v8", () => {
  const reg = tier1();
  assert.equal(reg.v2.interfaceVersion, 8);
  const tickers = launchTickers(reg);
  assert.deepEqual(tickers, reg.launchSet.markets.map((t) => t.toUpperCase()));
  const roles = rehearsalRoles(reg);
  assert.ok(tickers.includes(roles.dual) && tickers.includes(roles.single) && roles.dual !== roles.single);
  const dual = reg.markets.find((m) => m.ticker === roles.dual);
  assert.equal(dual.v2.wave, "canary", "the canary carries the dual beats when it is pooled");
  // The v9 launch set pays through v3 routes (fee 500); either venue is a route.
  assert.ok(dual.v2.univ3Pool && ["v3", "v4"].includes(dual.v2.payoutRoute?.venue), "the dual market pays through a v3 or v4 route");
});

test("freshInput nulls the recorded set and the single market's pool, and leaves the source untouched", () => {
  const reg = tier1();
  const before = JSON.stringify(reg);
  const roles = rehearsalRoles(reg);
  const copy = freshInput(reg, roles);
  assert.equal(JSON.stringify(reg), before, "the registry object itself is not mutated");
  assert.equal(copy.v2.deployBlock, null);
  const leaves = (o) => Object.values(o).flatMap((v) => (v !== null && typeof v === "object" ? leaves(v) : [v]));
  assert.ok(Object.keys(copy.v2.contracts).length === Object.keys(reg.v2.contracts).length, "every contract key is kept");
  assert.ok(leaves(copy.v2.contracts).every((v) => v === null), "every recorded contract is null");
  assert.ok(leaves(copy.v2.externalDeployBlocks).every((v) => v === null));
  assert.ok(leaves(copy.v2.bots).every((v) => v === null));
  assert.equal(copy.v2.flywheel.feeSplitter, null);
  assert.equal(copy.v2.flywheel.deployBlock, null);
  assert.equal(copy.shared.feeRecipient, null);
  assert.equal(copy.shared.admin, reg.shared.admin, "the Admin Safe is an input, kept");
  for (const m of copy.markets) assert.ok(m.v2.registeredAt === null && m.v2.registerTx === null && (m.v2.houseVault ?? null) === null, `${m.ticker} not recorded`);
  // The house block: the committed registry records the live launch factory and vaults; a fresh deploy has none
  assert.ok(reg.v2.house.factories.length > 0, "the committed registry records a house factory (else this check says nothing)");
  assert.deepEqual(copy.v2.house, { factories: [] });
  for (const m of copy.markets.filter((x) => x.v2?.house)) assert.deepEqual(m.v2.house, { weekly: null, daily: null }, `${m.ticker}.v2.house`);
  // A launch vault is house.daily since the v9 mainnet launch (12:02 PM PT 2026-09-25), house.weekly on v8.
  assert.ok(reg.markets.some((m) => m.v2?.house?.weekly || m.v2?.house?.daily), "the committed registry records a market's House vault (else the loop above says nothing)");
  const single = copy.markets.find((m) => m.ticker === roles.single);
  for (const k of NULLED_SINGLE_FIELDS) assert.equal(single.v2[k], null, `${roles.single}.v2.${k}`);
  const dual = copy.markets.find((m) => m.ticker === roles.dual);
  const dualSrc = reg.markets.find((m) => m.ticker === roles.dual);
  assert.equal(dual.v2.univ3Pool, dualSrc.v2.univ3Pool, "the dual market keeps its pool");
  assert.deepEqual(dual.v2.payoutRoute, dualSrc.v2.payoutRoute, "the dual market keeps its payout route");
});

// A minimal registry for the refusals: the rule, not the committed data.
const row = (ticker, v2) => ({ ticker, asset: "0x0000000000000000000000000000000000000001", v2: { status: "live", wave: "wave1", univ3Pool: null, payoutRoute: null, ...v2 } });
const POOL = { univ3Pool: "0x00000000000000000000000000000000000000aa", payoutRoute: { venue: "v4", fee: 500, tickSpacing: 10, poolId: "0x01" } };
const mk = (launch, markets) => ({ launchSet: launch === undefined ? undefined : { markets: launch }, markets, v2: { contracts: {} }, shared: {} });

test("launchTickers refuses a registry without a launch set, an unknown ticker and a repeat", () => {
  assert.throws(() => launchTickers(mk(undefined, [row("AAA", POOL)])), /no launchSet\.markets/);
  assert.throws(() => launchTickers(mk([], [row("AAA", POOL)])), /no launchSet\.markets/);
  assert.throws(() => launchTickers(mk(["AAA", "ZZZ"], [row("AAA", POOL)])), /ZZZ, not in markets/);
  assert.throws(() => launchTickers(mk(["AAA", "aaa"], [row("AAA", POOL)])), /repeats/);
  assert.deepEqual(launchTickers(mk(["aaa"], [row("AAA", POOL)])), ["AAA"]);
});

test("rehearsalRoles: canary first, else the first pooled; needs two markets and one pooled", () => {
  assert.deepEqual(rehearsalRoles(mk(["AAA", "BBB"], [row("AAA", POOL), row("BBB", { ...POOL, wave: "canary" })])), { dual: "BBB", single: "AAA", tickers: ["AAA", "BBB"] });
  assert.deepEqual(rehearsalRoles(mk(["AAA", "BBB"], [row("AAA", {}), row("BBB", POOL)])), { dual: "BBB", single: "AAA", tickers: ["AAA", "BBB"] });
  // an unpooled canary does not carry the dual beats
  assert.equal(rehearsalRoles(mk(["AAA", "BBB"], [row("AAA", { wave: "canary" }), row("BBB", POOL)])).dual, "BBB");
  assert.throws(() => rehearsalRoles(mk(["AAA"], [row("AAA", POOL)])), /needs two launch markets/);
  assert.throws(() => rehearsalRoles(mk(["AAA", "BBB"], [row("AAA", {}), row("BBB", {})])), /no launch market has both/);
  // a pool without a route is not enough: the dual beats include the v4 USDG conversion
  assert.throws(() => rehearsalRoles(mk(["AAA", "BBB"], [row("AAA", { univ3Pool: POOL.univ3Pool }), row("BBB", {})])), /no launch market has both/);
});

// dualOpen: the rule that decides whether the mm-bot quotes the dual market at all (the spot-age halt) and whether the
// story's r0 settles in the money. Prices are 6-dp USDG per share; NVDA's ladder and 2.5 USDG tick from the registry.
const nvdaOpen = (pool6, belowBps) => {
  const reg = tier1();
  const nvda = reg.markets.find((m) => m.ticker === "NVDA");
  return dualOpen({ pool6, belowBps, firstOtmBps: reg.v2.defaults.ladder.daily.firstOtmBps, strikeTick: BigInt(nvda.v2.strikeTick), toleranceBps: MM_FAIR_SPOT_TOLERANCE_BPS });
};

test("dualOpen: 280 bps under the 2026-09-23 fork's NVDA pool finishes r0 in the money, outside the 50 bps corroboration", () => {
  assert.equal(MM_FAIR_SPOT_TOLERANCE_BPS, 50n, "the shipped keeper default (keeper/src/v2/config.ts, T-OP-366)");
  const o = nvdaOpen(228_900_000n, 280n);
  assert.equal(o.spot6, 222_490_800n);
  assert.equal(o.gapBps, 288n);
  assert.equal(o.r0, 225_000_000n);
  assert.equal(o.r0InTheMoney, true);
  assert.equal(o.corroborates, false, "2-services asserts r0InTheMoney only; 3-story's feed heartbeat keeps the spot clock fresh");
});

test("dualOpen: the v7 open (97 %, 300 bps) is a 309 bps gap, outside the old 300 bps tolerance and the shipped 50", () => {
  const o = nvdaOpen(228_900_000n, 300n);
  assert.equal(o.gapBps, 309n);
  assert.equal(o.corroborates, false, "this is the open that halted the mm-bot spot-age on the 2026-09-23 run");
  assert.equal(o.r0InTheMoney, true);
});

test("dualOpen: too close to the pool and the tick can push r0 to the pool's price", () => {
  // 200 bps under a 230.00 pool: spot 225.40, r0 raw 227.654 rounds up to 230.00, not under the pool
  const tight = nvdaOpen(230_000_000n, 200n);
  assert.equal(tight.r0, 230_000_000n);
  assert.equal(tight.r0InTheMoney, false);
  assert.equal(tight.gapBps, 204n);
  assert.equal(tight.corroborates, false, "204 bps of the open is outside the 50 bps default as well");
  const chosen = nvdaOpen(230_000_000n, 280n);
  assert.equal(chosen.r0, 227_500_000n);
  assert.equal(chosen.r0InTheMoney, true, `280 bps holds r0 in the money at 230.00 too (r0 ${chosen.r0})`);
  assert.equal(chosen.corroborates, false);
});

test("dualOpen: the gap is measured in bps of the OPEN price, as the keeper divides by the oracle's spot", () => {
  // 291 bps of the pool is 299 bps of the open and 100 is 101; at the 50 bps default, 50 bps of the pool is exactly
  // 50 of the open (inside, <=) and 51 is 51 (outside)
  assert.equal(nvdaOpen(228_900_000n, 291n).gapBps, 299n);
  assert.equal(nvdaOpen(228_900_000n, 100n).gapBps, 101n);
  assert.equal(nvdaOpen(228_900_000n, 50n).gapBps, 50n);
  assert.equal(nvdaOpen(228_900_000n, 50n).corroborates, true);
  assert.equal(nvdaOpen(228_900_000n, 51n).corroborates, false);
});

test("dualOpen: at the shipped 50 bps no NVDA open both corroborates and finishes r0 in the money", () => {
  // Why 2-services asserts r0InTheMoney only and 3-story heartbeats the dual market: a corroborating open is at most
  // ~50 bps under the pool, and r0 is at least firstOtmBps (100) over the open, so r0 lands at or above the pool.
  for (const pool6 of [150_000_000n, 228_900_000n, 230_000_000n, 350_000_000n]) {
    let maxCorroborating = -1n;
    let minInTheMoney = null;
    for (let below = 0n; below <= 300n; below += 1n) {
      const o = nvdaOpen(pool6, below);
      assert.ok(!(o.corroborates && o.r0InTheMoney), `pool ${pool6}, ${below} bps under: both bounds hold`);
      if (o.corroborates) maxCorroborating = below;
      if (o.r0InTheMoney && minInTheMoney === null) minInTheMoney = below;
    }
    assert.ok(maxCorroborating >= 0n && maxCorroborating <= 50n, `pool ${pool6}: largest corroborating offset ${maxCorroborating}`);
    assert.ok(minInTheMoney !== null && minInTheMoney >= 100n, `pool ${pool6}: smallest in-the-money offset ${minInTheMoney}`);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// Step 1f' (1-fork.mjs) and 3-story's 3h check, against what PayoutRouter.routes(asset) returns.
// ---------------------------------------------------------------------------------------------------------------------
const { encodeAbiParameters, keccak256 } = createRequire(path.join(ROOT, "keeper", "package.json"))("viem");
const ZERO = "0x0000000000000000000000000000000000000000";
const ASSET = "0x00000000000000000000000000000000000000aa";
const USDG = "0x0000000000000000000000000000000000000bb0";
const V = Object.fromEntries(ROUTE_VENUES.map((name, i) => [name, i]));
/** A v4 pool id from viem's ABI encoder: independent of build-markets.mjs encodePoolKey, which v4PoolId uses. */
const poolIdOf = (a, b, fee, tickSpacing) => {
  const [c0, c1] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  const types = ["address", "address", "uint24", "int24", "address"].map((type) => ({ type }));
  return keccak256(encodeAbiParameters(types, [c0, c1, fee, tickSpacing, ZERO]));
};
const at = { asset: ASSET, usdg: USDG };
const WANT_V3 = { venue: "v3", fee: 500 };
const WANT_V4 = { venue: "v4", fee: 500, tickSpacing: 10, poolId: poolIdOf(ASSET, USDG, 500, 10) };
// What PayoutRouter.sol stores: setRouteV3 tickSpacing 0 and the factory's pool; setRouteV4 its tickSpacing and no pool.
const ON_V3 = { venue: V.V3, fee: 500, tickSpacing: 0, v3Pool: "0x00000000000000000000000000000000000000cc" };
const ON_V4 = { venue: V.V4, fee: 500, tickSpacing: 10, v3Pool: ZERO };
const ON_NONE = { venue: V.None, fee: 0, tickSpacing: 0, v3Pool: ZERO };

test("step 1f': a v3 route passes on venue and fee (tickSpacing 0 on chain), a v4 route on venue, fee, tickSpacing and poolId", () => {
  assert.deepEqual(payoutRouteIssues(WANT_V3, ON_V3, at), []);
  assert.deepEqual(payoutRouteIssues(WANT_V4, ON_V4, at), []);
  assert.deepEqual(payoutRouteIssues(null, ON_NONE, at), [], "no route in the registry and none on chain: paid in kind");
});

test("step 1f': a venue that disagrees with the registry fails whichever way round, and so does a missing route", () => {
  const cases = [[WANT_V3, ON_V4], [WANT_V4, ON_V3], [WANT_V3, ON_NONE], [WANT_V4, ON_NONE], [null, ON_V3], [null, ON_V4]];
  for (const [want, onChain] of cases) {
    const issues = payoutRouteIssues(want, onChain, at);
    assert.equal(issues.length, 1, `${JSON.stringify(want)} vs venue ${onChain.venue}: ${issues.join("; ")}`);
    assert.match(issues[0], /^venue (None|V3|V4) on chain, the registry's payoutRoute is (v3|v4|null)/);
  }
});

test("step 1f': a different fee, tickSpacing or poolId is named", () => {
  assert.deepEqual(payoutRouteIssues(WANT_V3, { ...ON_V3, fee: 3000 }, at), ["fee 3000 on chain, the registry's 500"]);
  assert.ok(payoutRouteIssues(WANT_V4, { ...ON_V4, fee: 3000 }, at).includes("fee 3000 on chain, the registry's 500"));
  assert.deepEqual(payoutRouteIssues(WANT_V4, { ...ON_V4, tickSpacing: 60 }, at), ["tickSpacing 60 on chain, the registry's 10"]);
  const other = { ...WANT_V4, poolId: poolIdOf(ASSET, USDG, 500, 60) };
  assert.deepEqual(payoutRouteIssues(other, ON_V4, at), [`poolId ${WANT_V4.poolId} of the on-chain key, the registry pins ${other.poolId}`]);
});

test("step 1f' on the committed registry: every launch market's route passes as PayoutRouter would store it", () => {
  const reg = tier1();
  const tickers = launchTickers(reg);
  // The v9 launch set is v3 (fee 500): this is the branch the old tickSpacing compare refused.
  assert.ok(tickers.some((T) => reg.markets.find((m) => m.ticker === T).v2.payoutRoute?.venue === "v3"), "a launch market has a v3 route");
  for (const T of tickers) {
    const m = reg.markets.find((x) => x.ticker === T);
    const want = m.v2.payoutRoute;
    const onChain = !want ? ON_NONE : want.venue === "v3" ? { ...ON_V3, fee: want.fee } : { ...ON_V4, fee: want.fee, tickSpacing: want.tickSpacing };
    assert.deepEqual(payoutRouteIssues(want, onChain, { asset: m.asset, usdg: reg.shared.usdg }), [], `${T} ${JSON.stringify(want)}`);
  }
});

test("v4PoolId hashes a key to the id the registry pins (shared.token) and to viem's own ABI encoding", () => {
  const { poolKey, poolId } = tier1().shared.token;
  assert.equal(v4PoolId(poolKey), poolId.toLowerCase());
  assert.equal(v4PoolId({ currency0: ASSET, currency1: USDG, fee: 500, tickSpacing: 10, hooks: ZERO }), poolIdOf(ASSET, USDG, 500, 10));
});

test("3-story 3h: the dual market's USDG conversion must run through the route the registry names", () => {
  assert.equal(paidThroughRegistryRoute({ venue: "V3" }, WANT_V3), true);
  assert.equal(paidThroughRegistryRoute({ venue: "V4" }, WANT_V4), true);
  assert.equal(paidThroughRegistryRoute({ venue: "V4" }, WANT_V3), false, "v4 on chain, v3 in the registry");
  assert.equal(paidThroughRegistryRoute({ venue: "V3" }, WANT_V4), false, "v3 on chain, v4 in the registry");
  assert.equal(paidThroughRegistryRoute({}, WANT_V3), false, "step 1 recorded no route");
  assert.equal(paidThroughRegistryRoute({ venue: "None" }, null), false, "a dual market with no route never passes");
  assert.deepEqual([routeVenue(WANT_V3), routeVenue(WANT_V4), routeVenue(null)], ["V3", "V4", "None"]);
});

test("1-fork step 1f' and 3-story 3h use these checks, not the v4-only compares they replaced (they run only on a fork)", () => {
  const src = (name) => readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), name), "utf8");
  const fork = src("1-fork.mjs");
  const step1f = fork.slice(fork.indexOf(`step("1f'.`), fork.indexOf("patchState(", fork.indexOf(`step("1f'.`)));
  assert.match(step1f, /payoutRouteIssues\(want, r, \{ asset: markets\[T\]\.asset, usdg \}\)/, "step 1f' checks the route with payoutRouteIssues");
  assert.doesNotMatch(step1f, /Number\(r\.tickSpacing\) === Number\(want\.tickSpacing\)/, "the unconditional tickSpacing compare is back");
  const story = src("3-story.mjs");
  assert.match(story, /expect\(paidThroughRegistryRoute\(route, M\[D\]\.payoutRoute\) && dualPaid\.length >= 3/, "3h checks the registry's venue");
  assert.doesNotMatch(story, /expect\(route\.venue === "V4"/, "3h requires a v4 route again");
});
