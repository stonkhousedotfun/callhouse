/** lib/api.ts network readers: fail-soft behaviour, envelope unwrapping and the order-feed parse. `fetch` is stubbed. */
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { API_BASE, ApiError, fetchAccount, fetchCycles, fetchHealth, fetchKeeperOrderBook, fetchVaultSummary, normaliseCycle } from "./api";

const upstream = vi.fn<typeof fetch>();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../ops/fixtures/api/${name}`, import.meta.url), "utf8"));

beforeEach(() => {
  upstream.mockReset();
  vi.stubGlobal("fetch", upstream);
});
afterEach(() => vi.unstubAllGlobals());

const ACCOUNT = "0x00000000000000000000000000000000000000Ee";

describe("fetchVaultSummary", () => {
  it("reads the wrapped vault with alternate spellings, money objects by raw, and ISO timestamps", async () => {
    upstream.mockResolvedValue(json({ vault: {
      phase: "1", cycle: 7, total_assets: { raw: "100000000000000000000", decimals: 18, formatted: "100.0" }, idle_nvda: "60",
      locked: 40, shares: " 90 ", usdg_balance: "7000000", ui_multiplier: "1000000000000000000", spot: 200.9, updated_at: "2026-09-25T00:00:00Z",
    } }));
    expect(await fetchVaultSummary()).toEqual({
      phase: 1, cycleNumber: 7, totalAssets: 100n * 10n ** 18n, idleAssets: 60n, lockedAssets: 40n, totalSupply: 90n, usdgBalance: 7_000_000n,
      uiMultiplier: 10n ** 18n, spotUsdg: 200n, updatedAt: Math.floor(Date.parse("2026-09-25T00:00:00Z") / 1000),
    });
    expect(upstream.mock.calls[0]![0]).toBe(`${API_BASE}/v1/vault`);
    expect(upstream.mock.calls[0]![1]).toMatchObject({ cache: "no-store", headers: { accept: "application/json" } });
  });

  it("degrades unparseable fields to undefined instead of throwing", async () => {
    upstream.mockResolvedValue(json({ phase: "later", totalAssets: "1.5", idleAssets: "", lockedAssets: true, ts: "", spotUsdg: "NaN", cycleNumber: {} }));
    const out = await fetchVaultSummary();
    expect(out).not.toBeNull();
    expect(out!.phase).toBeUndefined();
    expect(out!.totalAssets).toBeUndefined();
    expect(out!.idleAssets).toBeUndefined();
    expect(out!.lockedAssets).toBeUndefined();
    expect(out!.updatedAt).toBeUndefined();
    expect(out!.spotUsdg).toBeUndefined();
    expect(out!.cycleNumber).toBeUndefined();
  });

  it("returns null when the indexer is down or answers an error", async () => {
    upstream.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    expect(await fetchVaultSummary()).toBeNull();
    upstream.mockResolvedValueOnce(json({ error: "down" }, 500));
    expect(await fetchVaultSummary()).toBeNull();
  });
});

describe("fetchCycles", () => {
  it("unwraps the envelope, drops rows without a cycle number, and sorts newest first", async () => {
    upstream.mockResolvedValue(json({ cycles: [fixture("cycle-unfilled.json"), { status: "listed" }, fixture("cycle-filled.json"), fixture("cycle-assigned.json")] }));
    const rows = await fetchCycles(3);
    expect(upstream.mock.calls[0]![0]).toBe(`${API_BASE}/v1/cycles?limit=3`);
    const cycles = rows!.map((r) => r.cycle);
    expect(cycles).toHaveLength(3);
    expect([...cycles].sort((a, b) => b - a)).toEqual(cycles);
  });

  it.each([["a bare array", (x: unknown[]) => x], ["items", (x: unknown[]) => ({ items: x })], ["data", (x: unknown[]) => ({ data: x })]])(
    "accepts %s", async (_label, wrap) => {
      upstream.mockResolvedValue(json(wrap([{ cycle: 2 }, { cycleNumber: "5" }])));
      expect((await fetchCycles())!.map((r) => r.cycle)).toEqual([5, 2]);
    });

  it("returns [] for an unrecognised envelope and null when unreachable, so the page can tell them apart", async () => {
    upstream.mockResolvedValueOnce(json({ rows: [] }));
    expect(await fetchCycles()).toEqual([]);
    upstream.mockResolvedValueOnce(new Response("not json", { status: 200 }));
    expect(await fetchCycles()).toBeNull();
  });
});

describe("fetchAccount", () => {
  it("reads the wrapped account", async () => {
    upstream.mockResolvedValue(json({ account: { balance: "5", claimable_usdg: { raw: "1500000", formatted: "1.5" }, queued: 2n.toString(), epoch: "3" } }));
    expect(await fetchAccount(ACCOUNT)).toEqual({ address: ACCOUNT, shares: 5n, claimableUsdg: 1_500_000n, queuedShares: 2n, queuedEpoch: 3 });
    expect(upstream.mock.calls[0]![0]).toBe(`${API_BASE}/v1/account/${ACCOUNT}`);
  });

  it("returns null on a 404", async () => {
    upstream.mockResolvedValue(new Response("nope", { status: 404, statusText: "Not Found" }));
    expect(await fetchAccount(ACCOUNT)).toBeNull();
  });
});

describe("fetchHealth", () => {
  it("reads the indexer head, lag and the vault's phase from /v1/health", async () => {
    upstream.mockResolvedValue(json({ indexer: { head: 1_790_000_000 }, lag: { blocks: "3" }, vault: { phase: 2, cycle: 9 } }));
    expect(await fetchHealth()).toEqual({ ok: true, lastBeat: 1_790_000_000, rpcLagBlocks: 3, phase: 2, cycleNumber: 9 });
    expect(upstream.mock.calls[0]![0]).toBe(`${API_BASE}/v1/health`);
  });

  it("is not ok when the indexer fails", async () => {
    upstream.mockResolvedValue(json({ error: "syncing" }, 503));
    expect(await fetchHealth()).toEqual({ ok: false });
  });
});

describe("ApiError", () => {
  it("carries the status", () => {
    const e = new ApiError(503, "down");
    expect(e).toBeInstanceOf(Error);
    expect([e.name, e.status, e.message]).toEqual(["ApiError", 503, "down"]);
  });
});

describe("fetchKeeperOrderBook", () => {
  const H = `0x${"ab".repeat(32)}`;

  it("reads the route's lists, caps each at 9, keeps only known closed states and string reasons", async () => {
    upstream.mockResolvedValue(json({
      configured: true,
      orders: Array.from({ length: 12 }, (_, i) => ({ i })),
      rejected: [{ orderHash: H, reasons: ["bad", 7, "worse"] }, { orderHash: "nothex", reasons: "x" }],
      closed: [{ orderHash: H, state: "soldOut" }, { orderHash: H, state: "exploded" }, { state: "expired" }],
      unchecked: Array.from({ length: 12 }, () => ({ orderHash: H, reasons: ["rpc"] })),
    }));
    const book = await fetchKeeperOrderBook();
    expect(upstream.mock.calls[0]![0]).toBe("/api/keeper/orders");
    expect(book.configured).toBe(true);
    expect(book.listings).toHaveLength(9);
    expect(book.rejected).toEqual([{ orderHash: H, reasons: ["bad", "worse"] }, { orderHash: null, reasons: [] }]);
    expect(book.closed).toEqual([{ orderHash: H, state: "soldOut" }, { orderHash: null, state: "expired" }]);
    expect(book.unchecked).toHaveLength(9);
    expect(book.error).toBeUndefined();
  });

  it("reports the unconfigured 503 as not configured, not as an error of its own", async () => {
    upstream.mockResolvedValue(json({ configured: false, orders: [{ i: 1 }], error: "The order feed is not configured." }, 503));
    const book = await fetchKeeperOrderBook();
    expect(book.configured).toBe(false);
    expect(book.listings).toEqual([]); // never offered from a non-OK answer
    expect(book.error).toBe("The order feed is not configured.");
  });

  it("names the HTTP status when a non-OK answer has no error of its own", async () => {
    upstream.mockResolvedValue(json({}, 502));
    expect((await fetchKeeperOrderBook()).error).toBe("The order feed route answered HTTP 502.");
    upstream.mockResolvedValue(new Response("<html>", { status: 504 }));
    expect(await fetchKeeperOrderBook()).toEqual({ configured: true, listings: [], rejected: [], closed: [], unchecked: [],
      error: "The order feed route answered HTTP 504." });
  });

  it("never shows the browser's own network message", async () => {
    upstream.mockRejectedValue(new TypeError("Failed to fetch: net::ERR_BLOCKED"));
    expect((await fetchKeeperOrderBook()).error).toBe("The order feed route did not answer.");
  });

  it("tolerates non-array lists", async () => {
    upstream.mockResolvedValue(json({ orders: "x", closed: {}, rejected: null }));
    expect(await fetchKeeperOrderBook()).toEqual({ configured: true, listings: [], rejected: [], closed: [], unchecked: [], error: undefined });
  });
});

describe("normaliseCycle number tolerance", () => {
  it("reads a bigint cycle number and rejects a non-finite one", () => {
    expect(normaliseCycle({ cycle: 4n })?.cycle).toBe(4);
    expect(normaliseCycle({ cycle: Number.POSITIVE_INFINITY })).toBeNull();
    expect(normaliseCycle({ cycle: "  " })).toBeNull();
    expect(normaliseCycle(null)).toBeNull();
  });
});
