/**
 * lib/v2/priceHistory: range mapping, normalisation of a RECORDED GeckoTerminal answer, the cache, the
 * upstream deadline and every failure the chart falls back on.
 */
import { describe, expect, it } from "vitest";

import { getV2Market } from "@/lib/markets";
import {
  CACHE_FAIL_S, CACHE_OK_S, PRICE_RANGES, RANGE_SPECS, createPriceHistoryCache, geckoOhlcvUrl, isPriceRange,
  normaliseOhlcv, servePriceHistory, toUsdg6, type PriceHistoryDeps,
} from "./priceHistory";

const NVDA_TOKEN = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec";

/**
 * Recorded 2026-09-23 ~05:45Z from
 * https://api.geckoterminal.com/api/v2/networks/robinhood/pools/0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3/ohlcv/minute?aggregate=15&limit=4&currency=usd&token=0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec
 * (newest first, as the API sends it; the `meta.quote` block trimmed to what is read).
 */
const RECORDED = {
  data: {
    id: "f21bf220-ae65-4494-bb7e-1fca4df4d1b0",
    type: "ohlcv_request_response",
    attributes: {
      ohlcv_list: [
        [1790142300, 228.876444044332, 229.152050465396, 228.820552374713, 228.820552374713, 83.69007106455469],
        [1790141400, 228.721102219491, 229.198241993753, 228.680387783082, 228.876444044332, 19645.768273973747],
        [1790140500, 228.92618475341, 229.462127649561, 228.68040153413, 228.721102219491, 26037.735999133063],
        [1790139600, 229.48259310474, 229.619760187824, 228.510172841043, 228.92618475341, 63600.591185906174],
      ],
    },
  },
  meta: {
    base: { name: "NVIDIA • Robinhood Token", symbol: "NVDA", address: NVDA_TOKEN },
    quote: { symbol: "USDG", address: "0x5fc5360d0400a0fd4f2af552add042d716f1d168" },
  },
};
const RECORDED_NOW = 1790142400;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A fetch that records every URL and answers from `answer`. */
function fakeFetch(answer: (url: string, init?: RequestInit) => Promise<Response>) {
  const calls: string[] = [];
  const fn = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    return answer(url, init);
  }) as typeof fetch;
  return { fn, calls };
}

function deps(fetchFn: typeof fetch, clock: { now: number }, extra: Partial<PriceHistoryDeps> = {}): PriceHistoryDeps {
  return { fetch: fetchFn, now: () => clock.now, cache: createPriceHistoryCache(), ...extra };
}

describe("RANGE_SPECS", () => {
  it("maps 1D/1W/1M/1Y to 15-minute, hourly, 4-hour and daily candles the API accepts", () => {
    expect(PRICE_RANGES).toEqual(["1D", "1W", "1M", "1Y"]);
    expect(RANGE_SPECS["1D"]).toMatchObject({ timeframe: "minute", aggregate: 15, resolutionSec: 900, spanSec: 86_400, limit: 97 });
    expect(RANGE_SPECS["1W"]).toMatchObject({ timeframe: "hour", aggregate: 1, resolutionSec: 3_600, limit: 169 });
    expect(RANGE_SPECS["1M"]).toMatchObject({ timeframe: "hour", aggregate: 4, resolutionSec: 14_400, limit: 181 });
    expect(RANGE_SPECS["1Y"]).toMatchObject({ timeframe: "day", aggregate: 1, resolutionSec: 86_400, limit: 366 });
    // The API's documented aggregates and row cap.
    const allowed = { minute: [1, 5, 15], hour: [1, 4, 12], day: [1] } as const;
    for (const r of PRICE_RANGES) {
      const s = RANGE_SPECS[r];
      expect((allowed[s.timeframe] as readonly number[]).includes(s.aggregate)).toBe(true);
      expect(s.limit).toBeLessThanOrEqual(1000);
      expect(s.resolutionSec * (s.limit - 1)).toBeGreaterThanOrEqual(s.spanSec);
    }
  });

  it("accepts only the four range names", () => {
    expect(PRICE_RANGES.every(isPriceRange)).toBe(true);
    for (const bad of ["1d", "5D", "", null, undefined, 1]) expect(isPriceRange(bad)).toBe(false);
  });

  it("asks for the stock token's USD price on the robinhood network", () => {
    const url = new URL(geckoOhlcvUrl("0xPOOL", NVDA_TOKEN, RANGE_SPECS["1D"]));
    expect(url.origin + url.pathname).toBe("https://api.geckoterminal.com/api/v2/networks/robinhood/pools/0xPOOL/ohlcv/minute");
    expect(Object.fromEntries(url.searchParams)).toEqual({ aggregate: "15", limit: "97", currency: "usd", token: NVDA_TOKEN });
  });
});

