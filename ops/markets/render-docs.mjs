#!/usr/bin/env node
/**
 * Render the public "Markets" docs page from the market registry.
 *
 *   ops/markets/tier1.json (+ v2-sources.json + v7-legacy.json)
 *     -> callhouse-docs/product/markets.md (and its GitBook mirror)
 *
 * WHY A RENDERER AND NOT A HAND-WRITTEN PAGE
 *   The docs promise "trust only the addresses on this page". With 35 markets that is 70 token and
 *   feed addresses, the configured Uniswap v3 pools, the v2 contracts and the v1 factory; a hand-copied table is
 *   the one place a wrong address could slip in unnoticed. So the page is GENERATED from the
 *   registry, whose token and feed addresses were read on chain at `verifiedAtBlock` and whose v2
 *   blocks `build-markets.mjs --check` validates (pools included, on chain), and `--check` here is
 *   a CI / pre-deploy gate: the committed page must equal what the registry renders, or the deploy
 *   stops. Every address and per-market figure comes from the registry. The few numbers it cannot
 *   carry are compiled constants of the v2 contracts (the 30-minute settlement window, the
 *   10-minute snapshot grace; V2Constants.sol), stated as such.
 *
 * WHAT IT RENDERS (the v2 markets page, D2-04)
 *   - what a market is on v2 (one Stock Token on the shared contracts), the standing v2 disclosure
 *     and the address warning;
 *   - status and waves: what planned / live / paused mean, and which tickers are in which wave;
 *   - per market, ordered live -> paused -> planned, then canary -> wave1 -> wave2, then ticker:
 *       * v2 status (with the registration date and tx once registered), wave, Stock Token,
 *         Chainlink feed, settlement sources: Chainlink always; + Uniswap v3 TWAP with the pool when
 *         `v2.univ3Pool` is set; the separate v3-or-v4 payout route; oracle settings a market overrides;
 *       * strike tick in USDG, puts yes/no, the weekly and daily ladder shape (expiries ahead,
 *         strikes, first distance, step) from `v2.defaults` with the market's `v2.overrides` merged;
 *   - the v2 contracts (`v2.contracts`), flywheel contracts (`v2.flywheel`), Admin and Treasury
 *     Safes (`shared.safes`), their deploy blocks, and the third-party contracts v2 relies on;
 *   - the interface-7 contract set and its registered markets from the frozen `v7-legacy.json` input;
 *   - legacy: the v1 factories that exist (live or paused rows; NVDA today) with their run-off state
 *     (`v1RunOff`, with the freeze date when `v1FrozenAt` is set), and the count of per-market
 *     factories that were never built (superseded-by-v2);
 *   - provenance: the registry's verifiedAtBlock and generatedAt and the recon's observedBlock and
 *     checkedAt. The page carries those timestamps, never `Date.now()`, so a re-render of an
 *     unchanged registry is byte-identical and `--check` is meaningful.
 *
 * WHAT IT REFUSES (throws, so the gate goes red instead of the page going wrong)
 *   - an unknown v1 status or v2 status / wave; a v1 `planned` row (ADR-02 cancelled that rollout:
 *     the page has nothing true to say about a planned v1 factory);
 *   - a live or paused v1 row without a factory, a superseded row with one; a `v1FrozenAt` that is not
 *     unix seconds on a factory with `v1RunOff: true`;
 *   - a registered (live / paused) v2 market without registeredAt + registerTx, a live v2 market
 *     while the Clearinghouse address is null;
 *   - a `v2.contracts`, `v2.contracts.sources`, `v2.flywheel`, `shared.safes` or `v2.defaults` key it
 *     does not know, or an override outside `v2.defaults`: a schema change must reach this page;
 *   - a missing or non-interface-7 `v7-legacy.json`, or one without its `_legacy` marker;
 *   - a `v2.interfaceVersion` other than RENDERS_INTERFACE_VERSION. Registry schema v2 has no
 *     "Data Streams enabled for this market" field (`dataStreamsFeedId` is the recon's stream id,
 *     set for all 35 whether or not access exists), and C2-12 registers the source for no market, so
 *     the page says Data Streams settles no market. The interface revision that adds that switch
 *     must bump the version, and this renderer with it.
 *
 * WHERE IT WRITES
 *   callhouse-docs is the GitBook repository, a sibling of this app repository
 *   (../callhouse-docs from the app root). GitBook syncs the space from `callhouse-docs/docs/`
 *   (gitbook-docs.yaml, `content.directory: ./docs`), and the repository keeps the root pages and
 *   that mirror identical (every docs commit touches both). So by default the renderer writes and
 *   checks BOTH `product/markets.md` and `docs/product/markets.md`; `--out <path>` narrows it to
 *   one file (a rehearsal, a fork, a different checkout). `--docs-dir <dir>` points at another
 *   callhouse-docs checkout (a worktree always needs it). Remember that a push to callhouse-docs
 *   PUBLISHES.
 *
 * USAGE
 *   node ops/markets/render-docs.mjs             # render; prints each path written
 *   node ops/markets/render-docs.mjs --check     # exit 1 if any target differs from the render
 *   node ops/markets/render-docs.mjs --out /tmp/markets.md
 *   node ops/markets/render-docs.mjs --docs-dir ~/src/callhouse-docs
 *
 * Node >= 22, no npm dependencies on purpose (it runs from a bare checkout, before any install).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// T-OP-138. The six external contracts' KEY LIST comes from the builder, never from a second hand-written
// copy: `build-markets.mjs` is where T-OP-114 defined it, and a list re-typed here would agree with it right
// up to the day one of them changed. Importing the module runs no build (its `main()` is guarded by
// `isMain`); it reads only node built-ins.
import { V2_EXTERNAL_CONTRACT_NAMES } from "./build-markets.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..", "..");
const REGISTRY = path.join(here, "tier1.json");
const RECON = path.join(here, "v2-sources.json");
const LEGACY = path.join(here, "v7-legacy.json");
const EXPLORER = "https://robinhoodchain.blockscout.com";

/** The registry interface version this page is written for (see WHAT IT REFUSES). */
const RENDERS_INTERFACE_VERSION = 8; // `dataStreamsFeedId` still does not say whether Data Streams is enabled for a market, so the configured-source refusal remains version-pinned instead of being inferred.
const LEGACY_INTERFACE_VERSION = 7;
// Mirrored from contracts/src/v2/interfaces/V2Constants.sol:44,48,95 at the v8 contract source:
// the settlement window, v3 snapshot grace, and largest accepted payout-route fee tier.
const SETTLEMENT_WINDOW_S = 1800;
const SNAPSHOT_GRACE_S = 600;
const MAX_ROUTE_FEE_TIER = 10_000;
/** Every v1 status the registry may carry (build-markets.mjs validates the same list). */
const V1_STATUSES = ["live", "paused", "planned", "superseded-by-v2"];
const V2_STATUS_ORDER = ["live", "paused", "planned"];
const V2_WAVE_ORDER = ["canary", "wave1", "wave2"];
const WAVE_LABEL = { canary: "Canary", wave1: "Wave 1", wave2: "Wave 2" };
const TENORS = ["weekly", "daily"];

