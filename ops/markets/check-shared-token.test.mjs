/**
 * Proves `check-shared-token.mjs` by breaking it against a CANNED chain — no network, no RPC.
 *
 * The canned chain answers exactly what a correct chain 4663 answers for the registry's own values
 * (code at every pinned contract, the token's symbol/decimals, StateView slot0/liquidity for the ONE
 * pool id the key hashes to, the hook's launch record for that id, the router's WETH9, the
 * factory's getPool). Everything else is "0x" or a revert, which is what a wrong key, a wrong hook or
 * an unknown id gets from the real PoolManager. So each broken registry must turn exactly the lines
 * the guard's header promises red, and the intact registry must be green.
 *
 * Hashing and selectors still go through `cast` (the guard's one dependency); the words are built
 * with the guard's own encoders so the fixture cannot drift from the decoder under test.
 *
 *   node --test ops/markets/check-shared-token.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  DYNAMIC_FEE_FLAG, addrWord, castTools, decodeLaunch, decodeSlot0, decodeString, encodePoolKey, intWord,
  runChecks, uintWord, words,
} from "./check-shared-token.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const tier1 = JSON.parse(readFileSync(path.join(here, "tier1.json"), "utf8"));
const sources = JSON.parse(readFileSync(path.join(here, "v2-sources.json"), "utf8"));
const clone = (o) => JSON.parse(JSON.stringify(o));
const lower = (a) => a.toLowerCase();

/*//////////////////////////////////////////////////////////////
                              PURE PIECES
//////////////////////////////////////////////////////////////*/

test("encodePoolKey: five words in field order, int24 tickSpacing as two's complement", () => {
  const key = { currency0: `0x${"0".repeat(40)}`, currency1: `0x${"ab".repeat(20)}`, fee: 0x800000, tickSpacing: -60, hooks: `0x${"cd".repeat(20)}` };
  const hex = encodePoolKey(key);
  const w = words(hex);
  assert.equal(w.length, 5);
  assert.equal(w[0], "0".repeat(64));
  assert.equal(w[1], "0".repeat(24) + "ab".repeat(20));
  assert.equal(w[2], "0".repeat(58) + "800000");
  assert.equal(w[3], "f".repeat(62) + "c4", "-60 is 0xff..c4 over 256 bits");
  assert.equal(w[4], "0".repeat(24) + "cd".repeat(20));
  assert.equal(intWord(200), "0".repeat(62) + "c8");
  assert.throws(() => uintWord(-1), /negative/);
  // The registry's own pin, recomputed by THIS encoder, not the builder's.
  assert.equal(words(encodePoolKey(tier1.shared.token.poolKey)).length, 5);
});

test("the pinned poolId is keccak256 of this encoder's words, and a one-unit change to the key moves it", async () => {
  const key = tier1.shared.token.poolKey;
  const id = (await castTools.keccak(encodePoolKey(key))).toLowerCase();
  assert.equal(id, tier1.shared.token.poolId.toLowerCase());
  const moved = (await castTools.keccak(encodePoolKey({ ...key, fee: key.fee + 1 }))).toLowerCase();
  assert.notEqual(moved, id, "a checker whose id cannot move proves nothing");
});

test("decoders: string, StateView slot0 with a negative tick, the thirteen-field launch record", () => {
  const str = "STONKHOUSE";
  const strHex = `0x${uintWord(32)}${uintWord(str.length)}${Buffer.from(str).toString("hex").padEnd(64, "0")}`;
  assert.equal(decodeString(strHex), str);
  const slot0 = decodeSlot0(`0x${uintWord(12345n)}${intWord(-197203)}${uintWord(0)}${uintWord(100)}`);
  assert.deepEqual(slot0, { sqrtPriceX96: 12345n, tick: -197203, protocolFee: 0, lpFee: 100 });
  const token = `0x${"c2".repeat(20)}`;
  const launch = decodeLaunch(`0x${uintWord(1)}${uintWord(0)}${addrWord(token)}${"0".repeat(64)}${"0".repeat(64 * 3)}${uintWord(100)}${uintWord(3000)}${uintWord(5000)}${uintWord(100)}${uintWord(300)}${uintWord(0)}`);
  assert.equal(launch.registered, true);
  assert.equal(launch.memecoinIsCurrency0, false);
  assert.equal(launch.memecoin, token);
  assert.equal(launch.quoteToken, `0x${"0".repeat(40)}`);
  assert.deepEqual([launch.creatorTaxBps, launch.protocolFeeShareBps, launch.buybackBurnBps, launch.hookFeeBps, launch.maxInternalPriceImpactBps, launch.buybackEnabled], [100, 3000, 5000, 100, 300, false]);
  assert.throws(() => decodeLaunch(`0x${uintWord(1)}`), /13/);
});

