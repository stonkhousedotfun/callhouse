#!/usr/bin/env node
// Regenerate web/lib/markets.generated.ts from the market registry, ops/markets/tier1.json.
//
// WHY THIS EXISTS: the registry is the one list of markets Stonkhouse runs (ops/markets/README.md),
// and the app must not hard-code a ticker, a token or a factory anywhere. But the app is built in
// a Docker image whose build context is the REPO ROOT (the workspace install needs the lockfile)
// with `ops/` excluded by the root .dockerignore, and web/Dockerfile copies only `scripts/` and
// `web/` into the builder, so `next build` cannot read ops/ at all. The registry is therefore
// compiled in by this script and the OUTPUT IS COMMITTED: `lib/markets.generated.ts` is what the
// build sees, and `lib/markets.test.ts` fails the test gate whenever it drifts from the registry.
// Run `pnpm --filter @callhouse/web gen:markets` after any change to tier1.json and commit the
// result.
//
// WHAT IS COPIED, AND WHY ONLY THIS. The app needs, per market: the ticker (the URL segment and
// every unit label), the issuer's token name, the Stock Token and feed addresses (the account page
// approves the token; the feed is shown, never read), the factory and its deploy block (null until
// the market is configured), status and wave (a planned market 404s and is listed on the landing
// under its wave), the pricing mode and the Cboe root. The per-account deposit cap in USD rides
// along as registry context for the landing and the docs; no page renders it today (the account
// page shows the factory's own on-chain cap, which is the one that binds), so a cap change in the
// registry needs no rebuild until something does. `v1FrozenAt` (unix seconds of the owner's v1
// freeze, null until then) is copied for the legacy v1 banner, which prints the date only when the
// registry has one. Keeper knobs, verification records and keeper addresses stay in ops/: the
// browser has no use for them and a smaller generated file is a smaller thing to review.
//
// V2. The registry's v2 blocks come along whole, because the v2 app reads its contract addresses
// from this file, never from env (the indexer's /v2/config is only a cross-check): each market's
// `v2` block (status, wave, strikeTick, mintFeePpm, pool, Data Streams id, overrides, house vault, registration) and the
// top-level block as V2_REGISTRY (interface version, deploy block), V2_CONTRACTS (null until the
// v2 deploy writes addresses back), V2_UNISWAP_V3, V2_FEES and V2_DEFAULTS. v1 `status` gains
// `superseded-by-v2`: the per-market factory rollout that 34 rows were planned for was cancelled.
//
// DETERMINISM: the output is a pure function of the registry file. `generatedAt` is the REGISTRY's
// own build timestamp, not the wall clock at generation, so re-running the script against an
// unchanged registry produces a byte-identical file and no spurious diff. The file is written to a
// sibling temp path and renamed into place, so a kill mid-write leaves the old file, never a
// truncated one that `next build` would then fail on.
//
// `--check` compares the rendered bytes with the committed file and never writes. It is the
// pre-deploy drift gate; a missing or stale file exits nonzero.
//
// `--registry <path>` (or MARKETS_REGISTRY=<path>) points the script at another registry file.
// That is for rehearsing a market's go-live against a COPY of the registry; the committed output
// must always come from the real one, and the test gate checks exactly that. Because a stale
// MARKETS_REGISTRY in the environment is the silent way to get this wrong, a non-default source
// is announced twice: a WARNING on stderr at generation, and the real path with a "REHEARSAL, do
// not commit" marker in the generated file's own header, so a `git diff` shows it even when the
// test gate was not run.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// T-OP-138. The six EXTERNAL v2 contracts' key list (houseVault, houseVaultFactory, hedger,
// rewardsDistributorLender, earnVault, stockVenueAdapter) is imported from the builder that defined it
// (T-OP-114), never re-typed here: a second copy agrees with the first right up to the day one of them
// changes. This script already reads ops/markets/tier1.json from the same checkout, so ops/ is present
// wherever this runs (it is the Docker build that lacks ops/, and the Docker build never runs this
// script). Importing the module runs no build: its `main()` is guarded by `isMain`.
// T-OP-156. The per-market `v2` key set is imported the same way: this file's own copy (V2_MARKET_NAMES, twelve
// names) threw on `markets[].v2.houseVault` the day the builder gained it, exactly the shape T-OP-138 removed for
// the top-level block. One list, owned by the builder that closes the block.
import { V2_EXTERNAL_CONTRACT_NAMES, V2_MARKET_KEYS } from "../../ops/markets/build-markets.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const defaultRegistry = path.resolve(pkgRoot, "..", "ops", "markets", "tier1.json");
// `--out <path>` (T-OP-138) writes the rendered file somewhere other than lib/markets.generated.ts: for a
// rehearsal against a scratch registry, and for web/scripts/gen-markets.test.mjs, which must never write
// into the checkout. The committed file always comes from a run without it.
const out = (() => {
  const i = process.argv.indexOf("--out");
  if (i === -1) return path.resolve(pkgRoot, "lib", "markets.generated.ts");
  const p = process.argv[i + 1];
  if (!p) throw new Error("--out needs a path");
  return path.resolve(process.cwd(), p);
})();
const check = process.argv.includes("--check");

