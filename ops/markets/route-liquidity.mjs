/**
 * ops/markets/route-liquidity.mjs — every pool the system routes through must be a DEEP pool.
 *
 *   node ops/markets/route-liquidity.mjs                       # measure the committed registry, print, exit 1 on FAIL
 *   node ops/markets/route-liquidity.mjs --json                # the same, machine-readable
 *   node ops/markets/route-liquidity.mjs --registry <file>     # another registry
 *   RH_RPC=<url> ...                                           # endpoint (default: the public primary)
 *   node --test ops/markets/route-liquidity.test.mjs
 *
 * `build-markets.mjs --check` calls {routeLiquidityIssues}, so a shallow route can never be registered again.
 *
 * No route anywhere may reference a low-liquidity pool.
 *
 * WHAT "DEEP" MEANS HERE, AND WHAT IT DELIBERATELY DOES NOT MEAN. A swap's price is set by the liquidity that is IN
 * RANGE NEAR THE CURRENT PRICE, not by a pool's TVL: a pool can hold millions in positions parked far from spot and
 * still move 5 % on a small trade. So the measure is the USDG a trade must spend (or receive) to move the pool's price
 * by BAND_BPS from spot, in each direction, walking every initialized tick in between exactly as the pool would.
 * That is read from the chain on every run -- slot0, active liquidity, the tick bitmap and each initialized tick's
 * liquidityNet -- and never from the registry, TVL figures or an indexer.
 *
 * THE RULE. A referenced pool FAILS when either
 *   (a) its depth in the weaker direction is below MIN_DEPTH_USD (absolute floor), or
 *   (b) it holds less than MIN_SHARE_OF_DEEPEST of the depth of the deepest candidate for the same pair.
 * Candidates are every Uniswap v3 pool the canonical factory returns for the pair at V3_FEE_TIERS, plus every
 * HOOKLESS static-fee Uniswap v4 pool the PoolManager ever initialized for the pair (its `Initialize` logs, filtered by
 * currency0/currency1 topic). Only hookless static-fee v4 pools can be a PayoutRouter route (PayoutRouter.sol:88-92),
 * so a hooked pool is never offered as "the deeper alternative". A candidate whose price is more than
 * MAX_SPOT_DEVIATION_BPS away from the referenced pools' median is not a real market for the pair and is excluded
 * (named in the output), so a stray pool initialized at a silly price cannot become the yardstick.
 * The thresholds are the constants in this file.
 *
 * THE FEE RULE. Depth cannot see a deep route that costs more than the payout floor
 * credits. A PAYOUT ROUTE also FAILS when
 *   (c) its cost for the payout's direction (the asset sold into USDG) is above MAX_ROUTE_FEE_TIER pips: v4 is
 *       slot0's lpFee plus the protocol-fee half for that direction, v3 is the pool fee (v3's protocol fee is taken
 *       out of the LP fee). This mirrors PayoutRouter._v4FeeBps, which refuses such a route with ROUTE_COST, and
 *       Clearinghouse._conversionFloor, which credits at most MAX_ROUTE_FEE_BPS of route fee; or
 *   (d) it is the LIVE route and its cost, in bps rounded up, is above what the floor credits for it:
 *       min(PayoutRouter.routeFeeBps(asset), MAX_ROUTE_FEE_BPS). The router caches the fee at setRoute time; a
 *       protocol fee raised since then leaves the floor short until someone calls refreshRouteFee(asset).
 * Either way the fee the floor did not credit comes out of the maxPayoutSlippageBps budget meant for price impact, so
 * payouts miss the floor (BadPrice) and pay in kind at sizes a correctly priced route converts. The rule is stricter
 * than the doc's first wording (cost above maxPayoutSlippageBps + MAX_ROUTE_FEE_BPS): that would pass SPCX's 1 %
 * route at 110 bps, and the slippage budget is for price impact, not for fee the floor never credited.
 *
 * WHAT IS CHECKED. Registry-controlled references, which FAIL the check:
 *   - each market's payout route: the registry's `v2.payoutRoute` AND the live `PayoutRouter.routes(asset)`; if the
 *     two disagree that is itself a FAIL (a check that reads the registry but never the chain cannot see drift);
 *   - each market's settlement TWAP pool: the registry's `v2.univ3Pool` AND the live `UniV3TwapSource.pools(asset)`.
 *   Both equalities are waived for a market that is not registered yet (`v2.registeredAt` null) while its chain slot is
 *   still empty, because RegisterMarkets writes both slots after the deploy writeback; that is reported, and
 *   the registry reference is still measured for depth.
 * On-chain immutables, which are REPORTED (the fix is a redeploy, not a registry edit, so a permanently red check
 * would only teach people to ignore it):
 *   - the V4BuybackExecutor's USDG/WETH v3 pool (`v3Pool()`);
 *   - the STONKHOUSE token pool (`shared.token.poolKey`, the executor's `poolId()`): a hooked ETH/token pool with no
 *     USDG side, measured in ETH and reported without the USD floor.
 *
 * NUMBERS. Depth is a measurement for a threshold, not an amount anyone is paid, so it is computed in IEEE doubles
 * from the exact on-chain integers (sqrt price at a tick = 1.0001^(tick/2)); the relative error is far below the
 * margin of either threshold. Nothing here decides a payout.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/*//////////////////////////////////////////////////////////////
                              THRESHOLDS
//////////////////////////////////////////////////////////////*/

