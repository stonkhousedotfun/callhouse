import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { ApiUnavailable, V2ApiClient, V2_API_TIMEOUT_MS } from "./api";
import { ALL_MARKET_SERIES_POLICY, v2Keys } from "./hooks";

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

type SeriesFixture = { series: { longId: string; shortId: string; expiry: number; strike: { raw: string } }; [key: string]: unknown };
function seriesRows(item: unknown, start: number, count: number): SeriesFixture[] {
  const row = item as SeriesFixture;
  return Array.from({ length: count }, (_, index) => {
    const id = start + index;
    return { ...row, series: { ...row.series, longId: String(id), shortId: String(100_000 + id),
      ticker: "NVDA", isPut: false, status: "open" } };
  });
}

/** The client exposes a typed method for every fixture route. */
function invoke(api: V2ApiClient, rel: string): Promise<unknown> {
  const path = rel.replace(/\.json$/, "");
  if (path === "health") return api.getHealth();
  if (path === "services") return api.getServices();
  if (path === "admin/operations") return api.getAdminOperations();
  if (path === "flywheel") return api.getFlywheel();
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
  if (path === "earn") return api.getEarn();
  if (path === "house") return api.getHouse();
  const parts = path.split("/");
  if (parts[0] === "house" && parts.length === 2) return api.getHouseMarket(parts[1]);
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
    // 232 since T-452 generated services.json (46813b5e). A route added without its fixture, or a fixture
    // lost, moves this number; invoke() throws for a fixture with no client method.
    expect(files.length).toBe(232);
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

  it("requests manual redirects and refuses a redirect with its own reason", async () => {
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect, "V2 fetch must request manual redirects").toBe("manual");
      return new Response(null, { status: 302, headers: { location: "https://elsewhere.example/v2/health" } });
    }) as typeof fetch;
    const api = new V2ApiClient({ baseUrl: "https://indexer.example", fetchImpl });

    await expect(api.getHealth()).rejects.toMatchObject({
      name: "ApiUnavailable",
      reason: "redirect",
      status: 302,
      message: "Indexer returned a redirect, which is not followed",
    });
  });

  it("also refuses the opaque status-zero shape browsers expose for manual cross-origin redirects", async () => {
    const opaqueRedirect = {
      body: null,
      headers: new Headers(),
      ok: false,
      status: 0,
      type: "opaqueredirect",
    } as Response;
    const api = new V2ApiClient({ baseUrl: "https://indexer.example",
      fetchImpl: (async () => opaqueRedirect) as typeof fetch });

    await expect(api.getHealth()).rejects.toMatchObject({ reason: "redirect", status: 0 });
  });

  it("refuses a declared oversized body before opening its stream", async () => {
    let cancelled = false;
    const response = {
      body: {
        cancel: async () => { cancelled = true; },
        getReader: () => { throw new Error("oversized response body was read"); },
      },
      headers: new Headers({ "content-length": "17" }),
      ok: true,
      status: 200,
      type: "default",
    } as unknown as Response;
    const api = new V2ApiClient({ baseUrl: "https://indexer.example", maxBytes: 16,
      fetchImpl: (async () => response) as typeof fetch });

    await expect(api.getHealth()).rejects.toMatchObject({ reason: "too-large", status: 200 });
    expect(cancelled).toBe(true);
  });

  it("caps the streamed bytes when content-length is absent", async () => {
    const health = JSON.parse(readFileSync(join(FIXTURES, "health.json"), "utf8")) as unknown;
    const encoded = new TextEncoder().encode(JSON.stringify(health));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const middle = Math.ceil(encoded.byteLength / 2);
        controller.enqueue(encoded.slice(0, middle));
        controller.enqueue(encoded.slice(middle));
        controller.close();
      },
    });
    const api = new V2ApiClient({ baseUrl: "https://indexer.example", maxBytes: encoded.byteLength - 1,
      fetchImpl: (async () => new Response(body,
        { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch });

    await expect(api.getHealth()).rejects.toMatchObject({ reason: "too-large", status: 200 });
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

    const operations = JSON.parse(readFileSync(join(FIXTURES, "admin", "operations.json"), "utf8")) as unknown;
    const admin = clientReturning(operations);
    await admin.api.getAdminOperations({ status: "executed", limit: 25, cursor: "next/page" });
    const adminUrl = new URL(admin.calls[0].url);
    expect(adminUrl.pathname).toBe("/v2/admin/operations");
    expect(Object.fromEntries(adminUrl.searchParams)).toEqual({
      status: "executed", limit: "25", cursor: "next/page",
    });
  });

  it("loads every market-series page and de-duplicates a cursor boundary", async () => {
    const fixture = JSON.parse(readFileSync(join(FIXTURES, "markets", "NVDA", "series.json"), "utf8")) as { items: unknown[]; asOf: number };
    const firstPage = seriesRows(fixture.items[0], 1, 200);
    const lastPage = [firstPage[199], ...seriesRows(fixture.items[1], 201, 1)];
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      calls.push(url.toString());
      const second = url.searchParams.get("cursor") === "page-2";
      return Response.json(second
        ? { items: lastPage, asOf: fixture.asOf, nextCursor: null }
        : { items: firstPage, asOf: fixture.asOf, nextCursor: "page-2" });
    }) as typeof fetch;
    const api = new V2ApiClient({ baseUrl: "https://indexer.example", fetchImpl });
    const result = await api.getAllMarketSeries("NVDA", { type: "call", status: "open" });
    expect(result.items).toHaveLength(201);
    expect(calls).toHaveLength(2);
    expect(Object.fromEntries(new URL(calls[0]).searchParams)).toEqual({ type: "call", status: "open", limit: "200" });
    expect(new URL(calls[1]).searchParams.get("cursor")).toBe("page-2");
  });

  it("reports the oldest indexed head across the pages it merged", async () => {
    const fixture = JSON.parse(readFileSync(join(FIXTURES, "markets", "NVDA", "series.json"), "utf8")) as { items: unknown[]; asOf: number };
    // The middle page is the stalest, so neither the first nor the last page's asOf is the answer.
    const heads = [fixture.asOf, fixture.asOf - 120, fixture.asOf - 30];
    let calls = 0;
    const api = new V2ApiClient({ baseUrl: "https://indexer.example", fetchImpl: (async () => {
      calls += 1;
      const last = calls === heads.length;
      return Response.json({ items: seriesRows(fixture.items[0], (calls - 1) * 200 + 1, last ? 1 : 200),
        asOf: heads[calls - 1], nextCursor: last ? null : `page-${calls + 1}` });
    }) as typeof fetch });
    const result = await api.getAllMarketSeries("NVDA");
    expect(calls).toBe(3);
    expect(result.items).toHaveLength(401);
    expect(result.asOf).toBe(fixture.asOf - 120);
  });

  it("fails closed on a repeated series cursor", async () => {
    const fixture = JSON.parse(readFileSync(join(FIXTURES, "markets", "NVDA", "series.json"), "utf8")) as { items: unknown[]; asOf: number };
    const page = seriesRows(fixture.items[0], 1, 200);
    let calls = 0;
    const api = new V2ApiClient({ baseUrl: "https://indexer.example", fetchImpl: (async () => {
      calls += 1;
      return Response.json({ items: page, asOf: fixture.asOf, nextCursor: "repeat" });
    }) as typeof fetch });
    await expect(api.getAllMarketSeries("NVDA")).rejects.toMatchObject({
      name: "ApiUnavailable", reason: "invalid", message: "Indexer repeated a series cursor",
    });
    expect(calls).toBe(2);
  });

  it("caps a non-terminating series walk at fifty pages", async () => {
    const fixture = JSON.parse(readFileSync(join(FIXTURES, "markets", "NVDA", "series.json"), "utf8")) as { items: unknown[]; asOf: number };
    let calls = 0;
    const api = new V2ApiClient({ baseUrl: "https://indexer.example", fetchImpl: (async () => {
      calls += 1;
      return Response.json({ items: seriesRows(fixture.items[0], (calls - 1) * 200 + 1, 200), asOf: fixture.asOf, nextCursor: `page-${calls}` });
    }) as typeof fetch });
    await expect(api.getAllMarketSeries("NVDA")).rejects.toMatchObject({
      name: "ApiUnavailable", reason: "invalid", message: "Indexer returned too many series pages",
    });
    expect(calls).toBe(50);
  });

  it("propagates caller cancellation through a multi-page series walk", async () => {
    const fixture = JSON.parse(readFileSync(join(FIXTURES, "markets", "NVDA", "series.json"), "utf8")) as { items: unknown[]; asOf: number };
    const controller = new AbortController();
    let calls = 0;
    let releaseSecond!: () => void;
    const secondStarted = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const api = new V2ApiClient({ baseUrl: "https://indexer.example", fetchImpl: (async (_input, init) => {
      calls += 1;
      if (calls === 1) return Response.json({ items: seriesRows(fixture.items[0], 1, 200), asOf: fixture.asOf, nextCursor: "page-2" });
      releaseSecond();
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const abort = () => reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
    }) as typeof fetch });
    const request = api.getAllMarketSeries("NVDA", {}, { signal: controller.signal });
    await secondStarted;
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: "ApiUnavailable", reason: "network" });
    expect(calls).toBe(2);
  });

  it("rejects oversized, short nonterminal, foreign, and conflicting series pages", async () => {
    const fixture = JSON.parse(readFileSync(join(FIXTURES, "markets", "NVDA", "series.json"), "utf8")) as { items: unknown[]; asOf: number };
    const oversized = clientReturning({ items: seriesRows(fixture.items[0], 1, 201), asOf: fixture.asOf, nextCursor: null });
    await expect(oversized.api.getAllMarketSeries("NVDA", { type: "call", status: "open" }))
      .rejects.toMatchObject({ reason: "invalid" });

    const short = clientReturning({ items: seriesRows(fixture.items[0], 1, 1), asOf: fixture.asOf, nextCursor: "page-2" });
    await expect(short.api.getAllMarketSeries("NVDA", { type: "call", status: "open" }))
      .rejects.toMatchObject({ reason: "invalid", message: "Indexer returned a short nonterminal series page" });

    const foreignRow = seriesRows(fixture.items[0], 1, 1)[0];
    const foreign = clientReturning({ items: [{ ...foreignRow,
      series: { ...foreignRow.series, ticker: "META" } }], asOf: fixture.asOf, nextCursor: null });
    await expect(foreign.api.getAllMarketSeries("NVDA", { type: "call", status: "open" }))
      .rejects.toMatchObject({ reason: "invalid", message: "Indexer returned a series outside the requested market filters" });

    const firstPage = seriesRows(fixture.items[0], 1, 200);
    let calls = 0;
    const conflict = new V2ApiClient({ baseUrl: "https://indexer.example", fetchImpl: (async () => {
      calls += 1;
      if (calls === 1) return Response.json({ items: firstPage, asOf: fixture.asOf, nextCursor: "page-2" });
      const duplicate = firstPage[0];
      return Response.json({ items: [{ ...duplicate, series: { ...duplicate.series,
        expiry: duplicate.series.expiry + 1 } }], asOf: fixture.asOf, nextCursor: null });
    }) as typeof fetch });
    await expect(conflict.getAllMarketSeries("NVDA", { type: "call", status: "open" }))
      .rejects.toMatchObject({ reason: "invalid", message: "Indexer returned conflicting series identities" });
  });

  it("applies one deadline to the whole series traversal", async () => {
    const fixture = JSON.parse(readFileSync(join(FIXTURES, "markets", "NVDA", "series.json"), "utf8")) as { items: unknown[]; asOf: number };
    let calls = 0;
    const api = new V2ApiClient({ baseUrl: "https://indexer.example", allSeriesTimeoutMs: 50,
      fetchImpl: (async (_input, init) => {
        calls += 1;
        if (calls === 1) return Response.json({ items: seriesRows(fixture.items[0], 1, 200), asOf: fixture.asOf, nextCursor: "page-2" });
        return new Promise<Response>((_resolve, reject) => {
          const abort = () => reject(init?.signal?.reason ?? new DOMException("Aborted", "AbortError"));
          if (init?.signal?.aborted) abort();
          else init?.signal?.addEventListener("abort", abort, { once: true });
        });
      }) as typeof fetch });
    await expect(api.getAllMarketSeries("NVDA", { type: "call", status: "open" }))
      .rejects.toMatchObject({ reason: "timeout" });
    expect(calls).toBe(2);
  });

  it("does not apply the shorter ordinary request timeout inside the traversal deadline", async () => {
    const fixture = JSON.parse(readFileSync(join(FIXTURES, "markets", "NVDA", "series.json"), "utf8")) as { items: unknown[]; asOf: number };
    let calls = 0;
    const api = new V2ApiClient({ baseUrl: "https://indexer.example", timeoutMs: 5, allSeriesTimeoutMs: 100,
      fetchImpl: ((_input, init) => {
        calls += 1;
        return new Promise<Response>((resolve, reject) => {
          const signal = init?.signal;
          const timer = setTimeout(() => {
            signal?.removeEventListener("abort", abort);
            resolve(Response.json({ items: seriesRows(fixture.items[0], 1, 1), asOf: fixture.asOf, nextCursor: null }));
          }, 25);
          const abort = () => {
            clearTimeout(timer);
            reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
          };
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        });
      }) as typeof fetch });

    await expect(api.getAllMarketSeries("NVDA", { type: "call", status: "open" }))
      .resolves.toMatchObject({ items: [{ series: { longId: "1" } }], nextCursor: null });
    await expect(api.getMarketSeries("NVDA", { type: "call", status: "open" }))
      .rejects.toMatchObject({ reason: "timeout" });
    expect(calls).toBe(2);
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

  it("parses the house list fixture, rejects an unknown key, and surfaces ApiUnavailable on a bad body", async () => {
    const list = JSON.parse(readFileSync(join(FIXTURES, "house.json"), "utf8")) as unknown;
    const market = JSON.parse(readFileSync(join(FIXTURES, "house", "NVDA.json"), "utf8")) as {
      currentEpoch: { nav: unknown; resultUsdg: { raw: string } | null };
      epochs: { resultUsdg: { raw: string } | null }[];
    };
    const ok = clientReturning(list);
    await expect(ok.api.getHouse()).resolves.toEqual(list);
    expect(new URL(ok.calls[0].url).pathname).toBe("/v2/house");

    const nvda = clientReturning(market);
    const parsed = await nvda.api.getHouseMarket("NVDA");
    // `currentEpoch` is nullable in the schema, so this asserts it IS present for this fixture
    // before reading through it, rather than assuming it away with a non-null assertion.
    expect(parsed.currentEpoch).not.toBeNull();
    expect(parsed.currentEpoch?.nav).toBeNull();
    expect(parsed.epochs.some((epoch) => epoch.resultUsdg?.raw.startsWith("-"))).toBe(true);
    expect(new URL(nvda.calls[0].url).pathname).toBe("/v2/house/NVDA");

    const drifted = clientReturning({ ...(list as object), extra: true });
    await expect(drifted.api.getHouse()).rejects.toMatchObject({ name: "ApiUnavailable", reason: "invalid" });
    const bad = clientReturning({ items: "nope" });
    await expect(bad.api.getHouse()).rejects.toMatchObject({ name: "ApiUnavailable", reason: "invalid" });
  });
});

