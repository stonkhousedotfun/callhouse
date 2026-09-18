#!/usr/bin/env node
/**
 * Build the Tier-1 market registry: ops/markets/tier1.json.
 *
 * One file drives every market-specific thing in the system: the factory deploy scripts
 * (contracts/script/DeploySoloBatch.sh), the per-market keeper env files (ops/keeper-env.sh), the
 * indexer env, the web app's market list (web/lib/markets.ts via web/scripts/gen-markets.mjs) and
 * the docs page (callhouse-docs/product/markets.md). Nothing else may hard-code a market.
 *
 * WHAT IT DOES
 *   1. Fetches Chainlink's feed directory for chain 4663 (or reads --feeds <file>), keeps the
 *      feeds whose `docs.marketHours` is `us_equities_24/5` (the tokenised-equity feeds), and
 *      derives the ticker from the feed name (`Robinhood NVDA / USD`, `Robinhood DELL-USD`).
 *   2. Cross-references each ticker with ops/recon/R6-stock-tokens-list.json (204 Stock Tokens
 *      the issuer had deployed by 2026-09-12) by token `symbol`. A ticker with no token, or with
 *      more than one, is reported and skipped.
 *   3. Verifies every pair ON CHAIN with `cast` against RH_RPC: feed `decimals() == 8`,
 *      `latestRoundData().answer > 0` and its age, `description()` containing the ticker; token
 *      `decimals() == 18`, `symbol()`, and the ERC-8056 `uiMultiplier()` / `oraclePaused()` probes.
 *      A market that fails any check is written with `verification.ok == false` and its issues,
 *      never silently dropped, and the script exits 1.
 *   4. Fetches Cboe's delayed option chain for the ticker (unless --skip-cboe) and records whether
 *      a weekly chain exists (the next two Fridays both listed) and how far Cboe's `current_price`
 *      sits from the feed's spot. The keeper's vol mode needs both: it prices the week from the
 *      chain of the SAME underlying and refuses a spot divergence above
 *      KEEPER_VOL_MAX_SPOT_DIVERGENCE_BPS (300). A root whose chain is a different instrument
 *      (SPCX on Cboe is not the SpaceX token) or has no weeklies (SGOV) is `mode: "fixed"`.
 *   5. Merges the result over the existing tier1.json so hand-maintained fields survive a
 *      regeneration: `deployment.*`, `wave`, `status`, `depositCapUsd`, `strikeOtmBps`,
 *      `minAskUsdg6`, `targetDelta`, `priceEdgeBps`, `premiumMarginBps`, `modeOverride`, `v1RunOff`
 *      (ADR-10: the owner froze this v1 factory; ops/keeper-env.sh then renders SOLO_WIND_DOWN=1),
 *      `v1FrozenAt` (unix seconds of that freeze, written with `v1RunOff: true`), `notes`, and the
 *      v2 blocks: the top-level `v2` (contract addresses, bot addresses, Uniswap periphery, fees,
 *      defaults) and each market's `v2` (status, wave, strikeTick, pool, liquidity floor, Data
 *      Streams id, overrides). The v2 blocks are written by hand and by the v2 deploy write-back,
 *      never derived here: nothing the builder fetches can say which pool a settlement source
 *      should trust or which wave a market opens in.
 *   6. Validates what it cannot regenerate, so a bad hand edit fails loudly here instead of at a
 *      deploy: `status` is live | planned | paused | superseded-by-v2 (the v1 factory lifecycle;
 *      ADR-02 cancelled the per-market factory rollout, so the 34 rows that were planned are
 *      superseded and a live row needs a factory while a superseded one must not have one);
 *      `v1FrozenAt` is absent, null or positive unix seconds, and when set the row has a factory
 *      and `v1RunOff: true`; the v2 blocks match ops/markets/README.md "v2 blocks" (interface
 *      version, enums, strikeTick a positive multiple of PRICE_TICK = 100, fee ceilings of
 *      V2Constants, overrides naming only keys of `v2.defaults`, each market's effective
 *      `spotMaxAgeS` at most the oracle's 4-day ceiling and at least its feed heartbeat + 1 h,
 *      a pool always with its floor, the
 *      three bot addresses EIP-55 checksummed or null and distinct from each other and from every
 *      other key the registry names). A pool is checked twice: offline, its token pair must be
 *      {asset, USDG} in the F2-02 recon (ops/markets/v2-sources.json), and on chain
 *      `token0()`/`token1()` must be that pair and the v3 factory's `getPool` must return it for the
 *      pool's own `fee()`. Current in-range liquidity under the floor is reported, not failed: it
 *      moves with the market, and the floor is a settlement-time gate.
 *
 * USAGE
 *   node ops/markets/build-markets.mjs                      # fetch feeds, verify, fetch Cboe, write
 *   node ops/markets/build-markets.mjs --feeds path.json    # use a saved feed directory
 *   node ops/markets/build-markets.mjs --skip-cboe          # no Cboe fetch (keeps previous evidence)
 *   node ops/markets/build-markets.mjs --check              # verify only; exit 1 on drift, write nothing
 *   node ops/markets/build-markets.mjs --check --registry /path/to/other.json    # explicit alternate registry
 *   RH_RPC=... overrides the RPC (default: the public primary).
 *
 * `--registry <file>` reads AND writes that file instead of ops/markets/tier1.json, under exactly the
 * same rules. A separate development registry can be supplied explicitly; nothing defaults to it.
 * Every consumer that reads a non-production registry is told so on its own command line.
 *
 * Needs `cast` (foundry) on PATH and Node >= 22. No npm dependencies on purpose: this runs from
 * a bare checkout during a deploy, before any workspace install.
 */
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const here = path.dirname(fileURLToPath(import.meta.url));
const opsDir = path.resolve(here, "..");
/** The registry this run reads and writes: ops/markets/tier1.json, or `--registry <file>`. */
const OUT = (() => {
  const i = process.argv.indexOf("--registry");
  if (i === -1) return path.join(here, "tier1.json");
  const p = process.argv[i + 1];
  if (!p || p.startsWith("--")) {
    console.error("--registry needs a path");
    process.exit(2);
  }
  return path.resolve(process.cwd(), p);
})();
const TOKENS = path.join(opsDir, "recon", "R6-stock-tokens-list.json");
const V2_SOURCES = path.join(here, "v2-sources.json");
const FEEDS_URL = "https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json";
const RPC = process.env.RH_RPC ?? "https://rpc.mainnet.chain.robinhood.com";
const CBOE = (root) => `https://cdn.cboe.com/api/global/delayed_quotes/options/${root}.json`;
const EXPLORER = "https://robinhoodchain.blockscout.com";

/** Fixed facts of chain 4663 every market shares. */
const SHARED = {
  chainId: 4663,
  usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  clearinghouse: "0x53d7A6d0489Daf3d67b9A314e0eAB2B78Acab9C6",
  seaport: "0x0000000000000068F116a894984e2DB1123eB395",
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
  admin: "0xEb82c3D0F89d47453F94f0C2b2a2752e27a19d9b",
  guardian: "0x29741A8d283a253E8Ce10aDfd04C6507438b6F39",
  feeRecipient: "0xEb82c3D0F89d47453F94f0C2b2a2752e27a19d9b",
};