/** Depth is measured over a price move of this many bps from spot, each direction. 100 = 1 %. */
export const BAND_BPS = 100;
/** Absolute floor, USD of USDG, on the weaker side of a BAND_BPS move. */
export const MIN_DEPTH_USD = 50_000;
/** A referenced pool must hold at least this share of the deepest candidate's depth. */
export const MIN_SHARE_OF_DEEPEST = 0.5;
/** A candidate this far from the referenced pools' median spot is not a market for the pair (excluded, named). */
export const MAX_SPOT_DEVIATION_BPS = 500;
/** The standard Uniswap v3 fee tiers the canonical factory is asked about, plus any tier a reference names. */
export const V3_FEE_TIERS = [100, 500, 3000, 10000];
/** V2Constants.MAX_ROUTE_FEE_TIER: no route of either venue may name a higher fee (PayoutRouter.sol:75, :89). */
export const MAX_ROUTE_FEE_TIER = 10_000;
/** V2Constants.MAX_ROUTE_FEE_BPS: the most route fee Clearinghouse._conversionFloor credits (= the tier in bps). */
export const MAX_ROUTE_FEE_BPS = MAX_ROUTE_FEE_TIER / 100;
/** Uniswap v4 LPFeeLibrary.DYNAMIC_FEE_FLAG (PayoutRouter.sol:28): a fee with this bit set is not a static fee. */
export const DYNAMIC_FEE_FLAG = 0x800000;
/** Only the deepest few candidates by active liquidity get the full tick walk; active L orders a pair's pools. */
export const CANDIDATES_WALKED = 4;

/*//////////////////////////////////////////////////////////////
                        PINNED CONSTANTS (asserted)
//////////////////////////////////////////////////////////////*/

/**
 * Four-byte selectors, pinned so this file needs no ABI library. Each is re-derived with `cast sig` by
 * route-liquidity.test.mjs, so a typo cannot survive the test run.
 */
export const SELECTORS = Object.freeze({
  "slot0()": "0x3850c7bd",
  "liquidity()": "0x1a686502",
  "tickSpacing()": "0xd0c93a7c",
  "token0()": "0x0dfe1681",
  "token1()": "0xd21220a7",
  "fee()": "0xddca3f43",
  "tickBitmap(int16)": "0x5339c296",
  "ticks(int24)": "0xf30dba93",
  "getPool(address,address,uint24)": "0x1698ee82",
  "getSlot0(bytes32)": "0xc815641c",
  "getLiquidity(bytes32)": "0xfa6793d5",
  "getTickBitmap(bytes32,int16)": "0x1c7ccb4c",
  "getTickLiquidity(bytes32,int24)": "0xcaedab54",
  "routes(address)": "0xd7409659",
  "routeFeeBps(address)": "0xbd28dba2",
  "poolManager()": "0xdc4c90d3",
  "v4StateView()": "0x297e3969",
  "pools(address)": "0xa4063dbc",
  "v3Pool()": "0x3a924d5b",
  "weth()": "0x3fc8cef3",
  "poolId()": "0x3e0dc34e",
  "decimals()": "0x313ce567",
  "aggregate3((address,bool,bytes)[])": "0x82ad56cb",
});

/** keccak256("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)"), re-derived by the test. */
export const V4_INITIALIZE_TOPIC = "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438";

const ZERO = "0x0000000000000000000000000000000000000000";
const Q96 = 2 ** 96;

/*//////////////////////////////////////////////////////////////
                           PURE MATHS (offline)
//////////////////////////////////////////////////////////////*/

/** sqrt(1.0001^tick): the pool's sqrt price at a tick boundary, in raw token1-per-token0 units. */
export function sqrtAtTick(tick) {
  return Math.pow(1.0001, tick / 2);
}

/** sqrtPriceX96 (decimal string, bigint or number) as a double. */
export function sqrtFromX96(x96) {
  return Number(BigInt(x96)) / Q96;
}

/**
 * Walk a concentrated-liquidity curve from the current price to `targetSqrt`, crossing every initialized tick on the
 * way exactly as the pool does: moving UP across tick t adds liquidityNet(t), moving DOWN across t subtracts it.
 * Returns the raw token amounts that move over the walk: amount1 = Σ L·Δ√P, amount0 = Σ L·Δ(1/√P).
 *
 * @param {{sqrtP:number, tick:number, liquidity:bigint|number, ticks:{tick:number, liquidityNet:bigint|number}[]}} s
 * @param {number} targetSqrt
 */
export function walk(s, targetSqrt) {
  const up = targetSqrt > s.sqrtP;
  let L = Number(s.liquidity);
  let cur = s.sqrtP;
  let amount0 = 0;
  let amount1 = 0;
  const add = (lo, hi) => {
    const l = Math.max(0, L);
    amount1 += l * (hi - lo);
    amount0 += l * (1 / lo - 1 / hi);
  };
  if (up) {
    const bounds = s.ticks.filter((t) => t.tick > s.tick).sort((a, b) => a.tick - b.tick);
    for (const b of bounds) {
      const at = sqrtAtTick(b.tick);
      if (at >= targetSqrt) break;
      if (at > cur) add(cur, at);
      cur = Math.max(cur, at);
      L += Number(b.liquidityNet);
    }
    if (targetSqrt > cur) add(cur, targetSqrt);
  } else {
    const bounds = s.ticks.filter((t) => t.tick <= s.tick).sort((a, b) => b.tick - a.tick);
    for (const b of bounds) {
      const at = sqrtAtTick(b.tick);
      if (at <= targetSqrt) break;
      if (at < cur) add(at, cur);
      cur = Math.min(cur, at);
      L -= Number(b.liquidityNet);
    }
    if (targetSqrt < cur) add(targetSqrt, cur);
  }
  return { amount0, amount1 };
}