/** `v2.contracts` in page order: key, contract name, what it does. Exactly these keys (plus `sources`). */
const V2_CONTRACTS = [
  ["clearinghouse", "Clearinghouse", "Markets, series, collateral, settlement and redemption"],
  ["orderBook", "OrderBook", "Bids, resale asks and write-on-fill asks"],
  ["settlementOracle", "SettlementOracle", "The settlement price of each market and expiry"],
  ["expiryCalendar", "ExpiryCalendar", "Which timestamps are valid daily and weekly expiries"],
  ["keeperRewards", "KeeperRewards", "Small USDG bounties for permissionless lifecycle calls"],
  ["autoRoller", "AutoRoller", "Writers' auto-roll strategies"],
  ["payoutAdapter", "PayoutRouter", "Attempts eligible winning-call conversion to USDG over the configured Uniswap v3 or v4 route"],
  ["makerVault", "MakerVault", "The protocol's market-making vault"],
  ["makerRegistry", "MakerRegistry", "Market maker rebate tiers"],
  ["rewardsDistributor", "RewardsDistributor", "Market maker reward claims per epoch"],
  ["accessManager", "AccessManager", "Delayed administration and instant guardian controls"],
];
/** `v2.contracts.sources`: key, contract name, what it does. */
const V2_SOURCES = [
  ["chainlink", "ChainlinkFeedSource", "Settlement source: Chainlink push feeds"],
  ["univ3", "UniV3TwapSource", "Settlement source: Uniswap v3 pool TWAPs"],
  ["dataStreams", "DataStreamsSource", "Settlement source: Chainlink Data Streams (enabled for no market)"],
];
/**
 * The six EXTERNAL v2 contracts (T-OP-114): `v2.contracts` keys the deploy wrapper reads and T-OP-116's
 * externals step writes back, but which DeployV8 does not create. ACCEPTED WHEN PRESENT, never required:
 * the committed registry does not carry them until the first write-back, and `checkKeys` below refuses
 * any name outside core ∪ externals exactly as before. What each one does, looked up BY THE IMPORTED
 * LIST — the page order and the key set are the builder's; only the prose lives here, and a key the
 * builder knows that this table cannot describe throws at load (`describeExternals`), so the list and
 * the prose cannot drift apart silently.
 */
// Prose mirrors each contract's @notice at callhouse-contracts leekzor/v8 (HouseVault.sol:22, HouseVaultFactory.sol:13,
// Hedger.sol:19, RewardsDistributor via DeployLenderRewards.s.sol, EarnVault.sol:25, StockVenueAdapter.sol:7).
const V2_EXTERNAL_DESCRIPTIONS = {
  houseVault: ["HouseVault", "The user-funded market maker: one instance per market; depositors fund it with USDG and Stock Tokens"],
  houseVaultFactory: ["HouseVaultFactory", "Deploys one HouseVault per market and keeps the index of them (created by LISTING)"],
  hedger: ["Hedger", "Posts USDG, borrows stock, sells it via the payout route and buys it back via Uniswap v4"],
  rewardsDistributorLender: ["RewardsDistributor (lender)", "The second RewardsDistributor instance: lender reward claims per epoch, paid in the $STONKHOUSE token"],
  earnVault: ["EarnVault", "The Earn vault: depositors pay one ERC-20 in and get shares"],
  stockVenueAdapter: ["StockVenueAdapter", "The Earn vault's stock-side venue adapter (shipped disabled)"],
};
/** `[key, name, what]` for every external, in the builder's order; throws if the two disagree. */
function describeExternals() {
  const known = Object.keys(V2_EXTERNAL_DESCRIPTIONS);
  const missing = V2_EXTERNAL_CONTRACT_NAMES.filter((k) => !known.includes(k));
  const extra = known.filter((k) => !V2_EXTERNAL_CONTRACT_NAMES.includes(k));
  if (missing.length || extra.length) {
    throw new Error(`V2_EXTERNAL_DESCRIPTIONS disagrees with build-markets.mjs V2_EXTERNAL_CONTRACT_NAMES${missing.length ? `: no description for ${missing.join(", ")}` : ""}${extra.length ? `: describes ${extra.join(", ")}, which the builder does not know` : ""}`);
  }
  return V2_EXTERNAL_CONTRACT_NAMES.map((k) => [k, ...V2_EXTERNAL_DESCRIPTIONS[k]]);
}
const V2_EXTERNALS = describeExternals();
/** Closed v8 periphery blocks that are not members of `v2.contracts`. */
const V2_FLYWHEEL = [
  ["feeSplitter", "FeeSplitter", "Protocol fee receiver and distributor"],
  ["buybackExecutor", "V4BuybackExecutor", "Restricted Uniswap v4 execution for the fee flywheel"],
];
const SHARED_SAFES = [
  ["admin", "Admin Safe", "2-of-3 owner Safe for delayed administration"],
  ["treasury", "Treasury Safe", "2-of-3 Safe that holds protocol treasury assets"],
];
/** The archived interface-7 set has the pre-v8 `v2.contracts` shape. */
const LEGACY_V2_CONTRACTS = [
  ["clearinghouse", "Clearinghouse", "Markets, series, collateral, settlement and redemption"],
  ["orderBook", "OrderBook", "Bids, resale asks and write-on-fill asks"],
  ["settlementOracle", "SettlementOracle", "The settlement price of each market and expiry"],
  ["expiryCalendar", "ExpiryCalendar", "Which timestamps are valid daily and weekly expiries"],
  ["keeperRewards", "KeeperRewards", "Small USDG bounties for permissionless lifecycle calls"],
  ["autoRoller", "AutoRoller", "Writers' auto-roll strategies"],
  ["payoutAdapter", "UniV3PayoutAdapter", "Attempts eligible winning-call conversion over Uniswap v3"],
  ["makerVault", "MakerVault", "The protocol's market-making vault"],
  ["makerRegistry", "MakerRegistry", "Market maker rebate tiers"],
  ["rewardsDistributor", "RewardsDistributor", "Market maker reward claims per epoch"],
];
// IPayoutRouter.sol:41-45 names None, V3 and V4. The registry mirrors None as null and the other
// two as lower-case `venue` values, matching ops/v2/monitor.mjs's existing vocabulary.
const PAYOUT_ROUTE_KEYS = {
  v3: ["venue", "fee"],
  v4: ["venue", "fee", "tickSpacing", "poolId"],
};
/** The shape of `v2.defaults` this page renders; a market's `v2.overrides` may name any subset. */
const LADDER_SHAPE = { rungs: 0, firstOtmBps: 0, stepBps: 0, cardTargetBps: 0 };
const DEFAULTS_SHAPE = {
  maxDeviationBps: 0,
  uncorroboratedDelayS: 0,
  spotMaxAgeS: 0,
  ladder: { weekly: LADDER_SHAPE, daily: LADDER_SHAPE },
  expiriesAhead: { weekly: 0, daily: 0 },
};

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) {
    console.error(`render-docs: ${name} needs a value (a path), got '${v ?? "(end of arguments)"}'`);
    process.exit(2);
  }
  return v;
};
const CHECK = flag("--check");
const OUT = opt("--out");
const DOCS_DIR = path.resolve(opt("--docs-dir") ?? path.join(appRoot, "..", "callhouse-docs"));