/**
 * Per-market defaults. Everything here is a keeper or deploy parameter an operator may override
 * per market in tier1.json; the builder never overwrites an existing per-market value.
 *
 *   depositCapUsd     per-ACCOUNT cap (AccountFactory.depositCap is checked against one account's
 *                     held balance, not a global total), in USD notional at build time. Converted
 *                     to whole tokens at the verified spot (`depositCap`, 18 dp, at least 1 token).
 *   strikeOtmBps      fixed mode: strike = spot × (1 + bps/10000), whole USDG. Inside the 3%–12% band.
 *   minAskUsdg6       the ask is never below this (USDG base units). Replaces the 1 USDG floor of
 *                     the NVDA-only keeper, meaningless for a $25 token. 0.10 USDG.
 *   targetDelta / priceEdgeBps / premiumMarginBps  vol-mode knobs, the keeper's own defaults.
 */
const DEFAULTS = {
  depositCapUsd: 10_000,
  strikeOtmBps: 500,
  minAskUsdg6: "100000",
  targetDelta: 0.15,
  priceEdgeBps: 1000,
  premiumMarginBps: 100,
  maxPriceAgeS: 345_600,
  maxSpotDivergenceBps: 300,
};

/**
 * The v1 rollout waves of the Tier-1 plan, kept as the record of that plan: a ticker not listed
 * lands in wave2. NVDA is live. The rollout itself was superseded by v2 (ADR-02); v2 waves live in
 * each market's `v2.wave`.
 */
const WAVES = {
  live: ["NVDA"],
  canary: ["TSLA", "AAPL"],
  wave1: ["MSFT", "META", "GOOGL", "AMZN", "AMD", "ORCL", "PLTR", "COIN", "MSTR", "TSM", "QQQ", "SPY"],
};

const README =
  "Tier-1 market registry for Stonkhouse on Robinhood Chain 4663: every Stock Token that has a live Chainlink us_equities_24/5 feed. GENERATED by ops/markets/build-markets.mjs; hand-edit only deployment.*, wave, status, depositCapUsd, strikeOtmBps, minAskUsdg6, targetDelta, priceEdgeBps, premiumMarginBps, modeOverride, v1RunOff, v1FrozenAt, notes, the top-level v2 block and each market's v2 block — the builder preserves those and regenerates everything else. `status` is the v1 factory lifecycle (live | planned | paused | superseded-by-v2: the per-market factory rollout was cancelled for v2); `v2.status` is the v2 market lifecycle (ops/markets/README.md). Every address was read on chain at verifiedAtBlock (see verification per market). Consumers: contracts/script/DeploySoloBatch.sh, ops/keeper-env.sh, ops/v2-env.mjs, web/scripts/gen-markets.mjs, callhouse-docs/product/markets.md, keeper/src/v2.";

/*//////////////////////////////////////////////////////////////
                          V2 SCHEMA
//////////////////////////////////////////////////////////////*/

/**
 * The frozen v2 interface version the registry's v2 blocks are written for. The one place it is spelled in
 * ops/ and web/: v2.interfaceVersion must equal it, and every other reader copies the registry's
 * value. Version 2 (ISettlementOracle candidate view and events), version 3 (API only: card
 * `perShare` ticket and the put card target), version 4 (OrderFilled.recipient), version 5 (notifier
 * settings sessions) and version 6 (24 h fee-change delay, per-expiry settlement pins, the 1 % payout
 * route fee-tier ceiling) left the registry schema as is. Version 7 (c05 collateral rent, c16 stale-ask
 * cancel, c21 vault outflow cap) is the first that grows it: `v2.fees.mintFeePpm` and a per-market
 * `v2.mintFeePpm` (the writer fee, now rent at mint), `v2.vault` (the six-field MakerVault Limits the
 * deploy sets), `v2.fees.premiumFeeBps` 0, and a pool observation ring of at least
 * MIN_POOL_OBSERVATION_CARDINALITY for any market that keeps a univ3 settlement source.
 */
const INTERFACE_VERSION = 7;
const V1_STATUSES = ["live", "planned", "paused", "superseded-by-v2"];
const V1_WAVES = ["live", "canary", "wave1", "wave2"];
const V2_STATUSES = ["planned", "live", "paused"];
const V2_WAVES = ["canary", "wave1", "wave2"];
const V2_CONTRACT_NAMES = [
  "clearinghouse", "orderBook", "settlementOracle", "expiryCalendar", "keeperRewards",
  "autoRoller", "payoutAdapter", "makerVault", "makerRegistry", "rewardsDistributor",
];
const V2_SOURCE_NAMES = ["chainlink", "univ3", "dataStreams"];
/**
 * The v2 bot keys, by ADDRESS only (ops/v2/derive-bot-keys.sh writes them; the keys stay under
 * ~/.callhouse-keys/v2/). BIP-44 indices of the ops mnemonic: cranker 50 (no role), pricer 51
 * (PRICER_ROLE on AutoRoller), mmQuoter 52 (QUOTER_ROLE on MakerVault). ops/deploy.md §15.
 */
const V2_BOT_NAMES = ["cranker", "pricer", "mmQuoter"];
const V2_MARKET_KEYS = [
  "status", "wave", "strikeTick", "puts", "mintFeePpm", "univ3Pool", "univ3MinLiquidity", "dataStreamsFeedId",
  "overrides", "registeredAt", "registerTx",
];
/** V2Constants: strikes and prices are multiples of PRICE_TICK; the fee ceilings the contracts enforce. */
const PRICE_TICK = 100n;
const FEE_CEIL_BPS = { premiumFeeBps: 1000, resaleFeeBps: 1000, takerFeeCapBps: 1000, makerRebateBps: 10_000, exerciseFeeBps: 200 };
const TAKER_FEE_FLAT_CEIL = 1_000_000n;
/**
 * V2Constants.MINT_FEE_CEIL_PPM (INTERFACE_VERSION 7, c05): the highest collateral rent a market may be
 * registered with, in millionths of the locked collateral per MINT_FEE_PERIOD (7 days) of remaining life.
 * Clearinghouse._checkConfig reverts CeilingExceeded above it.
 */
const MINT_FEE_CEIL_PPM = 5000;
/**
 * V2Constants.MIN_POOL_OBSERVATION_CARDINALITY (SETTLEMENT_WINDOW + SNAPSHOT_GRACE + 1). Owner sign-off c10
 * (DECISIONS-2026-09-17 §7): a pool with a shorter observation ring can have the expiry's window overwritten by
 * one dust mint or burn per second before the snapshot grace ends, so UniV3TwapSource.setPool refuses it and the
 * market is registered Chainlink-only. Every launch pool but NVDA's and SPCX's is below it.
 */
const MIN_POOL_OBSERVATION_CARDINALITY = 2401;
/** V2Constants.MAX_ROUTE_FEE_TIER: the highest Uniswap v3 fee tier (hundredths of a bip) a v2 pool may have. */
const MAX_ROUTE_FEE_TIER = 10_000;
/** SettlementOracle.MAX_SPOT_MAX_AGE (4 days): setMarket refuses a larger spotMaxAge. */
const MAX_SPOT_MAX_AGE_S = 4 * 86_400;
/**
 * The least a market's spotMaxAgeS may exceed its feed's heartbeat by. The Robinhood Chain equity feeds print on a
 * 0.5 % move or the 24 h heartbeat, so a quiet feed's last print is up to a heartbeat (plus a transmit latency of at
 * most 30 s, 2026-08-03..09-17) old inside a regular session; any smaller age makes `spot()` revert StaleSpot for part
 * of most sessions (ops/deploy.md §15.13).
 */
const SPOT_AGE_OVER_HEARTBEAT_S = 3600;
const UINT128_MAX = (1n << 128n) - 1n;

/**
 * What a registry with no top-level `v2` block gets (a first build from nothing): the frozen
 * schema with every address null. The periphery addresses are the Uniswap v3 deployment on 4663
 * that the F2-02 recon found with code; the fees and defaults are the launch values of the plan.
 */