function registryPathFromArgs(argv) {
  const i = argv.indexOf("--registry");
  if (i !== -1) {
    const p = argv[i + 1];
    if (!p) throw new Error("--registry needs a path");
    return path.resolve(process.cwd(), p);
  }
  if (process.env.MARKETS_REGISTRY) return path.resolve(process.cwd(), process.env.MARKETS_REGISTRY);
  return defaultRegistry;
}

const STATUSES = new Set(["live", "planned", "paused", "superseded-by-v2"]);
const WAVES = new Set(["live", "canary", "wave1", "wave2"]);
const MODES = new Set(["vol", "fixed"]);
const V2_STATUSES = new Set(["planned", "live", "paused"]);
const V2_WAVES = new Set(["canary", "wave1", "wave2"]);
const V2_CONTRACT_NAMES = [
  "clearinghouse", "orderBook", "settlementOracle", "expiryCalendar", "keeperRewards",
  "autoRoller", "payoutAdapter", "makerVault", "makerRegistry", "rewardsDistributor", "accessManager",
];
const V2_SOURCE_NAMES = ["chainlink", "univ3", "dataStreams"];
const V2_FEE_NAMES = [
  "premiumFeeBps", "mintFeePpm", "allowRent", "resaleFeeBps", "takerFeeFlat",
  "takerFeeCapBps", "makerRebateBps", "exerciseFeeBps",
];
const PAYOUT_ROUTE_NAMES = {
  v3: ["venue", "fee"],
  v4: ["venue", "fee", "tickSpacing", "poolId"],
};
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const TICKER = /^[A-Z0-9.]{1,10}$/;
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const nullOrAddress = (v) => v === null || (typeof v === "string" && ADDRESS.test(v));
const isUint = (v) => Number.isSafeInteger(v) && v >= 0;
// Mirrors V2Constants.MINT_FEE_CEIL_PPM, MAX_ROUTE_FEE_TIER and Uniswap v4 TickMath.MAX_TICK_SPACING.
const MINT_FEE_CEIL_PPM = 5_000;
const MAX_ROUTE_FEE_TIER = 10_000;
const MAX_TICK_SPACING = 32_767;

function assertExactKeys(value, expected, where) {
  const missing = expected.filter((key) => !(key in value));
  const unknown = Object.keys(value).filter((key) => !expected.includes(key));
  if (missing.length || unknown.length) {
    throw new Error(`${where} keys differ from the v8 registry schema` +
      `${missing.length ? `; missing ${missing.join(", ")}` : ""}` +
      `${unknown.length ? `; unknown ${unknown.join(", ")}` : ""}`);
  }
}

/**
 * The top-level v2 block. ops/markets/build-markets.mjs --check validates it in full (interface
 * version, fee ceilings, recon cross-checks, pools on chain); this refuses what would break the app:
 * a missing or mistyped address, a fee or ladder the payoff maths cannot read.
 */
