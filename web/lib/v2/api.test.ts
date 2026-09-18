import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { ApiUnavailable, V2ApiClient, V2_API_TIMEOUT_MS } from "./api";
import { v2Keys } from "./hooks";

const FIXTURES = fileURLToPath(new URL("../../../ops/fixtures/api/v2/", import.meta.url));

function listJson(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) listJson(path, out);
    else if (path.endsWith(".json")) out.push(path);
  }
  return out;
}

function clientReturning(body: unknown, status = 200) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { api: new V2ApiClient({ baseUrl: "https://indexer.example/", fetchImpl }), calls };
}

/** The client exposes a typed method for every fixture route. */
function invoke(api: V2ApiClient, rel: string): Promise<unknown> {
  const path = rel.replace(/\.json$/, "");
  if (path === "health") return api.getHealth();
  if (path === "config") return api.getConfig();
  if (path === "markets") return api.getMarkets();
  if (path === "calendar/holidays") return api.getCalendarHolidays(0, 30);
  if (path === "cards") return api.getCards();
  if (path === "cards/hero") return api.getHeroCard();
  if (path === "feed/wins") return api.getWins();
  if (path === "feed/activity") return api.getActivity();
  if (path === "strategies") return api.getStrategies();
  if (path === "leaderboard") return api.getLeaderboard();
  if (path === "stats") return api.getStats();
  if (path === "makers") return api.getMakers();
  const parts = path.split("/");
  if (parts[0] === "markets" && parts[2] === "series") return api.getMarketSeries(parts[1]);
  if (parts[0] === "series") {
    if (parts.length === 2) return api.getSeries(parts[1]);
    if (parts[2] === "book") return api.getBook(parts[1]);
    if (parts[2] === "holders") return api.getHolders(parts[1]);
    if (parts[2] === "trades") return api.getTrades(parts[1]);
  }
  if (parts[0] === "accounts") {
    if (parts[2] === "positions") return api.getPositions(parts[1]);
    if (parts[2] === "history") return api.getHistory(parts[1]);
  }
  if (parts[0] === "pnl") return api.getPnl(parts[1]);
  if (parts[0] === "makers") return api.getMaker(parts[1]);
  if (parts[0] === "fair") return api.getFair(parts[1]);
  throw new Error(`missing client method for ${rel}`);
}

describe("V2ApiClient", () => {
  it("validates every fixture through its typed route method", async () => {
    const files = listJson(FIXTURES);
    expect(files.length).toBe(226);
    for (const file of files) {
      const rel = relative(FIXTURES, file).split(sep).join("/");
      const body = JSON.parse(readFileSync(file, "utf8")) as unknown;
      const { api, calls } = clientReturning(body);
      await expect(invoke(api, rel), rel).resolves.toEqual(body);
      expect(calls, rel).toHaveLength(1);
      expect(new URL(calls[0].url).pathname, rel).toBe(`/v2/${rel.slice(0, -5)}`);
    }
  });

  it("uses no-store for health and fee config, normal HTTP cache behavior for other routes", async () => {
    const health = JSON.parse(readFileSync(join(FIXTURES, "health.json"), "utf8")) as unknown;
    const { api, calls } = clientReturning(health);
    await api.getHealth();
    expect(calls[0].init?.cache).toBe("no-store");
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
    expect(V2_API_TIMEOUT_MS).toBe(8_000);
    const config = JSON.parse(readFileSync(join(FIXTURES, "config.json"), "utf8")) as unknown;
    const feeConfig = clientReturning(config);
    await feeConfig.api.getConfig();
    expect(feeConfig.calls[0].init?.cache).toBe("no-store");
    const markets = JSON.parse(readFileSync(join(FIXTURES, "markets.json"), "utf8")) as unknown;
    const other = clientReturning(markets);
    await other.api.getMarkets();
    expect(other.calls[0].init?.cache).toBeUndefined();
  });

  it("encodes path segments and all route filters", async () => {
    const fixture = JSON.parse(readFileSync(join(FIXTURES, "cards.json"), "utf8")) as unknown;
    const { api, calls } = clientReturning(fixture);
    await api.getCards({ ticker: "NVDA", tenor: "weekly", type: "call", sort: "multiple", limit: 20, cursor: "a/b" });
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/v2/cards");
    expect(Object.fromEntries(url.searchParams)).toEqual({ ticker: "NVDA", tenor: "weekly", type: "call", sort: "multiple", limit: "20", cursor: "a/b" });

    const book = JSON.parse(readFileSync(join(FIXTURES, "series", readdirSync(join(FIXTURES, "series")).find((name) => /^\d+$/.test(name))!, "book.json"), "utf8")) as unknown;
    const other = clientReturning(book);
    await other.api.getBook("12/34", 5);
    expect(other.calls[0].url).toBe("https://indexer.example/v2/series/12%2F34/book?depth=5");
  });

  it("exposes 404 envelopes as typed unavailable errors", async () => {
    const { api } = clientReturning({ error: { code: "not_found", message: "no series" } }, 404);
    await expect(api.getSeries("1")).rejects.toMatchObject({
      name: "ApiUnavailable", reason: "http", status: 404, code: "not_found", message: "no series", path: "/v2/series/1",
    });
  });

  it("fails soft on malformed error envelopes and schema drift", async () => {
    const server = clientReturning({ unexpected: true }, 500);
    await expect(server.api.getHealth()).rejects.toMatchObject({ reason: "http", status: 500 });
    const malformed = clientReturning({ status: "ok", block: 123 });
    await expect(malformed.api.getHealth()).rejects.toMatchObject({ reason: "invalid", status: 200 });
  });

  it("wraps invalid JSON, network failures and timeout", async () => {
    const invalid = new V2ApiClient({ baseUrl: "https://indexer.example", fetchImpl: (async () => new Response("<html>bad</html>")) as typeof fetch });
    await expect(invalid.getHealth()).rejects.toMatchObject({ reason: "invalid" });
    const network = new V2ApiClient({ baseUrl: "https://indexer.example", fetchImpl: (async () => { throw new TypeError("offline"); }) as typeof fetch });
    await expect(network.getHealth()).rejects.toMatchObject({ reason: "network" });
    const hanging = new V2ApiClient({
      baseUrl: "https://indexer.example", timeoutMs: 5,
      fetchImpl: ((_: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)))) as typeof fetch,
    });
    await expect(hanging.getHealth()).rejects.toMatchObject({ reason: "timeout" });
    expect(ApiUnavailable).toBeDefined();
  });
});

describe("v2 query keys", () => {
  it("separates filters and normalizes address casing", () => {
    expect(v2Keys.cards({ ticker: "NVDA" })).not.toEqual(v2Keys.cards({ ticker: "TSLA" }));
    expect(v2Keys.book("10", 5)).not.toEqual(v2Keys.book("10", 20));
    expect(v2Keys.positions("0xABC")).toEqual(v2Keys.positions("0xabc"));
    expect(v2Keys.health).not.toEqual(v2Keys.config);
  });
});
