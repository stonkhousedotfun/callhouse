/** GET /api/v2/price-history: the route wiring over lib/v2/priceHistory, with the upstream stubbed. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getV2Market } from "@/lib/markets";
import { PRICE_HISTORY_CACHE } from "@/lib/v2/priceHistory";

import { GET } from "./route";

const nvda = getV2Market("NVDA")!;

const ANSWER = {
  data: { attributes: { ohlcv_list: [[Math.floor(Date.now() / 1000) - 900, 229, 230, 228, 229.5, 1]] } },
  meta: { base: { address: nvda.asset.toLowerCase() } },
};

function request(query: string): Request {
  return new Request(`http://localhost/api/v2/price-history?${query}`);
}

describe("GET /api/v2/price-history", () => {
  const upstream = vi.fn<typeof fetch>();
  beforeEach(() => {
    PRICE_HISTORY_CACHE.entries.clear();
    PRICE_HISTORY_CACHE.inflight.clear();
    upstream.mockReset();
    vi.stubGlobal("fetch", upstream);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("serves candles for a registered ticker, cacheable for a minute in the browser", async () => {
    upstream.mockResolvedValue(new Response(JSON.stringify(ANSWER), { status: 200 }));
    const res = await GET(request("ticker=NVDA&range=1D"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60, s-maxage=180, stale-while-revalidate=120");
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, ticker: "NVDA", range: "1D", pool: nvda.v2.univ3Pool, source: "GeckoTerminal" });
    expect(body.candles).toHaveLength(1);
    expect(String(upstream.mock.calls[0][0])).toContain(`/pools/${nvda.v2.univ3Pool}/ohlcv/minute?`);
  });

  it("answers the chart's fallback case with 502, a reason and no-store when the source fails", async () => {
    upstream.mockResolvedValue(new Response("{}", { status: 503 }));
    const res = await GET(request("ticker=NVDA&range=1W"));
    expect(res.status).toBe(502);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: false, ticker: "NVDA", range: "1W", error: "The price source answered HTTP 503.", retryable: true });
  });

  it("refuses a bad range or an unknown ticker without calling the source", async () => {
    expect((await GET(request("ticker=NVDA&range=10Y"))).status).toBe(400);
    expect((await GET(request("ticker=../../etc&range=1D"))).status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });
});