/*//////////////////////////////////////////////////////////////
                             THE CANNED CHAIN
//////////////////////////////////////////////////////////////*/

/** A chain that agrees with `registry` + `src` exactly once: for their own values and nothing else. */
async function cannedChain(registry, src) {
  const tools = castTools;
  const sel = async (sig) => (await tools.selector(sig)).toLowerCase();
  const S = Object.fromEntries(await Promise.all([
    "symbol()", "decimals()", "poolManager()", "getSlot0(bytes32)", "getLiquidity(bytes32)", "launches(bytes32)",
    "WETH9()", "fee()", "token0()", "token1()", "getPool(address,address,uint24)", "slot0()", "liquidity()",
  ].map(async (sig) => [sig, await sel(sig)])));
  const t = registry.shared.token;
  const c = (name) => src.contracts[name].address;
  const usdg = registry.shared.usdg;
  const poolId = (await tools.keccak(encodePoolKey(t.poolKey))).toLowerCase();
  const v3 = { pool: c("usdgWethV3Pool"), fee: 100, liquidity: 3350678233682306682n };
  const tiers = { 100: v3.pool, 500: `0x${"69".repeat(20)}`, 3000: `0x${"a9".repeat(20)}`, 10000: `0x${"5f".repeat(20)}` };
  const known = new Set([t.address, t.poolKey.hooks, c("weth"), c("usdgWethV3Pool"), c("v4StateView"), c("v4PoolManager"), c("factory"), c("router"), ...Object.values(tiers)].map(lower));
  const revert = () => { throw Object.assign(new Error("execution reverted"), { reverted: true }); };
  const word = (n) => `0x${uintWord(n)}`;
  const addr = (a) => `0x${addrWord(a)}`;
  const str = (s) => `0x${uintWord(32)}${uintWord(s.length)}${Buffer.from(s).toString("hex").padEnd(64, "0")}`;
  const launchFor = (id) => id === poolId
    ? `0x${uintWord(1)}${uintWord(0)}${addrWord(t.address)}${"0".repeat(64)}${"0".repeat(64 * 3)}${uintWord(100)}${uintWord(3000)}${uintWord(5000)}${uintWord(100)}${uintWord(300)}${uintWord(0)}`
    : `0x${"0".repeat(64 * 13)}`;
  const slot0For = (id) => id === poolId ? `0x${uintWord(215783155687869406744588924124585n)}${intWord(158201)}${uintWord(0)}${uintWord(t.poolKey.fee)}` : `0x${"0".repeat(256)}`;
  const calls = [];
  const rpc = async (method, params) => {
    calls.push([method, params]);
    if (method === "eth_getCode") return known.has(lower(params[0])) ? "0x6001" : "0x";
    if (method !== "eth_call") throw new Error(`canned chain has no ${method}`);
    const to = lower(params[0].to);
    const data = params[0].data.toLowerCase();
    const selector = data.slice(0, 10);
    const arg = (i) => data.slice(10 + i * 64, 10 + (i + 1) * 64);
    if (to === lower(t.address)) {
      if (selector === S["symbol()"]) return str(t.symbol);
      if (selector === S["decimals()"]) return word(t.decimals);
      return revert();
    }
    if (to === lower(c("v4StateView"))) {
      if (selector === S["poolManager()"]) return addr(c("v4PoolManager"));
      if (selector === S["getSlot0(bytes32)"]) return slot0For(`0x${arg(0)}`);
      if (selector === S["getLiquidity(bytes32)"]) return word(`0x${arg(0)}` === poolId ? 29277002188455995497142n : 0n);
      return revert();
    }
    if (to === lower(t.poolKey.hooks)) {
      if (selector === S["poolManager()"]) return addr(c("v4PoolManager"));
      if (selector === S["launches(bytes32)"]) return launchFor(`0x${arg(0)}`);
      return revert();
    }
    if (to === lower(c("router"))) return selector === S["WETH9()"] ? addr(c("weth")) : revert();
    if (to === lower(c("factory"))) {
      if (selector !== S["getPool(address,address,uint24)"]) return revert();
      const [a, b, fee] = [`0x${arg(0).slice(24)}`, `0x${arg(1).slice(24)}`, Number(BigInt(`0x${arg(2)}`))];
      const pair = new Set([lower(usdg), lower(c("weth"))]);
      return addr(pair.has(a) && pair.has(b) && a !== b && tiers[fee] ? tiers[fee] : `0x${"0".repeat(40)}`);
    }
    if (Object.values(tiers).map(lower).includes(to)) {
      const mine = to === lower(v3.pool);
      if (selector === S["fee()"]) return word(mine ? v3.fee : Number(Object.keys(tiers).find((k) => lower(tiers[k]) === to)));
      if (selector === S["token0()"]) return addr(c("weth"));
      if (selector === S["token1()"]) return addr(usdg);
      if (selector === S["slot0()"]) return `0x${uintWord(4138920278665617946763912n)}${intWord(-197203)}${"0".repeat(64 * 5)}`;
      if (selector === S["liquidity()"]) return word(mine ? v3.liquidity : 1n);
      return revert();
    }
    return revert();
  };
  return { rpc, calls, poolId };
}