/**
 * Depth of one pool around its spot, in units of the QUOTE token (USDG for a Stock Token pair; for the token pool,
 * ETH): what a trade receives when it pushes the base's price down by `bandBps` (sell) and what it spends pushing it
 * up by `bandBps` (buy). `quoteIsToken0` says which side the quote is on; `quoteDecimals` scales raw units.
 */
export function depth(state, { quoteIsToken0, quoteDecimals, bandBps = BAND_BPS }) {
  const b = bandBps / 10_000;
  const s = { ...state, sqrtP: sqrtFromX96(state.sqrtPriceX96) };
  // Base price in quote units falls on a sell. Pool price P = token1/token0.
  //   quote = token0: base is token1; base price = 1/P; a sell raises P.   quote = token1: a sell lowers P.
  const sellTarget = quoteIsToken0 ? s.sqrtP / Math.sqrt(1 - b) : s.sqrtP * Math.sqrt(1 - b);
  const buyTarget = quoteIsToken0 ? s.sqrtP / Math.sqrt(1 + b) : s.sqrtP * Math.sqrt(1 + b);
  const sell = walk(s, sellTarget);
  const buy = walk(s, buyTarget);
  const scale = 10 ** quoteDecimals;
  const pick = (a) => (quoteIsToken0 ? a.amount0 : a.amount1) / scale;
  const sellQuote = pick(sell);
  const buyQuote = pick(buy);
  // Spot of the base in quote units, human-scaled by both decimals (base decimals applied by the caller's `baseDecimals`).
  return { sell: sellQuote, buy: buyQuote, weaker: Math.min(sellQuote, buyQuote) };
}

/** Human spot price of the base in quote units. */
export function spot(sqrtPriceX96, { quoteIsToken0, quoteDecimals, baseDecimals }) {
  const p = sqrtFromX96(sqrtPriceX96) ** 2; // raw token1 per raw token0
  const raw = quoteIsToken0 ? 1 / p : p; // raw quote per raw base
  return raw * 10 ** (baseDecimals - quoteDecimals);
}

/** Median of a non-empty list of numbers. */
export function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * The verdict on one referenced pool against the deepest candidate of its pair. Pure.
 * @returns {{ok:boolean, reasons:string[]}}
 */
