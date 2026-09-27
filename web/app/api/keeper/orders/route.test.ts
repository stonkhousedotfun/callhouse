/** GET /api/keeper/orders: route wiring (sharing, error mapping, no-store); the keeper and chain logic are stubbed. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/chain", () => ({ CHAIN_ID: 4663, publicClient: { tag: "client" } }));
vi.mock("@/lib/contracts", () => ({
  VAULT: "0x00000000000000000000000000000000000000aa",
  USDG: "0x00000000000000000000000000000000000000bb",
  CLEARINGHOUSE: "0x00000000000000000000000000000000000000cc",
  SEAPORT: "0x00000000000000000000000000000000000000dd",
}));
vi.mock("@/lib/keeperOrders", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/keeperOrders")>()),
  serveKeeperOrders: vi.fn(),
  viemKeeperChainReader: vi.fn(),
}));

import { serveKeeperOrders, viemKeeperChainReader, type KeeperRouteDeps } from "@/lib/keeperOrders";
import { GET } from "./route";

const serve = vi.mocked(serveKeeperOrders);
const reader = { readState: vi.fn(async () => "state"), getOrderHashes: vi.fn(async () => ["0xhash"]) };
const body = (extra: object = {}) => ({ configured: true, orders: [], rejected: [], closed: [], unchecked: [], ...extra });

let n = 0;
/** A fresh URL per test so the module-level shared answer from a previous test is never reused. */
function freshUrl(): string {
  n += 1;
  return `http://keeper.internal:8787/orders?t=${n}`;
}

describe("GET /api/keeper/orders", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-25T12:00:00Z"));
    serve.mockReset();
    vi.mocked(viemKeeperChainReader).mockReset().mockReturnValue(reader as never);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("forwards the lib's status and body with no-store, reading the URL and config from the server", async () => {
    const url = freshUrl();
    vi.stubEnv("KEEPER_ORDERS_URL", url);
    serve.mockResolvedValue({ status: 200, body: body({ orders: [{ id: 1 }] }) } as never);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.json()).orders).toEqual([{ id: 1 }]);
    const deps = serve.mock.calls[0]![0] as KeeperRouteDeps;
    expect(deps.keeperOrdersUrl).toBe(url);
    expect(deps.config).toEqual({
      vault: "0x00000000000000000000000000000000000000aa",
      usdg: "0x00000000000000000000000000000000000000bb",
      clearinghouse: "0x00000000000000000000000000000000000000cc",
      seaport: "0x00000000000000000000000000000000000000dd",
      chainId: 4663,
    });
    expect(deps.nowSeconds).toBe(Math.floor(Date.parse("2026-09-25T12:00:00Z") / 1000));
  });

  it("builds the chain reader lazily, once, against the configured vault and Seaport", async () => {
    vi.stubEnv("KEEPER_ORDERS_URL", freshUrl());
    serve.mockImplementation(async (deps) => {
      await deps.chain.readState({ offerers: [], orderHashes: [] } as never);
      await deps.chain.getOrderHashes([] as never);
      return { status: 200, body: body() } as never;
    });
    await GET();
    expect(reader.readState).toHaveBeenCalled();
    expect(reader.getOrderHashes).toHaveBeenCalled();
    // The reader is memoised at module scope; it may already have been built by an earlier call.
    expect(vi.mocked(viemKeeperChainReader).mock.calls.length).toBeLessThanOrEqual(1);
    for (const call of vi.mocked(viemKeeperChainReader).mock.calls) {
      expect(call[1]).toEqual({ vault: "0x00000000000000000000000000000000000000aa", seaport: "0x00000000000000000000000000000000000000dd" });
    }
  });

  it("answers 502 with an empty, configured body when the check throws", async () => {
    vi.stubEnv("KEEPER_ORDERS_URL", freshUrl());
    serve.mockRejectedValue(new Error("boom"));
    const res = await GET();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual(body({ error: "The order feed route could not check the keeper's orders." }));
  });

  it("forwards the unconfigured 503 when KEEPER_ORDERS_URL is unset", async () => {
    vi.stubEnv("KEEPER_ORDERS_URL", undefined as unknown as string);
    delete process.env.KEEPER_ORDERS_URL;
    serve.mockResolvedValue({ status: 503, body: { ...body(), configured: false } } as never);
    const res = await GET();
    expect(res.status).toBe(503);
    expect(serve.mock.calls[0]![0].keeperOrdersUrl).toBeUndefined();
  });

  it("shares one computation between requests for the same URL; a new URL never reuses it", async () => {
    // The two-second expiry uses the Date.now captured when the route module loaded (real time), so it is covered by
    // shareWhileRunning's own tests in lib/keeperOrders.test.ts rather than here.
    vi.stubEnv("KEEPER_ORDERS_URL", freshUrl());
    serve.mockResolvedValue({ status: 200, body: body() } as never);
    await Promise.all([GET(), GET()]);
    await GET();
    expect(serve).toHaveBeenCalledTimes(1);
    vi.stubEnv("KEEPER_ORDERS_URL", freshUrl());
    await GET();
    expect(serve).toHaveBeenCalledTimes(2);
  });
});