/** T-OP-131's state: the three lowercase Uniswap v3 constants in canonical form, in both files. */
async function checksummed() {
  const r = clone(tier1);
  const s = clone(sources);
  for (const k of ["factory", "swapRouter02", "quoterV2"]) r.v2.uniswapV3[k] = await castTools.checksum(r.v2.uniswapV3[k]);
  for (const k of ["factory", "router", "quoter"]) s.contracts[k].address = await castTools.checksum(s.contracts[k].address);
  return { r, s };
}

const fails = (lines) => lines.filter((l) => l.startsWith("FAIL")).map((l) => l.slice(6).split(":")[0]);

test("intact registry + a chain that agrees with it: green, and the guard actually asked the chain", async () => {
  const { r, s } = await checksummed();
  const chain = await cannedChain(r, s);
  const { lines, failures } = await runChecks({ registry: r, sources: s, rpc: chain.rpc, block: "latest" });
  assert.equal(failures, 0, lines.filter((l) => l.startsWith("FAIL")).join("\n"));
  assert.ok(lines.some((l) => l.startsWith("ok    pool initialised") && l.includes(chain.poolId)), "slot0 asked for the pinned id");
  assert.ok(chain.calls.some(([m, p]) => m === "eth_call" && lower(p[0].to) === lower(s.contracts.v4StateView.address)), "StateView was read");
  assert.ok(chain.calls.some(([m, p]) => m === "eth_call" && lower(p[0].to) === lower(r.shared.token.poolKey.hooks)), "the hook was read");
});

test("the guard compares, it does not merely read: a chain whose token says another symbol goes red", async () => {
  const { r, s } = await checksummed();
  const chain = await cannedChain({ ...r, shared: { ...r.shared, token: { ...r.shared.token, symbol: "NOTSTONK" } } }, s);
  const { failures, lines } = await runChecks({ registry: r, sources: s, rpc: chain.rpc, block: "latest" });
  assert.deepEqual(fails(lines), ["token symbol"]);
  assert.equal(failures, 1);
});

test("fee flipped to the dynamic flag with the poolId left pinned: (2) red naming both ids", async () => {
  const { r, s } = await checksummed();
  const broken = clone(r);
  broken.shared.token.poolKey.fee = DYNAMIC_FEE_FLAG;
  const chain = await cannedChain(r, s);
  const { lines } = await runChecks({ registry: broken, sources: s, rpc: chain.rpc, block: "latest" });
  assert.deepEqual(fails(lines).filter((f) => f === "poolId recompute"), ["poolId recompute"]);
  const line = lines.find((l) => l.includes("poolId recompute"));
  assert.ok(line.includes(r.shared.token.poolId) && line.includes("names a different pool"), line);
});