export function judge(ref, deepest, { minDepth = MIN_DEPTH_USD, minShare = MIN_SHARE_OF_DEEPEST, absolute = true } = {}) {
  const reasons = [];
  if (absolute && !(ref.depth.weaker >= minDepth)) {
    reasons.push(`depth ${fmt(ref.depth.weaker)} within ±${BAND_BPS} bps is below the ${fmt(minDepth)} floor`);
  }
  if (deepest && (deepest.id ?? deepest.label) !== (ref.id ?? ref.label) && deepest.depth.weaker > 0) {
    const share = ref.depth.weaker / deepest.depth.weaker;
    if (!(share >= minShare)) {
      reasons.push(`holds ${(share * 100).toFixed(1)} % of the depth of the deepest candidate ${deepest.label} (${fmt(deepest.depth.weaker)}); the floor is ${(minShare * 100).toFixed(0)} %`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * What a swap SELLING the asset through a payout route costs, in pips and in bps rounded up. Pure.
 * v4 mirrors PayoutRouter._v4FeeBps: lpFee + (zeroForOne ? protocolFee & 0xFFF : protocolFee >> 12), where
 * zeroForOne is "the asset is currency0" (V4Types.zeroForOne). v3 mirrors _v3FeeBps: the pool fee alone, because v3's
 * protocol fee is a share of the LP fee. A cost that cannot be read is `null`, which {judgeFee} FAILS.
 * @param {{venue:string, fee?:number, lpFee?:number, protocolFee?:number}} ref
 * @param {boolean} zeroForOne
 * @returns {{pips:number, bps:number, lp:number, protocol:number} | null}
 */
export function routeCost(ref, zeroForOne) {
  const int = (x) => Number.isInteger(x) && x >= 0;
  if (ref.venue === "v3") {
    if (!int(ref.fee)) return null;
    return { pips: ref.fee, bps: Math.ceil(ref.fee / 100), lp: ref.fee, protocol: 0 };
  }
  if (!int(ref.lpFee) || !int(ref.protocolFee)) return null;
  const protocol = zeroForOne ? ref.protocolFee & 0xfff : ref.protocolFee >> 12;
  const pips = ref.lpFee + protocol;
  return { pips, bps: Math.ceil(pips / 100), lp: ref.lpFee, protocol };
}

/**
 * The fee verdict on one payout route. Pure. `cachedBps` is PayoutRouter.routeFeeBps(asset), passed only when `ref`
 * IS the live route (the cache describes that route and no other).
 * @returns {{ok:boolean, reasons:string[], cost:ReturnType<typeof routeCost>}}
 */
export function judgeFee(ref, { zeroForOne, cachedBps = undefined }) {
  const cost = routeCost(ref, zeroForOne);
  if (cost === null) return { ok: false, reasons: ["its fee could not be read, so its cost against the conversion floor is unknown"], cost };
  const what = ref.venue === "v3" ? `pool fee ${cost.pips} pips` : `lpFee ${cost.lp} + protocol fee ${cost.protocol} pips on the sell side = ${cost.pips} pips`;
  const reasons = [];
  if (cost.pips > MAX_ROUTE_FEE_TIER) {
    reasons.push(`${what} is above MAX_ROUTE_FEE_TIER ${MAX_ROUTE_FEE_TIER}: the conversion floor credits at most ${MAX_ROUTE_FEE_BPS} bps of route fee; replace the route (PayoutRouter._v4FeeBps refuses it with ROUTE_COST)`);
  } else if (cachedBps !== undefined && !(cost.bps <= Number(cachedBps))) {
    // No MAX_ROUTE_FEE_BPS clamp is needed here: past the tier arm cost.bps <= 100, so a cache the floor would clamp
    // (> 100) can never be the short one, and a short cache (< cost.bps <= 100) is credited as it stands.
    reasons.push(`${what} costs ${cost.bps} bps but the floor credits ${cachedBps} (PayoutRouter.routeFeeBps(asset) = ${cachedBps}): the cached fee is stale, call refreshRouteFee(asset)`);
  }
  return { ok: reasons.length === 0, reasons, cost };
}

const fmt = (x) => `$${Math.round(x).toLocaleString("en-US")}`;

/*//////////////////////////////////////////////////////////////
                     ABI ENCODING / DECODING (tiny)
//////////////////////////////////////////////////////////////*/

const word = (hex) => hex.replace(/^0x/, "").padStart(64, "0");
export function encAddress(a) {
  return word(a.toLowerCase());
}
export function encInt(n) {
  const v = BigInt(n);
  return (v < 0n ? (1n << 256n) + v : v).toString(16).padStart(64, "0");
}
export function encBytes32(b) {
  return b.replace(/^0x/, "").toLowerCase().padStart(64, "0");
}
export function words(hex) {
  const h = hex.replace(/^0x/, "");
  const out = [];
  for (let i = 0; i + 64 <= h.length; i += 64) out.push(h.slice(i, i + 64));
  return out;
}
export const decUint = (w) => BigInt("0x" + w);
export function decInt(w) {
  const v = BigInt("0x" + w);
  return v >= 1n << 255n ? v - (1n << 256n) : v;
}
export const decAddress = (w) => "0x" + w.slice(24);

/** Calldata for `sig` with already-encoded 32-byte words. */
export function calldata(sig, ...encoded) {
  const sel = SELECTORS[sig];
  if (!sel) throw new Error(`no pinned selector for ${sig}`);
  return sel + encoded.join("");
}

/*//////////////////////////////////////////////////////////////
                  CHAIN SOURCE (the injectable read side)
//////////////////////////////////////////////////////////////*/

/**
 * A JSON-RPC transport: `{ call(to, data) -> hex, logs(filter) -> log[] }`, both pinned to `block`.
 * Everything above it goes through {chainSource}, and the tests hand {chainSource} a fake transport instead.
 */
export function rpcTransport(url, { block, fetchImpl = globalThis.fetch, concurrency = 8 } = {}) {
  let id = 0;
  let inFlight = 0;
  const queue = [];
  const tag = block === undefined ? "latest" : "0x" + Number(block).toString(16);
  const run = async (method, params) => {
    while (inFlight >= concurrency) await new Promise((r) => queue.push(r));
    inFlight++;
    try {
      for (let attempt = 0; ; attempt++) {
        const res = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
        });
        if (res.status === 429 && attempt < 5) {
          await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
          continue;
        }
        const body = await res.json();
        if (body.error) throw new Error(`${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
        return body.result;
      }
    } finally {
      inFlight--;
      queue.shift()?.();
    }
  };
  return {
    block: tag,
    call: (to, data) => run("eth_call", [{ to, data }, tag]),
    logs: (filter) => run("eth_getLogs", [{ ...filter, fromBlock: filter.fromBlock ?? "0x0", toBlock: tag }]),
  };
}

/**
 * Multicall3 `aggregate3((address,bool,bytes)[])` calldata for `reqs` (`{to, data}`), allowFailure true on each.
 * Hand-encoded: a dynamic array of dynamic tuples. Decoded by {decodeAggregate3}. Both are exercised by the test.
 */
export function encodeAggregate3(reqs) {
  const hexlen = (h) => h.replace(/^0x/, "").length / 2;
  const pad = (h) => {
    const x = h.replace(/^0x/, "");
    return x + "0".repeat((64 - (x.length % 64)) % 64);
  };
  const tuples = reqs.map((r) => encAddress(r.to) + encInt(1) + encInt(0x60) + encInt(hexlen(r.data)) + pad(r.data));
  let offset = 32 * reqs.length;
  const heads = [];
  for (const tpl of tuples) {
    heads.push(encInt(offset));
    offset += tpl.length / 2;
  }
  return SELECTORS["aggregate3((address,bool,bytes)[])"] + encInt(0x20) + encInt(reqs.length) + heads.join("") + tuples.join("");
}

/** `(bool success, bytes returnData)[]` from aggregate3's return data. */
export function decodeAggregate3(hex) {
  const h = hex.replace(/^0x/, "");
  const at = (byte) => BigInt("0x" + h.slice(byte * 2, byte * 2 + 64));
  const arr = Number(at(0));
  const n = Number(at(arr));
  const base = arr + 32;
  const out = [];
  for (let i = 0; i < n; i++) {
    const tpl = base + Number(at(base + 32 * i));
    const success = at(tpl) === 1n;
    const bytesAt = tpl + Number(at(tpl + 32));
    const len = Number(at(bytesAt));
    out.push({ success, data: "0x" + h.slice((bytesAt + 32) * 2, (bytesAt + 32 + len) * 2) });
  }
  return out;
}

/**
 * High-level chain reads over a transport. Every function here is what the tests replace with fixtures. With
 * `multicall` (the registry's `shared.multicall3`), reads that fan out -- the v4 prefilter, bitmap words, tick
 * reads -- go through Multicall3 in chunks: the public endpoint serves ~7 calls/s under load, one aggregate is
 * one call.
 */
export function chainSource(t, { multicall, chunk = 150 } = {}) {
  const c = async (to, sig, ...enc) => words(await t.call(to, calldata(sig, ...enc)));
  /** Many `{to, sig, enc}` reads; each result is its words, or throws naming the failed read. */
  const many = async (reqs) => {
    const datas = reqs.map((r) => ({ to: r.to, data: calldata(r.sig, ...(r.enc ?? [])) }));
    if (!multicall) return Promise.all(datas.map(async (d) => words(await t.call(d.to, d.data))));
    const chunks = [];
    for (let i = 0; i < datas.length; i += chunk) chunks.push(datas.slice(i, i + chunk));
    const results = await Promise.all(chunks.map(async (ch) => decodeAggregate3(await t.call(multicall, encodeAggregate3(ch)))));
    return results.flat().map((r, i) => {
      if (!r.success) throw new Error(`multicall: ${reqs[i].sig} on ${reqs[i].to} reverted`);
      return words(r.data);
    });
  };
  const bitmapTicks = async (wordReq, lo, hi, ts, tickReq, tickNet) => {
    const compress = (x) => Math.floor(x / ts);
    const positions = [];
    for (let wp = compress(lo) >> 8; wp <= compress(hi) >> 8; wp++) positions.push(wp);
    const bitmaps = await many(positions.map(wordReq));
    const initialized = [];
    positions.forEach((wp, k) => {
      const bits = decUint(bitmaps[k][0]);
      if (bits === 0n) return;
      for (let bit = 0; bit < 256; bit++) {
        if (!((bits >> BigInt(bit)) & 1n)) continue;
        const tick = (wp * 256 + bit) * ts;
        if (tick >= lo && tick <= hi) initialized.push(tick);
      }
    });
    const nets = await many(initialized.map(tickReq));
    return initialized.map((tick, k) => ({ tick, liquidityNet: tickNet(nets[k]) }));
  };
  const span = (bandBps, ts) => Math.ceil(Math.log(1 / (1 - bandBps / 10_000)) / Math.log(1.0001)) + 2 * ts;

  return {
    async decimals(token) {
      if (token === ZERO) return 18; // native ETH
      return Number(decUint((await c(token, "decimals()"))[0]));
    },
    async v3Pool(pool, bandBps = BAND_BPS) {
      const [[s0, s1], [lw], [tw], [t0], [t1], [fw]] = await many(
        ["slot0()", "liquidity()", "tickSpacing()", "token0()", "token1()", "fee()"].map((sig) => ({ to: pool, sig })),
      );
      const tick = Number(decInt(s1));
      const ts = Number(decInt(tw));
      const w = span(bandBps, ts);
      const ticks = await bitmapTicks(
        (wp) => ({ to: pool, sig: "tickBitmap(int16)", enc: [encInt(wp)] }),
        tick - w,
        tick + w,
        ts,
        (tk) => ({ to: pool, sig: "ticks(int24)", enc: [encInt(tk)] }),
        (ws) => decInt(ws[1]),
      );
      return { sqrtPriceX96: decUint(s0), tick, liquidity: decUint(lw), ticks, tickSpacing: ts, token0: decAddress(t0), token1: decAddress(t1), fee: Number(decUint(fw)) };
    },
    async v4Pool(stateView, poolId, tickSpacing, bandBps = BAND_BPS) {
      const id = encBytes32(poolId);
      // getSlot0 -> (sqrtPriceX96, tick, protocolFee, lpFee): the fees price a payout route (routeCost).
      const [[s0, s1, pf, lf], [lw]] = await many([
        { to: stateView, sig: "getSlot0(bytes32)", enc: [id] },
        { to: stateView, sig: "getLiquidity(bytes32)", enc: [id] },
      ]);
      const tick = Number(decInt(s1));
      const w = span(bandBps, tickSpacing);
      const ticks = await bitmapTicks(
        (wp) => ({ to: stateView, sig: "getTickBitmap(bytes32,int16)", enc: [id, encInt(wp)] }),
        tick - w,
        tick + w,
        tickSpacing,
        (tk) => ({ to: stateView, sig: "getTickLiquidity(bytes32,int24)", enc: [id, encInt(tk)] }),
        (ws) => decInt(ws[1]),
      );
      return { sqrtPriceX96: decUint(s0), tick, liquidity: decUint(lw), ticks, tickSpacing, protocolFee: Number(decUint(pf)), lpFee: Number(decUint(lf)) };
    },
    /** Active liquidity and price of many v4 pools at once: most initialized v4 pools are empty. */
    async v4LiquidityMany(stateView, poolIds) {
      const res = await many(
        poolIds.flatMap((id) => [
          { to: stateView, sig: "getLiquidity(bytes32)", enc: [encBytes32(id)] },
          { to: stateView, sig: "getSlot0(bytes32)", enc: [encBytes32(id)] },
        ]),
      );
      return poolIds.map((_, k) => ({ liquidity: decUint(res[2 * k][0]), sqrtPriceX96: decUint(res[2 * k + 1][0]) }));
    },
    async v3GetPool(factory, a, b, fee) {
      const [w] = await c(factory, "getPool(address,address,uint24)", encAddress(a), encAddress(b), encInt(fee));
      return decAddress(w);
    },
    /** Every v4 pool the PoolManager initialized for (currency0, currency1), from its Initialize logs. */
    async v4Initialized(poolManager, currency0, currency1) {
      const logs = await t.logs({
        address: poolManager,
        topics: [V4_INITIALIZE_TOPIC, null, "0x" + encAddress(currency0), "0x" + encAddress(currency1)],
      });
      return logs.map((l) => {
        const w = words(l.data);
        return {
          poolId: l.topics[1],
          fee: Number(decUint(w[0])),
          tickSpacing: Number(decInt(w[1])),
          hooks: decAddress(w[2]),
          block: Number(BigInt(l.blockNumber)),
        };
      });
    },
    async payoutRoute(router, asset) {
      const w = await c(router, "routes(address)", encAddress(asset));
      const venue = Number(decUint(w[0]));
      return {
        venue: venue === 1 ? "v3" : venue === 2 ? "v4" : "none",
        fee: Number(decUint(w[1])),
        tickSpacing: Number(decInt(w[2])),
        v3Pool: decAddress(w[3]),
      };
    },
    /** The route fee the PayoutRouter caches for `asset` and the Clearinghouse's conversion floor credits. */
    async routeFeeBps(router, asset) {
      return Number(decUint((await c(router, "routeFeeBps(address)", encAddress(asset)))[0]));
    },
    async routerV4(router) {
      return {
        poolManager: decAddress((await c(router, "poolManager()"))[0]),
        stateView: decAddress((await c(router, "v4StateView()"))[0]),
      };
    },
    async twapPool(source, asset) {
      return decAddress((await c(source, "pools(address)", encAddress(asset)))[0]);
    },
    async executorPools(executor) {
      return {
        v3Pool: decAddress((await c(executor, "v3Pool()"))[0]),
        weth: decAddress((await c(executor, "weth()"))[0]),
        poolId: "0x" + (await c(executor, "poolId()"))[0],
      };
    },
  };
}

/*//////////////////////////////////////////////////////////////
                              THE CHECK
//////////////////////////////////////////////////////////////*/

const lc = (a) => String(a).toLowerCase();
const sorted = (a, b) => (lc(a) < lc(b) ? [a, b] : [b, a]);
const short = (x) => `${String(x).slice(0, 10)}…`;

/**
 * Measure one pair: every candidate (v3 tiers from the factory, hookless static-fee v4 pools from the logs), the
 * named references among them, and the deepest sane candidate. `refs` are `{ label, venue, address | poolId,
 * tickSpacing? }`. Returns measured references, the deepest candidate, and the candidates excluded as off-price.
 */
export async function measurePair(src, { base, quote, factory, poolManager, stateView, refs, extraV3Fees = [] }) {
  const [c0, c1] = sorted(base, quote);
  const quoteIsToken0 = lc(c0) === lc(quote);
  const [baseDecimals, quoteDecimals] = await Promise.all([src.decimals(base), src.decimals(quote)]);
  const units = { quoteIsToken0, quoteDecimals, baseDecimals };

  // Candidates.
  const cands = [];
  const fees = [...new Set([...V3_FEE_TIERS, ...extraV3Fees])];
  const v3 = await Promise.all(fees.map(async (fee) => [fee, await src.v3GetPool(factory, c0, c1, fee)]));
  for (const [fee, pool] of v3) {
    if (lc(pool) !== lc(ZERO)) cands.push({ label: `v3 ${fee} ${pool}`, venue: "v3", address: pool, fee });
  }
  const v4 = (await src.v4Initialized(poolManager, c0, c1)).filter(
    (p) => lc(p.hooks) === lc(ZERO) && (p.fee & DYNAMIC_FEE_FLAG) === 0 && p.fee > 0 && p.fee <= MAX_ROUTE_FEE_TIER,
  );
  const v4State = await src.v4LiquidityMany(stateView, v4.map((p) => p.poolId));
  for (const [k, p] of v4.entries()) {
    const { liquidity, sqrtPriceX96 } = v4State[k];
    if (liquidity === 0n) continue;
    cands.push({ label: `v4 ${p.fee}/${p.tickSpacing} ${short(p.poolId)}`, venue: "v4", poolId: p.poolId, fee: p.fee, tickSpacing: p.tickSpacing, liquidity, sqrtPriceX96 });
  }

  const measure = async (x) => {
    const state = x.venue === "v3" ? await src.v3Pool(x.address) : await src.v4Pool(stateView, x.poolId, x.tickSpacing);
    // The pool's own fees (v3 fee(), v4 slot0 lpFee/protocolFee) override what the reference named: routeCost prices
    // the pool the chain holds.
    const poolFees = x.venue === "v3" ? { fee: state.fee ?? x.fee } : { lpFee: state.lpFee, protocolFee: state.protocolFee };
    return { ...x, ...poolFees, id: idOf(x), liquidity: state.liquidity, spot: spot(state.sqrtPriceX96, units), depth: depth(state, units) };
  };

  const measuredRefs = await Promise.all(refs.map(measure));
  const refSpot = median(measuredRefs.map((r) => r.spot));

  // v3 candidates need their own L read; v4 ones already have it from the prefilter.
  await Promise.all(
    cands.map(async (cnd) => {
      if (cnd.venue === "v3" && cnd.liquidity === undefined) {
        const s = await src.v3Pool(cnd.address);
        cnd.liquidity = s.liquidity;
        cnd.sqrtPriceX96 = s.sqrtPriceX96;
      }
      cnd.spot = spot(cnd.sqrtPriceX96, units);
    }),
  );
  const offPrice = cands.filter((cnd) => Math.abs(cnd.spot / refSpot - 1) * 10_000 > MAX_SPOT_DEVIATION_BPS);
  const sane = cands
    .filter((cnd) => !offPrice.includes(cnd))
    .sort((a, b) => (BigInt(b.liquidity) > BigInt(a.liquidity) ? 1 : BigInt(b.liquidity) < BigInt(a.liquidity) ? -1 : 0))
    .slice(0, CANDIDATES_WALKED);
  const walked = await Promise.all(sane.map(measure));
  const all = [...walked, ...measuredRefs];
  const deepestOf = (xs) => xs.reduce((best, x) => (!best || x.depth.weaker > best.depth.weaker ? x : best), null);
  const deepest = deepestOf(all);
  // A settlement TWAP pool can only be replaced by another v3 pool (UniV3TwapSource is v3-only), so it is judged
  // against the deepest v3 candidate; a payout route may move to either venue.
  const deepestV3 = deepestOf(all.filter((x) => x.venue === "v3"));
  return { units, refs: measuredRefs, candidates: walked, deepest, deepestV3, offPrice: offPrice.map((x) => x.label), candidateCount: cands.length };
}

/** A reference's identity for comparison with candidates (a pool address or a v4 id). */
function idOf(x) {
  return lc(x.venue === "v3" ? x.address : x.poolId);
}

/**
 * The whole check over a registry. Returns `{ issues, reports, pairs }`: `issues` are FAILs for registry-controlled
 * references (build-markets pushes them onto its v2 issues), `reports` are measured immutables and notes (logged).
 */
export async function routeLiquidityIssues(registry, src) {
  const issues = [];
  const reports = [];
  const pairs = [];
  const usdg = registry.shared?.usdg;
  const router = registry.v2?.contracts?.payoutAdapter;
  const twap = registry.v2?.contracts?.sources?.univ3;
  const factory = registry.v2?.uniswapV3?.factory;
  if (![usdg, router, twap, factory].every((a) => /^0x[0-9a-fA-F]{40}$/.test(String(a)))) {
    // Before a deploy there is no router or TWAP source to read; after one, their absence is a fault.
    if (registry.v2?.deployBlock === null || registry.v2?.deployBlock === undefined) {
      return { issues, reports: ["route liquidity: not deployed (v2.deployBlock is null), so no live route or TWAP pool to measure"], pairs };
    }
    return { issues: ["route liquidity: shared.usdg, v2.contracts.payoutAdapter, v2.contracts.sources.univ3 and v2.uniswapV3.factory must all be addresses: nothing measured"], reports, pairs };
  }
  const { poolManager, stateView } = await src.routerV4(router);

  for (const m of registry.markets ?? []) {
    const t = m.ticker;
    const refs = [];
    // PayoutRouter.routes(asset) and UniV3TwapSource.pools(asset) are written on chain only by RegisterMarkets,
    // which runs AFTER the writeback in both deploy paths (launch-v8.sh, stonkctl phases). A market the registry does not
    // record as registered (v2.registeredAt null) therefore reads EMPTY on chain on every fresh deploy: that is "not
    // registered yet", not a mismatch. The registry-vs-chain equality is skipped only in that case -- unregistered AND
    // empty on chain. A registered market is compared as before, and so is an unregistered one whose chain slot is
    // already set (something other than RegisterMarkets wrote it). The depth judgement below runs for every market.
    const registered = m.v2?.registeredAt !== null && m.v2?.registeredAt !== undefined;
    // Payout route: registry vs chain.
    const reg = m.v2?.payoutRoute ?? null;
    const live = await src.payoutRoute(router, m.asset);
    const routePending = !registered && live.venue === "none";
    if (reg === null) {
      if (live.venue !== "none") issues.push(`${t}: payout route is null in the registry but the PayoutRouter holds a ${live.venue} route (fee ${live.fee})`);
    } else if (routePending) {
      reports.push(`${t}: not registered yet (v2.registeredAt null) and PayoutRouter.routes(asset) is empty: the registry route is compared once RegisterMarkets has run`);
    } else if (live.venue !== reg.venue || live.fee !== reg.fee || (reg.venue === "v4" && live.tickSpacing !== reg.tickSpacing)) {
      issues.push(`${t}: registry v2.payoutRoute is ${reg.venue} fee ${reg.fee}${reg.venue === "v4" ? ` tickSpacing ${reg.tickSpacing}` : ""} but PayoutRouter.routes(asset) on chain is ${live.venue} fee ${live.fee}${live.venue === "v4" ? ` tickSpacing ${live.tickSpacing}` : ""}: the registry must describe the live route`);
    }
    if (reg?.venue === "v4") refs.push({ label: `${t} payout route (registry v4 ${reg.fee}/${reg.tickSpacing} ${short(reg.poolId)})`, role: "payoutRoute", venue: "v4", poolId: reg.poolId, tickSpacing: reg.tickSpacing, fee: reg.fee });
    if (reg?.venue === "v3") {
      const [a, b] = sorted(m.asset, usdg);
      const pool = await src.v3GetPool(factory, a, b, reg.fee);
      refs.push({ label: `${t} payout route (registry v3 ${reg.fee} ${pool})`, role: "payoutRoute", venue: "v3", address: pool, fee: reg.fee });
    }
    if (live.venue === "v3" && !refs.some((r) => r.venue === "v3" && lc(r.address) === lc(live.v3Pool))) {
      refs.push({ label: `${t} payout route (on chain v3 ${live.fee} ${live.v3Pool})`, role: "payoutRoute", venue: "v3", address: live.v3Pool, fee: live.fee });
    }
    // Settlement TWAP pool: registry vs chain.
    const regPool = m.v2?.univ3Pool ?? null;
    const livePool = await src.twapPool(twap, m.asset);
    const poolPending = !registered && lc(livePool) === lc(ZERO);
    if (regPool && poolPending) {
      reports.push(`${t}: not registered yet (v2.registeredAt null) and UniV3TwapSource.pools(asset) is empty: the registry pool is compared once RegisterMarkets has run`);
    } else if (regPool && lc(livePool) !== lc(regPool)) {
      issues.push(`${t}: registry v2.univ3Pool is ${regPool} but UniV3TwapSource.pools(asset) on chain is ${livePool}`);
    }
    for (const p of new Set([regPool, lc(livePool) === lc(ZERO) ? null : livePool].filter(Boolean).map(lc))) {
      refs.push({ label: `${t} oracle pool (v3 ${p})`, role: "univ3Pool", venue: "v3", address: p });
    }
    if (!refs.length) continue;

    const res = await measurePair(src, { base: m.asset, quote: usdg, factory, poolManager, stateView, refs, extraV3Fees: refs.filter((r) => r.venue === "v3" && r.fee).map((r) => r.fee) });
    pairs.push({ ticker: t, ...res });
    for (const r of res.refs) {
      const v = judge(r, r.role === "univ3Pool" ? res.deepestV3 : res.deepest);
      r.verdict = v;
      if (!v.ok) issues.push(`${t}: ${r.label} is SHALLOW — ${v.reasons.join("; ")}`);
    }
    // The fee rule: payout routes only (a TWAP pool is read, never swapped through). A payout sells the asset
    // into USDG, so the direction is zeroForOne exactly when the asset is currency0 (V4Types.zeroForOne). The cached
    // routeFeeBps describes the live route alone, so only the reference that IS the live route is held to it.
    const zeroForOne = lc(sorted(m.asset, usdg)[0]) === lc(m.asset);
    const isLive = (r) =>
      (live.venue === "v3" && r.venue === "v3" && lc(r.address) === lc(live.v3Pool)) ||
      (live.venue === "v4" && r.venue === "v4" && r.fee === live.fee && r.tickSpacing === live.tickSpacing);
    const routeRefs = res.refs.filter((r) => r.role === "payoutRoute");
    const cachedBps = routeRefs.some(isLive) ? await src.routeFeeBps(router, m.asset) : undefined;
    for (const r of routeRefs) {
      const f = judgeFee(r, { zeroForOne, cachedBps: isLive(r) ? cachedBps : undefined });
      r.feeVerdict = f;
      if (!f.ok) issues.push(`${t}: ${r.label} is TOO EXPENSIVE — ${f.reasons.join("; ")}`);
    }
  }

  // On-chain immutables: reported, never failing (the fix is a redeploy).
  const executor = registry.v2?.flywheel?.buybackExecutor;
  if (/^0x[0-9a-fA-F]{40}$/.test(String(executor))) {
    const ex = await src.executorPools(executor);
    const res = await measurePair(src, { base: ex.weth, quote: usdg, factory, poolManager, stateView, refs: [{ label: `buyback executor v3 USDG/WETH ${ex.v3Pool}`, role: "immutable", venue: "v3", address: ex.v3Pool }] });
    pairs.push({ ticker: "WETH (buyback)", ...res });
    const v = judge(res.refs[0], res.deepest);
    res.refs[0].verdict = v;
    reports.push(`buyback executor ${executor} v3Pool ${ex.v3Pool}: ${v.ok ? "deep" : "SHALLOW — " + v.reasons.join("; ")} (immutable: a fix is a redeploy)`);
  }
  const tok = registry.shared?.token;
  if (tok?.poolKey && tok?.poolId) {
    const pk = tok.poolKey;
    const state = await src.v4Pool(stateView, tok.poolId, pk.tickSpacing);
    const ethIsToken0 = lc(pk.currency0) === lc(ZERO);
    const d = depth(state, { quoteIsToken0: ethIsToken0, quoteDecimals: 18 });
    reports.push(`${tok.symbol} pool ${short(tok.poolId)} (hooked ${pk.hooks}): ±${BAND_BPS} bps depth ${d.sell.toFixed(4)} ETH sell / ${d.buy.toFixed(4)} ETH buy (no USDG side, no USD floor; the token's own pool, immutable in the executor)`);
  }
  return { issues, reports, pairs };
}

/*//////////////////////////////////////////////////////////////
                                  CLI
//////////////////////////////////////////////////////////////*/

async function main(argv) {
  const i = argv.indexOf("--registry");
  const file = i === -1 ? path.join(HERE, "tier1.json") : path.resolve(argv[i + 1]);
  const registry = JSON.parse(readFileSync(file, "utf8"));
  const url = process.env.RH_RPC ?? "https://rpc.mainnet.chain.robinhood.com";
  const head = await blockHead(url);
  const src = chainSource(rpcTransport(url, { block: head }), { multicall: registry.shared?.multicall3 });
  const out = await routeLiquidityIssues(registry, src);
  if (argv.includes("--json")) {
    console.log(JSON.stringify({ block: head, host: new URL(url).host, ...out }, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  } else {
    console.error(`route liquidity at block ${head} (${new URL(url).host}), band ±${BAND_BPS} bps, floor ${fmt(MIN_DEPTH_USD)}, share ${MIN_SHARE_OF_DEEPEST * 100} %`);
    for (const p of out.pairs) {
      console.error(`${p.ticker}: ${p.candidateCount} candidate pools, ${p.offPrice.length} off-price excluded`);
      for (const x of [...p.refs, ...p.candidates]) {
        console.error(`  ${x === p.deepest ? "*" : " "} ${x.label.padEnd(70)} sell ${fmt(x.depth.sell).padStart(12)} buy ${fmt(x.depth.buy).padStart(12)} spot ${x.spot.toFixed(4)}${x.verdict ? (x.verdict.ok ? "  ok" : "  FAIL") : ""}${x.feeVerdict ? `  fee ${x.feeVerdict.cost ? `${x.feeVerdict.cost.bps} bps` : "unknown"}${x.feeVerdict.ok ? "" : " FAIL"}` : ""}`);
      }
    }
    for (const r of out.reports) console.error(`report: ${r}`);
    for (const s of out.issues) console.error(`FAIL: ${s}`);
  }
  process.exit(out.issues.length ? 1 : 0);
}

async function blockHead(url) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }) });
  return Number(BigInt((await res.json()).result));
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.stack ?? String(e));
    process.exit(1);
  });
}
