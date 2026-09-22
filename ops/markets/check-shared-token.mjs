#!/usr/bin/env node
/**
 * ops/markets/check-shared-token.mjs — a read-only, on-chain guard for the launch pool T-OP-108 pinned.
 *
 *   node ops/markets/check-shared-token.mjs [--registry ops/markets/tier1.json]
 *        [--sources ops/markets/v2-sources.json] [--rpc URL] [--block N] [--v3-fee 100]
 *
 * WHAT IT PROVES, one line per assertion, exit 1 naming every failure, exit 2 when it cannot decide
 * (no `cast`, RPC unreachable, wrong chain). Nothing here is typed in: every expected value comes from
 * the registry, from `v2-sources.json`, or from a chain read that names its source.
 *
 *  (1) `shared.token.address` holds code and its own `symbol()` / `decimals()` equal the registry.
 *  (2) `shared.token.poolId` == keccak256(abi.encode(PoolKey)) recomputed here from the five v4 words
 *      (address, address, uint24, int24, address), NOT taken from the builder's `poolIdIssues`.
 *  (3) THE ONE NOBODY HAD PROVED. `StateView.getSlot0(poolId)` on chain 4663 answers a non-zero
 *      sqrtPriceX96 and `getLiquidity(poolId)` is positive — the pinned key IS the live, initialised
 *      launch pool, not a key that hashes to an id no pool has. A static key with the wrong fee (v4
 *      dynamic-fee pools carry 0x800000) or the wrong tickSpacing hashes to an id whose slot0 is zero,
 *      and this is the line that says so. For a static key the pool's lpFee must equal `poolKey.fee`.
 *  (4) `poolKey.hooks` holds code, names the same PoolManager the registry does, and its
 *      `launches(poolId)` record is registered for THIS token as currency1 against native ETH — the
 *      exact read `V4BuybackExecutor`'s constructor makes (`src/v2/periphery/V4BuybackExecutor.sol:280-285`),
 *      which otherwise costs a full deploy to learn.
 *  (5) `contracts.weth` == `SwapRouter02.WETH9()`; `contracts.usdgWethV3Pool` == `factory.getPool(USDG,
 *      WETH, 100)` (the route's tier, `USDG_WETH_V3_FEE`, `--v3-fee` to override) with code, `fee()` of
 *      that tier, its two tokens the pair, and its slot0 / liquidity printed beside the other three
 *      tiers so the reader can see whether the pinned tier is the deepest. The choice is stated, never
 *      changed here.
 *  (6) Every address this guard consumes is EIP-55 CANONICAL: it equals `cast to-check-sum-address` of
 *      itself. This is the broadcast preflight's rule (callhouse-contracts
 *      `script/v2/check-deploy-inputs.sh` `checksum_ok`), which REFUSES all-lowercase. It is stricter
 *      than viem's `isAddress(a, { strict: true })`, which accepts an all-lowercase address as
 *      "unchecksummed but legal" — a rule under which a lowercase constant passes and then stops the
 *      broadcast. `getAddress` / `cast to-check-sum-address` NORMALISE and prove nothing.
 *
 * Hashing goes through `cast keccak` / `cast to-check-sum-address` / `cast sig`, the same one
 * dependency `build-markets.mjs` and `r13-probe.mjs` use; viem is not resolvable from `ops/` (only
 * from `web/`). The RPC is plain JSON-RPC over `fetch`, every read pinned to ONE block so the lines
 * describe a single state, and that block is printed with the endpoint as provenance.
 *
 * Pure pieces (`encodePoolKey`, the decoders, `runChecks`) are exported so `check-shared-token.test.mjs`
 * can prove the guard by breaking it against a canned chain without a network.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const ADDRESS = /^0x[\da-fA-F]{40}$/;
const BYTES32 = /^0x[\da-f]{64}$/;
const ZERO = `0x${"0".repeat(40)}`;
/** v4's flag for a dynamic LP fee in `PoolKey.fee` (`LPFeeLibrary.DYNAMIC_FEE_FLAG`). */
export const DYNAMIC_FEE_FLAG = 0x800000;
const V3_FEE_TIERS = [100, 500, 3000, 10000];
/**
 * The fee tier of the USDG/WETH v3 pool the buyback's first leg swaps through: a ROUTE PARAMETER, not
 * an address, and the one number this guard does not read from a file. It is the same constant the
 * recon writes the pool from (`ops/recon/r13-probe.mjs` `USDG_WETH_V3_FEE`) and the contracts spike
 * derived (`callhouse-contracts/docs/V2-FLYWHEEL-ROUTE-SPIKE.md`, "v3 USDG/WETH 0.01 %"); `--v3-fee`
 * overrides it. The guard asserts the pinned pool IS that tier and IS the factory's pool for it.
 */
