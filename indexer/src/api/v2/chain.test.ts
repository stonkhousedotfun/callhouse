/**
 * The batched live reads in src/api/v2/chain.ts other than the MakerVault snapshot (vault.chain.test.ts):
 * readSpots, readFree and readRewardBalances. The RPC is a fake multicall; every call is recorded so the test can
 * check which contract and function each batch addresses, and each read's failure, revert and timeout paths.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({
  CHAIN_NAME: "robinhood",
  LIVE_READ_TIMEOUT_MS: 1_000,
  USDG: "0x0000000000000000000000000000000000000001",
  V2_CLEARINGHOUSE: "0x000000000000000000000000000000000000c011" as string | undefined,
  V2_SETTLEMENT_ORACLE: "0x000000000000000000000000000000000000c013" as string | undefined,
}));
const rpc = vi.hoisted(() => ({
  multicall: vi.fn(),
  client: undefined as unknown,
}));

vi.mock("../../../lib/env", () => env);
vi.mock("ponder:api", () => ({
  publicClients: new Proxy({}, {
    get: (_target, name) => (name === "robinhood" ? rpc.client : undefined),
  }),
}));

const { readFree, readRewardBalances, readSpots } = await import("./chain");

const A = "0x00000000000000000000000000000000000000Aa" as const;
const B = "0x00000000000000000000000000000000000000Bb" as const;
const C = "0x00000000000000000000000000000000000000Cc" as const;
const ok = (result: unknown) => ({ status: "success", result });
const fail = { status: "failure", error: new Error("execution reverted") };

beforeEach(() => {
  rpc.multicall.mockReset();
  rpc.client = { multicall: rpc.multicall };
  env.V2_CLEARINGHOUSE = "0x000000000000000000000000000000000000c011";
  env.V2_SETTLEMENT_ORACLE = "0x000000000000000000000000000000000000c013";
});

afterEach(() => {
  vi.useRealTimers();
});

describe("readSpots", () => {
  it("asks the settlement oracle for spot(underlying) once, batched with failures allowed", async () => {
    rpc.multicall.mockResolvedValueOnce([ok([180_000_000n, 1_700_000_000n]), ok([2_500_000n, 1_700_000_100n])]);
    const spots = await readSpots([A, B]);
    const { contracts, allowFailure } = rpc.multicall.mock.calls[0]![0];
    expect(allowFailure).toBe(true);
    expect(contracts.map((c: any) => [c.address, c.functionName, c.args])).toEqual([
      [env.V2_SETTLEMENT_ORACLE, "spot", [A]],
      [env.V2_SETTLEMENT_ORACLE, "spot", [B]],
    ]);
    expect([...spots]).toEqual([
      [A.toLowerCase(), { price: 180_000_000n, updatedAt: 1_700_000_000 }],
      [B.toLowerCase(), { price: 2_500_000n, updatedAt: 1_700_000_100 }],
    ]);
  });

  it("drops a reverted, zero, unstamped or out-of-range spot but keeps the others", async () => {
    rpc.multicall.mockResolvedValueOnce([
      fail,
      ok([0n, 1n]),
      ok([1n, 0n]),
      ok([1n, BigInt(Number.MAX_SAFE_INTEGER) + 1n]),
      ok([7n, BigInt(Number.MAX_SAFE_INTEGER)]),
    ]);
    const spots = await readSpots([A, B, C, A, B]);
    expect([...spots]).toEqual([[B.toLowerCase(), { price: 7n, updatedAt: Number.MAX_SAFE_INTEGER }]]);
  });

  it("makes no call for no underlyings or without an oracle, and degrades to empty on an RPC error", async () => {
    expect((await readSpots([])).size).toBe(0);
    env.V2_SETTLEMENT_ORACLE = undefined;
    expect((await readSpots([A])).size).toBe(0);
    expect(rpc.multicall).not.toHaveBeenCalled();
    env.V2_SETTLEMENT_ORACLE = "0x000000000000000000000000000000000000c013";
    rpc.multicall.mockRejectedValueOnce(new Error("429 Too Many Requests"));
    expect((await readSpots([A])).size).toBe(0);
  });

  it("gives up after LIVE_READ_TIMEOUT_MS instead of hanging the request", async () => {
    vi.useFakeTimers();
    rpc.multicall.mockReturnValueOnce(new Promise(() => undefined));
    const pending = readSpots([A]);
    await vi.advanceTimersByTimeAsync(999);
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("readFree", () => {
  it("reads Clearinghouse.free(account, asset) per asset and keys results by lower-cased asset", async () => {
    rpc.multicall.mockResolvedValueOnce([ok(5_000_000n), fail, ok(0n)]);
    const free = await readFree(C, [A, B, C]);
    expect(rpc.multicall.mock.calls[0]![0].contracts.map((c: any) => [c.address, c.functionName, c.args])).toEqual([
      [env.V2_CLEARINGHOUSE, "free", [C, A]],
      [env.V2_CLEARINGHOUSE, "free", [C, B]],
      [env.V2_CLEARINGHOUSE, "free", [C, C]],
    ]);
    expect([...free]).toEqual([[A.toLowerCase(), 5_000_000n], [C.toLowerCase(), 0n]]);
  });

  it("is empty without assets, without a clearinghouse, or when the RPC fails", async () => {
    expect((await readFree(C, [])).size).toBe(0);
    env.V2_CLEARINGHOUSE = undefined;
    expect((await readFree(C, [A])).size).toBe(0);
    expect(rpc.multicall).not.toHaveBeenCalled();
    env.V2_CLEARINGHOUSE = "0x000000000000000000000000000000000000c011";
    rpc.multicall.mockRejectedValueOnce(new Error("timeout"));
    expect((await readFree(C, [A])).size).toBe(0);
  });
});

describe("readRewardBalances", () => {
  const TOKEN_A = "0x00000000000000000000000000000000000000d1";
  const TOKEN_B = "0x00000000000000000000000000000000000000d2";

  it("resolves each distributor's payout token, then reads its balance and decimals from that token", async () => {
    rpc.multicall
      .mockResolvedValueOnce([ok(TOKEN_A), fail, ok(TOKEN_B)])
      .mockResolvedValueOnce([ok(1_250_000n), ok(6), ok(3n * 10n ** 18n), ok(18n)]);
    const balances = await readRewardBalances([A, B, C]);
    const [first, second] = rpc.multicall.mock.calls.map((call) => call[0].contracts);
    expect(first.map((c: any) => [c.address, c.functionName])).toEqual([[A, "usdg"], [B, "usdg"], [C, "usdg"]]);
    // B's token did not resolve, so it is not read at all.
    expect(second.map((c: any) => [c.address, c.functionName, c.args])).toEqual([
      [TOKEN_A, "balanceOf", [A]], [TOKEN_A, "decimals", undefined],
      [TOKEN_B, "balanceOf", [C]], [TOKEN_B, "decimals", undefined],
    ]);
    expect([...balances]).toEqual([
      [A.toLowerCase(), { balance: 1_250_000n, decimals: 6 }],
      [C.toLowerCase(), { balance: 3n * 10n ** 18n, decimals: 18 }],
    ]);
  });

  it("drops a distributor whose balance or decimals failed, or whose decimals are not a sane scale", async () => {
    rpc.multicall
      .mockResolvedValueOnce([ok(TOKEN_A), ok(TOKEN_A), ok(TOKEN_B), ok(TOKEN_B)])
      .mockResolvedValueOnce([fail, ok(6), ok(1n), fail, ok(1n), ok(37), ok(1n), ok(-1)]);
    expect((await readRewardBalances([A, B, C, A])).size).toBe(0);
  });

  it("is empty with no distributors, no client, or a failed first or second batch", async () => {
    expect((await readRewardBalances([])).size).toBe(0);
    rpc.client = undefined;
    expect((await readRewardBalances([A])).size).toBe(0);
    expect(rpc.multicall).not.toHaveBeenCalled();
    rpc.client = { multicall: rpc.multicall };
    rpc.multicall.mockRejectedValueOnce(new Error("down"));
    expect((await readRewardBalances([A])).size).toBe(0);
    rpc.multicall.mockResolvedValueOnce([ok(TOKEN_A)]).mockRejectedValueOnce(new Error("down"));
    expect((await readRewardBalances([A])).size).toBe(0);
    expect(rpc.multicall).toHaveBeenCalledTimes(3);
  });
});
