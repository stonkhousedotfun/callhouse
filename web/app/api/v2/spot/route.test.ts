/** GET /api/v2/spot: the route wiring over lib/v2/displaySpot, with the API and the chain stubbed. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { liveV2Markets } from "@/lib/markets";
import { V2_API_BASE } from "@/lib/v2/api";

vi.mock("@/lib/v2/displaySpot", () => ({ resolveDisplaySpot: vi.fn() }));

import { resolveDisplaySpot } from "@/lib/v2/displaySpot";
import { GET } from "./route";

const resolve = vi.mocked(resolveDisplaySpot);
const tickers = liveV2Markets().map((m) => m.ticker);
const first = tickers[0]!;

describe("GET /api/v2/spot", () => {
  const upstream = vi.fn<typeof fetch>();
  beforeEach(() => {
    upstream.mockReset();
    resolve.mockReset();
    vi.stubGlobal("fetch", upstream);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("has at least one live market to serve", () => {
    expect(tickers.length).toBeGreaterThan(0);
  });

  it("passes each API spot through, as bigint, and serves string rows cacheable for 30 s", async () => {
    upstream.mockResolvedValue(new Response(JSON.stringify([
      { ticker: first, spot: { raw: "225549701" }, spotUpdatedAt: 1_790_000_000 },
    ]), { status: 200 }));
    resolve.mockImplementation(async (ticker, api) =>
      ticker === first ? { raw: api!.raw, updatedAt: api!.updatedAt, source: "api" } : null);

    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=30, s-maxage=30");
    expect(await res.json()).toEqual({ items: [{ ticker: first, raw: "225549701", updatedAt: 1_790_000_000, source: "api" }] });
    expect(String(upstream.mock.calls[0]![0])).toBe(`${V2_API_BASE}/v2/markets`);
    expect(upstream.mock.calls[0]![1]).toMatchObject({ cache: "no-store" });
    expect(resolve).toHaveBeenCalledWith(first, { raw: 225_549_701n, updatedAt: 1_790_000_000 });
    // Every live market is asked, even ones the API did not price.
    expect(resolve.mock.calls.map((c) => c[0])).toEqual(tickers);
    for (const call of resolve.mock.calls.slice(1)) expect(call[1]).toBeNull();
  });

  it("drops malformed API rows so the chain fallback is used instead", async () => {
    upstream.mockResolvedValue(new Response(JSON.stringify([
      { ticker: first, spot: { raw: "-5" }, spotUpdatedAt: 1 },
      { ticker: first, spot: { raw: "12.5" }, spotUpdatedAt: 1 },
      { ticker: first, spot: { raw: 100 }, spotUpdatedAt: 1 },
      { ticker: first, spot: { raw: "100" }, spotUpdatedAt: 0 },
      { ticker: first, spot: { raw: "100" }, spotUpdatedAt: 1.5 },
      { ticker: first, spot: null, spotUpdatedAt: 1 },
      { ticker: 7, spot: { raw: "100" }, spotUpdatedAt: 1 },
      null,
    ]), { status: 200 }));
    resolve.mockResolvedValue({ raw: 1_000_000n, updatedAt: 5, source: "chainlink" });
    const res = await GET();
    for (const call of resolve.mock.calls) expect(call[1]).toBeNull();
    const body = await res.json() as { items: Array<{ source: string; raw: string }> };
    expect(body.items).toHaveLength(tickers.length);
    expect(body.items.every((row) => row.source === "chainlink" && row.raw === "1000000")).toBe(true);
  });

  it.each([
    ["an HTTP error", () => Promise.resolve(new Response("{}", { status: 503 }))],
    ["a non-array body", () => Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }))],
    ["invalid JSON", () => Promise.resolve(new Response("not json", { status: 200 }))],
    ["a network failure", () => Promise.reject(new Error("ECONNREFUSED"))],
  ])("falls back to the chain for every market on %s", async (_label, answer) => {
    upstream.mockImplementation(answer);
    resolve.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [] });
    expect(resolve).toHaveBeenCalledTimes(tickers.length);
    for (const call of resolve.mock.calls) expect(call[1]).toBeNull();
  });
});