export const USDG_WETH_V3_FEE = 100;

/*//////////////////////////////////////////////////////////////
                         ABI WORDS AND DECODERS
//////////////////////////////////////////////////////////////*/

const strip = (h) => (h.startsWith("0x") ? h.slice(2) : h);
/** A 32-byte word for an address (left-padded, lowercased). */
export const addrWord = (a) => strip(a).toLowerCase().padStart(64, "0");
/** A 32-byte word for an unsigned integer. */
export function uintWord(v) {
  const n = BigInt(v);
  if (n < 0n) throw new Error(`uintWord: ${v} is negative`);
  return n.toString(16).padStart(64, "0");
}
/** A 32-byte word for a signed integer: two's complement over 256 bits, which `BigInt.asUintN` is. */
export const intWord = (v) => BigInt.asUintN(256, BigInt(v)).toString(16).padStart(64, "0");
const bytes32Word = (h) => strip(h).toLowerCase().padStart(64, "0");

/**
 * `abi.encode(PoolKey)` — the preimage of `PoolId.toId()`: five static words in field order
 * (currency0, currency1, fee uint24, tickSpacing int24, hooks). Written here on purpose rather than
 * imported from `build-markets.mjs`, so the registry's pin is checked by a second encoder.
 */
export function encodePoolKey({ currency0, currency1, fee, tickSpacing, hooks }) {
  return `0x${addrWord(currency0)}${addrWord(currency1)}${uintWord(fee)}${intWord(tickSpacing)}${addrWord(hooks)}`;
}

/** The 32-byte words of a return payload. */
export function words(hex) {
  const h = strip(hex);
  if (h.length % 64 !== 0) throw new Error(`payload of ${h.length / 2} bytes is not whole words`);
  const out = [];
  for (let i = 0; i < h.length; i += 64) out.push(h.slice(i, i + 64));
  return out;
}
const wordUint = (w) => BigInt(`0x${w}`);
const wordInt = (w, bits) => BigInt.asIntN(bits, BigInt(`0x${w}`));
const wordAddr = (w) => `0x${w.slice(24)}`;
const wordBool = (w) => wordUint(w) !== 0n;

/** ABI `string` return: offset, length, bytes. */
export function decodeString(hex) {
  const h = strip(hex);
  const offset = Number(BigInt(`0x${h.slice(0, 64)}`)) * 2;
  const length = Number(BigInt(`0x${h.slice(offset, offset + 64)}`)) * 2;
  return Buffer.from(h.slice(offset + 64, offset + 64 + length), "hex").toString("utf8");
}

/** `StateView.getSlot0(bytes32)` → (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee). */
export function decodeSlot0(hex) {
  const [a, b, c, d] = words(hex);
  return { sqrtPriceX96: wordUint(a), tick: Number(wordInt(b, 24)), protocolFee: Number(wordUint(c)), lpFee: Number(wordUint(d)) };
}

/** v3 `slot0()` → (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool). */
export function decodeV3Slot0(hex) {
  const [a, b] = words(hex);
  return { sqrtPriceX96: wordUint(a), tick: Number(wordInt(b, 24)) };
}

/**
 * `PonsV2MemeHook.launches(bytes32)` — the thirteen-field record, in the order the verified source
 * and `src/v2/periphery/BuybackDeps.sol` `IPonsLaunchHook` declare it.
 */
