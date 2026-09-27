/* -------------------------------------------------------------------------------------------------
 * What the numbered rehearsal deploys under INTERFACE_VERSION 8, derived from the registry.
 *
 *   launchTickers(reg)     the tickers step 1 registers: the registry's root `launchSet.markets` (NVDA
 *                          and SPCX). Never a ticker literal, never `wave` or `status`: the launchSet
 *                          block's own note says why neither answers this question.
 *   rehearsalRoles(reg)    which launch market carries which beat of the story and the drills:
 *                            dual    settles on Chainlink AND its Uniswap pool, is paid out through its payout route
 *                                    (the registry's v2.payoutRoute, v3 or v4; the v9 launch set is v3 fee 500)
 *                                    (the old NVDA beats, and the old TSLA beats that need a second pooled market
 *                                    are re-homed here or reported notCovered)
 *                            single  its pool and payout route are NULLED in the rehearsal's input copy, so it settles
 *                                    on Chainlink alone and pays in kind (the old META beats: the single-source
 *                                    candidate and its 6 h delay, the in-kind fallback, feed-paused, guardian veto)
 *   freshInput(reg, roles) the registry copy step 1 hands DeployV2Batch.sh --rehearse: every recorded deployment
 *                          field nulled (the real tier1.json records the live v8 set, and the batch only deploys a
 *                          registry whose set is all null), and the single market's pool nulled -- exactly what
 *                          ops/devnet does for its single-source market (its second market's pool is
 *                          cleared) and what callhouse-contracts script/v2/rehearse-v2.sh CHAINLINK_ONLY does to its
 *                          INPUT copy. ops/markets/tier1.json and dev.json are never written.
 *
 * Why the single market is a launch market with its pool nulled and not META: the registry's launch set is two
 * dual-source markets, and the batch's launch guard refuses a ticker outside it. A nulled pool on a copy
 * is the only way to rehearse the single-source path without registering an off-launch market.
 *   payoutRouteIssues      step 1f': the PayoutRouter route on chain against the registry's v2.payoutRoute.
 * ------------------------------------------------------------------------------------------------- */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodePoolKey, routeCurrencies } from "../../markets/build-markets.mjs";

// viem from the keeper package, as lib.mjs loads it.
const { keccak256 } = createRequire(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "keeper", "package.json"))("viem");

/** The launch set, upper-cased, validated against `markets[]`. */
export function launchTickers(reg) {
  const list = reg?.launchSet?.markets;
  if (!Array.isArray(list) || list.length === 0) throw new Error("the registry has no launchSet.markets: the rehearsal takes its tickers from it and from nothing else");
  const tickers = list.map((t) => String(t).toUpperCase());
  const known = new Set((reg.markets ?? []).map((m) => m.ticker));
  const missing = tickers.filter((t) => !known.has(t));
  if (missing.length) throw new Error(`launchSet.markets names ${missing.join(", ")}, not in markets[]`);
  if (new Set(tickers).size !== tickers.length) throw new Error(`launchSet.markets repeats a ticker: ${tickers.join(", ")}`);
  return tickers;
}

const rowOf = (reg, T) => reg.markets.find((m) => m.ticker === T);
const pooled = (row) => Boolean(row?.v2?.univ3Pool) && Boolean(row?.v2?.payoutRoute);

/**
 * `dual`: the launch market whose `wave` is "canary", when it has a pool and a route, else the first launch market
 * that has both. `single`: the first OTHER launch market (in launchSet order). Needs two launch markets.
 */
export function rehearsalRoles(reg) {
  const tickers = launchTickers(reg);
  if (tickers.length < 2) throw new Error(`the rehearsal needs two launch markets (one dual-source, one single-source by a nulled pool), launchSet has ${tickers.join(", ")}`);
  const canary = tickers.find((T) => rowOf(reg, T).v2?.wave === "canary" && pooled(rowOf(reg, T)));
  const dual = canary ?? tickers.find((T) => pooled(rowOf(reg, T)));
  if (!dual) throw new Error(`no launch market has both a v2.univ3Pool and a v2.payoutRoute (${tickers.join(", ")}): nothing can carry the dual-source beats`);
  const single = tickers.find((T) => T !== dual);
  return { dual, single, tickers };
}