function assertV2Top(v2) {
  const where = "registry v2";
  if (!isObject(v2)) throw new Error(`${where}: missing (ops/markets/README.md "v2 blocks")`);
  // Copied, not compared: ops/markets/build-markets.mjs --check holds the one expected version, and
  // lib/v2/config.ts compares the compiled value with the indexer's.
  if (!(Number.isSafeInteger(v2.interfaceVersion) && v2.interfaceVersion > 0)) throw new Error(`${where}.interfaceVersion is not a positive integer`);
  const block = v2.deployBlock;
  if (!(block === null || (Number.isSafeInteger(block) && block > 0) || (typeof block === "string" && DECIMAL.test(block) && block !== "0"))) {
    throw new Error(`${where}.deployBlock is neither null nor a block number`);
  }
  if (!isObject(v2.contracts) || !isObject(v2.contracts.sources)) throw new Error(`${where}.contracts / .contracts.sources missing`);
  // T-OP-138: the core eleven and `sources` are exact; an external key is known only when present (the
  // builder's rule), and is then held to null-or-address like the rest. Any other name still throws, and
  // V2_CONTRACT_NAMES stays eleven: this file's V2_CONTRACTS literal is `v2.contracts` verbatim, so an
  // external the registry carries is copied through, and one it does not carry is simply absent.
  const externalsPresent = V2_EXTERNAL_CONTRACT_NAMES.filter((k) => k in v2.contracts);
  assertExactKeys(v2.contracts, [...V2_CONTRACT_NAMES, ...externalsPresent, "sources"], `${where}.contracts`);
  assertExactKeys(v2.contracts.sources, V2_SOURCE_NAMES, `${where}.contracts.sources`);
  for (const k of [...V2_CONTRACT_NAMES, ...externalsPresent]) if (!(k in v2.contracts) || !nullOrAddress(v2.contracts[k])) throw new Error(`${where}.contracts.${k} is neither null nor an address`);
  for (const k of V2_SOURCE_NAMES) if (!(k in v2.contracts.sources) || !nullOrAddress(v2.contracts.sources[k])) throw new Error(`${where}.contracts.sources.${k} is neither null nor an address`);
  for (const k of ["factory", "swapRouter02", "quoterV2"]) {
    if (typeof v2.uniswapV3?.[k] !== "string" || !ADDRESS.test(v2.uniswapV3[k])) throw new Error(`${where}.uniswapV3.${k} is not an address`);
  }
  const f = v2.fees;
  if (!isObject(f)) throw new Error(`${where}.fees missing`);
  assertExactKeys(f, V2_FEE_NAMES, `${where}.fees`);
  for (const k of ["premiumFeeBps", "resaleFeeBps", "takerFeeCapBps", "makerRebateBps", "exerciseFeeBps"]) {
    if (!isUint(f[k])) throw new Error(`${where}.fees.${k} is not a non-negative integer`);
  }
  if (f.premiumFeeBps <= f.resaleFeeBps) {
    throw new Error(`${where}.fees.premiumFeeBps must be above resaleFeeBps in interface version 8`);
  }
  if (typeof f.allowRent !== "boolean") throw new Error(`${where}.fees.allowRent is not a boolean`);
  if (!isUint(f.mintFeePpm) || f.mintFeePpm > MINT_FEE_CEIL_PPM) {
    throw new Error(`${where}.fees.mintFeePpm is not an integer in [0, ${MINT_FEE_CEIL_PPM}]`);
  }
  if (!f.allowRent && f.mintFeePpm !== 0) {
    throw new Error(`${where}.fees.mintFeePpm must be 0 unless v2.fees.allowRent is true`);
  }
  if (typeof f.takerFeeFlat !== "string" || !DECIMAL.test(f.takerFeeFlat)) throw new Error(`${where}.fees.takerFeeFlat is not a decimal string of USDG base units`);
  const d = v2.defaults;
  if (!isObject(d)) throw new Error(`${where}.defaults missing`);
  for (const k of ["maxDeviationBps", "uncorroboratedDelayS", "spotMaxAgeS"]) if (!isUint(d[k])) throw new Error(`${where}.defaults.${k} is not a non-negative integer`);
  for (const tenor of ["weekly", "daily"]) {
    for (const k of ["rungs", "firstOtmBps", "stepBps", "cardTargetBps"]) {
      if (!isUint(d.ladder?.[tenor]?.[k])) throw new Error(`${where}.defaults.ladder.${tenor}.${k} is not a non-negative integer`);
    }
    if (!isUint(d.expiriesAhead?.[tenor])) throw new Error(`${where}.defaults.expiriesAhead.${tenor} is not a non-negative integer`);
  }
  return v2;
}