export function decodeLaunch(hex) {
  const w = words(hex);
  if (w.length < 13) throw new Error(`launches() answered ${w.length} words, expected 13`);
  return {
    registered: wordBool(w[0]),
    memecoinIsCurrency0: wordBool(w[1]),
    memecoin: wordAddr(w[2]),
    quoteToken: wordAddr(w[3]),
    creator: wordAddr(w[4]),
    buybackCreatorRecipient: wordAddr(w[5]),
    protocolFeeRecipient: wordAddr(w[6]),
    creatorTaxBps: Number(wordUint(w[7])),
    protocolFeeShareBps: Number(wordUint(w[8])),
    buybackBurnBps: Number(wordUint(w[9])),
    hookFeeBps: Number(wordUint(w[10])),
    maxInternalPriceImpactBps: Number(wordUint(w[11])),
    buybackEnabled: wordBool(w[12]),
  };
}

/*//////////////////////////////////////////////////////////////
                       CAST: HASHING, CHECKSUMS, SELECTORS
//////////////////////////////////////////////////////////////*/

const unable = (message) => Object.assign(new Error(message), { unable: true });
async function cast(args) {
  try {
    const { stdout } = await execFileP("cast", args, { timeout: 30_000 });
    return stdout.trim();
  } catch (e) {
    throw unable(`cast ${args[0]} failed (${e.code ?? e.message}); no cast means this guard cannot hash, so it refuses rather than passes`);
  }
}
/** Each `cast` answer is a pure function of its input, so it is asked once per process. */
function memo(fn) {
  const seen = new Map();
  return (input) => {
    if (!seen.has(input)) seen.set(input, fn(input));
    return seen.get(input);
  };
}
/** The default hashing/checksum/selector backend: foundry's `cast`. */
export const castTools = {
  keccak: memo((hex) => cast(["keccak", hex])),
  checksum: memo((a) => cast(["to-check-sum-address", a.toLowerCase()])),
  selector: memo((sig) => cast(["sig", sig])),
};

/*//////////////////////////////////////////////////////////////
                                THE CHECKS
//////////////////////////////////////////////////////////////*/

/**
 * Run every assertion against a chain reachable through `rpc(method, params)`. Returns the report
 * lines and the failure count; throws an `unable` error when it cannot decide. `block` is the hex
 * block tag every read is pinned to; the caller resolved it once.
 */
