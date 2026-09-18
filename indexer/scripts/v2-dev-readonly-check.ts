/** Deployed-dev manifest checks only. No RPC client, signer, database or service control. */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { configResponseSchema, healthResponseSchema, marketSchema } from "../src/api/v2/schema.ts";

const MAX_BYTES = 1_048_576;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = /^0x0{40}$/i;
const positiveInteger = z.number().int().positive().safe();
const bps = z.number().int().min(0).max(10_000);
const rentPpm = z.number().int().min(0).max(5_000);
const registryFees = z.object({ premiumFeeBps: bps, mintFeePpm: rentPpm, resaleFeeBps: bps,
  takerFeeFlat: z.string().regex(/^(0|[1-9][0-9]*)$/), takerFeeCapBps: bps,
  makerRebateBps: bps, exerciseFeeBps: bps });
const registryAddress = z.string().regex(ADDRESS).refine((value) => !ZERO_ADDRESS.test(value));
const registryContracts = z.object({
  clearinghouse: registryAddress, orderBook: registryAddress, settlementOracle: registryAddress,
  expiryCalendar: registryAddress, keeperRewards: registryAddress,
  autoRoller: registryAddress, payoutAdapter: registryAddress,
  makerVault: registryAddress, makerRegistry: registryAddress,
  rewardsDistributor: registryAddress,
  sources: z.object({ chainlink: registryAddress, univ3: registryAddress,
    dataStreams: registryAddress }),
});
const ticker = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,31}$/);
const registrySchema = z.object({
  shared: z.object({ chainId: positiveInteger, usdg: registryAddress }),
  v2: z.object({ interfaceVersion: positiveInteger, deployBlock: positiveInteger,
    contracts: registryContracts, fees: registryFees }),
  markets: z.array(z.object({ ticker, asset: registryAddress,
    v2: z.object({ status: z.enum(["planned", "live", "paused"]), puts: z.boolean(),
      mintFeePpm: rentPpm.optional(), overrides: z.object({ mintFeePpm: rentPpm.optional() }).optional(),
      strikeTick: z.string().regex(/^[1-9][0-9]*$/) }),
  })).min(1).max(1_000),
});

// Reuse the producer's established field validators, selecting only stable manifest fields.
// Deliberately do not accept this subset check as validation of the complete v7 response.
const configSchema = configResponseSchema.pick({ chainId: true, interfaceVersion: true,
  deployBlock: true, usdg: true, contracts: true, fees: true }).strip().extend({
  fees: configResponseSchema.shape.fees.strip(),
  contracts: configResponseSchema.shape.contracts.strip().extend({
    sources: configResponseSchema.shape.contracts.shape.sources.strip(),
  }),
});
const marketsSchema = z.array(marketSchema.innerType().pick({ ticker: true, underlying: true,
  status: true, puts: true, strikeTick: true, mintFeePpm: true }).strip()).max(1_000);

export interface Options {
  baseUrl: string;
  registryPath: string;
  registrySha256?: string;
  expectedInterfaceVersion?: number;
  expectedChainId?: number;
  timeoutMs?: number;
  maxLagSeconds?: number;
  allowLoopback?: boolean;
}
export interface Check { name: string; passed: boolean; details: string[] }
export interface Report {
  scope: "read-only-deployment-manifest";
  status: "manifest_passed" | "failed";
  registrySha256: string | null;
  checks: Check[];
  pendingChecks: string[];
}

function baseUrl(raw: string, allowLoopback: boolean): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("Invalid base URL."); }
  if (url.username || url.password || url.search || url.hash)
    throw new Error("Base URL must have no credentials, query or fragment.");
  const local = url.hostname === "localhost" || url.hostname.endsWith(".localhost") ||
    /^127\./.test(url.hostname) || url.hostname === "[::1]";
  if (local && !allowLoopback) throw new Error("Loopback needs --allow-loopback for local fixtures.");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local && allowLoopback))
    throw new Error("Base URL must use HTTPS; HTTP is allowed only for opted-in loopback fixtures.");
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  return url;
}

function boundedInteger(value: number, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  return value;
}