describe("v2 query keys", () => {
  it("separates filters and normalizes address casing", () => {
    expect(v2Keys.cards({ ticker: "NVDA" })).not.toEqual(v2Keys.cards({ ticker: "TSLA" }));
    expect(v2Keys.allMarketSeries("NVDA", { type: "call" })).not.toEqual(v2Keys.marketSeries("NVDA", { type: "call" }));
    expect(v2Keys.book("10", 5)).not.toEqual(v2Keys.book("10", 20));
    expect(v2Keys.positions("0xABC")).toEqual(v2Keys.positions("0xabc"));
    expect(v2Keys.adminOperations({ status: "pending" }))
      .not.toEqual(v2Keys.adminOperations({ status: "executed" }));
    expect(v2Keys.flywheel).not.toEqual(v2Keys.config);
    expect(v2Keys.health).not.toEqual(v2Keys.config);
    expect(v2Keys.house).not.toEqual(v2Keys.earn());
    expect(v2Keys.houseMarket("NVDA")).not.toEqual(v2Keys.houseMarket("TSLA"));
    expect(v2Keys.houseMarket("NVDA", "0xABC")).toEqual(v2Keys.houseMarket("NVDA", "0xabc"));
  });

  it("keeps full series traversal off the live polling and retry cadence", () => {
    expect(ALL_MARKET_SERIES_POLICY).toEqual({
      staleTime: 300_000,
      refetchInterval: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      retry: false,
    });
  });
});