const V2_SKELETON = {
  interfaceVersion: INTERFACE_VERSION,
  deployBlock: null,
  contracts: {
    ...Object.fromEntries(V2_CONTRACT_NAMES.map((k) => [k, null])),
    sources: Object.fromEntries(V2_SOURCE_NAMES.map((k) => [k, null])),
  },
  bots: Object.fromEntries(V2_BOT_NAMES.map((k) => [k, null])),
  uniswapV3: {
    factory: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa",
    swapRouter02: "0xcaf681a66d020601342297493863e78c959e5cb2",
    quoterV2: "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7",
  },
  // INTERFACE_VERSION 7 (c05): premiumFeeBps is 0 at launch and the writer fee is mintFeePpm, collateral rent
  // charged at mint and refunded pro rata by close. The shared rate is the fallback RegisterMarkets reads as
  // V2_MINT_FEE_PPM; every tier-1 market carries its own reviewed `v2.mintFeePpm` and validation below
  // refuses a market without one, so the fallback only ever reaches a market nobody has priced.
  fees: { premiumFeeBps: 0, mintFeePpm: 80, resaleFeeBps: 0, takerFeeFlat: "100000", takerFeeCapBps: 1000, makerRebateBps: 5000, exerciseFeeBps: 25 },
  // INTERFACE_VERSION 7 (c21): the MakerVault Limits tuple the deploy sets, all six fields in setLimits order
  // in the pinned contracts. maxDailyOutflow is the leaky-bucket cap on net USDG a quoter call may pay out: at most the
  // cap at once and at most twice the cap in 24 h. The deploy reads them as V2_VAULT_* env; recorded here so the
  // incident runbook, the monitor and a later setLimits all quote the same six fields.
  vault: {
    maxSeriesUnits: "10000",
    maxTotalNotional: "250000000000",
    askToleranceBps: 100,
    maxBidBpsOfSpot: 1000,
    maxOrderLifetime: 0,
    maxDailyOutflow: "2500000000",
  },
  defaults: {
    maxDeviationBps: 150,
    uncorroboratedDelayS: 21600,
    // The feeds' 24 h heartbeat plus 1 h (ops/deploy.md §15.13): a quiet feed's last print stays accepted.
    spotMaxAgeS: 90000,
    ladder: {
      weekly: { rungs: 5, firstOtmBps: 200, stepBps: 200, cardTargetBps: 400 },
      daily: { rungs: 5, firstOtmBps: 100, stepBps: 100, cardTargetBps: 200 },
    },
    expiriesAhead: { weekly: 2, daily: 3 },
  },
};

/**
 * A market first seen by the builder gets this `v2` block: planned, last wave, no pool. strikeTick
 * and mintFeePpm are deliberately null, which validation refuses: a tick has to be chosen from the Cboe
 * listing (ops/recon/r13-probe.mjs proposes one) and an owner-reviewed rent rate, never
 * defaulted — a market that silently inherited the shared rate would charge writers the wrong rent, and
 * one that inherited 0 would charge nothing at all.
 */
const v2MarketSkeleton = () => ({
  status: "planned",
  wave: "wave2",
  strikeTick: null,
  puts: false,
  mintFeePpm: null,
  univ3Pool: null,
  univ3MinLiquidity: null,
  dataStreamsFeedId: null,
  overrides: {},
  registeredAt: null,
  registerTx: null,
});

const args = new Set(process.argv.slice(2));
const argValue = (flag) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
};
const CHECK_ONLY = args.has("--check");
const SKIP_CBOE = args.has("--skip-cboe");
const FEEDS_FILE = argValue("--feeds");

/*//////////////////////////////////////////////////////////////
                             HELPERS
//////////////////////////////////////////////////////////////*/

const log = (...a) => console.error(...a);

/** EIP-55 checksum without a dependency: keccak-256 over the lowercase hex, via `cast keccak`. */
async function checksum(addr) {
  const { stdout } = await execFileP("cast", ["to-check-sum-address", addr]);
  return stdout.trim();
}

/** `cast call` with a typed signature; returns the output lines with cast's `[1.2e3]` annotations stripped. */
async function call(to, sig, block, args = []) {
  const a = ["call", to, sig, ...args, "--rpc-url", RPC];
  if (block !== undefined) a.push("--block", String(block));
  const { stdout } = await execFileP("cast", a, { timeout: 30_000 });
  return stdout
    .trim()
    .split("\n")
    .map((l) => l.replace(/\s+\[[^\]]*\]\s*$/, "").trim());
}

const unquote = (s) => (s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s);

async function blockNumber() {
  const { stdout } = await execFileP("cast", ["block-number", "--rpc-url", RPC]);
  return Number(stdout.trim());
}

/** Run `fn` over `items` with at most `n` in flight. */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

/** `Robinhood NVDA / USD` and `Robinhood DELL-USD` both mean NVDA / DELL. */
function tickerOf(feed) {
  const m = feed.name.match(/^Robinhood\s+([A-Z0-9.]+)\s*(?:\/|-)\s*USD$/);
  return m ? m[1] : null;
}

/** The next two Fridays after `now`, as Cboe's YYMMDD. */
function nextFridays(now, count = 2) {
  const out = [];
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  while (out.length < count) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (d.getUTCDay() === 5) {
      out.push(
        `${String(d.getUTCFullYear()).slice(2)}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`,
      );
    }
  }
  return out;
}

/*//////////////////////////////////////////////////////////////
                              INPUTS
//////////////////////////////////////////////////////////////*/

async function loadFeeds() {
  if (FEEDS_FILE) {
    // Keep local input provenance without embedding a private machine path in the public registry.
    return { source: `local snapshot: ${path.basename(FEEDS_FILE)}`, feeds: JSON.parse(readFileSync(FEEDS_FILE, "utf8")) };
  }
  const res = await fetch(FEEDS_URL, { headers: { "user-agent": "stonkhouse-ops/1.0" } });
  if (!res.ok) throw new Error(`feed directory: HTTP ${res.status}`);
  return { source: FEEDS_URL, feeds: await res.json() };
}

function loadTokens() {
  return JSON.parse(readFileSync(TOKENS, "utf8"));
}

function loadExisting() {
  if (!existsSync(OUT)) return null;
  return JSON.parse(readFileSync(OUT, "utf8"));
}

/*//////////////////////////////////////////////////////////////
                           VERIFICATION
//////////////////////////////////////////////////////////////*/

