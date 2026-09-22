import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress } from "viem";

const defaultInput = fileURLToPath(new URL("../../ops/markets/tier1.json", import.meta.url));
const registryArg = process.argv.indexOf("--registry");
if (registryArg !== -1 && !process.argv[registryArg + 1]) {
  throw new Error("--registry needs a path");
}
const input = registryArg === -1
  ? process.env.MARKETS_REGISTRY ? path.resolve(process.env.MARKETS_REGISTRY) : defaultInput
  : path.resolve(process.argv[registryArg + 1]);
const rehearsal = input !== defaultInput;
if (rehearsal) {
  console.warn(`WARNING: generating indexer v2 registry from ${input} (REHEARSAL, do not commit)`);
}
const outputArg = process.argv.indexOf("--output");
if (outputArg !== -1 && !process.argv[outputArg + 1]) throw new Error("--output needs a path");
const output = outputArg === -1 ? fileURLToPath(new URL("../lib/v2/marketRegistry.generated.ts", import.meta.url))
  : path.resolve(process.argv[outputArg + 1]);
const registry = JSON.parse(readFileSync(input, "utf8"));
if (!registry.v2 || !Array.isArray(registry.markets)) throw new Error("v2 registry is missing");

if (registry.v2.interfaceVersion !== 8) throw new Error("v8 consumer requires interfaceVersion 8");
function rate(value, name) {
  if (!Number.isInteger(value) || value < 0 || value > 5_000) throw new Error(`${name} must be ppm in 0..5000`);
  return value;
}
function deployBlock(value, name) {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be null or a positive safe integer`);
  return value;
}
function chainId(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
}
function uiMultiplier(value, name) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    throw new Error(`${name} must be a canonical positive decimal string`);
  }
  return value;
}
function settlementDelay(value, name) {
  if (!Number.isSafeInteger(value) || value < 1_800 || value > 86_400) {
    throw new Error(`${name} must be an integer in 1800..86400`);
  }
  return value;
}
function route(value, name) {
  if (value === null) return null;
  try { return getAddress(value); }
  catch { throw new Error(`${name} must be null or an address`); }
}
function payoutRoute(value, name) {
  if (value === null) return null;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be null, a v3 route, or a v4 route`);
  }
  const expected = value.venue === "v3" ? ["venue", "fee"]
    : value.venue === "v4" ? ["venue", "fee", "tickSpacing", "poolId"] : null;
  if (expected === null) throw new Error(`${name}.venue must be v3 or v4`);
  const actual = Object.keys(value).sort();
  if (actual.join(",") !== [...expected].sort().join(",")) {
    throw new Error(`${name} must have exactly ${expected.join(", ")}`);
  }
  if (!Number.isSafeInteger(value.fee) || value.fee < 1 || value.fee > 10_000) {
    throw new Error(`${name}.fee must be an integer in 1..10000`);
  }
  if (value.venue === "v3") return { venue: "v3", fee: value.fee };
  if (!Number.isSafeInteger(value.tickSpacing) || value.tickSpacing < 1 || value.tickSpacing > 32_767) {
    throw new Error(`${name}.tickSpacing must be an integer in 1..32767`);
  }
  if (typeof value.poolId !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value.poolId)) {
    throw new Error(`${name}.poolId must be a 32-byte hex value`);
  }
  return { venue: "v4", fee: value.fee, tickSpacing: value.tickSpacing, poolId: value.poolId.toLowerCase() };
}
/**
 * T-OP-099. The registry's `launchSet` block: the owner's launch set (2026-09-21: NVDA and SPCX), AUTHORITATIVE and
 * deliberately not derived from `wave` or `status` (the block's own note says why). Rendered into the projection so
 * /v2/markets can flag launch membership without reading tier1.json, which the production image does not carry.
 * Validated the way ops/markets/build-markets.mjs validates it: an object of { note, markets }, a non-empty note, a
 * non-empty array of tickers that each name a market in this registry, no duplicates. Missing is an error: a
 * projection with no launch set would either hide every market or promise every market, and neither is a default.
 */