/**
 * `/v2/services` (T-424 producer, T-296 consumer).
 *
 * There is no fixture for this route, so it is not covered by the fixture sweep above and needs
 * its own test. What is asserted here is what the CONSUMER depends on: the answer is parsed
 * against the frozen schema, the request is not cached, and a body that does not match raises
 * ApiUnavailable rather than returning a partially-read object. The last one is the important
 * one — `smartPricingOffer` treats a failed read as "not healthy", and that only holds if a bad
 * body actually fails instead of arriving with `healthy` undefined.
 */
describe("getServices", () => {
  const body = {
    pricer: { healthy: true, reason: "ready", reasons: [], checkedAt: 1_800_000_000, lastEvaluationAt: 1_799_999_995 },
  };

  it("reads /v2/services with no-store and parses the frozen shape", async () => {
    const { api, calls } = clientReturning(body);
    const services = await api.getServices();
    expect(calls[0]!.url).toContain("/v2/services");
    // no-store for the same reason getHealth has it: a cached readiness answer reports a dead
    // service as alive for as long as the cache lives.
    expect(calls[0]!.init?.cache).toBe("no-store");
    expect(services.pricer.healthy).toBe(true);
    expect(services.pricer.reason).toBe("ready");
  });

  it("rejects a body that does not match the schema instead of half-reading it", async () => {
    // An unknown key, a missing key and a wrong type each have to fail, because the consumer's
    // fail-closed decision is only sound if a bad answer throws rather than arriving with
    // `healthy: undefined`.
    for (const bad of [
      { pricer: { healthy: true, reason: "ready", reasons: [], checkedAt: 1, lastEvaluationAt: null, extra: 1 } },
      { pricer: { healthy: true, reason: "ready", reasons: [], checkedAt: 1 } },
      { pricer: { healthy: "yes", reason: "ready", reasons: [], checkedAt: 1, lastEvaluationAt: null } },
      { pricer: { healthy: false, reason: "made-up", reasons: [], checkedAt: 1, lastEvaluationAt: null } },
      { pricer: { healthy: false, reason: "not_ready", reasons: ["disk-full"], checkedAt: 1, lastEvaluationAt: null } },
    ]) {
      const { api } = clientReturning(bad);
      await expect(api.getServices(), JSON.stringify(bad)).rejects.toMatchObject({ name: "ApiUnavailable", reason: "invalid" });
    }
  });

  it("carries the pricer's own reasons through unchanged", async () => {
    const notReady = {
      pricer: { healthy: false, reason: "not_ready", reasons: ["role-refused", "fair-stale"], checkedAt: 2, lastEvaluationAt: null },
    };
    const { api } = clientReturning(notReady);
    expect((await api.getServices()).pricer.reasons).toEqual(["role-refused", "fair-stale"]);
  });
});