async function verifyPair(ticker, asset, feed, block) {
  const issues = [];
  const v = { block, ok: false };
  try {
    v.feedDecimals = Number((await call(feed, "decimals()(uint8)", block))[0]);
    if (v.feedDecimals !== 8) issues.push(`feed decimals ${v.feedDecimals} != 8`);
  } catch (e) {
    issues.push(`feed decimals(): ${e.message.split("\n")[0]}`);
  }
  try {
    const [roundId, answer, , updatedAt] = await call(
      feed,
      "latestRoundData()(uint80,int256,uint256,uint256,uint80)",
      block,
    );
    v.feedRoundId = roundId;
    v.feedAnswer = answer;
    v.feedUpdatedAt = Number(updatedAt);
    v.feedAgeS = Math.floor(Date.now() / 1000) - v.feedUpdatedAt;
    if (BigInt(answer) <= 0n) issues.push(`feed answer ${answer} <= 0`);
    if (v.feedAgeS > DEFAULTS.maxPriceAgeS) issues.push(`feed age ${v.feedAgeS}s > maxPriceAge ${DEFAULTS.maxPriceAgeS}s`);
    v.spotUsd = Number(BigInt(answer)) / 1e8;
  } catch (e) {
    issues.push(`feed latestRoundData(): ${e.message.split("\n")[0]}`);
  }
  try {
    v.feedDescription = unquote((await call(feed, "description()(string)", block))[0]);
    if (!v.feedDescription.includes(ticker)) issues.push(`feed description "${v.feedDescription}" lacks ${ticker}`);
  } catch (e) {
    issues.push(`feed description(): ${e.message.split("\n")[0]}`);
  }
  try {
    v.tokenDecimals = Number((await call(asset, "decimals()(uint8)", block))[0]);
    if (v.tokenDecimals !== 18) issues.push(`token decimals ${v.tokenDecimals} != 18`);
  } catch (e) {
    issues.push(`token decimals(): ${e.message.split("\n")[0]}`);
  }
  try {
    v.tokenSymbol = unquote((await call(asset, "symbol()(string)", block))[0]);
    if (v.tokenSymbol !== ticker) issues.push(`token symbol "${v.tokenSymbol}" != ${ticker}`);
  } catch (e) {
    issues.push(`token symbol(): ${e.message.split("\n")[0]}`);
  }
  try {
    v.uiMultiplier = (await call(asset, "uiMultiplier()(uint256)", block))[0];
    if (BigInt(v.uiMultiplier) === 0n) issues.push("uiMultiplier() == 0");
  } catch (e) {
    issues.push(`token uiMultiplier(): ${e.message.split("\n")[0]}`);
  }
  try {
    v.oraclePaused = (await call(asset, "oraclePaused()(bool)", block))[0] === "true";
    if (v.oraclePaused) issues.push("oraclePaused() == true");
  } catch (e) {
    issues.push(`token oraclePaused(): ${e.message.split("\n")[0]}`);
  }
  v.issues = issues;
  v.ok = issues.length === 0;
  return v;
}

/*//////////////////////////////////////////////////////////////
                               CBOE
//////////////////////////////////////////////////////////////*/

async function probeCboe(root, spotUsd, previous) {
  const checkedAt = new Date().toISOString();
  const out = { root, url: CBOE(root), checkedAt, http: null, rows: 0, expiries: [], weekly: false, currentPrice: null, spotDivergenceBps: null, underlyingMatches: null };
  try {
    const res = await fetch(out.url, { headers: { "user-agent": "Mozilla/5.0 stonkhouse-ops/1.0" }, signal: AbortSignal.timeout(30_000) });
    out.http = res.status;
    if (!res.ok) return out;
    const json = await res.json();
    const opts = json?.data?.options ?? [];
    out.rows = opts.length;
    out.symbol = json?.data?.symbol ?? null;
    out.currentPrice = typeof json?.data?.current_price === "number" ? json.data.current_price : null;
    const exps = new Set();
    for (const o of opts) {
      const m = /^[A-Z.]+(\d{6})[CP]\d+$/.exec(o.option ?? "");
      if (m) exps.add(m[1]);
    }
    out.expiries = [...exps].sort();
    const fridays = nextFridays(new Date());
    out.weekly = fridays.every((f) => exps.has(f));
    if (out.currentPrice !== null && spotUsd) {
      out.spotDivergenceBps = Math.round((Math.abs(out.currentPrice / spotUsd - 1)) * 10_000);
      out.underlyingMatches = out.spotDivergenceBps <= DEFAULTS.maxSpotDivergenceBps;
    }
  } catch (e) {
    out.error = e.message;
    if (previous) return { ...previous, lastError: e.message, lastErrorAt: checkedAt };
  }
  return out;
}

/** vol only when the chain is weekly AND is the same underlying as the feed. */
function modeFor(cboe) {
  if (!cboe || cboe.http !== 200) return { mode: "fixed", reason: "no Cboe chain" };
  if (!cboe.weekly) return { mode: "fixed", reason: `no weekly expiries (has ${cboe.expiries.slice(0, 4).join(",")}…)` };
  if (cboe.underlyingMatches === false) {
    return { mode: "fixed", reason: `Cboe ${cboe.root} is a different instrument: current_price diverges ${cboe.spotDivergenceBps} bps from the feed` };
  }
  return { mode: "vol", reason: `weekly chain, ${cboe.rows} rows, spot divergence ${cboe.spotDivergenceBps ?? "?"} bps` };
}

/*//////////////////////////////////////////////////////////////
                         V2 VALIDATION
//////////////////////////////////////////////////////////////*/

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isAddress = (v) => typeof v === "string" && ADDRESS.test(v);
const isUint = (v) => Number.isSafeInteger(v) && v >= 0;
const isPositiveInt = (v) => Number.isSafeInteger(v) && v > 0;
/** A decimal string within (0, max]: how the registry spells a big integer (§3: strikeTick, takerFeeFlat). */
const isDecimalIn = (v, max) => typeof v === "string" && DECIMAL.test(v) && BigInt(v) > 0n && BigInt(v) <= max;

function loadV2Sources() {
  return existsSync(V2_SOURCES) ? JSON.parse(readFileSync(V2_SOURCES, "utf8")) : null;
}

/** Exactly these keys. Every consumer reads fixed names, so a misspelt key would be ignored silently. */
function exactKeys(obj, keys, where, issues) {
  for (const k of keys) if (!(k in obj)) issues.push(`${where}.${k} is missing`);
  for (const k of Object.keys(obj)) if (!keys.includes(k)) issues.push(`${where}.${k} is not a known key (${keys.join(", ")})`);
}

/** An object whose every leaf is a non-negative integer, shaped like `shape`: the defaults and ladders. */
function intTree(obj, shape, where, issues, { exact }) {
  if (!isObject(obj)) {
    issues.push(`${where} must be an object`);
    return;
  }
  if (exact) exactKeys(obj, Object.keys(shape), where, issues);
  for (const [k, v] of Object.entries(obj)) {
    if (!(k in shape)) {
      if (!exact) issues.push(`${where}.${k} is not a key of v2.defaults`);
      continue;
    }
    if (isObject(shape[k])) intTree(v, shape[k], `${where}.${k}`, issues, { exact });
    else if (!isUint(v)) issues.push(`${where}.${k} must be a non-negative integer, not ${JSON.stringify(v)}`);
  }
}