function assertPayoutRoute(route, where) {
  if (route === null) return null;
  if (!isObject(route) || !(route.venue in PAYOUT_ROUTE_NAMES)) {
    throw new Error(`${where} is neither null nor a v3 or v4 payout route`);
  }
  assertExactKeys(route, PAYOUT_ROUTE_NAMES[route.venue], where);
  if (!Number.isSafeInteger(route.fee) || route.fee < 1 || route.fee > MAX_ROUTE_FEE_TIER) {
    throw new Error(`${where}.fee is not an integer in [1, ${MAX_ROUTE_FEE_TIER}]`);
  }
  if (route.venue === "v3") return { venue: route.venue, fee: route.fee };
  if (!Number.isSafeInteger(route.tickSpacing) || route.tickSpacing < 1 || route.tickSpacing > MAX_TICK_SPACING) {
    throw new Error(`${where}.tickSpacing is not an integer in [1, ${MAX_TICK_SPACING}]`);
  }
  if (typeof route.poolId !== "string" || !BYTES32.test(route.poolId)) {
    throw new Error(`${where}.poolId is not a 32-byte hex pool id`);
  }
  return { venue: route.venue, fee: route.fee, tickSpacing: route.tickSpacing, poolId: route.poolId };
}

/** One market's v2 block; `v2` is the validated top-level block (a live market needs its contracts). */
function assertV2Market(m, v2) {
  const where = `market ${JSON.stringify(m?.ticker)} v2`;
  const b = m.v2;
  if (!isObject(b)) throw new Error(`${where}: missing`);
  assertExactKeys(b, V2_MARKET_KEYS, where);
  if (!V2_STATUSES.has(b.status)) throw new Error(`${where}.status ${JSON.stringify(b.status)} is not planned|live|paused`);
  if (!V2_WAVES.has(b.wave)) throw new Error(`${where}.wave ${JSON.stringify(b.wave)} is not canary|wave1|wave2`);
  if (typeof b.strikeTick !== "string" || !DECIMAL.test(b.strikeTick) || BigInt(b.strikeTick) === 0n || BigInt(b.strikeTick) % 100n !== 0n) {
    throw new Error(`${where}.strikeTick ${JSON.stringify(b.strikeTick)} is not a positive multiple of 100 USDG base units`);
  }
  if (typeof b.puts !== "boolean") throw new Error(`${where}.puts is not a boolean`);
  if (!isUint(b.mintFeePpm) || b.mintFeePpm > MINT_FEE_CEIL_PPM) {
    throw new Error(`${where}.mintFeePpm is not an integer in [0, ${MINT_FEE_CEIL_PPM}]`);
  }
  if (!v2.fees.allowRent && b.mintFeePpm !== 0) {
    throw new Error(`${where}.mintFeePpm must be 0 unless v2.fees.allowRent is true`);
  }
  if (!nullOrAddress(b.univ3Pool)) throw new Error(`${where}.univ3Pool is neither null nor an address`);
  if (!(b.univ3MinLiquidity === null || (typeof b.univ3MinLiquidity === "string" && DECIMAL.test(b.univ3MinLiquidity)))) {
    throw new Error(`${where}.univ3MinLiquidity is neither null nor a decimal string`);
  }
  if (!(b.dataStreamsFeedId === null || (typeof b.dataStreamsFeedId === "string" && BYTES32.test(b.dataStreamsFeedId)))) {
    throw new Error(`${where}.dataStreamsFeedId is neither null nor a 32-byte hex id`);
  }
  const payoutRoute = assertPayoutRoute(b.payoutRoute, `${where}.payoutRoute`);
  if (!isObject(b.overrides)) throw new Error(`${where}.overrides is not an object`);
  // T-OP-156: this market's HouseVault (owner ruling 2026-09-22, two vaults at launch), written back per ticker by
  // the broadcast's externals stage; null until then and for ever on a market outside the launch set. Shape only
  // here -- the launch-set rule, the zero-address refusal and the EIP-55 case are build-markets.mjs's (its --check
  // is the registry gate); this file copies what that gate accepted.
  if (!nullOrAddress(b.houseVault)) throw new Error(`${where}.houseVault is neither null nor an address`);
  if (!(b.registeredAt === null || (Number.isSafeInteger(b.registeredAt) && b.registeredAt > 0))) throw new Error(`${where}.registeredAt is neither null nor unix seconds`);
  if (!(b.registerTx === null || (typeof b.registerTx === "string" && BYTES32.test(b.registerTx)))) throw new Error(`${where}.registerTx is neither null nor a transaction hash`);
  // A live v2 market with no clearinghouse would render a ticket that writes to address null.
  if (b.status === "live" && (v2.contracts.clearinghouse === null || v2.contracts.orderBook === null)) {
    throw new Error(`${where}.status is live but registry v2.contracts.clearinghouse / orderBook is null`);
  }
  return {
    status: b.status, wave: b.wave, strikeTick: b.strikeTick, puts: b.puts, mintFeePpm: b.mintFeePpm, univ3Pool: b.univ3Pool,
    univ3MinLiquidity: b.univ3MinLiquidity, dataStreamsFeedId: b.dataStreamsFeedId, payoutRoute, overrides: b.overrides,
    houseVault: b.houseVault, registeredAt: b.registeredAt, registerTx: b.registerTx,
  };
}