export async function runChecks({ registry, sources, rpc, block, tools = castTools, v3Fee = USDG_WETH_V3_FEE }) {
  const lines = [];
  let failures = 0;
  const ok = (name, detail) => lines.push(`ok    ${name}: ${detail}`);
  const fail = (name, detail) => { failures++; lines.push(`FAIL  ${name}: ${detail}`); };
  const check = (cond, name, detail) => (cond ? ok(name, detail) : fail(name, detail));

  const shared = registry?.shared ?? {};
  const token = shared.token ?? {};
  const key = token.poolKey ?? {};
  const contracts = sources?.contracts ?? {};
  const sourceAddr = (name) => contracts[name]?.address;

  // (6) Every address this guard consumes, canonical EIP-55, before any of them is sent anywhere.
  const consumed = [
    ["registry shared.usdg", shared.usdg],
    ["registry shared.token.address", token.address],
    ["registry shared.token.poolKey.currency0", key.currency0],
    ["registry shared.token.poolKey.currency1", key.currency1],
    ["registry shared.token.poolKey.hooks", key.hooks],
    ["registry v2.uniswapV3.factory", registry?.v2?.uniswapV3?.factory],
    ["registry v2.uniswapV3.swapRouter02", registry?.v2?.uniswapV3?.swapRouter02],
    ["v2-sources contracts.weth.address", sourceAddr("weth")],
    ["v2-sources contracts.usdgWethV3Pool.address", sourceAddr("usdgWethV3Pool")],
    ["v2-sources contracts.v4StateView.address", sourceAddr("v4StateView")],
    ["v2-sources contracts.v4PoolManager.address", sourceAddr("v4PoolManager")],
    ["v2-sources contracts.factory.address", sourceAddr("factory")],
    ["v2-sources contracts.router.address", sourceAddr("router")],
  ];
  for (const [name, value] of consumed) {
    if (typeof value !== "string" || !ADDRESS.test(value)) { fail(`eip55 ${name}`, `${JSON.stringify(value)} is not an address`); continue; }
    const canonical = await tools.checksum(value);
    check(canonical === value, `eip55 ${name}`, canonical === value ? value : `${value} is not canonical EIP-55 (${canonical})`);
  }
  const required = ["shared.usdg", "shared.token.address", "poolKey.currency1", "poolKey.hooks", "weth", "usdgWethV3Pool", "v4StateView", "factory", "router"];
  const have = [shared.usdg, token.address, key.currency1, key.hooks, sourceAddr("weth"), sourceAddr("usdgWethV3Pool"), sourceAddr("v4StateView"), sourceAddr("factory"), sourceAddr("router")];
  const missing = required.filter((_, i) => typeof have[i] !== "string" || !ADDRESS.test(have[i]));
  if (missing.length) throw unable(`cannot read the chain without ${missing.join(", ")}`);
  const usdg = shared.usdg;
  const stateView = sourceAddr("v4StateView");
  const poolManager = sourceAddr("v4PoolManager");
  const factory = sourceAddr("factory");
  const router = sourceAddr("router");
  check(typeof registry?.v2?.uniswapV3?.factory === "string" && registry.v2.uniswapV3.factory.toLowerCase() === factory.toLowerCase(),
    "factory tie", `registry v2.uniswapV3.factory and v2-sources contracts.factory name the same contract (${factory})`);
  check(typeof registry?.v2?.uniswapV3?.swapRouter02 === "string" && registry.v2.uniswapV3.swapRouter02.toLowerCase() === router.toLowerCase(),
    "router tie", `registry v2.uniswapV3.swapRouter02 and v2-sources contracts.router name the same contract (${router})`);

  const sel = async (sig) => strip(await tools.selector(sig));
  // A revert or an empty answer is a FINDING about the contract asked (a wrong hooks address has no
  // `launches`), so `call` turns it into "0x" and the assertion below names it; only transport, HTTP
  // and chain-level errors stay UNABLE. The rpc marks a revert with `reverted: true`.
  const call = async (to, sig, args = "") => {
    try { return await rpc("eth_call", [{ to, data: `0x${await sel(sig)}${args}` }, block]); }
    catch (e) { if (e?.reverted) return "0x"; throw e; }
  };
  const code = async (a) => rpc("eth_getCode", [a, block]);
  const hasCode = (c) => typeof c === "string" && c !== "0x" && c.length > 2;
  const addrOf = (raw) => (hasCode(raw) && strip(raw).length >= 64 ? wordAddr(words(raw)[0]) : null);
  const uintOf = (raw) => (hasCode(raw) && strip(raw).length >= 64 ? wordUint(words(raw)[0]) : null);

  // (1) the token itself.
  check(hasCode(await code(token.address)), "token code", `${token.address} holds ${(strip(await code(token.address)).length / 2)} bytes`);
  const symbolRaw = await call(token.address, "symbol()");
  const symbol = hasCode(symbolRaw) ? decodeString(symbolRaw) : null;
  check(symbol === token.symbol, "token symbol", `chain symbol() ${JSON.stringify(symbol)} vs registry ${JSON.stringify(token.symbol)}`);
  const decimalsRaw = uintOf(await call(token.address, "decimals()"));
  const decimals = decimalsRaw === null ? null : Number(decimalsRaw);
  check(decimals === token.decimals, "token decimals", `chain decimals() ${decimals} vs registry ${token.decimals}`);

  // (2) the pool id, recomputed from the five words.
  check(Number.isInteger(key.fee) && key.fee >= 0 && key.fee <= 0xffffff, "poolKey.fee", `${JSON.stringify(key.fee)} is a uint24`);
  check(Number.isInteger(key.tickSpacing) && key.tickSpacing >= -0x800000 && key.tickSpacing <= 0x7fffff, "poolKey.tickSpacing", `${JSON.stringify(key.tickSpacing)} is an int24`);
  check(typeof key.currency0 === "string" && key.currency0 === ZERO, "poolKey.currency0", `${key.currency0} is native ETH (the zero address)`);
  check(typeof key.currency1 === "string" && key.currency1.toLowerCase() === String(token.address).toLowerCase(), "poolKey.currency1", `${key.currency1} is shared.token.address`);
  check(typeof token.poolId === "string" && BYTES32.test(token.poolId), "poolId shape", `${token.poolId} is 32 lowercase hex bytes`);
  const encodable = Number.isInteger(key.fee) && key.fee >= 0 && Number.isInteger(key.tickSpacing)
    && [key.currency0, key.currency1, key.hooks].every((a) => typeof a === "string" && ADDRESS.test(a));
  if (!encodable) throw unable("the pool key is not encodable; fix the lines above first");
  const preimage = encodePoolKey(key);
  const computed = (await tools.keccak(preimage)).toLowerCase();
  const pinned = String(token.poolId).toLowerCase();
  check(computed === pinned, "poolId recompute", computed === pinned
    ? `keccak256(abi.encode(${key.currency0}, ${key.currency1}, ${key.fee}, ${key.tickSpacing}, ${key.hooks})) == ${pinned}`
    : `keccak256(abi.encode(PoolKey)) is ${computed} but the registry pins ${pinned}: the pinned id names a different pool`);

  // (3) the pinned id is a live, initialised v4 pool — asked of the PoolManager's own state, by id.
  check(hasCode(await code(stateView)), "stateView code", `${stateView} holds code`);
  const svManager = addrOf(await call(stateView, "poolManager()"));
  check(svManager !== null && svManager.toLowerCase() === String(poolManager).toLowerCase(), "stateView.poolManager()", `${svManager} vs v2-sources contracts.v4PoolManager ${poolManager}`);
  const slot0Raw = await call(stateView, "getSlot0(bytes32)", bytes32Word(pinned));
  const slot0 = hasCode(slot0Raw) ? decodeSlot0(slot0Raw) : null;
  check(slot0 !== null && slot0.sqrtPriceX96 !== 0n, "pool initialised", slot0 === null
    ? `StateView.getSlot0(${pinned}) answered nothing`
    : slot0.sqrtPriceX96 !== 0n
      ? `StateView.getSlot0(${pinned}): sqrtPriceX96 ${slot0.sqrtPriceX96}, tick ${slot0.tick}, protocolFee ${slot0.protocolFee}, lpFee ${slot0.lpFee}`
      : `StateView.getSlot0(${pinned}) has sqrtPriceX96 0: no pool with this id is initialised on this chain, so the key (fee ${key.fee}, tickSpacing ${key.tickSpacing}, hooks ${key.hooks}) does not describe the live launch pool`);
  const liquidity = uintOf(await call(stateView, "getLiquidity(bytes32)", bytes32Word(pinned))) ?? 0n;
  check(liquidity > 0n, "pool liquidity", `StateView.getLiquidity(${pinned}) = ${liquidity}`);
  if (slot0 !== null && key.fee !== DYNAMIC_FEE_FLAG) {
    check(slot0.lpFee === key.fee, "pool lpFee", `static key fee ${key.fee} vs the pool's lpFee ${slot0.lpFee}`);
  } else if (slot0 !== null) {
    ok("pool lpFee", `dynamic-fee key (0x800000); the pool's lpFee is ${slot0.lpFee} and is set by the hook`);
  }

  // (4) the hook: code, the same PoolManager, and its launch record for this id.
  check(hasCode(await code(key.hooks)), "hooks code", `${key.hooks} holds code`);
  const hookManager = addrOf(await call(key.hooks, "poolManager()"));
  check(hookManager !== null && hookManager.toLowerCase() === String(poolManager).toLowerCase(), "hooks.poolManager()", `${hookManager} vs v2-sources contracts.v4PoolManager ${poolManager}`);
  const launchRaw = await call(key.hooks, "launches(bytes32)", bytes32Word(pinned));
  const launch = hasCode(launchRaw) && strip(launchRaw).length >= 13 * 64 ? decodeLaunch(launchRaw) : null;
  if (launch === null) {
    fail("hooks.launches(poolId)", `${key.hooks} answered ${hasCode(launchRaw) ? `${strip(launchRaw).length / 2} bytes` : "nothing (reverted or empty)"} for ${pinned}: not the launch hook's thirteen-field record, which V4BuybackExecutor's constructor reads and reverts NoSource without`);
  } else {
    check(launch.registered, "hooks.launches(poolId).registered", `${launch.registered}`);
    check(launch.memecoin.toLowerCase() === String(token.address).toLowerCase() && !launch.memecoinIsCurrency0,
      "hooks.launches(poolId).memecoin", `${launch.memecoin} as currency${launch.memecoinIsCurrency0 ? 0 : 1} vs shared.token.address ${token.address} as currency1`);
    check(launch.quoteToken === ZERO, "hooks.launches(poolId).quoteToken", `${launch.quoteToken} (native ETH is the zero address)`);
    ok("hooks.launches(poolId) terms", `creatorTaxBps ${launch.creatorTaxBps}, hookFeeBps ${launch.hookFeeBps}, protocolFeeShareBps ${launch.protocolFeeShareBps}, buybackBurnBps ${launch.buybackBurnBps}, maxInternalPriceImpactBps ${launch.maxInternalPriceImpactBps}, buybackEnabled ${launch.buybackEnabled}`);
  }

  // (5) the buyback's first leg: WETH from the router, the v3 pool from the factory.
  const weth = sourceAddr("weth");
  const v3Pool = sourceAddr("usdgWethV3Pool");
  const routerWeth = addrOf(await call(router, "WETH9()"));
  check(routerWeth !== null && routerWeth.toLowerCase() === weth.toLowerCase(), "weth", `SwapRouter02.WETH9() ${routerWeth} vs v2-sources contracts.weth ${weth}`);
  check(hasCode(await code(weth)), "weth code", `${weth} holds code`);
  check(hasCode(await code(v3Pool)), "usdgWethV3Pool code", `${v3Pool} holds code`);
  const poolFeeRaw = uintOf(await call(v3Pool, "fee()"));
  const poolFee = poolFeeRaw === null ? null : Number(poolFeeRaw);
  check(poolFee === v3Fee, "usdgWethV3Pool fee", `pool.fee() = ${poolFee} vs the route's tier ${v3Fee}`);
  const t0 = addrOf(await call(v3Pool, "token0()"))?.toLowerCase() ?? null;
  const t1 = addrOf(await call(v3Pool, "token1()"))?.toLowerCase() ?? null;
  const pair = new Set([usdg.toLowerCase(), weth.toLowerCase()]);
  check(t0 !== null && t1 !== null && pair.has(t0) && pair.has(t1) && t0 !== t1, "usdgWethV3Pool pair", `token0 ${t0}, token1 ${t1} vs USDG ${usdg} / WETH ${weth}`);
  const getPool = async (fee) => addrOf(await call(factory, "getPool(address,address,uint24)", addrWord(usdg) + addrWord(weth) + uintWord(fee)));
  const fromFactory = await getPool(v3Fee);
  check(fromFactory !== null && fromFactory.toLowerCase() === v3Pool.toLowerCase(), "usdgWethV3Pool derivation",
    `factory.getPool(USDG, WETH, ${v3Fee}) = ${fromFactory} vs v2-sources contracts.usdgWethV3Pool ${v3Pool}`);
  const v3Slot0Raw = await call(v3Pool, "slot0()");
  const v3Slot0 = hasCode(v3Slot0Raw) && strip(v3Slot0Raw).length >= 2 * 64 ? decodeV3Slot0(v3Slot0Raw) : { sqrtPriceX96: null, tick: null };
  const v3Liquidity = uintOf(await call(v3Pool, "liquidity()"));
  check(v3Slot0.sqrtPriceX96 !== null && v3Slot0.sqrtPriceX96 !== 0n && v3Liquidity !== null && v3Liquidity > 0n, "usdgWethV3Pool state",
    `slot0 sqrtPriceX96 ${v3Slot0.sqrtPriceX96}, tick ${v3Slot0.tick}; liquidity ${v3Liquidity}`);
  const tiers = [];
  for (const fee of V3_FEE_TIERS) {
    const p = await getPool(fee);
    if (p === null || p === ZERO) { tiers.push(`${fee}: no pool`); continue; }
    const l = (hasCode(await code(p)) ? uintOf(await call(p, "liquidity()")) : null) ?? 0n;
    tiers.push(`${fee}: ${p} liquidity ${l}${p.toLowerCase() === v3Pool.toLowerCase() ? " (pinned)" : ""}`);
  }
  const deepest = tiers.filter((t) => t.includes("liquidity")).map((t) => ({ t, l: BigInt(t.split("liquidity ")[1].split(" ")[0]) }))
    .sort((a, b) => (a.l < b.l ? 1 : a.l > b.l ? -1 : 0))[0];
  ok("usdgWethV3Pool tiers", `${tiers.join("; ")} — the pinned tier is ${deepest?.t.includes("(pinned)") ? "" : "NOT "}the deepest by in-range liquidity (stated, not changed)`);

  return { lines, failures };
}