/** The top-level `v2` block. Offline; `recon` (v2-sources.json) cross-checks the periphery addresses. */
function validateV2Top(v2, recon, issues) {
  if (!isObject(v2)) {
    issues.push("v2 (top level) is missing or not an object");
    return;
  }
  exactKeys(v2, Object.keys(V2_SKELETON), "v2", issues);
  if (v2.interfaceVersion !== INTERFACE_VERSION) issues.push(`v2.interfaceVersion is ${JSON.stringify(v2.interfaceVersion)}, this builder knows ${INTERFACE_VERSION}`);
  if (v2.deployBlock !== null && !isPositiveInt(v2.deployBlock) && !isDecimalIn(v2.deployBlock, BigInt(Number.MAX_SAFE_INTEGER))) {
    issues.push("v2.deployBlock must be null or a positive block number");
  }
  if (isObject(v2.contracts)) {
    exactKeys(v2.contracts, [...V2_CONTRACT_NAMES, "sources"], "v2.contracts", issues);
    for (const k of V2_CONTRACT_NAMES) {
      if (k in v2.contracts && v2.contracts[k] !== null && !isAddress(v2.contracts[k])) issues.push(`v2.contracts.${k} must be null or an address`);
    }
    if (isObject(v2.contracts.sources)) {
      exactKeys(v2.contracts.sources, V2_SOURCE_NAMES, "v2.contracts.sources", issues);
      for (const k of V2_SOURCE_NAMES) {
        const a = v2.contracts.sources[k];
        if (a !== undefined && a !== null && !isAddress(a)) issues.push(`v2.contracts.sources.${k} must be null or an address`);
      }
    } else issues.push("v2.contracts.sources must be an object");
  } else issues.push("v2.contracts must be an object");
  if (isObject(v2.bots)) {
    exactKeys(v2.bots, V2_BOT_NAMES, "v2.bots", issues);
    for (const k of V2_BOT_NAMES) {
      if (k in v2.bots && v2.bots[k] !== null && !isAddress(v2.bots[k])) issues.push(`v2.bots.${k} must be null or an address`);
    }
  } else issues.push("v2.bots must be an object (null per bot until ops/v2/derive-bot-keys.sh writes the address)");
  if (isObject(v2.uniswapV3)) {
    exactKeys(v2.uniswapV3, Object.keys(V2_SKELETON.uniswapV3), "v2.uniswapV3", issues);
    const reconNames = { factory: "factory", swapRouter02: "router", quoterV2: "quoter" };
    for (const [k, r] of Object.entries(reconNames)) {
      const a = v2.uniswapV3[k];
      if (!isAddress(a)) {
        issues.push(`v2.uniswapV3.${k} must be an address`);
        continue;
      }
      const seen = recon?.contracts?.[r];
      if (seen && (seen.address.toLowerCase() !== a.toLowerCase() || seen.codeExists !== true)) {
        issues.push(`v2.uniswapV3.${k} ${a} is not the ${r} the F2-02 recon found with code (${seen.address})`);
      }
    }
  } else issues.push("v2.uniswapV3 must be an object");
  if (isObject(v2.fees)) {
    exactKeys(v2.fees, Object.keys(V2_SKELETON.fees), "v2.fees", issues);
    for (const [k, ceil] of Object.entries(FEE_CEIL_BPS)) {
      if (k in v2.fees && !(isUint(v2.fees[k]) && v2.fees[k] <= ceil)) issues.push(`v2.fees.${k} must be an integer in [0, ${ceil}]`);
    }
    const flat = v2.fees.takerFeeFlat;
    if ("takerFeeFlat" in v2.fees && !(flat === "0" || isDecimalIn(flat, TAKER_FEE_FLAT_CEIL))) {
      issues.push(`v2.fees.takerFeeFlat must be a decimal string of USDG base units in [0, ${TAKER_FEE_FLAT_CEIL}]`);
    }
    // INTERFACE_VERSION 7 (c05): a premium fee above the resale fee is the dodge the rent replaces — the writer
    // mints, writes into a one-tick bid of their own and resells at the resale fee. DeployV2Batch.sh refuses the
    // same, and DeployV2/VerifyV2 assert it on chain.
    if (isUint(v2.fees.premiumFeeBps) && isUint(v2.fees.resaleFeeBps) && v2.fees.premiumFeeBps > v2.fees.resaleFeeBps) {
      issues.push(
        `v2.fees.premiumFeeBps ${v2.fees.premiumFeeBps} is above v2.fees.resaleFeeBps ${v2.fees.resaleFeeBps}: from INTERFACE_VERSION 7 the writer fee is collateral rent at mint (v2.fees.mintFeePpm / v2.mintFeePpm) and a premium fee above the resale fee is avoidable by writing into your own bid and reselling`,
      );
    }
    // The shared rent rate. 0 is refused, not just out of range: with premiumFeeBps 0 a registry whose shared rate
    // fell to 0 would deploy markets that charge writers nothing (DECISIONS-2026-09-17 §11).
    if (!(isUint(v2.fees.mintFeePpm) && v2.fees.mintFeePpm > 0 && v2.fees.mintFeePpm <= MINT_FEE_CEIL_PPM)) {
      issues.push(`v2.fees.mintFeePpm must be an integer in [1, ${MINT_FEE_CEIL_PPM}] (MINT_FEE_CEIL_PPM); 0 would charge writers no rent while premiumFeeBps is 0`);
    }
  } else issues.push("v2.fees must be an object");
  validateV2Vault(v2.vault, issues);
  intTree(v2.defaults, V2_SKELETON.defaults, "v2.defaults", issues, { exact: true });
}

/**
 * `v2.vault`: the MakerVault `Limits` tuple the deploy sets, in setLimits order (INTERFACE_VERSION 7, c21).
 * Every field is validated against the solidity width it is encoded into, because a setLimits call site that
 * drops or overflows one does not encode. maxDailyOutflow must be > 0: 0 deploys the vault frozen — the quoter
 * could cancel, close and place asks but never bid, take or replace upwards — which is a post-launch spend
 * freeze, not a deploy value.
 */
const VAULT_LIMIT_MAX = {
  maxSeriesUnits: (1n << 64n) - 1n,
  maxTotalNotional: UINT128_MAX,
  askToleranceBps: 10_000n,
  maxBidBpsOfSpot: 10_000n,
  maxOrderLifetime: (1n << 32n) - 1n,
  maxDailyOutflow: UINT128_MAX,
};
/** The two that are written as decimal strings (uint64 / uint128 base units), like takerFeeFlat and strikeTick. */
const VAULT_LIMIT_STRINGS = new Set(["maxSeriesUnits", "maxTotalNotional", "maxDailyOutflow"]);

function validateV2Vault(vault, issues) {
  if (!isObject(vault)) {
    issues.push("v2.vault must be an object (the six-field MakerVault Limits the deploy sets)");
    return;
  }
  exactKeys(vault, Object.keys(V2_SKELETON.vault), "v2.vault", issues);
  for (const [k, max] of Object.entries(VAULT_LIMIT_MAX)) {
    if (!(k in vault)) continue;
    const v = vault[k];
    if (VAULT_LIMIT_STRINGS.has(k)) {
      if (!(v === "0" || isDecimalIn(v, max))) issues.push(`v2.vault.${k} must be a decimal string in [0, ${max}]`);
    } else if (!(isUint(v) && BigInt(v) <= max)) {
      issues.push(`v2.vault.${k} must be an integer in [0, ${max}]`);
    }
  }
  if ("maxDailyOutflow" in vault && vault.maxDailyOutflow === "0") {
    issues.push("v2.vault.maxDailyOutflow must be > 0: 0 deploys the MakerVault unable to bid, take or replace upwards; a spend freeze is a setLimits call after launch, not a deploy value");
  }
}