// ---------------------------------------------------------------------------------------------
// Formatting helpers. Every address is printed in full inside a link to the explorer: the page is
// the thing a user compares a wallet prompt against, and an abbreviated `0xd060…9EEC` is exactly
// what an impostor token can match. Long tables are the price.
// ---------------------------------------------------------------------------------------------
const addr = (a) => `[\`${a}\`](${EXPLORER}/address/${a})`;
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const block = (n) => Number(n).toLocaleString("en-US");
const day = (unixSeconds) => new Date(unixSeconds * 1000).toISOString().slice(0, 10);

/** USDG base units (6 dp) -> "2.50 USDG": at least two decimals, never rounded. */
function usdg(raw) {
  const v = BigInt(raw);
  const frac = (v % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${(v / 1_000_000n).toLocaleString("en-US")}.${frac} USDG`;
}

/** Basis points -> "2%", "1.5%", "0.25%". */
const pct = (bps) => `${bps / 100}%`;

/** Seconds -> "6 h", "30 min", "90 s". */
function duration(s) {
  if (s % 3600 === 0) return `${s / 3600} h`;
  if (s % 60 === 0) return `${s / 60} min`;
  return `${s} s`;
}

/** Throw unless `obj` has exactly the keys of `shape` (recursively), or a subset when `subset`. */
function checkShape(obj, shape, where, { subset }) {
  if (!isObject(obj)) throw new Error(`${where} must be an object`);
  for (const k of Object.keys(obj)) {
    if (!(k in shape)) throw new Error(`${where}.${k} is not a key this page renders (${Object.keys(shape).join(", ")}): update render-docs.mjs`);
  }
  for (const [k, v] of Object.entries(shape)) {
    if (!(k in obj)) {
      if (subset) continue;
      throw new Error(`${where}.${k} is missing`);
    }
    if (isObject(v)) checkShape(obj[k], v, `${where}.${k}`, { subset });
    else if (!Number.isSafeInteger(obj[k]) || obj[k] < 0) throw new Error(`${where}.${k} must be a non-negative integer`);
  }
}

/** `v2.defaults` with a market's `v2.overrides` laid over it, key by key. */
function withOverrides(defaults, overrides) {
  const out = {};
  for (const [k, v] of Object.entries(defaults)) {
    const o = overrides?.[k];
    out[k] = isObject(v) ? withOverrides(v, o) : o === undefined ? v : o;
  }
  return out;
}

/** One tenor's ladder: "2 expiries, 5 strikes from +2% in 2% steps", or "none". */
function ladderCell(eff, def, tenor) {
  const l = eff.ladder[tenor];
  const d = def.ladder[tenor];
  const n = eff.expiriesAhead[tenor];
  const own = n !== def.expiriesAhead[tenor] || l.rungs !== d.rungs || l.firstOtmBps !== d.firstOtmBps || l.stepBps !== d.stepBps;
  const text =
    n === 0 || l.rungs === 0
      ? "none"
      : `${n} ${n === 1 ? "expiry" : "expiries"}, ${l.rungs} ${l.rungs === 1 ? "strike" : "strikes"} from +${pct(l.firstOtmBps)}${l.rungs === 1 ? "" : ` in ${pct(l.stepBps)} steps`}`;
  return own ? `${text} (market setting)` : text;
}

/** Chainlink, + the Uniswap v3 pool when set, + any oracle setting the market overrides. */
function sourcesCell(m, eff, def) {
  const sources = ["Chainlink"];
  if (m.v2.univ3Pool) sources.push(`Uniswap v3 TWAP ${addr(m.v2.univ3Pool)}`);
  // Data Streams is never listed: registry interface 8 still cannot say it is enabled (see the header).
  const own = [];
  if (eff.maxDeviationBps !== def.maxDeviationBps) own.push(`agreement within ${pct(eff.maxDeviationBps)}`);
  if (eff.uncorroboratedDelayS !== def.uncorroboratedDelayS) own.push(`single-source delay ${duration(eff.uncorroboratedDelayS)}`);
  if (eff.spotMaxAgeS !== def.spotMaxAgeS) own.push(`spot max age ${duration(eff.spotMaxAgeS)}`);
  return sources.join(" + ") + (own.length ? ` (${own.join(", ")})` : "");
}

/** The payout execution route is deliberately separate from the settlement-source pool. */
function payoutRouteCell(route) {
  if (route === null) return "No route — winning calls pay in Stock Tokens in kind";
  // IPayoutRouter.sol:47 defines `fee` as hundredths of a bip on both venues. `pct()` takes basis
  // points, so divide by 100 before formatting (3000 -> 30 bps -> 0.3%).
  const tier = pct(route.fee / 100);
  if (route.venue === "v3") return `Uniswap v3 — ${tier} fee tier`;
  // A v4 pool has no address. Its bytes32 id is the pin (IPayoutRouter.sol:20-23), so do not use addr().
  return `Uniswap v4 — ${tier} fee tier, tick spacing ${route.tickSpacing}, pool id \`${route.poolId}\``;
}

function statusCell(v) {
  if (v.status === "planned") return "`planned`";
  const when = `[${day(v.registeredAt)}](${EXPLORER}/tx/${v.registerTx})`;
  return v.status === "live" ? `\`live\` since ${when}` : `\`paused\` (registered ${when})`;
}

/** A ticker list for prose and table cells: "AAPL, AMD and AMZN", or "—". */
function list(tickers) {
  if (tickers.length === 0) return "—";
  if (tickers.length === 1) return tickers[0];
  return `${tickers.slice(0, -1).join(", ")} and ${tickers.at(-1)}`;
}

// ---------------------------------------------------------------------------------------------
// Consistency. Anything the page cannot render truthfully is a registry error, not a page choice.
// ---------------------------------------------------------------------------------------------
function validate(reg, recon) {
  const v2 = reg.v2;
  if (!isObject(v2)) throw new Error("the registry has no top-level v2 block");
  if (v2.interfaceVersion !== RENDERS_INTERFACE_VERSION) {
    throw new Error(`v2.interfaceVersion is ${JSON.stringify(v2.interfaceVersion)}; this page is written for ${RENDERS_INTERFACE_VERSION} (re-check the Data Streams rule, then bump RENDERS_INTERFACE_VERSION)`);
  }
  // T-OP-138: the core set and `sources` are exact; an external key is known only when present (the
  // builder's rule, build-markets.mjs validateV2Top). Any other name still throws.
  const present = V2_EXTERNAL_CONTRACT_NAMES.filter((k) => k in v2.contracts);
  const contractKeys = [...V2_CONTRACTS.map(([k]) => k), ...present, "sources"];
  checkKeys(v2.contracts, contractKeys, "v2.contracts");
  for (const k of present) {
    const a = v2.contracts[k];
    if (a !== null && !(typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a))) throw new Error(`v2.contracts.${k} is neither null nor an address`);
  }
  checkKeys(v2.contracts.sources, V2_SOURCES.map(([k]) => k), "v2.contracts.sources");
  checkKeys(v2.flywheel, [...V2_FLYWHEEL.map(([k]) => k), "deployBlock"], "v2.flywheel");
  checkKeys(reg.shared?.safes, SHARED_SAFES.map(([k]) => k), "shared.safes");
  checkShape(v2.defaults, DEFAULTS_SHAPE, "v2.defaults", { subset: false });
  if (!recon || !Number.isSafeInteger(recon.observedBlock) || typeof recon.checkedAt !== "string") {
    throw new Error(`${path.relative(appRoot, RECON)} is missing or has no observedBlock / checkedAt (the pools and periphery are stamped with them)`);
  }

  const unknown = reg.markets.filter((m) => !V1_STATUSES.includes(m.status));
  if (unknown.length) throw new Error(`markets with an unknown status: ${unknown.map((m) => `${m.ticker}=${m.status}`).join(", ")}`);
  for (const m of reg.markets) {
    const t = m.ticker;
    if (m.status === "planned") {
      throw new Error(`${t} has v1 status "planned": ADR-02 cancelled the per-market factory rollout; set it to "superseded-by-v2"`);
    }
    if ((m.status === "live" || m.status === "paused") && (!m.deployment?.factory || !m.deployment?.deployBlock)) {
      throw new Error(`${t} is "${m.status}" but has no deployment.factory / deployBlock in the registry`);
    }
    if (m.status === "superseded-by-v2" && m.deployment?.factory) {
      throw new Error(`${t} is "superseded-by-v2" but has deployment.factory ${m.deployment.factory}`);
    }
    if (m.v1FrozenAt !== undefined && m.v1FrozenAt !== null && !(Number.isSafeInteger(m.v1FrozenAt) && m.v1FrozenAt > 0 && m.v1RunOff === true && m.deployment?.factory)) {
      throw new Error(`${t}: v1FrozenAt ${JSON.stringify(m.v1FrozenAt)} must be unix seconds on a factory with v1RunOff: true`);
    }
    const v = m.v2;
    if (!isObject(v)) throw new Error(`${t} has no v2 block`);
    if (!V2_STATUS_ORDER.includes(v.status)) throw new Error(`${t}: v2.status ${JSON.stringify(v.status)} is not ${V2_STATUS_ORDER.join(" | ")}`);
    if (!V2_WAVE_ORDER.includes(v.wave)) throw new Error(`${t}: v2.wave ${JSON.stringify(v.wave)} is not ${V2_WAVE_ORDER.join(" | ")}`);
    if (typeof v.strikeTick !== "string" || !/^[1-9][0-9]*$/.test(v.strikeTick)) throw new Error(`${t}: v2.strikeTick must be a positive decimal string`);
    if (typeof v.puts !== "boolean") throw new Error(`${t}: v2.puts must be true or false`);
    if (v.payoutRoute !== null) {
      if (!isObject(v.payoutRoute)) throw new Error(`${t}: v2.payoutRoute must be null or an object`);
      const routeKeys = PAYOUT_ROUTE_KEYS[v.payoutRoute.venue];
      if (!routeKeys) throw new Error(`${t}: v2.payoutRoute.venue ${JSON.stringify(v.payoutRoute.venue)} is not ${Object.keys(PAYOUT_ROUTE_KEYS).join(" | ")}`);
      checkKeys(v.payoutRoute, routeKeys, `${t}.v2.payoutRoute`);
      if (!Number.isSafeInteger(v.payoutRoute.fee) || v.payoutRoute.fee < 1 || v.payoutRoute.fee > MAX_ROUTE_FEE_TIER) {
        throw new Error(`${t}: v2.payoutRoute.fee must be an integer in [1, ${MAX_ROUTE_FEE_TIER}]`);
      }
      if (v.payoutRoute.venue === "v4") {
        if (!Number.isSafeInteger(v.payoutRoute.tickSpacing) || v.payoutRoute.tickSpacing < 1) {
          throw new Error(`${t}: v2.payoutRoute.tickSpacing must be a positive integer`);
        }
        if (typeof v.payoutRoute.poolId !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(v.payoutRoute.poolId)) {
          throw new Error(`${t}: v2.payoutRoute.poolId must be a 32-byte v4 pool id`);
        }
      }
    }
    checkShape(v.overrides, DEFAULTS_SHAPE, `${t}.v2.overrides`, { subset: true });
    if (v.status !== "planned" && (!Number.isSafeInteger(v.registeredAt) || typeof v.registerTx !== "string")) {
      throw new Error(`${t}: v2.status ${v.status} needs registeredAt and registerTx`);
    }
    if (v.status === "live" && !v2.contracts.clearinghouse) throw new Error(`${t}: v2.status live but v2.contracts.clearinghouse is null`);
  }

  // The page prints every token and feed address under "Trust only the production addresses" and
  // says they were read on chain at verifiedAtBlock. build-markets.mjs writes a market whose on-chain
  // checks failed (it preserves the hand edits and exits 1), so a failing row can reach a commit; it
  // must not reach the published page.
  const unverified = reg.markets.filter((m) => !isObject(m.verification) || m.verification.ok !== true);
  if (unverified.length) {
    const why = unverified
      .map((m) => `${m.ticker}: ${isObject(m.verification) ? (m.verification.issues ?? []).join("; ") || "verification.ok is not true" : "no verification block"}`)
      .join("\n  ");
    throw new Error(`${unverified.length} market(s) failed on-chain verification, so this page cannot say their addresses were read on chain (re-run ops/markets/build-markets.mjs and fix the registry):\n  ${why}`);
  }
  const stale = reg.markets.filter((m) => m.verification.block !== reg.verifiedAtBlock);
  if (stale.length) {
    throw new Error(`the page stamps every address with verifiedAtBlock ${reg.verifiedAtBlock}, but ${stale.map((m) => `${m.ticker}=${m.verification.block}`).join(", ")} were verified at another block`);
  }
}