function launchSet(value, markets) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("launchSet must be an object of { note, markets }: the registry must name its launch set explicitly");
  }
  if (typeof value.note !== "string" || value.note.trim() === "") throw new Error("launchSet.note must be a non-empty string");
  if (!Array.isArray(value.markets) || value.markets.length === 0) throw new Error("launchSet.markets must be a non-empty array of tickers");
  const known = new Set(markets.map((market) => market.ticker));
  const seen = new Set();
  for (const ticker of value.markets) {
    if (typeof ticker !== "string" || !/^[A-Z0-9.]+$/.test(ticker)) throw new Error(`launchSet.markets contains ${JSON.stringify(ticker)}, which is not a ticker`);
    if (seen.has(ticker)) throw new Error(`launchSet.markets names ${ticker} twice`);
    seen.add(ticker);
    if (!known.has(ticker)) throw new Error(`launchSet.markets names ${ticker}, which is not a market in this registry`);
  }
  return { note: value.note, markets: [...value.markets] };
}
function expiriesAhead(value, name, partial = false) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  const result = {};
  for (const tenor of ["daily", "weekly"]) {
    const entry = value[tenor];
    if (entry === undefined && partial) continue;
    if (!Number.isSafeInteger(entry) || entry < 0) throw new Error(`${name}.${tenor} must be a nonnegative integer`);
    result[tenor] = entry;
  }
  return result;
}
rate(registry.v2.fees?.mintFeePpm, "v2.fees.mintFeePpm");
const data = {
  chainId: chainId(registry.shared?.chainId, "shared.chainId"),
  interfaceVersion: registry.v2.interfaceVersion,
  deployBlock: deployBlock(registry.v2.deployBlock, "v2.deployBlock"),
  contracts: registry.v2.contracts,
  safes: {
    admin: registry.shared?.safes?.admin ?? null,
    treasury: registry.shared?.safes?.treasury ?? null,
  },
  flywheel: {
    feeSplitter: registry.v2.flywheel?.feeSplitter ?? null,
    buybackExecutor: registry.v2.flywheel?.buybackExecutor ?? null,
    deployBlock: deployBlock(registry.v2.flywheel?.deployBlock ?? null, "v2.flywheel.deployBlock"),
  },
  fees: registry.v2.fees,
  defaults: {
    ladder: registry.v2.defaults.ladder,
    expiriesAhead: expiriesAhead(registry.v2.defaults.expiriesAhead, "v2.defaults.expiriesAhead"),
  },
  // T-OP-099. The owner's launch set, verbatim from the registry root; /v2/markets flags membership from it.
  launchSet: launchSet(registry.launchSet, registry.markets),
  markets: registry.markets.map((market) => ({
    ticker: market.ticker,
    name: market.name,
    underlying: market.asset,
    uiMultiplier: uiMultiplier(market.verification?.uiMultiplier, `${market.ticker}.verification.uiMultiplier`),
    status: market.v2.status,
    strikeTick: market.v2.strikeTick,
    puts: market.v2.puts,
    mintFeePpm: rate(market.v2.mintFeePpm ?? market.v2.overrides?.mintFeePpm ?? registry.v2.fees.mintFeePpm, `${market.ticker}.v2.mintFeePpm`),
    payoutRoute: payoutRoute(market.v2.payoutRoute, `${market.ticker}.v2.payoutRoute`),
    settlement: {
      sourceCount: route(market.v2.univ3Pool, `${market.ticker}.v2.univ3Pool`) === null ? 1 : 2,
      uncorroboratedDelayS: settlementDelay(
        market.v2.overrides?.uncorroboratedDelayS === undefined
          ? registry.v2.defaults.uncorroboratedDelayS
          : market.v2.overrides.uncorroboratedDelayS,
        `${market.ticker}.v2.uncorroboratedDelayS`,
      ),
      route: payoutRoute(market.v2.payoutRoute, `${market.ticker}.v2.payoutRoute`),
    },
    overrides: {
      ...(market.v2.overrides?.ladder === undefined ? {} : { ladder: market.v2.overrides.ladder }),
      ...(market.v2.overrides?.expiriesAhead === undefined ? {} : {
        expiriesAhead: expiriesAhead(market.v2.overrides.expiriesAhead, `${market.ticker}.v2.overrides.expiriesAhead`, true),
      }),
    },
  })),
};
const source = rehearsal ? `${input} (REHEARSAL, do not commit)` : "ops/markets/tier1.json";
const rendered = `// GENERATED by indexer/scripts/gen-v2-registry.mjs from ${source}.\n` +
  `// The production image contains indexer/ only; regenerate after any registry change.\n` +
  `export const V2_REGISTRY = ${JSON.stringify(data, null, 2)} as const;\n`;
if (process.argv.includes("--check")) {
  if (readFileSync(output, "utf8") !== rendered) {
    console.error("indexer v2 API registry snapshot drifted; run pnpm --filter @callhouse/indexer gen:v2-registry");
    process.exit(1);
  }
} else {
  const temp = `${output}.tmp-${process.pid}`;
  writeFileSync(temp, rendered);
  renameSync(temp, output);
}