/*//////////////////////////////////////////////////////////////
                                   CLI
//////////////////////////////////////////////////////////////*/

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

async function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const registryPath = path.resolve(arg("--registry", path.join(here, "tier1.json")));
  const sourcesPath = path.resolve(arg("--sources", path.join(here, "v2-sources.json")));
  const registry = JSON.parse(readFileSync(registryPath, "utf8"));
  const sources = JSON.parse(readFileSync(sourcesPath, "utf8"));
  const rpcUrl = arg("--rpc", process.env.RH_PUBLIC_RPC ?? registry.rpc ?? sources.rpc);
  if (!rpcUrl) throw unable("no RPC: pass --rpc, set RH_PUBLIC_RPC, or give the registry an `rpc` field");
  let id = 0;
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  // The public 4663 endpoint answers HTTP 429 to a burst of a few dozen reads; back off and retry rather
  // than report a rate limit as a chain fact. Anything else is UNABLE, never a pass.
  const rpc = async (method, params) => {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }), signal: AbortSignal.timeout(30_000) });
      } catch (e) { throw unable(`${method}: ${rpcUrl} unreachable (${e.message})`); }
      if (res.status === 429 && attempt < 6) { await sleep(500 * 2 ** attempt); continue; }
      if (!res.ok) throw unable(`${method}: HTTP ${res.status} from ${rpcUrl}`);
      const body = await res.json();
      if (body.error) {
        const message = `${method}: ${body.error.message ?? JSON.stringify(body.error)}`;
        // A revert on eth_call is the contract's answer, which runChecks turns into a named FAIL.
        if (method === "eth_call") throw Object.assign(new Error(message), { reverted: true });
        throw unable(message);
      }
      await sleep(120);
      return body.result;
    }
  };
  const chainId = Number(await rpc("eth_chainId", []));
  const want = Number(registry?.shared?.chainId);
  if (chainId !== want) throw unable(`${rpcUrl} is chain ${chainId}, the registry is chain ${want}: refusing to read the wrong chain`);
  const blockArg = arg("--block");
  const block = blockArg ? `0x${BigInt(blockArg).toString(16)}` : await rpc("eth_blockNumber", []);
  console.log(`check-shared-token: ${path.relative(process.cwd(), registryPath)} + ${path.relative(process.cwd(), sourcesPath)}; chain ${chainId} via ${rpcUrl}; every read at block ${Number(block)}`);
  const v3Fee = Number(arg("--v3-fee", USDG_WETH_V3_FEE));
  if (!V3_FEE_TIERS.includes(v3Fee)) throw unable(`--v3-fee ${v3Fee} is not a Uniswap v3 tier (${V3_FEE_TIERS.join(", ")})`);
  const { lines, failures } = await runChecks({ registry, sources, rpc, block, v3Fee });
  for (const line of lines) console.log(line);
  console.log(failures === 0 ? `PASS: ${lines.length} assertions at block ${Number(block)}` : `FAIL: ${failures} of ${lines.length} assertions failed at block ${Number(block)}`);
  process.exit(failures === 0 ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.unable ? `UNABLE: ${e.message}` : (e.stack ?? String(e)));
    process.exit(2);
  });
}