test("fee flipped AND the poolId recomputed to match: (2) green, (3) red — only the chain can say the pool does not exist", async () => {
  const { r, s } = await checksummed();
  const broken = clone(r);
  broken.shared.token.poolKey.fee = DYNAMIC_FEE_FLAG;
  broken.shared.token.poolId = (await castTools.keccak(encodePoolKey(broken.shared.token.poolKey))).toLowerCase();
  const chain = await cannedChain(r, s);
  const { lines } = await runChecks({ registry: broken, sources: s, rpc: chain.rpc, block: "latest" });
  const f = fails(lines);
  assert.ok(!f.includes("poolId recompute"), "the pin is self-consistent, so (2) cannot see it");
  assert.ok(f.includes("pool initialised") && f.includes("pool liquidity"), f.join(", "));
  assert.ok(lines.find((l) => l.includes("pool initialised")).includes(broken.shared.token.poolId), "names the id that has no pool");
  assert.ok(f.includes("hooks.launches(poolId).registered"), "the hook has no record for that id either");
});

test("one address lowercased: (6) red naming it, canonical form shown", async () => {
  const { r, s } = await checksummed();
  const broken = clone(r);
  broken.shared.token.poolKey.hooks = lower(broken.shared.token.poolKey.hooks);
  const chain = await cannedChain(r, s);
  const { lines } = await runChecks({ registry: broken, sources: s, rpc: chain.rpc, block: "latest" });
  const line = lines.find((l) => l.startsWith("FAIL  eip55 registry shared.token.poolKey.hooks"));
  assert.ok(line && line.includes(r.shared.token.poolKey.hooks), line);
});

test("all-lowercase is refused, which viem's strict isAddress would NOT do: the rule is the preflight's", async () => {
  // The base registries carry three lowercase Uniswap v3 constants (T-OP-131's subject); under this
  // guard they are failures, under viem's strict mode they would pass. Both files, both names.
  const chain = await cannedChain(tier1, sources);
  const { lines } = await runChecks({ registry: tier1, sources, rpc: chain.rpc, block: "latest" });
  const f = fails(lines);
  for (const name of ["eip55 registry v2.uniswapV3.factory", "eip55 registry v2.uniswapV3.swapRouter02", "eip55 v2-sources contracts.factory.address", "eip55 v2-sources contracts.router.address"]) {
    assert.ok(f.includes(name), `${name} should be refused while lowercase; got ${f.join(", ")}`);
  }
});

test("wrong hooks (a contract with code that is not the launch hook), poolId recomputed to match: (3) and (4) red", async () => {
  const { r, s } = await checksummed();
  const broken = clone(r);
  broken.shared.token.poolKey.hooks = s.contracts.v4StateView.address;
  broken.shared.token.poolId = (await castTools.keccak(encodePoolKey(broken.shared.token.poolKey))).toLowerCase();
  const chain = await cannedChain(r, s);
  const { lines } = await runChecks({ registry: broken, sources: s, rpc: chain.rpc, block: "latest" });
  const f = fails(lines);
  assert.ok(f.includes("pool initialised"), f.join(", "));
  assert.ok(f.includes("hooks.launches(poolId)"), "a revert from launches() is a named FAIL, not UNABLE");
  assert.ok(lines.find((l) => l.startsWith("FAIL  hooks.launches(poolId)")).includes(s.contracts.v4StateView.address));
});

test("a wrong v3 pool (a real pool of another tier) or a wrong WETH is caught by derivation, not by code presence", async () => {
  const { r, s } = await checksummed();
  const chain = await cannedChain(r, s);
  const wrongPool = clone(s);
  wrongPool.contracts.usdgWethV3Pool.address = await castTools.checksum(`0x${"69".repeat(20)}`); // the 500 tier: has code, wrong tier
  let out = await runChecks({ registry: r, sources: wrongPool, rpc: chain.rpc, block: "latest" });
  assert.ok(fails(out.lines).includes("usdgWethV3Pool fee") && fails(out.lines).includes("usdgWethV3Pool derivation"), fails(out.lines).join(", "));
  const wrongWeth = clone(s);
  wrongWeth.contracts.weth.address = s.contracts.usdgWethV3Pool.address; // has code, is not what the router wraps
  out = await runChecks({ registry: r, sources: wrongWeth, rpc: chain.rpc, block: "latest" });
  assert.ok(fails(out.lines).includes("weth"), fails(out.lines).join(", "));
});

test("a missing input is UNABLE, never a pass", async () => {
  const { r, s } = await checksummed();
  const broken = clone(s);
  delete broken.contracts.v4StateView;
  const chain = await cannedChain(r, s);
  await assert.rejects(runChecks({ registry: r, sources: broken, rpc: chain.rpc, block: "latest" }), (e) => e.unable === true && /v4StateView/.test(e.message));
});