describe("normaliseOhlcv", () => {
  it("turns the recorded answer into candles, oldest first", () => {
    const candles = normaliseOhlcv(RECORDED, { token: NVDA_TOKEN, spanSec: 86_400, now: RECORDED_NOW });
    expect(candles.map((k) => k.t)).toEqual([1790139600, 1790140500, 1790141400, 1790142300]);
    expect(candles[0]).toEqual({ t: 1790139600, o: 229.48259310474, h: 229.619760187824, l: 228.510172841043, c: 228.92618475341 });
    expect(toUsdg6(candles.at(-1)!.c)).toBe(228_820_552n);
  });

  it("matches the token case-insensitively (the registry checksums, the API lowercases)", () => {
    const checksummed = getV2Market("NVDA")!.asset;
    expect(checksummed).not.toBe(NVDA_TOKEN);
    expect(normaliseOhlcv(RECORDED, { token: checksummed, spanSec: 86_400, now: RECORDED_NOW })).toHaveLength(4);
  });

  it("refuses an answer priced in another token rather than charting 1/price", () => {
    const flipped = { ...RECORDED, meta: { base: RECORDED.meta.quote, quote: RECORDED.meta.base } };
    expect(() => normaliseOhlcv(flipped, { token: NVDA_TOKEN, spanSec: 86_400, now: RECORDED_NOW }))
      .toThrow("priced a different token");
    const noMeta = { data: RECORDED.data };
    expect(() => normaliseOhlcv(noMeta, { token: NVDA_TOKEN, spanSec: 86_400, now: RECORDED_NOW })).toThrow("different token");
  });

  it("refuses the wrong shape, malformed rows and non-positive prices", () => {
    const opts = { token: NVDA_TOKEN, spanSec: 86_400, now: RECORDED_NOW };
    expect(() => normaliseOhlcv({ errors: [{ status: "400" }] }, opts)).toThrow("unexpected shape");
    const rows = (list: unknown[]) => ({ ...RECORDED, data: { attributes: { ohlcv_list: list } } });
    expect(() => normaliseOhlcv(rows([[1790139600, 1, 1, 1]]), opts)).toThrow("malformed");
    expect(() => normaliseOhlcv(rows([[1790139600, 1, 1, 0, 1]]), opts)).toThrow("malformed");
    expect(() => normaliseOhlcv(rows([[1790139600, "x", 1, 1, 1]]), opts)).toThrow("malformed");
    expect(() => normaliseOhlcv(rows([[1.5, 1, 1, 1, 1]]), opts)).toThrow("malformed");
  });

  it("keeps only the range's window and says so when nothing is left", () => {
    // The window is [now - span, now], inclusive: 1_900 s back from 1790142400 is exactly 1790140500's open time.
    expect(normaliseOhlcv(RECORDED, { token: NVDA_TOKEN, spanSec: 1_900, now: RECORDED_NOW }).map((k) => k.t))
      .toEqual([1790140500, 1790141400, 1790142300]);
    const candles = normaliseOhlcv(RECORDED, { token: NVDA_TOKEN, spanSec: 1_899, now: RECORDED_NOW });
    expect(candles.map((k) => k.t)).toEqual([1790141400, 1790142300]);
    expect(() => normaliseOhlcv(RECORDED, { token: NVDA_TOKEN, spanSec: 60, now: RECORDED_NOW })).toThrow("no candles");
  });
});