/** Every check here is one the app would otherwise discover as a broken page. Fail the generate. */
function assertMarket(m, v2) {
  const where = `market ${JSON.stringify(m?.ticker)}`;
  if (typeof m.ticker !== "string" || !TICKER.test(m.ticker)) throw new Error(`${where}: ticker is not [A-Z0-9.]{1,10}`);
  if (typeof m.name !== "string" || m.name.length === 0) throw new Error(`${where}: name missing`);
  if (typeof m.asset !== "string" || !ADDRESS.test(m.asset)) throw new Error(`${where}: asset is not an address`);
  if (typeof m.feed !== "string" || !ADDRESS.test(m.feed)) throw new Error(`${where}: feed is not an address`);
  if (!STATUSES.has(m.status)) throw new Error(`${where}: status ${JSON.stringify(m.status)} is not live|planned|paused|superseded-by-v2`);
  if (!WAVES.has(m.wave)) throw new Error(`${where}: wave ${JSON.stringify(m.wave)} is not live|canary|wave1|wave2`);
  if (!MODES.has(m.mode)) throw new Error(`${where}: mode ${JSON.stringify(m.mode)} is not vol|fixed`);
  if (typeof m.cboe?.root !== "string" || m.cboe.root.length === 0) throw new Error(`${where}: cboe.root missing`);
  const d = m.deployment ?? {};
  const factory = d.factory ?? null;
  const deployBlock = d.deployBlock ?? null;
  if (factory !== null && !ADDRESS.test(factory)) throw new Error(`${where}: deployment.factory is not an address`);
  if (deployBlock !== null && !(Number.isInteger(deployBlock) && deployBlock > 0)) {
    throw new Error(`${where}: deployment.deployBlock is not a positive integer`);
  }
  // A live market without a factory would render an account page that reads address null. The
  // registry's own builder allows the state (status is hand-maintained); the app does not.
  if (m.status === "live" && (factory === null || deployBlock === null)) {
    throw new Error(`${where}: status is live but deployment.factory / deployBlock is null`);
  }
  // Absent is null. build-markets.mjs --check also requires v1RunOff: true alongside it; what the app
  // needs is a date it can print, on a market that has a v1 factory to have frozen.
  const v1FrozenAt = m.v1FrozenAt ?? null;
  if (v1FrozenAt !== null && !(Number.isSafeInteger(v1FrozenAt) && v1FrozenAt > 0)) {
    throw new Error(`${where}: v1FrozenAt is neither null nor unix seconds`);
  }
  if (v1FrozenAt !== null && factory === null) throw new Error(`${where}: v1FrozenAt is set but deployment.factory is null`);
  const cap = m.depositCapUsd ?? null;
  if (cap !== null && !(typeof cap === "number" && Number.isFinite(cap) && cap > 0)) {
    throw new Error(`${where}: depositCapUsd is neither null nor a positive number`);
  }
  return { ticker: m.ticker, name: m.name, asset: m.asset, feed: m.feed, factory, deployBlock, status: m.status, wave: m.wave, mode: m.mode, cboeRoot: m.cboe.root, depositCapUsd: cap, v1FrozenAt, v2: assertV2Market(m, v2) };
}