async function get(url: URL, route: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(new URL(route.slice(1), url), {
      method: "GET", redirect: "error", signal: controller.signal,
      headers: { accept: "application/json", "cache-control": "no-cache" },
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status}.`);
    }
    if (route === "/ready") { await response.body?.cancel(); return null; }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Empty response body.");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > MAX_BYTES) { await reader.cancel(); throw new Error("Response exceeds 1 MiB."); }
      chunks.push(chunk.value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
    catch { throw new Error("Invalid JSON response."); }
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Request timed out.");
    // Fetch errors can contain the supplied URL. Report only our fixed, safe diagnostics.
    if (error instanceof Error && /^(HTTP [0-9]{3}\.|Empty response body\.|Response exceeds 1 MiB\.|Invalid JSON response\.)$/.test(error.message)) throw error;
    throw new Error("Endpoint unavailable or redirect refused.");
  } finally { clearTimeout(timer); }
}

function sameAddress(a: string | null, b: string | null): boolean {
  return a?.toLowerCase() === b?.toLowerCase();
}

export async function checkDeployedDev(options: Options): Promise<Report> {
  const report: Report = { scope: "read-only-deployment-manifest", status: "failed",
    registrySha256: null, checks: [], pendingChecks: [
      "Rent charge, refund and accrual behavior: requires the separate v7 acceptance suite.",
      "Series, events and on-chain state parity: requires the separate v7 acceptance suite.",
    ] };
  let url: URL;
  let registry: z.infer<typeof registrySchema>;
  let timeoutMs: number;
  let maxLagSeconds: number;
  let version: number;
  let chainId: number;
  try {
    url = baseUrl(options.baseUrl, options.allowLoopback ?? false);
    timeoutMs = boundedInteger(options.timeoutMs ?? 10_000, 10, 30_000, "timeoutMs");
    maxLagSeconds = boundedInteger(options.maxLagSeconds ?? 120, 0, 3_600, "maxLagSeconds");
    version = boundedInteger(options.expectedInterfaceVersion ?? 7, 1, 1_000, "interfaceVersion");
    chainId = boundedInteger(options.expectedChainId ?? 4663, 1, Number.MAX_SAFE_INTEGER, "chainId");
    let bytes: Buffer;
    try {
      const stat = statSync(options.registryPath);
      if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error();
      bytes = readFileSync(options.registryPath);
    } catch { throw new Error("Cannot read explicit registry as a regular file of at most 1 MiB."); }
    if (bytes.length > MAX_BYTES) throw new Error("Registry exceeds 1 MiB.");
    report.registrySha256 = createHash("sha256").update(bytes).digest("hex");
    if (options.registrySha256 !== undefined && (!/^[a-fA-F0-9]{64}$/.test(options.registrySha256) ||
        options.registrySha256.toLowerCase() !== report.registrySha256))
      throw new Error("Registry SHA-256 does not match the supplied pin.");
    let input: unknown;
    try { input = JSON.parse(bytes.toString("utf8")) as unknown; } catch { throw new Error("Invalid registry JSON."); }
    const parsed = registrySchema.safeParse(input);
    if (!parsed.success) throw new Error("Registry lacks valid deployment, contract or market identity fields.");
    registry = parsed.data;
    if (registry.v2.interfaceVersion !== version) throw new Error("Registry interface version does not match expected version.");
    if (registry.shared.chainId !== chainId) throw new Error("Registry chain ID does not match expected chain.");
    if (!registry.markets.some((market) => market.v2.status === "live"))
      throw new Error("Registry has no intended live markets.");
    if (registry.markets.some((market) => market.v2.status !== "planned" &&
      (market.v2.mintFeePpm ?? market.v2.overrides?.mintFeePpm ?? registry.v2.fees.mintFeePpm) === 0))
      throw new Error("Registered markets must have nonzero effective writer rent.");
    if (new Set(registry.markets.map((market) => market.ticker)).size !== registry.markets.length ||
        new Set(registry.markets.map((market) => market.asset.toLowerCase())).size !== registry.markets.length)
      throw new Error("Registry has duplicate market identities.");
    report.checks.push({ name: "registry", passed: true, details: [] });
  } catch (error) {
    report.checks.push({ name: "inputs", passed: false, details: [error instanceof Error ? error.message : "Invalid inputs."] });
    return report;
  }

  const routes = ["/ready", "/v2/health", "/v2/config", "/v2/markets"] as const;
  const responses = await Promise.allSettled(routes.map((route) => get(url, route, timeoutMs)));
  for (const [index, route] of routes.entries()) {
    const response = responses[index]!;
    const details: string[] = [];
    if (response.status === "rejected") {
      report.checks.push({ name: route, passed: false, details: [response.reason.message] });
      continue;
    }
    if (route === "/v2/health") {
      const parsed = healthResponseSchema.strip().safeParse(response.value);
      if (!parsed.success) details.push("Invalid stable health fields.");
      else {
        if (parsed.data.interfaceVersion !== version) details.push("Interface version differs from pin.");
        if (parsed.data.status !== "ok" || parsed.data.lagSeconds > maxLagSeconds) details.push("Indexer is not healthy within the allowed lag.");
        if (BigInt(parsed.data.block) < BigInt(registry.v2.deployBlock)) details.push("Indexed block precedes deployment.");
      }
    } else if (route === "/v2/config") {
      const parsed = configSchema.safeParse(response.value);
      if (!parsed.success) details.push("Invalid stable config fields.");
      else {
        const config = parsed.data;
        if (config.chainId !== registry.shared.chainId) details.push("Chain ID differs from registry.");
        if (config.interfaceVersion !== version) details.push("Interface version differs from pin.");
        if (config.deployBlock !== String(registry.v2.deployBlock)) details.push("Deploy block differs from registry.");
        if (!sameAddress(config.usdg.address, registry.shared.usdg) || config.usdg.decimals !== 6 || config.usdg.symbol !== "USDG") details.push("USDG identity differs from registry.");
        for (const key of Object.keys(registry.v2.fees) as (keyof typeof registry.v2.fees)[]) {
          if (key === "takerFeeFlat") {
            if (config.fees.takerFeeFlat.raw !== registry.v2.fees.takerFeeFlat || config.fees.takerFeeFlat.decimals !== 6)
              details.push("fees.takerFeeFlat differs from registry.");
          } else if (config.fees[key] !== registry.v2.fees[key]) details.push(`fees.${key} differs from registry.`);
        }
        for (const key of Object.keys(registry.v2.contracts) as (keyof typeof registry.v2.contracts)[]) {
          if (key === "sources") {
            for (const source of Object.keys(registry.v2.contracts.sources) as (keyof typeof registry.v2.contracts.sources)[])
              if (!sameAddress(config.contracts.sources[source], registry.v2.contracts.sources[source])) details.push(`contracts.sources.${source} differs from registry.`);
          } else if (!sameAddress(config.contracts[key], registry.v2.contracts[key])) details.push(`contracts.${key} differs from registry.`);
        }
      }
    } else if (route === "/v2/markets") {
      const parsed = marketsSchema.safeParse(response.value);
      if (!parsed.success) details.push("Invalid stable market fields.");
      else {
        const rows = parsed.data;
        if (new Set(rows.map((row) => row.ticker)).size !== rows.length ||
            new Set(rows.map((row) => row.underlying.toLowerCase())).size !== rows.length) details.push("Duplicate API market identities.");
        const byTicker = new Map(registry.markets.map((market) => [market.ticker, market]));
        for (const row of rows) {
          const expected = byTicker.get(row.ticker);
          if (!expected) { details.push("API contains a market absent from registry."); continue; }
          if (!sameAddress(row.underlying, expected.asset) || row.status !== expected.v2.status ||
              row.puts !== expected.v2.puts || row.strikeTick.raw !== expected.v2.strikeTick || row.strikeTick.decimals !== 6)
            details.push(`Market ${expected.ticker} identity or policy differs from registry.`);
          const effectivePpm = expected.v2.mintFeePpm ?? expected.v2.overrides?.mintFeePpm ?? registry.v2.fees.mintFeePpm;
          if (row.mintFeePpm !== effectivePpm) details.push(`Market ${expected.ticker} writer rent differs from registry.`);
        }
        const actual = new Set(rows.map((row) => row.ticker));
        for (const market of registry.markets)
          if (market.v2.status !== "planned" && !actual.has(market.ticker)) details.push(`Registered market ${market.ticker} is missing.`);
      }
    }
    report.checks.push({ name: route, passed: details.length === 0, details });
  }
  report.status = report.checks.every((check) => check.passed) ? "manifest_passed" : "failed";
  return report;
}

export function parseOptions(args: string[]): Options {
  const values = new Map<string, string>();
  const known = new Set(["--base-url", "--registry", "--registry-sha256", "--interface-version", "--chain-id", "--timeout-ms", "--max-lag-seconds"]);
  let allowLoopback = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--allow-loopback" && !allowLoopback) { allowLoopback = true; continue; }
    if (!known.has(arg) || values.has(arg) || !args[i + 1] || args[i + 1]!.startsWith("--"))
      throw new Error("Unknown, duplicate or incomplete option.");
    values.set(arg, args[++i]!);
  }
  if (!values.get("--base-url") || !values.get("--registry"))
    throw new Error("Explicit --base-url and --registry are required.");
  return { baseUrl: values.get("--base-url")!, registryPath: values.get("--registry")!, allowLoopback,
    registrySha256: values.get("--registry-sha256"),
    expectedInterfaceVersion: values.has("--interface-version") ? Number(values.get("--interface-version")) : undefined,
    expectedChainId: values.has("--chain-id") ? Number(values.get("--chain-id")) : undefined,
    timeoutMs: values.has("--timeout-ms") ? Number(values.get("--timeout-ms")) : undefined,
    maxLagSeconds: values.has("--max-lag-seconds") ? Number(values.get("--max-lag-seconds")) : undefined };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const report = await checkDeployedDev(parseOptions(process.argv.slice(2)));
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.status === "manifest_passed" ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Read-only checker failed.");
    process.exitCode = 1;
  }
}
