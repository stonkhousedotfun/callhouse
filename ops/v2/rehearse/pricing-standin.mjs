#!/usr/bin/env node
/**
 * The rehearsal's stand-in pricing service (keeper/src/v2/pricing/server.ts shapes), the method of keeper/src/v2/mm/devnet-mm.ts:
 * GET /fair prices a series with the pricing service's own Black-Scholes (keeper/src/v2/pricing/bs.ts, trading-time
 * years) at the fork oracle's spot (SettlementOracle.trySpot) and a fixed vol per market; asOf = the head block's time.
 * The real service needs the live Cboe chain, which cannot follow a warped clock (a recorded deviation).
 *
 *   GET /fair?ticker&strike&expiry&type   { fair: Money, iv, delta, source: "model", spot: Money, asOf }
 *                                         { fair: null, reason, detail } when spot is not ok or the series expired
 *   GET /surface/:ticker                  { ticker, root, asOf, chainTimestamp, spot: Money, expiries: [] }
 *   GET /health                           { status: "ok", service, markets }
 *
 * Runs under the keeper's tsx (it imports bs.ts):
 *   PORT=42191 RH_RPC=http://127.0.0.1:8590 V2_REGISTRY_PATH=<rehearsal copy> keeper/node_modules/.bin/tsx ops/v2/rehearse/pricing-standin.mjs
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bsDelta, bsPrice, tradingYears } from "../../../keeper/src/v2/pricing/bs.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { createPublicClient, formatUnits, getAddress, http, parseAbi } = createRequire(path.join(ROOT, "keeper", "package.json"))("viem");

const port = Number(process.env.PORT ?? 42191);
const rpc = process.env.RH_RPC ?? "http://127.0.0.1:8590";
const registry = JSON.parse(readFileSync(process.env.V2_REGISTRY_PATH ?? "", "utf8"));
/** Fixed vols of the stand-in (trading clock). */
const IV = { NVDA: 0.55, TSLA: 0.65, META: 0.45 };
const oracle = getAddress(registry.v2.contracts.settlementOracle);
const markets = new Map(registry.markets.filter((m) => m.v2?.status === "live").map((m) => [m.ticker, getAddress(m.asset)]));
const client = createPublicClient({ transport: http(rpc, { timeout: 10_000 }) });
const oracleAbi = parseAbi(["function trySpot(address underlying) view returns (bool ok, uint256 price, uint256 updatedAt)"]);
const money = (raw) => ({ raw: raw.toString(), decimals: 6, formatted: formatUnits(raw, 6) });
const head = async () => Number((await client.getBlock({ blockTag: "latest" })).timestamp);

createServer((req, res) => {
  (async () => {
    const url = new URL(req.url ?? "/", "http://x");
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/health") return send(200, { status: "ok", service: "callhouse-pricing-standin", markets: markets.size });
    const surface = /^\/surface\/([A-Za-z0-9.]+)$/.exec(url.pathname);
    if (surface) {
      const ticker = surface[1].toUpperCase();
      const asset = markets.get(ticker);
      if (asset === undefined) return send(404, { expiries: null, reason: "unknown-ticker", detail: {} });
      const [ok, spot] = await client.readContract({ address: oracle, abi: oracleAbi, functionName: "trySpot", args: [asset] });
      if (!ok) return send(200, { expiries: null, reason: "spot-stale", detail: { oracle: "trySpot not ok" } });
      const asOf = await head();
      return send(200, { ticker, root: ticker, asOf, chainTimestamp: asOf, spot: money(spot), expiries: [] });
    }
    if (url.pathname !== "/fair") return send(404, { fair: null, reason: "not-found" });
    const ticker = (url.searchParams.get("ticker") ?? "").toUpperCase();
    const asset = markets.get(ticker);
    if (asset === undefined) return send(404, { fair: null, reason: "unknown-ticker", detail: {} });
    const strikeRaw = url.searchParams.get("strike") ?? "";
    const expiry = Number(url.searchParams.get("expiry"));
    const type = url.searchParams.get("type") === "put" ? "put" : "call";
    if (!/^[1-9]\d{0,17}$/.test(strikeRaw) || !Number.isInteger(expiry) || expiry <= 0) return send(400, { fair: null, reason: "bad-request", detail: {} });
    const asOf = await head();
    if (expiry <= asOf) return send(200, { fair: null, reason: "expired", detail: { expiry, asOf } });
    const [ok, spotRaw] = await client.readContract({ address: oracle, abi: oracleAbi, functionName: "trySpot", args: [asset] });
    if (!ok) return send(200, { fair: null, reason: "spot-stale", detail: { oracle: "trySpot not ok" } });
    const input = { type, spot: Number(spotRaw) / 1e6, strike: Number(strikeRaw) / 1e6, vol: IV[ticker] ?? 0.5, t: tradingYears(asOf, expiry) };
    const fair = BigInt(Math.round(bsPrice(input) * 1e6));
    return send(200, { fair: money(fair), iv: input.vol, delta: Math.round(bsDelta(input) * 1e6) / 1e6, source: "model", spot: money(spotRaw), asOf });
  })().catch((error) => {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ fair: null, reason: "internal-error", detail: String(error) }));
  });
}).listen(port, "127.0.0.1", () => process.stdout.write(`pricing stand-in on ${port} (${[...markets.keys()].join(", ")})\n`));