/** A TypeScript object literal for a JSON value: identifier keys unquoted, two-space indent. */
function lit(v, indent) {
  if (Array.isArray(v)) return `[${v.map((x) => lit(x, indent)).join(", ")}]`;
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  const keys = Object.keys(v);
  if (keys.length === 0) return "{}";
  const inner = `${indent}  `;
  const key = (k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k));
  return `{\n${keys.map((k) => `${inner}${key(k)}: ${lit(v[k], inner)},`).join("\n")}\n${indent}}`;
}

const registryPath = registryPathFromArgs(process.argv.slice(2));
const registry = JSON.parse(readFileSync(registryPath, "utf8"));
if (!Array.isArray(registry.markets) || registry.markets.length === 0) throw new Error(`${registryPath}: no markets[]`);
if (!Number.isInteger(registry.verifiedAtBlock)) throw new Error(`${registryPath}: verifiedAtBlock missing`);
if (typeof registry.generatedAt !== "string") throw new Error(`${registryPath}: generatedAt missing`);

const v2 = assertV2Top(registry.v2);
const markets = registry.markets.map((m) => assertMarket(m, v2));
const seen = new Set();
for (const m of markets) {
  const key = m.ticker.toLowerCase();
  // Tickers are URL segments and are matched case-insensitively, so two rows that differ only by
  // case would be one route with two markets behind it.
  if (seen.has(key)) throw new Error(`duplicate ticker ${m.ticker} (case-insensitive)`);
  seen.add(key);
}

/**
 * T-OP-099. The registry's `launchSet` block: the owner's launch set (2026-09-21: NVDA and SPCX), AUTHORITATIVE and
 * deliberately not derived from `wave` or `status` (the block's own note says why). Rendered so lib/markets.ts can
 * answer "is this market in the launch?" without tier1.json, which the Docker build context does not carry, and so
 * the directory can never promise a market the owner scoped out. Same validation as ops/markets/build-markets.mjs:
 * { note, markets }, a non-empty note, a non-empty array of tickers each naming a market here, no duplicates. Missing
 * is an error: a projection without a launch set would either hide every market or promise every market.
 */
function assertLaunchSet(block, tickers) {
  const where = "launchSet";
  if (!isObject(block)) throw new Error(`${where}: missing or not an object of { note, markets }; the registry must name its launch set explicitly`);
  assertExactKeys(block, ["note", "markets"], where);
  if (typeof block.note !== "string" || block.note.trim() === "") throw new Error(`${where}.note must be a non-empty string`);
  if (!Array.isArray(block.markets) || block.markets.length === 0) throw new Error(`${where}.markets must be a non-empty array of tickers`);
  const known = new Set(tickers);
  const named = new Set();
  for (const ticker of block.markets) {
    if (typeof ticker !== "string" || !/^[A-Z0-9.]+$/.test(ticker)) throw new Error(`${where}.markets contains ${JSON.stringify(ticker)}, which is not a ticker`);
    if (named.has(ticker)) throw new Error(`${where}.markets names ${ticker} twice`);
    named.add(ticker);
    if (!known.has(ticker)) throw new Error(`${where}.markets names ${ticker}, which is not a market in this registry`);
  }
  return { note: block.note, markets: [...block.markets] };
}
const launchSet = assertLaunchSet(registry.launchSet, markets.map((m) => m.ticker));

const isRehearsal = registryPath !== defaultRegistry;
// Repo-relative when the source is inside the repo (the real registry reads "../ops/markets/…"),
// absolute when it is not: a rehearsal copy in a temp directory would otherwise be labelled with
// a chain of "../" that says nothing about where it is.
const relSource = path.relative(pkgRoot, registryPath);
const sourceLabel = relSource.startsWith("..") && !relSource.startsWith(path.join("..", "ops")) ? registryPath : relSource;
if (isRehearsal) {
  console.error(
    `WARNING: generating from ${registryPath}, not the real registry (${defaultRegistry}). ` +
      "The output is for a rehearsal build and must not be committed; regenerate without --registry / MARKETS_REGISTRY first.",
  );
}