/** One market row: the v1 lifecycle fields and its `v2` block. Offline. */
function validateMarket(m, registry, recon, issues) {
  const t = m.ticker;
  if (!V1_STATUSES.includes(m.status)) issues.push(`${t}: status ${JSON.stringify(m.status)} is not ${V1_STATUSES.join(" | ")}`);
  if (!V1_WAVES.includes(m.wave)) issues.push(`${t}: wave ${JSON.stringify(m.wave)} is not ${V1_WAVES.join(" | ")}`);
  if (m.status === "live" && !m.deployment?.factory) issues.push(`${t}: status live but deployment.factory is null`);
  // Superseded means the factory was never built. A deployed factory is run off (v1RunOff), never superseded.
  if (m.status === "superseded-by-v2" && m.deployment?.factory) issues.push(`${t}: status superseded-by-v2 but a factory exists; a deployed v1 market is run off (v1RunOff), not superseded`);
  // When the owner froze this v1 factory (writesHalted + depositCap 0), in unix seconds. The freeze
  // runbook writes it together with v1RunOff: true, so a date without the run-off flag, or on a row
  // with no factory, is a half-done or misplaced edit.
  if (m.v1FrozenAt !== undefined && m.v1FrozenAt !== null) {
    if (!isPositiveInt(m.v1FrozenAt)) issues.push(`${t}: v1FrozenAt must be null or unix seconds (a positive integer), not ${JSON.stringify(m.v1FrozenAt)}`);
    if (!m.deployment?.factory) issues.push(`${t}: v1FrozenAt is set but deployment.factory is null: there is no v1 factory to have frozen`);
    if (m.v1RunOff !== true) issues.push(`${t}: v1FrozenAt is set but v1RunOff is not true: a frozen factory is run off, set both together`);
  }

  const v = m.v2;
  if (!isObject(v)) {
    issues.push(`${t}: v2 block is missing or not an object`);
    return;
  }
  exactKeys(v, V2_MARKET_KEYS, `${t}.v2`, issues);
  if (!V2_STATUSES.includes(v.status)) issues.push(`${t}: v2.status ${JSON.stringify(v.status)} is not ${V2_STATUSES.join(" | ")}`);
  if (!V2_WAVES.includes(v.wave)) issues.push(`${t}: v2.wave ${JSON.stringify(v.wave)} is not ${V2_WAVES.join(" | ")}`);
  if (!isDecimalIn(v.strikeTick, (1n << 64n) - 1n) || BigInt(v.strikeTick) % PRICE_TICK !== 0n) {
    issues.push(`${t}: v2.strikeTick ${JSON.stringify(v.strikeTick)} must be a decimal string of USDG base units, > 0 and a multiple of ${PRICE_TICK}`);
  }
  if (typeof v.puts !== "boolean") issues.push(`${t}: v2.puts must be true or false`);
  // INTERFACE_VERSION 7 (c05): the collateral rent this market is registered with, pinned into every series
  // created afterwards. Required per market and never 0: with premiumFeeBps 0 a missing or zero rate deploys a
  // market that charges writers nothing, and the shared v2.fees.mintFeePpm is a
  // fallback for a market nobody has priced, not a launch value. Rates require owner review.
  if (!(isUint(v.mintFeePpm) && v.mintFeePpm > 0 && v.mintFeePpm <= MINT_FEE_CEIL_PPM)) {
    issues.push(`${t}: v2.mintFeePpm ${JSON.stringify(v.mintFeePpm)} must be an integer in [1, ${MINT_FEE_CEIL_PPM}] (MINT_FEE_CEIL_PPM; Clearinghouse._checkConfig reverts CeilingExceeded above it, and 0 charges this market's writers no rent)`);
  }
  if (v.univ3Pool !== null && !isAddress(v.univ3Pool)) issues.push(`${t}: v2.univ3Pool must be null or an address`);
  if (v.univ3MinLiquidity !== null && !isDecimalIn(v.univ3MinLiquidity, UINT128_MAX)) {
    issues.push(`${t}: v2.univ3MinLiquidity must be null or a positive decimal string (uint128 pool liquidity)`);
  }
  // A pool without a floor would let the source trust a pool that has been drained; a floor without
  // a pool is a leftover.
  if ((v.univ3Pool === null) !== (v.univ3MinLiquidity === null)) issues.push(`${t}: v2.univ3Pool and v2.univ3MinLiquidity are set together or not at all`);
  if (v.dataStreamsFeedId !== null && !(typeof v.dataStreamsFeedId === "string" && BYTES32.test(v.dataStreamsFeedId))) {
    issues.push(`${t}: v2.dataStreamsFeedId must be null or a 32-byte hex id`);
  }
  if (isObject(v.overrides)) intTree(v.overrides, registry.v2?.defaults ?? V2_SKELETON.defaults, `${t}.v2.overrides`, issues, { exact: false });
  else issues.push(`${t}: v2.overrides must be an object ({} for none)`);
  // The spot age the oracle is registered with (RegisterMarkets passes it; 0 would mean the contract's 1 h default).
  const spotMaxAgeS = isObject(v.overrides) && "spotMaxAgeS" in v.overrides ? v.overrides.spotMaxAgeS : registry.v2?.defaults?.spotMaxAgeS;
  if (isUint(spotMaxAgeS)) {
    if (spotMaxAgeS === 0 || spotMaxAgeS > MAX_SPOT_MAX_AGE_S) issues.push(`${t}: spotMaxAgeS ${spotMaxAgeS} must be in [1, ${MAX_SPOT_MAX_AGE_S}] (SettlementOracle.MAX_SPOT_MAX_AGE; 0 is the contract's 1 h default)`);
    else if (isPositiveInt(m.feedHeartbeatS) && spotMaxAgeS < m.feedHeartbeatS + SPOT_AGE_OVER_HEARTBEAT_S) {
      issues.push(`${t}: spotMaxAgeS ${spotMaxAgeS} is under the feed heartbeat ${m.feedHeartbeatS} + ${SPOT_AGE_OVER_HEARTBEAT_S} s: spot() would revert StaleSpot whenever the feed is quiet (ops/deploy.md §15.13)`);
    }
  }
  if (v.registeredAt !== null && !isPositiveInt(v.registeredAt)) issues.push(`${t}: v2.registeredAt must be null or unix seconds`);
  if (v.registerTx !== null && !(typeof v.registerTx === "string" && BYTES32.test(v.registerTx))) issues.push(`${t}: v2.registerTx must be null or a transaction hash`);
  if (v.status !== "planned" && (v.registeredAt === null || v.registerTx === null)) {
    issues.push(`${t}: v2.status ${v.status} needs registeredAt and registerTx (the registration it went ${v.status} with)`);
  }
  if (v.status === "live") {
    for (const k of ["clearinghouse", "orderBook", "settlementOracle", "expiryCalendar"]) {
      if (!registry.v2?.contracts?.[k]) issues.push(`${t}: v2.status live but v2.contracts.${k} is null`);
    }
  }

  // The pool, offline, against the recon that selected it.
  if (isAddress(v.univ3Pool)) {
    const r = recon?.markets?.find((x) => x.ticker === t);
    const p = r?.pools?.find((x) => x.address.toLowerCase() === v.univ3Pool.toLowerCase());
    const want = [m.asset.toLowerCase(), registry.shared.usdg.toLowerCase()].sort().join("/");
    if (!recon) issues.push(`${t}: v2.univ3Pool is set but ops/markets/v2-sources.json is missing`);
    else if (!p) issues.push(`${t}: v2.univ3Pool ${v.univ3Pool} is not a pool the F2-02 recon found for ${t} (re-run ops/recon/r13-probe.mjs)`);
    else {
      const got = [p.token0.toLowerCase(), p.token1.toLowerCase()].sort().join("/");
      if (got !== want) issues.push(`${t}: v2.univ3Pool pair ${got} is not {asset, USDG} ${want}`);
      if (p.twap !== "usable") issues.push(`${t}: v2.univ3Pool is "${p.twap}" in the F2-02 recon; only a usable pool may be a settlement source`);
      // INTERFACE_VERSION 7, owner sign-off c10 (DECISIONS-2026-09-17 §7): the ring has to hold the whole
      // settlement window plus the snapshot grace, or one dust mint or burn per second overwrites the expiry's
      // observations before the snapshot is taken. UniV3TwapSource.setPool refuses a shallower pool
      // (UnsupportedAsset) and DeployV2Batch.sh refuses the registry row before anything is broadcast.
      if (!(isUint(p.cardinality) && p.cardinality >= MIN_POOL_OBSERVATION_CARDINALITY)) {
        issues.push(
          `${t}: v2.univ3Pool ${v.univ3Pool} has observation cardinality ${JSON.stringify(p.cardinality)} in the F2-02 recon, below MIN_POOL_OBSERVATION_CARDINALITY (${MIN_POOL_OBSERVATION_CARDINALITY}); register ${t} Chainlink-only (drop v2.univ3Pool and v2.univ3MinLiquidity, which also drops its payout route), or raise the ring with increaseObservationCardinalityNext(${MIN_POOL_OBSERVATION_CARDINALITY}) and re-run ops/recon/r13-probe.mjs`,
        );
      }
    }
  }
}