/** PayoutRouter's `Venue` enum by index (IPayoutRouter.sol: None, V3, V4). */
export const ROUTE_VENUES = Object.freeze(["None", "V3", "V4"]);

/** The venue a registry `v2.payoutRoute` names, spelled as the enum ("V3" | "V4"); "None" for a null route. */
export const routeVenue = (want) => (want ? String(want.venue).toUpperCase() : "None");

/** A v4 pool id: keccak256(abi.encode(PoolKey)), encoded by build-markets.mjs encodePoolKey (the registry's own pin). */
export const v4PoolId = (key) => keccak256(encodePoolKey(key));

/**
 * Step 1f': a launch market's PayoutRouter route on chain (`routes(asset)`: venue, fee, tickSpacing, v3Pool)
 * against the registry's `v2.payoutRoute`. Returns what disagrees; [] is a match.
 *   v3 { venue, fee }                      venue and fee. PayoutRouter.setRouteV3 resolves the pool from the v3 factory
 *                                          and stores tickSpacing 0, so a v3 route has no tickSpacing to compare (the
 *                                          v9 launch set, NVDA and SPCX, is v3 fee 500).
 *   v4 { venue, fee, tickSpacing, poolId } venue, fee, tickSpacing, and the poolId of the on-chain key (asset and USDG
 *                                          sorted, fee, tickSpacing, hooks 0: PayoutRouter.setRouteV4) = the pinned one.
 *   null                                   no route on chain (venue None): the market's ITM longs are paid in kind.
 * A venue that disagrees with the registry is always an issue, whichever way round.
 */
export function payoutRouteIssues(want, onChain, { asset, usdg }) {
  const venue = ROUTE_VENUES[Number(onChain.venue)] ?? `unknown (${onChain.venue})`;
  if (venue !== routeVenue(want)) return [`venue ${venue} on chain, the registry's payoutRoute is ${want ? want.venue : "null (no route)"}`];
  if (!want) return [];
  const issues = [];
  if (Number(onChain.fee) !== Number(want.fee)) issues.push(`fee ${onChain.fee} on chain, the registry's ${want.fee}`);
  if (venue === "V4") {
    if (Number(onChain.tickSpacing) !== Number(want.tickSpacing)) {
      issues.push(`tickSpacing ${onChain.tickSpacing} on chain, the registry's ${want.tickSpacing}`);
    } else {
      const id = v4PoolId({ ...routeCurrencies(asset, usdg), fee: Number(onChain.fee), tickSpacing: Number(onChain.tickSpacing), hooks: 0 });
      if (id.toLowerCase() !== String(want.poolId).toLowerCase()) issues.push(`poolId ${id} of the on-chain key, the registry pins ${want.poolId}`);
    }
  }
  return issues;
}

/** 3-story 3h: the dual market's USDG conversion ran through the route the registry names (a null route never passes). */
export const paidThroughRegistryRoute = (routeOnChain, want) => routeVenue(want) !== "None" && routeOnChain?.venue === routeVenue(want);

/** Recorded-deployment fields nulled in the input copy, by path, so the report can print them. */
export const NULLED_DEPLOYMENT_FIELDS = Object.freeze([
  "v2.deployBlock",
  "v2.contracts.* (every key, sources.* included)",
  "v2.externalDeployBlocks.*",
  "v2.flywheel.{feeSplitter,buybackExecutor,deployBlock}",
  "v2.bots.* (the batch puts anvil #8/#9/#10 stand-ins in the copy)",
  "v2.protocolAddresses.* (derived from the recorded set)",
  "shared.feeRecipient (the live FeeSplitter; DeployV8 deploys a new one)",
  "markets[].v2.{registeredAt,registerTx,houseVault}",
  "v2.house -> { factories: [] } and markets[].v2.house -> { weekly: null, daily: null } (T-OP-225's fresh shape, ops/markets/build-markets.mjs; the keeper refuses a weekly factory that is not v2.contracts.houseVaultFactory)",
]);