/** Validate only the archived fields this page reads; do not run the interface-8 validator on v7. */
function validateLegacy(legacy) {
  const rel = path.relative(appRoot, LEGACY);
  if (!legacy) throw new Error(`${rel} is missing; the interface-7 contract set cannot be omitted from this page`);
  if (typeof legacy._legacy !== "string" || legacy._legacy.trim() === "") {
    throw new Error(`${rel} has no _legacy marker; refusing to republish a current registry as the interface-7 set`);
  }
  if (!isObject(legacy.v2) || legacy.v2.interfaceVersion !== LEGACY_INTERFACE_VERSION) {
    throw new Error(`${rel} must record v2.interfaceVersion ${LEGACY_INTERFACE_VERSION}; refusing to label another interface as the legacy set`);
  }
  if (!Number.isSafeInteger(legacy.v2.deployBlock) || legacy.v2.deployBlock <= 0) {
    throw new Error(`${rel} has no positive v2.deployBlock`);
  }
  const contractKeys = [...LEGACY_V2_CONTRACTS.map(([k]) => k), "sources"];
  checkKeys(legacy.v2.contracts, contractKeys, "v7-legacy.v2.contracts");
  checkKeys(legacy.v2.contracts.sources, V2_SOURCES.map(([k]) => k), "v7-legacy.v2.contracts.sources");
  if (!Array.isArray(legacy.markets)) throw new Error(`${rel} has no markets array`);
  for (const market of legacy.markets) {
    const status = market.v2?.status;
    if (status !== "live" && status !== "paused") continue;
    if (!Number.isSafeInteger(market.v2.registeredAt) || typeof market.v2.registerTx !== "string") {
      throw new Error(`${rel}: ${market.ticker} is ${status} but has no registeredAt / registerTx`);
    }
  }
}