const j = (v) => JSON.stringify(v);
const lines = [
  isRehearsal
    ? `// GENERATED by web/scripts/gen-markets.mjs from ${sourceLabel} (REHEARSAL, do not commit) — do not edit.`
    : "// GENERATED by web/scripts/gen-markets.mjs from ops/markets/tier1.json — do not edit.",
  "//",
  "// Regenerate with `pnpm --filter @callhouse/web gen:markets` after the registry changes, and",
  "// commit the result: the Docker build context has no ops/, so this file IS the registry as far",
  "// as the app is concerned. lib/markets.test.ts fails when it drifts from tier1.json.",
  "// lib/markets.ts is the typed, filtered view every page reads; nothing imports this file directly",
  "// except that module and lib/contracts.ts (for the default market's compiled-in addresses).",
  "",
  "/** The registry build this file was generated from. */",
  "export const GENERATED_REGISTRY = {",
  `  verifiedAtBlock: ${j(registry.verifiedAtBlock)},`,
  `  generatedAt: ${j(registry.generatedAt)},`,
  "} as const;",
  "",
  "/** Every market in the registry, live or not, in registry order. */",
  "export const GENERATED_MARKETS = [",
];
for (const m of markets) {
  lines.push("  {");
  lines.push(`    ticker: ${j(m.ticker)},`);
  lines.push(`    name: ${j(m.name)},`);
  lines.push(`    asset: ${j(m.asset)},`);
  lines.push(`    feed: ${j(m.feed)},`);
  lines.push(`    factory: ${j(m.factory)},`);
  lines.push(`    deployBlock: ${j(m.deployBlock)},`);
  lines.push(`    status: ${j(m.status)},`);
  lines.push(`    wave: ${j(m.wave)},`);
  lines.push(`    mode: ${j(m.mode)},`);
  lines.push(`    cboeRoot: ${j(m.cboeRoot)},`);
  lines.push(`    depositCapUsd: ${j(m.depositCapUsd)},`);
  lines.push(`    v1FrozenAt: ${j(m.v1FrozenAt)},`);
  lines.push(`    v2: ${lit(m.v2, "    ")},`);
  lines.push("  },");
}
lines.push("] as const;");
lines.push("");
lines.push(
  "/** The registry's top-level v2 block: the interface version it follows and the v2 deploy block (null until deployed). */",
  `export const V2_REGISTRY = ${lit({ interfaceVersion: v2.interfaceVersion, deployBlock: v2.deployBlock }, "")} as const;`,
  "",
  "/** v2 contract addresses, as the registry has them; null until the v2 deploy writes them back. */",
  `export const V2_CONTRACTS = ${lit(v2.contracts, "")} as const;`,
  "",
  "/** Uniswap v3 periphery on 4663 (payout conversion). */",
  `export const V2_UNISWAP_V3 = ${lit(v2.uniswapV3, "")} as const;`,
  "",
  "/** Launch fee parameters (bps; takerFeeFlat in USDG base units, a decimal string). The contracts hold the live values. */",
  `export const V2_FEES = ${lit(v2.fees, "")} as const;`,
  "",
  "/** Market defaults: oracle bounds, strike ladders per tenor, expiries listed ahead. A market's v2.overrides replaces keys of these. */",
  `export const V2_DEFAULTS = ${lit(v2.defaults, "")} as const;`,
  "",
  "/** The owner's launch set (T-OP-099): the ONLY markets the app may present as launching. Not derived from wave or status; see the note. */",
  `export const LAUNCH_SET = ${lit(launchSet, "")} as const;`,
  "",
);

const rendered = lines.join("\n");
if (check) {
  if (!existsSync(out) || readFileSync(out, "utf8") !== rendered) {
    console.error(`gen-markets --check: ${path.relative(pkgRoot, out)} is missing or differs from ${sourceLabel}; run pnpm gen:markets`);
    process.exitCode = 1;
  } else {
    console.log(`gen-markets --check: ${path.relative(pkgRoot, out)} matches ${sourceLabel}`);
  }
} else {
  // Same directory as the target, so the rename is atomic on every filesystem this runs on.
  const tmp = `${out}.tmp`;
  writeFileSync(tmp, rendered);
  renameSync(tmp, out);
}
const live = markets.filter((m) => m.status === "live").map((m) => m.ticker);
if (!check) {
  console.log(
    `wrote ${path.relative(pkgRoot, out)}: ${markets.length} markets from ${sourceLabel} ` +
      `(verifiedAtBlock ${registry.verifiedAtBlock}); live: ${live.join(", ") || "none"}` +
      (isRehearsal ? " [REHEARSAL source, do not commit]" : ""),
  );
}