/**
 * One key per process (two bots on one key collide on nonces, ops/deploy.md §10): the three bot
 * addresses differ from each other and from every other key the registry names (admin, guardian,
 * fee recipient, the v1 market keepers). A collision means a wrong index or a pasted address.
 */
function validateV2Bots(registry, issues) {
  const bots = registry.v2?.bots;
  if (!isObject(bots)) return;
  const others = new Map();
  const name = (a, label) => { if (isAddress(a) && !others.has(a.toLowerCase())) others.set(a.toLowerCase(), label); };
  for (const k of ["admin", "guardian", "feeRecipient"]) name(registry.shared?.[k], `shared.${k}`);
  for (const m of registry.markets ?? []) name(m.deployment?.keeper, `${m.ticker} deployment.keeper`);
  const seen = new Map();
  for (const k of V2_BOT_NAMES) {
    const a = bots[k];
    if (!isAddress(a)) continue;
    const lower = a.toLowerCase();
    if (seen.has(lower)) issues.push(`v2.bots.${k} is the same address as v2.bots.${seen.get(lower)}`);
    if (others.has(lower)) issues.push(`v2.bots.${k} is the same address as ${others.get(lower)}`);
    seen.set(lower, k);
  }
}

/** Every non-null bot address must be written in its EIP-55 checksum form (via `cast`). */
async function checksumV2Bots(registry) {
  const issues = [];
  const bots = registry.v2?.bots;
  if (!isObject(bots)) return issues;
  for (const k of V2_BOT_NAMES) {
    if (!isAddress(bots[k])) continue;
    const want = await checksum(bots[k]);
    if (want !== bots[k]) issues.push(`v2.bots.${k} ${bots[k]} is not checksummed (${want})`);
  }
  return issues;
}

/** Every v2 problem the registry has without touching the chain. */
function validateV2(registry, recon) {
  const issues = [];
  validateV2Top(registry.v2, recon, issues);
  validateV2Bots(registry, issues);
  const tickers = new Set();
  for (const m of registry.markets) {
    if (tickers.has(m.ticker)) issues.push(`${m.ticker}: listed twice`);
    tickers.add(m.ticker);
    validateMarket(m, registry, recon, issues);
  }
  return issues;
}

/**
 * Each configured pool on chain, at the verification block: its tokens are {asset, USDG} and the
 * v3 factory returns it for its own fee tier (so it is a canonical factory pool, not a lookalike).
 * In-range liquidity under the floor is a note: harmonic-mean liquidity at settlement is the gate.
 */
async function probeV2Pools(registry, block) {
  const issues = [];
  const notes = [];
  const factory = registry.v2?.uniswapV3?.factory;
  const usdg = registry.shared.usdg.toLowerCase();
  const withPool = registry.markets.filter((m) => isAddress(m.v2?.univ3Pool));
  if (withPool.length && !isAddress(factory)) return { issues: ["v2.uniswapV3.factory is not an address: pools not probed"], notes, probed: 0 };
  await pool(withPool, 4, async (m) => {
    const p = m.v2.univ3Pool;
    try {
      const [token0] = await call(p, "token0()(address)", block);
      const [token1] = await call(p, "token1()(address)", block);
      const [fee] = await call(p, "fee()(uint24)", block);
      const [liquidity] = await call(p, "liquidity()(uint128)", block);
      const got = [token0.toLowerCase(), token1.toLowerCase()].sort().join("/");
      const want = [m.asset.toLowerCase(), usdg].sort().join("/");
      if (got !== want) issues.push(`${m.ticker}: pool ${p} on chain holds ${got}, not {asset, USDG} ${want}`);
      // INTERFACE_VERSION 6: UniV3PayoutAdapter.setRoute refuses a tier above 1 % (V2Constants.MAX_ROUTE_FEE_TIER) and
      // RegisterMarkets will not take such a pool as a TWAP source either.
      if (Number(fee) > MAX_ROUTE_FEE_TIER) issues.push(`${m.ticker}: pool ${p} fee tier ${fee} is above ${MAX_ROUTE_FEE_TIER} (1 %): no payout route or TWAP source can use it`);
      const [canonical] = await call(factory, "getPool(address,address,uint24)(address)", block, [token0, token1, fee]);
      if (canonical.toLowerCase() !== p.toLowerCase()) issues.push(`${m.ticker}: factory getPool(…, ${fee}) is ${canonical}, not ${p}`);
      if (isDecimalIn(m.v2.univ3MinLiquidity, UINT128_MAX) && BigInt(liquidity) < BigInt(m.v2.univ3MinLiquidity)) {
        notes.push(`${m.ticker}: in-range liquidity ${liquidity} is below the floor ${m.v2.univ3MinLiquidity} at block ${block}`);
      }
    } catch (e) {
      issues.push(`${m.ticker}: pool ${p}: ${e.message.split("\n")[0]}`);
    }
  });
  return { issues, notes, probed: withPool.length };
}

/*//////////////////////////////////////////////////////////////
                               MAIN
//////////////////////////////////////////////////////////////*/