/** The single market's fields nulled in the input copy. */
export const NULLED_SINGLE_FIELDS = Object.freeze(["univ3Pool", "univ3MinLiquidity", "payoutRoute"]);

const nullLeaves = (obj) => {
  if (obj === null || typeof obj !== "object") return null;
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, v !== null && typeof v === "object" ? nullLeaves(v) : null]));
};

/** A deep copy of `reg` that DeployV2Batch.sh --rehearse deploys fresh from. `reg` itself is not touched. */
export function freshInput(reg, roles = rehearsalRoles(reg)) {
  const copy = structuredClone(reg);
  copy._readme = `T-OP-247 REHEARSAL INPUT copy of ops/markets/tier1.json for ops/v2/rehearse (O2-03 on v8): recorded deployment nulled, ${roles.single}'s pool and payout route nulled so it rehearses the single-source, in-kind path. Never commit, never deploy from it.`;
  copy.v2.deployBlock = null;
  copy.v2.contracts = nullLeaves(copy.v2.contracts);
  if (copy.v2.externalDeployBlocks) copy.v2.externalDeployBlocks = nullLeaves(copy.v2.externalDeployBlocks);
  if (copy.v2.flywheel) for (const k of ["feeSplitter", "buybackExecutor", "deployBlock"]) if (k in copy.v2.flywheel) copy.v2.flywheel[k] = null;
  if (copy.v2.bots) copy.v2.bots = nullLeaves(copy.v2.bots);
  if (copy.v2.protocolAddresses) copy.v2.protocolAddresses = nullLeaves(copy.v2.protocolAddresses);
  if (copy.shared && "feeRecipient" in copy.shared) copy.shared.feeRecipient = null;
  if (copy.v2.house) copy.v2.house = { factories: [] };
  for (const m of copy.markets) {
    if (!m.v2) continue;
    for (const k of ["registeredAt", "registerTx", "houseVault"]) if (k in m.v2) m.v2[k] = null;
    if (m.v2.house) m.v2.house = { weekly: null, daily: null };
  }
  const single = rowOf(copy, roles.single);
  for (const k of NULLED_SINGLE_FIELDS) single.v2[k] = null;
  return copy;
}

/**
 * The dual market's open, `belowBps` under its pool's price (6-dp USDG per share), and the two bounds 2-services.mjs
 * asserts on it:
 *   corroborates  the gap, in bps of the OPEN price, is at most the mm-bot's MM_FAIR_SPOT_TOLERANCE_BPS: its pool reading
 *                 then refreshes the MM's spot clock (keeper/src/v2/mm/reads.ts readSpotClocks: rejected when
 *                 gap × 1e4 / spot > tolerance). The keeper compares the pool's TWAP; the pool does not trade in the
 *                 rehearsal, so slot0 stands for it.
 *   r0InTheMoney  the first daily rung's strike (keeper/src/v2/cranker/planner.ts ladderStrikes: spot × (1 + firstOtmBps)
 *                 rounded up, then up to the strike tick) is under the pool's price, where the story settles, so r0
 *                 finishes in the money: 3h guarantees payouts on r0 only.
 * At the shipped 50 bps tolerance the two cannot both hold for NVDA (firstOtmBps 100): a corroborating open
 * is at most ~50 bps under the pool, so r0 lands at or above it. 2-services.mjs asserts r0InTheMoney only and
 * 3-story.mjs's feed heartbeat keeps the dual market's spot clock fresh; `corroborates` is still reported.
 */
export function dualOpen({ pool6, belowBps, firstOtmBps, strikeTick, toleranceBps }) {
  const BPS = 10_000n;
  const spot6 = (pool6 * (BPS - belowBps)) / BPS;
  const gapBps = ((pool6 - spot6) * BPS) / spot6;
  const raw = (spot6 * (BPS + BigInt(firstOtmBps)) + BPS - 1n) / BPS;
  const r0 = ((raw + strikeTick - 1n) / strikeTick) * strikeTick;
  return { spot6, gapBps, r0, corroborates: gapBps <= toleranceBps, r0InTheMoney: r0 < pool6 };
}