function checkKeys(obj, keys, where) {
  if (!isObject(obj)) throw new Error(`${where} must be an object`);
  for (const k of keys) if (!(k in obj)) throw new Error(`${where}.${k} is missing`);
  for (const k of Object.keys(obj)) if (!keys.includes(k)) throw new Error(`${where}.${k} is not a key this page renders: update render-docs.mjs`);
}

// ---------------------------------------------------------------------------------------------
// The page.
// ---------------------------------------------------------------------------------------------
function render(reg, recon, legacy) {
  validate(reg, recon);
  validateLegacy(legacy);
  const v2 = reg.v2;
  const def = v2.defaults;
  const rank = (m) => [V2_STATUS_ORDER.indexOf(m.v2.status), V2_WAVE_ORDER.indexOf(m.v2.wave)];
  const markets = [...reg.markets].sort((a, b) => {
    const [sa, wa] = rank(a);
    const [sb, wb] = rank(b);
    return sa - sb || wa - wb || a.ticker.localeCompare(b.ticker);
  });
  const eff = new Map(markets.map((m) => [m.ticker, withOverrides(def, m.v2.overrides)]));
  const byStatus = (s) => markets.filter((m) => m.v2.status === s);
  const livev2 = byStatus("live");
  const pausedv2 = byStatus("paused");
  const plannedv2 = byStatus("planned");
  const pooled = markets.filter((m) => m.v2.univ3Pool);
  const v1Factories = reg.markets.filter((m) => m.status === "live" || m.status === "paused").sort((a, b) => a.ticker.localeCompare(b.ticker));
  const v1Live = v1Factories.filter((m) => m.status === "live" && m.v1RunOff !== true);
  const superseded = reg.markets.filter((m) => m.status === "superseded-by-v2");
  const contracts = [
    ...V2_CONTRACTS.map(([k]) => v2.contracts[k]),
    ...V2_EXTERNALS.map(([k]) => v2.contracts[k] ?? null),
    ...V2_SOURCES.map(([k]) => v2.contracts.sources[k]),
    ...V2_FLYWHEEL.map(([k]) => v2.flywheel[k]),
    ...SHARED_SAFES.map(([k]) => reg.shared.safes[k]),
  ];
  const anyDeployed = contracts.some(Boolean) || v2.deployBlock !== null || v2.flywheel.deployBlock !== null;
  const legacyRegistered = legacy.markets
    .filter((m) => m.v2?.status === "live" || m.v2?.status === "paused")
    .sort((a, b) => a.ticker.localeCompare(b.ticker));
  const reconDate = recon.checkedAt.slice(0, 10);

  const L = [];
  L.push(
    `<!-- GENERATED by ops/markets/render-docs.mjs in the app repository from ops/markets/tier1.json. Do not edit by hand: edit the registry and re-render. -->`,
    ``,
    `# Markets`,
    ``,
    `See which Stock Tokens Stonkhouse v2 lists, where each market's settlement price comes from, and which strikes and expiries each market gets.`,
    ``,
    `{% hint style="warning" %}`,
    `Stonkhouse v2 is unaudited. Stock Tokens carry market and issuer risks. Buyers can lose their full cost; writers can lose collateral. Stonkhouse is not available to US persons. Read [Risks](../resources/risks.md) before using the product.`,
    `{% endhint %}`,
    ``,
    `A market is one Stock Token listed on the shared v2 contracts. Every market uses the same Clearinghouse, order book, settlement oracle and expiry calendar; every series belongs to one market and settles on that market's price sources. What is per market: the Stock Token, its Chainlink feed, the Uniswap v3 pool where there is one for settlement, the separate payout route where one is configured, the strike tick, the strike ladders, whether puts are listed, and the oracle settings. [Fees](fees.md) has what a contract costs.`,
    ``,
    `{% hint style="warning" %}`,
    `**Trust only the production addresses on this page or on [Addresses](../protocol/addresses.md), and check them on chain yourself.** This page is generated from the operations registry; the end of the page says where and when each kind of address was checked. Do not treat an address omitted from the production registry as an official Stonkhouse address without owner publication and on-chain verification.`,
    `{% endhint %}`,
  );
  if (livev2.length === 0 && pausedv2.length === 0) {
    L.push(
      ``,
      `**No v2 market is marked live in this registry.** Every market below is \`planned\`; none of these entries authorizes trading.${v1Live.length ? ` The v1 ${list(v1Live.map((m) => m.ticker))} ${v1Live.length === 1 ? "factory" : "factories"} at the end of this page ${v1Live.length === 1 ? "is" : "are"} still live.` : ""}`,
    );
  }

  // Status and waves.
  L.push(
    ``,
    `## Status and waves`,
    ``,
    `* **\`planned\`**: not registered according to this registry. It authorizes no series, orders, buying, writing or deposits.`,
    `* **\`live\`**: registered on the live v2 contracts. Buying and writing require an open series, usable orders and active launch controls; this status alone does not mean an automated strike ladder is running.`,
    `* **\`paused\`**: registered, but new risk is stopped: no new series and no new contracts written. Contracts already written still settle and pay out; closing, redeeming, withdrawing and cancelling orders cannot be paused.`,
    ``,
    `Markets go live in waves: the canary first, then wave 1, then wave 2. A wave starts only after the previous one has run cleanly, so the order is a plan, not a schedule.`,
  );
  if (plannedv2.length) {
    L.push(``, `Do not buy, write or deposit through a flow that presents a market listed here as \`planned\` as live. Verify the contract addresses and market status on chain.`);
  }
  L.push(``, `| Wave | Live | Paused | Planned |`, `|---|---|---|---|`);
  for (const wave of V2_WAVE_ORDER) {
    const inWave = (s) => markets.filter((m) => m.v2.wave === wave && m.v2.status === s).map((m) => m.ticker);
    if (!markets.some((m) => m.v2.wave === wave)) continue;
    L.push(`| ${WAVE_LABEL[wave]} | ${inWave("live").join(", ") || "—"} | ${inWave("paused").join(", ") || "—"} | ${inWave("planned").join(", ") || "—"} |`);
  }

  // Tokens, feeds and settlement sources.
  const chainlinkOnly = markets.length - pooled.length;
  L.push(
    ``,
    `## Tokens, feeds and settlement sources`,
    ``,
    `A market's settlement price for an expiry is a time-weighted average over the last ${duration(SETTLEMENT_WINDOW_S)} before expiry (16:00 New York), and every series of that market and expiry shares it. [Oracle and settlement](../protocol/oracle-and-settlement.md) has the full rules. The sources:`,
    ``,
    `* **Chainlink**: every market. The market's Chainlink feed in the table, averaged from the feed's on-chain round history. It needs no keeper.`,
    `* **Uniswap v3 TWAP**: the ${pooled.length} ${pooled.length === 1 ? "market" : "markets"} with a pool in the table. The pool's time-weighted price over the same ${duration(SETTLEMENT_WINDOW_S)}, recorded by a keeper within ${duration(SNAPSHOT_GRACE_S)} after expiry, and counted only while the pool's liquidity is above the market's floor. This pool corroborates settlement; payout conversion uses the separate route in the table. [Settlement and payout](../buying/settlement-and-payout.md) says when a payout arrives in Stock Tokens instead.`,
    `* **Data Streams**: enabled for no market. The registry records each market's Chainlink Data Streams id, but the source settles nothing until an admin adds it to a market, which needs Data Streams access. When it is added it becomes the market's first source.`,
    ``,
    `When two sources agree within ${pct(def.maxDeviationBps)}, the price is final at once. With one source, or two that disagree, the highest-priority available price becomes a candidate that is final ${duration(def.uncorroboratedDelayS)} later unless the guardian vetoes it. ${chainlinkOnly === 0 ? "Every market has two sources." : `The ${chainlinkOnly} ${chainlinkOnly === 1 ? "market" : "markets"} on Chainlink alone always take${chainlinkOnly === 1 ? "s" : ""} that path.`} Those figures are the registry's defaults (\`maxDeviationBps\`, \`uncorroboratedDelayS\`); a market's own setting shows in its row, and the settlement oracle holds the values in force.`,
    ``,
    `| Ticker | Status | Wave | Stock Token | Chainlink feed | Settlement sources | Payout route |`,
    `|---|---|---|---|---|---|---|`,
  );
  for (const m of markets) {
    L.push(
      `| **${m.ticker}** | ${statusCell(m.v2)} | ${WAVE_LABEL[m.v2.wave]} | ${addr(m.asset)} | ${addr(m.feed)} (\`${m.feedDescription}\`) | ${sourcesCell(m, eff.get(m.ticker), def)} | ${payoutRouteCell(m.v2.payoutRoute)} |`,
    );
  }

  // Strikes, ladders and puts.
  L.push(
    ``,
    `## Strikes, ladders and puts`,
    ``,
    `Every strike in a market is a multiple of its **strike tick**, in USDG per share. Sizes and expiries work the same in every market; see [Sizes and expiries](../buying/sizes-and-expiries.md).`,
    ``,
    `The **ladder** settings below describe target strikes for weekly and daily expiries; they do not prove that any series has been created or that a cranker is running. When ladder automation is enabled for a live market, its lowest call strike is the first distance above spot, rounded up to the tick; each further strike is about one step higher. If spot rises until fewer than two strikes remain above it, the cranker adds strikes but never removes one. A market with puts on uses the same ladder mirrored below spot, and put writers post USDG instead of the Stock Token ([Cash-secured puts](../writing/cash-secured-puts.md)). Anyone can create a series at another valid strike.`,
    ``,
    `The registry's default ladder, which a market uses unless its row says "market setting":`,
    ``,
    `| Tenor | Expiries ahead | Strikes per expiry | First strike above spot | Step |`,
    `|---|---|---|---|---|`,
  );
  for (const tenor of TENORS) {
    const l = def.ladder[tenor];
    L.push(`| ${tenor === "weekly" ? "Weekly" : "Daily"} | ${def.expiriesAhead[tenor]} | ${l.rungs} | ${pct(l.firstOtmBps)} | ${pct(l.stepBps)} |`);
  }
  L.push(``, `| Ticker | Strike tick | Puts | Weekly ladder | Daily ladder |`, `|---|---|---|---|---|`);
  for (const m of markets) {
    const e = eff.get(m.ticker);
    L.push(`| **${m.ticker}** | ${usdg(m.v2.strikeTick)} | ${m.v2.puts ? "yes" : "no"} | ${ladderCell(e, def, "weekly")} | ${ladderCell(e, def, "daily")} |`);
  }

  // v2 contracts.
  const notRecorded = "not recorded in this registry";
  L.push(
    ``,
    `## v2 contracts`,
    ``,
    `Every market uses the same v2 contracts. ${
      v2.deployBlock !== null
        ? `They were deployed from block **${block(v2.deployBlock)}**.`
        : anyDeployed
          ? "The registry has not recorded their deploy block yet."
          : "**This registry records no v2 contract deployment.** Addresses are added after owner publication and verification; do not infer chain-wide deployment status from an empty registry."
    } [Addresses](../protocol/addresses.md) has the roles and how to check each contract.`,
    ``,
    `| Contract | What it does | Address |`,
    `|---|---|---|`,
  );
  for (const [k, name, what] of V2_CONTRACTS) {
    L.push(`| \`${name}\` | ${what} | ${v2.contracts[k] ? addr(v2.contracts[k]) : notRecorded} |`);
  }
  for (const [k, name, what] of V2_SOURCES) {
    L.push(`| \`${name}\` | ${what} | ${v2.contracts.sources[k] ? addr(v2.contracts.sources[k]) : notRecorded} |`);
  }
  for (const [k, name, what] of V2_FLYWHEEL) {
    L.push(`| \`${name}\` | ${what} | ${v2.flywheel[k] ? addr(v2.flywheel[k]) : notRecorded} |`);
  }
  for (const [k, name, what] of SHARED_SAFES) {
    L.push(`| \`${name}\` | ${what} | ${reg.shared.safes[k] ? addr(reg.shared.safes[k]) : notRecorded} |`);
  }
  if (v2.flywheel.deployBlock !== null) {
    L.push(``, `The flywheel contracts were deployed from block **${block(v2.flywheel.deployBlock)}**.`);
  }

  // External v2 contracts (T-OP-114 / T-OP-138): deployed by their own steps after the core set, so each
  // carries its own start block. A key the registry does not carry yet renders exactly like a null one.
  const notDeployed = "not deployed";
  L.push(
    ``,
    `### External v2 contracts`,
    ``,
    `These contracts are part of v2 but are deployed separately from the core set above, each by its own step, and each is recorded with its own start block once it exists. A contract listed as *${notDeployed}* has no address in this registry yet.`,
    ``,
    `| Contract | What it does | Address | Deployed from block |`,
    `|---|---|---|---|`,
  );
  for (const [k, name, what] of V2_EXTERNALS) {
    const a = v2.contracts[k] ?? null;
    const b = v2.externalDeployBlocks?.[k] ?? null;
    L.push(`| \`${name}\` | ${what} | ${a ? addr(a) : notDeployed} | ${b !== null ? block(b) : "—"} |`);
  }
  L.push(
    ``,
    `v2 also relies on these third-party contracts. USDG's address is a constant of the registry, not a read: what the registry checks on chain at block ${block(reg.verifiedAtBlock)} is that every configured Uniswap v3 pool holds exactly this token and the market's Stock Token. The Uniswap v3 contracts had code at block ${block(recon.observedBlock)} (${reconDate}). Check USDG yourself: \`cast call ${reg.shared.usdg} "symbol()(string)"\` on \`${reg.rpc}\` answers \`USDG\`, \`decimals()(uint8)\` answers 6.`,
    ``,
    `| Contract | Address |`,
    `|---|---|`,
    `| USDG | ${addr(reg.shared.usdg)} |`,
    `| Uniswap v3 factory | ${addr(v2.uniswapV3.factory)} |`,
    `| Uniswap \`SwapRouter02\` | ${addr(v2.uniswapV3.swapRouter02)} |`,
    `| Uniswap \`QuoterV2\` | ${addr(v2.uniswapV3.quoterV2)} |`,
  );

  // Archived interface-7 set. This is intentionally separate from the v8 markets and wave tables.
  L.push(
    ``,
    `## Legacy interface-7 contract set`,
    ``,
    `The archived \`ops/markets/v7-legacy.json\` registry records the earlier **interface 7** deployment from block **${block(legacy.v2.deployBlock)}**. These addresses belong to that contract set, not to the interface-8 deployment above.`,
    ``,
    `The owner-controlled run-off procedure, if applied, stops new series and new units from being written. Closing, redeeming, withdrawing, cancelling an order and selling an existing long on the order book remain available. The registry does not record whether that procedure has been applied.`,
    ``,
    `| Interface-7 contract | What it does | Address |`,
    `|---|---|---|`,
  );
  for (const [k, name, what] of LEGACY_V2_CONTRACTS) {
    L.push(`| \`${name}\` | ${what} | ${addr(legacy.v2.contracts[k])} |`);
  }
  for (const [k, name, what] of V2_SOURCES) {
    L.push(`| \`${name}\` | ${what} | ${addr(legacy.v2.contracts.sources[k])} |`);
  }
  L.push(``, `Markets registered on the interface-7 set:`, ``, `| Ticker | Interface-7 status |`, `|---|---|`);
  for (const market of legacyRegistered) {
    L.push(`| **${market.ticker}** | ${statusCell(market.v2)} |`);
  }

  // Legacy v1 factories.
  L.push(``, `## Legacy v1 factories`, ``);
  const built = v1Factories.length;
  L.push(
    `Before v2, each market was to get its own account factory. ${built === 0 ? "None is running." : `${built === 1 ? "One was built" : `${built} were built`} and ${built === 1 ? "is" : "are"} listed below.`}${superseded.length ? ` The factories planned for the other ${superseded.length} markets were never built.` : ""} A v1 factory is separate from v2: its positions do not move to v2, and its Stock Tokens have to be withdrawn and deposited again. [Moving from v1](../legacy/moving-from-v1.md) has the steps; [v1 reference](../legacy/v1-reference.md) explains how a v1 factory works.`,
  );
  if (built) {
    L.push(``, `| Ticker | Factory | Deployed at block | State |`, `|---|---|---|---|`);
    for (const m of v1Factories) {
      const state =
        m.v1RunOff === true
          ? `Running off: frozen${m.v1FrozenAt ? ` on ${day(m.v1FrozenAt)}` : ""}, so no new writes and no deposits. Listed weeks still settle, and withdrawals and USDG claims keep working.`
          : m.status === "live"
            ? "Live: takes deposits, and its keeper sets a new week of calls."
            : "Paused: its keeper is stopped, so no new week is set. Deposits, withdrawals, settlement and USDG claims keep working.";
      L.push(`| **${m.ticker}** | ${addr(m.deployment.factory)} | ${block(m.deployment.deployBlock)} | ${state} |`);
    }
  }

  // Provenance.
  L.push(
    ``,
    `## Where this page comes from`,
    ``,
    `This page is rendered from the operations registry (\`ops/markets/tier1.json\` in the app repository) by \`ops/markets/render-docs.mjs\`. Every Stock Token and Chainlink feed address in the registry was read on chain at block **${block(reg.verifiedAtBlock)}** on \`${reg.rpc}\`; the registry was generated at **${reg.generatedAt}**. The feed list is Chainlink's \`us_equities_24/5\` directory for chain 4663 (${reg.feedsSource.equity} equity feeds of ${reg.feedsSource.total}); the token list is the issuer's ${reg.tokensSource.total} Stock Tokens. A feed that later disappears from Chainlink's directory fails the registry check rather than silently dropping a market.`,
    ``,
    `The v2 settings (status, wave, strike tick, settlement-source pool, payout route, puts, ladders and contract addresses) are kept by hand in the registry and validated by \`ops/markets/build-markets.mjs --check\`. The Uniswap v3 settlement pools come from the source recon (\`ops/markets/v2-sources.json\`) at block **${block(recon.observedBlock)}** (${recon.checkedAt}); every registry check confirms on chain that each pool holds the market's Stock Token and USDG and is the pool the Uniswap v3 factory returns. Payout routes are separate hand-kept values; the same check recomputes every v4 pool id from its hookless PoolKey. The interface-7 addresses and registrations come only from \`ops/markets/v7-legacy.json\`. v1 factory addresses and deploy blocks are written back by their deploy script. The ${duration(SETTLEMENT_WINDOW_S)} settlement window and the ${duration(SNAPSHOT_GRACE_S)} snapshot grace are compiled constants of the v2 contracts. Where the prose and the code disagree, the code is the specification.`,
    ``,
    `## Related`,
    ``,
    `* [Oracle and settlement](../protocol/oracle-and-settlement.md): how the sources above become one settlement price.`,
    `* [Sizes and expiries](../buying/sizes-and-expiries.md): contract sizes, daily and weekly expiries.`,
    `* [Fees](fees.md): what a contract costs on top of its price.`,
    `* [Addresses](../protocol/addresses.md): the v2 contracts and roles in full.`,
    `* [Moving from v1](../legacy/moving-from-v1.md): leaving a v1 factory.`,
    `* [Risks](../resources/risks.md): what one issuer, one feed family and a single-source settlement mean for you.`,
    ``,
  );
  return L.join("\n");
}