async function main() {
  const { source: feedsSource, feeds } = await loadFeeds();
  const tokens = loadTokens();
  const existing = loadExisting();
  const recon = loadV2Sources();
  const prevByTicker = new Map((existing?.markets ?? []).map((m) => [m.ticker, m]));

  const equity = feeds.filter((f) => f?.docs?.marketHours === "us_equities_24/5");
  log(`feeds: ${feeds.length} total, ${equity.length} tokenised-equity (us_equities_24/5)`);

  const bySymbol = new Map();
  for (const t of tokens) {
    if (!bySymbol.has(t.symbol)) bySymbol.set(t.symbol, []);
    bySymbol.get(t.symbol).push(t);
  }

  const block = await blockNumber();
  log(`chain 4663 head ${block} via ${RPC}`);

  const skipped = [];
  const pairs = [];
  for (const f of equity) {
    const ticker = tickerOf(f);
    if (!ticker) {
      skipped.push({ feed: f.name, why: "ticker not derivable from feed name" });
      continue;
    }
    const matches = bySymbol.get(ticker) ?? [];
    if (matches.length !== 1) {
      skipped.push({ feed: f.name, ticker, why: `${matches.length} Stock Tokens with symbol ${ticker} in R6 list` });
      continue;
    }
    pairs.push({ ticker, feed: f, token: matches[0] });
  }
  pairs.sort((a, b) => (a.ticker < b.ticker ? -1 : 1));
  log(`pairs: ${pairs.length}; skipped: ${skipped.length}`);

  const markets = await pool(pairs, 6, async ({ ticker, feed, token }) => {
    const asset = await checksum(token.token);
    const feedProxy = await checksum(feed.proxyAddress);
    const feedSvr = feed.secondaryProxyAddress ? await checksum(feed.secondaryProxyAddress) : null;
    const feedAggregator = feed.contractAddress ? await checksum(feed.contractAddress) : null;
    const prev = prevByTicker.get(ticker);

    const verification = await verifyPair(ticker, asset, feedProxy, block);
    log(`  ${ticker.padEnd(6)} ${verification.ok ? "ok  " : "FAIL"} spot=${verification.spotUsd ?? "?"} age=${verification.feedAgeS ?? "?"}s ${verification.issues.join("; ")}`);

    const cboe = SKIP_CBOE ? (prev?.cboe ?? null) : await probeCboe(ticker, verification.spotUsd, prev?.cboe);
    const auto = modeFor(cboe);
    const mode = prev?.modeOverride ?? auto.mode;

    // `depositCapUsd: null` means uncapped (the live NVDA factory runs with type(uint256).max).
    const depositCapUsd = prev && "depositCapUsd" in prev ? prev.depositCapUsd : DEFAULTS.depositCapUsd;
    const spot = verification.spotUsd ?? 0;
    let depositCap;
    if (depositCapUsd === null) {
      depositCap = (2n ** 256n - 1n).toString();
    } else {
      const capTokens = spot > 0 ? Math.max(1, Math.floor(depositCapUsd / spot)) : 1;
      depositCap = (BigInt(capTokens) * 10n ** 18n).toString();
    }

    const wave = prev?.wave ?? (Object.entries(WAVES).find(([, list]) => list.includes(ticker))?.[0] ?? "wave2");
    // ADR-02 cancelled the per-market factory rollout: a market the builder has not seen before is
    // never a v1 candidate. It enters superseded, with a planned v2 block (v2MarketSkeleton).
    const status = prev?.status ?? (wave === "live" ? "live" : "superseded-by-v2");

    return {
      ticker,
      name: token.name,
      asset,
      assetSymbol: verification.tokenSymbol ?? null,
      assetDeployBlock: token.block,
      feed: feedProxy,
      feedSvr,
      feedAggregator,
      feedName: feed.name,
      feedDescription: verification.feedDescription ?? null,
      feedHeartbeatS: feed.heartbeat ?? null,
      feedThresholdPct: feed.threshold ?? null,
      cboe,
      mode,
      modeReason: prev?.modeOverride ? `override (auto: ${auto.mode}, ${auto.reason})` : auto.reason,
      ...(prev?.modeOverride ? { modeOverride: prev.modeOverride } : {}),
      depositCapUsd,
      depositCap,
      strikeOtmBps: prev?.strikeOtmBps ?? DEFAULTS.strikeOtmBps,
      minAskUsdg6: prev?.minAskUsdg6 ?? DEFAULTS.minAskUsdg6,
      targetDelta: prev?.targetDelta ?? DEFAULTS.targetDelta,
      priceEdgeBps: prev?.priceEdgeBps ?? DEFAULTS.priceEdgeBps,
      premiumMarginBps: prev?.premiumMarginBps ?? DEFAULTS.premiumMarginBps,
      wave,
      status,
      // Absent means false. Whatever was hand-written survives as written: a bad value is refused
      // loudly by ops/keeper-env.sh, where dropping it here would quietly un-freeze the market.
      ...(prev && "v1RunOff" in prev ? { v1RunOff: prev.v1RunOff } : {}),
      // Absent (or null) until the freeze. Kept as written too; validateMarket refuses a bad one.
      ...(prev && "v1FrozenAt" in prev ? { v1FrozenAt: prev.v1FrozenAt } : {}),
      // Hand-maintained as written (validateMarket says what is wrong with it); never merged key by key.
      v2: prev && "v2" in prev ? prev.v2 : v2MarketSkeleton(),
      verification,
      deployment: prev?.deployment ?? {
        factory: null,
        implementation: null,
        deployBlock: null,
        deployTx: null,
        keeper: null,
        keeperKeyIndex: null,
        guardian: SHARED.guardian,
        admin: SHARED.admin,
        feeRecipient: SHARED.feeRecipient,
        sourcify: null,
        configuredAt: null,
      },
      explorer: { asset: `${EXPLORER}/address/${asset}`, feed: `${EXPLORER}/address/${feedProxy}` },
      ...(prev?.notes ? { notes: prev.notes } : {}),
    };
  });

  const failing = markets.filter((m) => !m.verification.ok);
  const registry = {
    // Preserved as written, like the v2 blocks: what a non-production registry (supplied explicitly,
    // `--registry`) says about itself. Absent from ops/markets/tier1.json, which _readme describes.
    ...(existing && "_dev" in existing ? { _dev: existing._dev } : {}),
    _readme: README,
    generatedAt: new Date().toISOString(),
    verifiedAtBlock: block,
    rpc: RPC,
    feedsSource: { source: feedsSource, total: feeds.length, equity: equity.length },
    tokensSource: { file: "ops/recon/R6-stock-tokens-list.json", total: tokens.length },
    shared: SHARED,
    defaults: DEFAULTS,
    waves: WAVES,
    // Hand-maintained until the v2 deploy writes addresses back; the skeleton only for a first build.
    v2: existing && "v2" in existing ? existing.v2 : V2_SKELETON,
    skipped,
    summary: {
      markets: markets.length,
      verified: markets.length - failing.length,
      failing: failing.map((m) => m.ticker),
      vol: markets.filter((m) => m.mode === "vol").map((m) => m.ticker),
      fixed: markets.filter((m) => m.mode === "fixed").map((m) => m.ticker),
      live: markets.filter((m) => m.status === "live").map((m) => m.ticker),
    },
    markets,
  };

  // --check judges the committed file (a registry with no v2 block must fail, not borrow the
  // skeleton); a build judges what it is about to write.
  const subject = CHECK_ONLY && existing ? existing : registry;
  const v2Issues = validateV2(subject, recon);
  v2Issues.push(...(await checksumV2Bots(subject)));
  const probe = await probeV2Pools(subject, block);
  v2Issues.push(...probe.issues);
  for (const n of probe.notes) log(`  note: ${n}`);
  const v2Summary = `v2: ${subject.markets.length} market blocks, ${probe.probed} pools checked on chain at block ${block}, ${v2Issues.length} problem(s)`;

  if (CHECK_ONLY) {
    const drift = [];
    for (const m of markets) {
      const p = prevByTicker.get(m.ticker);
      if (!p) drift.push(`${m.ticker}: new`);
      else if (p.asset !== m.asset || p.feed !== m.feed) drift.push(`${m.ticker}: asset/feed changed`);
      if (!m.verification.ok) drift.push(`${m.ticker}: ${m.verification.issues.join("; ")}`);
    }
    for (const t of prevByTicker.keys()) if (!markets.some((m) => m.ticker === t)) drift.push(`${t}: gone from feed directory`);
    drift.push(...v2Issues);
    if (drift.length) {
      log("DRIFT:\n  " + drift.join("\n  "));
      log(v2Summary);
      process.exit(1);
    }
    log(v2Summary);
    log("no drift");
    return;
  }

  mkdirSync(here, { recursive: true });
  writeFileSync(OUT, JSON.stringify(registry, null, 2) + "\n");
  log(`wrote ${path.relative(process.cwd(), OUT)}: ${markets.length} markets, ${failing.length} failing verification, ${registry.summary.fixed.length} fixed-mode (${registry.summary.fixed.join(", ")})`);
  if (skipped.length) log("skipped:", JSON.stringify(skipped, null, 1));
  log(v2Summary);
  // Written anyway, like a failing verification: the hand edits are preserved as they were, and
  // the exit code is what stops a deploy.
  if (v2Issues.length) log("v2 PROBLEMS:\n  " + v2Issues.join("\n  "));
  if (failing.length || v2Issues.length) process.exit(1);
}

main().catch((e) => {
  log(e.stack ?? String(e));
  process.exit(1);
});