describe("servePriceHistory", () => {
  const nvda = getV2Market("NVDA")!;

  it("reads the registry's pool and the stock token for the market, never a literal", async () => {
    const clock = { now: RECORDED_NOW };
    const f = fakeFetch(async () => json(RECORDED));
    const { status, body } = await servePriceHistory({ ticker: "nvda", range: "1D" }, deps(f.fn, clock));
    expect(status).toBe(200);
    expect(f.calls).toEqual([geckoOhlcvUrl(nvda.v2.univ3Pool!, nvda.asset, RANGE_SPECS["1D"])]);
    expect(body).toMatchObject({
      ok: true, ticker: "NVDA", range: "1D", resolutionSec: 900, pool: nvda.v2.univ3Pool,
      firstAt: 1790139600, lastAt: 1790142300, fetchedAt: RECORDED_NOW, source: "GeckoTerminal",
      sourceUrl: `https://www.geckoterminal.com/robinhood/pools/${nvda.v2.univ3Pool}`,
    });
  });

  it("refuses an unknown range, an unknown market and a market without a pool, without calling out", async () => {
    const f = fakeFetch(async () => json(RECORDED));
    const d = deps(f.fn, { now: RECORDED_NOW });
    expect((await servePriceHistory({ ticker: "NVDA", range: "5D" }, d)).status).toBe(400);
    expect((await servePriceHistory({ ticker: "NVDA", range: null }, d)).status).toBe(400);
    expect((await servePriceHistory({ ticker: "TSLA", range: "1D" }, d)).status).toBe(404);
    expect((await servePriceHistory({ ticker: null, range: "1D" }, d)).status).toBe(404);
    const noPool = deps(f.fn, { now: RECORDED_NOW }, { market: () => ({ ticker: "NVDA", pool: null, token: NVDA_TOKEN }) });
    const answer = await servePriceHistory({ ticker: "NVDA", range: "1D" }, noPool);
    expect(answer).toMatchObject({ status: 404, body: { ok: false, error: "NVDA has no pool to chart." } });
    expect(f.calls).toEqual([]);
  });

  it("serves a good answer from the cache for CACHE_OK_S, then reads again", async () => {
    const clock = { now: RECORDED_NOW };
    const f = fakeFetch(async () => json(RECORDED));
    const d = deps(f.fn, clock);
    await servePriceHistory({ ticker: "NVDA", range: "1D" }, d);
    clock.now += CACHE_OK_S - 1;
    await servePriceHistory({ ticker: "NVDA", range: "1D" }, d);
    expect(f.calls).toHaveLength(1);
    // Another range is another key.
    await servePriceHistory({ ticker: "NVDA", range: "1W" }, d);
    expect(f.calls).toHaveLength(2);
    clock.now += 1;
    await servePriceHistory({ ticker: "NVDA", range: "1D" }, d);
    expect(f.calls).toHaveLength(3);
  });

  it("shares one upstream call between concurrent requests for the same key", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const f = fakeFetch(async () => { await gate; return json(RECORDED); });
    const d = deps(f.fn, { now: RECORDED_NOW });
    const both = Promise.all([
      servePriceHistory({ ticker: "NVDA", range: "1D" }, d),
      servePriceHistory({ ticker: "NVDA", range: "1D" }, d),
    ]);
    release();
    const [a, b] = await both;
    expect(f.calls).toHaveLength(1);
    expect(a).toBe(b);
  });

  it("answers 502 with a reason for an upstream error or a rate limit, and does not hammer it", async () => {
    const clock = { now: RECORDED_NOW };
    let status = 500;
    const f = fakeFetch(async () => json({ errors: [] }, status));
    const d = deps(f.fn, clock);
    expect(await servePriceHistory({ ticker: "NVDA", range: "1D" }, d)).toEqual({
      status: 502,
      body: { ok: false, ticker: "NVDA", range: "1D", error: "The price source answered HTTP 500.", retryable: true },
    });
    clock.now += CACHE_FAIL_S - 1;
    await servePriceHistory({ ticker: "NVDA", range: "1D" }, d);
    expect(f.calls).toHaveLength(1);
    clock.now += 1;
    status = 429;
    const limited = await servePriceHistory({ ticker: "NVDA", range: "1D" }, d);
    expect(limited.status).toBe(502);
    expect(limited.body).toMatchObject({ ok: false, error: expect.stringContaining("rate limiting") });
    expect(f.calls).toHaveLength(2);
  });

  it("answers 502 for a network failure and for an answer that is not the documented shape", async () => {
    const down = fakeFetch(async () => { throw new TypeError("fetch failed"); });
    expect((await servePriceHistory({ ticker: "NVDA", range: "1D" }, deps(down.fn, { now: RECORDED_NOW }))).body)
      .toMatchObject({ ok: false, error: "The price source could not be reached." });
    const odd = fakeFetch(async () => json({ data: null }));
    expect((await servePriceHistory({ ticker: "NVDA", range: "1D" }, deps(odd.fn, { now: RECORDED_NOW }))).body)
      .toMatchObject({ ok: false, error: "The price source answered in an unexpected shape." });
  });

  it("gives up at the deadline with 504 and aborts the request", async () => {
    let aborted = false;
    const hang = fakeFetch((_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => { aborted = true; reject(new DOMException("aborted", "AbortError")); });
    }));
    const answer = await servePriceHistory({ ticker: "NVDA", range: "1D" }, deps(hang.fn, { now: RECORDED_NOW }, { timeoutMs: 20 }));
    expect(answer).toMatchObject({ status: 504, body: { ok: false, error: "The price source did not answer in time.", retryable: true } });
    expect(aborted).toBe(true);
  });
});