// ---------------------------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------------------------
const reg = JSON.parse(readFileSync(REGISTRY, "utf8"));
const recon = existsSync(RECON) ? JSON.parse(readFileSync(RECON, "utf8")) : null;
const legacy = existsSync(LEGACY) ? JSON.parse(readFileSync(LEGACY, "utf8")) : null;
const page = render(reg, recon, legacy);

/** Default targets: the root page and the GitBook mirror, when that checkout has one. */
function targets() {
  if (OUT) return [path.resolve(OUT)];
  const root = path.join(DOCS_DIR, "product", "markets.md");
  const mirror = path.join(DOCS_DIR, "docs", "product", "markets.md");
  if (!existsSync(path.join(DOCS_DIR, "product"))) {
    throw new Error(`callhouse-docs not found at ${DOCS_DIR} (pass --docs-dir or --out)`);
  }
  return existsSync(path.join(DOCS_DIR, "docs", "product")) ? [root, mirror] : [root];
}

let drift = 0;
for (const t of targets()) {
  if (CHECK) {
    const onDisk = existsSync(t) ? readFileSync(t, "utf8") : null;
    if (onDisk === page) {
      console.log(`ok       ${t}`);
    } else {
      drift++;
      console.error(`DRIFT    ${t}${onDisk === null ? " (missing)" : ""}: re-run ops/markets/render-docs.mjs and commit the result`);
    }
  } else {
    mkdirSync(path.dirname(t), { recursive: true });
    writeFileSync(t, page);
    console.log(`written  ${t}`);
  }
}
if (drift) process.exit(1);
